/**
 * Hosted pick-best-image graph: loads as one tool, then a mocked run (local
 * NanoGPT stub only — no payments, no live API) returns the winning image.
 * Candidates and pick probabilities stay inside Decide; they are not outputs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaRef } from "nanoodle";
import { loadTools, emitResult } from "../src/tools.mjs";
import { createChargeGate } from "../src/gate.mjs";

/** 1x1 transparent PNG. The stub returns it for every image call. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GRAPH = new URL("./fixtures/hosted/pick-best-image.noodle-graph.json", import.meta.url);

test("pick-best-image loads as a tool and a mocked run returns the winning image", async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    requests.push({ method: req.method, path: req.url, json });

    if (req.method === "POST" && req.url === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.02 }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/decisions") {
      // Same answer both orders. decideMergeOrders remaps by position, so the
      // middle candidate (shown second in both the forward and reversed asks)
      // stays the winner at 70%.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        answers: {
          answer: {
            type: "choice",
            choice: "image_2",
            confidence: 0.7,
            probabilities: { image_1: 0.15, image_2: 0.7, image_3: 0.15 },
          },
        },
        usage: { input_tokens: 400, output_tokens: 0, cost: 0.000004 },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), "pick-best-"));
  try {
    await copyFile(GRAPH, join(dir, "pick-best-image.noodle-graph.json"));
    const registry = await loadTools({
      dirs: [dir],
      apiKey: "test-key",
      baseUrl,
      outDir: join(dir, "out"),
      log: () => {},
    });
    const listed = registry.listTools().find((t) => t.name === "pick-best-image");
    assert.ok(listed, "graph filename becomes the tool name");
    assert.match(listed.description, /Picks the best of three cheap images for a brief, or a subject plus a style\./);
    assert.match(listed.description, /Model cost about \$0\.014, plus 20% markup/);
    assert.match(listed.description, /\$0\.05 deposit held/);
    assert.match(listed.description, /decide:Pick the best/);
    assert.match(listed.description, /returns image \(pplx-decider-v1\.1-27b\) saved to disk/);
    assert.doesNotMatch(listed.description, /probabilities/);
    assert.equal(listed.inputSchema.required, undefined);
    const props = listed.inputSchema.properties;
    assert.ok(props.Brief);
    assert.ok(props.Subject);
    assert.ok(props.Style);
    assert.match(props.Brief.description, /optional/);
    assert.match(props.Brief.description, /a red paper lantern over a quiet canal at dusk/);
    assert.match(props.Subject.description, /optional/);
    assert.match(props.Style.description, /optional/);
    const tool = registry.tools.find((t) => t.name === "pick-best-image");
    assert.deepEqual(tool.x402, { usd: 0.05 });
    const pick = tool.wf.graph.nodes.find((n) => n.id === "pick");
    assert.equal(pick.fields.mode, "pick");
    assert.equal(pick.fields.model, "perplexity/pplx-decider-v1.1-27b");

    const before = requests.length;
    const brief = "a glass fox in a linen suit";
    const result = await registry.callTool({ name: "pick-best-image", arguments: { Brief: brief } });
    assert.equal(result.textOutput, false, "the winner is media, so a paid result can persist");
    const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
    const blob = texts.join("\n");
    assert.match(blob, /Pick the best: saved \//);
    assert.doesNotMatch(blob, /^image 2$/m, "the internal Decide label is not a tool output");
    assert.doesNotMatch(blob, /probabilities:/);
    assert.doesNotMatch(blob, /Candidate \d+: saved/);
    assert.match(blob, /cost: \$0\.0600\b/);
    const winnerPath = blob.match(/Pick the best: saved (\S+)/)[1];
    const winner = await readFile(winnerPath);
    assert.equal(winner[0], 0x89, "winner file is a PNG");
    assert.equal(String.fromCharCode(...winner.subarray(1, 4)), "PNG");

    const mine = requests.slice(before);
    assert.deepEqual(mine.map((r) => r.path).sort(), [
      "/api/v1/decisions",
      "/api/v1/decisions",
      "/v1/images/generations",
      "/v1/images/generations",
      "/v1/images/generations",
    ]);
    const images = mine.filter((r) => r.path === "/v1/images/generations");
    const byModel = Object.fromEntries(images.map((r) => [r.json.model, r.json]));
    assert.equal(byModel["krea-2/turbo"].seed, 101);
    assert.equal(byModel["krea-2/turbo"].size, "square");
    assert.equal(byModel["hidream-i1-fast"].seed, 202);
    assert.equal(byModel["hidream-i1-fast"].size, "1024x1024");
    assert.equal(byModel["flux-schnell"].seed, 303);
    assert.equal(byModel["flux-schnell"].size, "1024x1024");
    for (const img of images) assert.equal(img.json.prompt, brief);
    for (const dec of mine.filter((r) => r.path === "/api/v1/decisions")) {
      assert.equal(dec.json.model, "perplexity/pplx-decider-v1.1-27b");
      assert.equal(dec.json.questions.answer.type, "choice");
      assert.equal(dec.json.questions.answer.instructions, "Which image best matches the brief?");
      assert.equal(dec.json.state[0], brief);
    }

    // The other input shape: a subject plus a style, with the sample brief cleared.
    const alt = await registry.callTool({
      name: "pick-best-image",
      arguments: { Brief: "", Subject: "a glass fox", Style: "linen suit, studio light" },
    });
    const altBlob = alt.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.equal(alt.textOutput, false);
    assert.match(altBlob, /Pick the best: saved \//);
    assert.doesNotMatch(altBlob, /probabilities:/);
    const altImages = requests.slice(mine.length + before).filter((r) => r.path === "/v1/images/generations");
    assert.equal(altImages.length, 3);
    for (const img of altImages) {
      assert.equal(img.json.prompt, "a glass fox\n\nlinen suit, studio light");
      assert.doesNotMatch(img.json.prompt, /paper lantern/);
    }

    const afterAlt = requests.length;
    // Omitted Brief (key absent): only the subject and style the caller sent.
    await registry.callTool({
      name: "pick-best-image",
      arguments: { Subject: "a glass fox", Style: "linen suit, studio light" },
    });
    const omittedImages = requests.slice(afterAlt).filter((r) => r.path === "/v1/images/generations");
    assert.equal(omittedImages.length, 3);
    for (const img of omittedImages) {
      assert.equal(img.json.prompt, "a glass fox\n\nlinen suit, studio light");
      assert.doesNotMatch(img.json.prompt, /paper lantern/);
    }

    const afterOmitted = requests.length;
    await registry.callTool({
      name: "pick-best-image",
      arguments: { Subject: "only the subject" },
    });
    const subjectOnly = requests.slice(afterOmitted).filter((r) => r.path === "/v1/images/generations");
    assert.equal(subjectOnly.length, 3);
    for (const img of subjectOnly) {
      assert.equal(img.json.prompt, "only the subject");
      assert.doesNotMatch(img.json.prompt, /paper lantern/);
    }

    const afterSubject = requests.length;
    // All defaults: nothing supplied, so the saved brief sample is the prompt.
    await registry.callTool({ name: "pick-best-image", arguments: {} });
    const defaults = requests.slice(afterSubject).filter((r) => r.path === "/v1/images/generations");
    assert.equal(defaults.length, 3);
    for (const img of defaults) {
      assert.equal(img.json.prompt, "a red paper lantern over a quiet canal at dusk");
    }
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

const PNG_URL = "data:image/png;base64," + PNG_B64;

test("declared outputs only: an image sink does not leak Decide reports, and a pick sink returns the winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pick-emit-"));
  try {
    const internal = {
      graph: {
        nodes: [
          { id: "img", type: "image", name: "Candidate 1" },
          { id: "pick", type: "decide", name: "Pick the best", fields: { mode: "pick" } },
          { id: "final", type: "image", name: "Final" },
        ],
        links: [{ from: { node: "img", port: "image" }, to: { node: "pick", port: "img1" } }],
      },
      outputs: [{ key: "Final", nodeId: "final", type: "image", ports: [{ name: "image", type: "image" }] }],
    };
    const emitted = await emitResult(internal, {
      outputs: { Final: new MediaRef(PNG_URL) },
      nodes: {
        img: { status: "done", out: { image: PNG_URL } },
        pick: {
          status: "done",
          out: {
            text: "image 1",
            image: PNG_URL,
            decision: { rows: [{ label: "image 1", p: 0.7, win: true }, { label: "image 2", p: 0.3, win: false }] },
          },
        },
        final: { status: "done", out: { image: PNG_URL } },
      },
      costUsd: 0.014,
    }, "final", dir);
    const blob = emitted.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.equal(emitted.textOutput, false);
    assert.match(blob, /Final: saved \//);
    assert.doesNotMatch(blob, /probabilities/);
    assert.doesNotMatch(blob, /Candidate/);
    assert.doesNotMatch(blob, /^image 1$/m);

    const sink = await emitResult({
      graph: {
        nodes: [
          { id: "c1", type: "image", name: "Candidate 1" },
          { id: "pick", type: "decide", name: "Pick the best", fields: { mode: "pick" } },
        ],
        links: [{ from: { node: "c1", port: "image" }, to: { node: "pick", port: "img1" } }],
      },
      outputs: [{
        key: "Pick the best", nodeId: "pick", type: "decide",
        ports: [{ name: "text", type: "text" }, { name: "image", type: "image" }],
      }],
    }, {
      outputs: { "Pick the best": "image 2" },
      nodes: {
        c1: { status: "done", out: { image: PNG_URL } },
        pick: {
          status: "done",
          out: { text: "image 2", image: PNG_URL, decision: { rows: [{ label: "image 2", p: 0.7, win: true }] } },
        },
      },
      costUsd: 0.014,
    }, "sink", dir);
    const sinkBlob = sink.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.equal(sink.textOutput, false, "the label must not mark the paid image as text");
    assert.match(sinkBlob, /Pick the best: saved \//);
    assert.doesNotMatch(sinkBlob, /^image 2$/m);
    assert.doesNotMatch(sinkBlob, /probabilities/);
    assert.doesNotMatch(sinkBlob, /Candidate 1: saved/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";

function miniChain() {
  const state = { receivable: {}, history: [], transfers: [] };
  return {
    state,
    ops: {
      rpc: async (body) => {
        if (body.action === "receivable") return { blocks: state.receivable };
        if (body.action === "account_history") return { history: [] };
        throw new Error("unexpected rpc action " + body.action);
      },
      transfer: async (to, amountRaw, describe) => {
        state.transfers.push({ to, amountRaw, describe });
        return "F".repeat(64);
      },
      pocket: async () => {},
    },
  };
}

async function until(label, pred) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > 5000) throw new Error("timed out waiting for " + label);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a paid pick-best image survives restart and replays with no model calls", async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    requests.push({ path: req.url, json });
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.02 }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/decisions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        answers: { answer: { type: "choice", choice: "image_2", confidence: 0.7, probabilities: { image_1: 0.15, image_2: 0.7, image_3: 0.15 } } },
        usage: { cost: 0.000004 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), "pick-replay-"));
  const stateFile = join(dir, "gate-state.json");
  try {
    await copyFile(GRAPH, join(dir, "pick-best-image.noodle-graph.json"));
    const registry = await loadTools({
      dirs: [dir], apiKey: "test-key", baseUrl, outDir: join(dir, "out"), log: () => {},
    });
    const chain = miniChain();
    const gate = createChargeGate({
      address: GATE_ADDR, ops: chain.ops, usd: 0.05, xnoUsd: 1,
      publicBase: "http://pay.test", pollMs: 10, waitMs: 1000, stateFile,
      validate: (p) => registry.prepareCall(p), log: () => {},
    }).wrapRegistry(registry);
    const args = { Brief: "a glass fox in a linen suit" };
    const quoted = await gate.callTool({ name: "pick-best-image", arguments: args });
    const pay = quoted.structuredContent.x402;
    chain.state.receivable["A".repeat(64)] = { amount: pay.amountRaw, source: PAYER };
    const before = requests.length;
    const first = await gate.callTool({ name: "pick-best-image", arguments: { ...args, _payment_id: pay.paymentId } });
    assert.ok(!first.isError, first.content && first.content[0] && first.content[0].text);
    assert.equal(requests.length - before, 5, "three images and two decider calls");
    const blob = first.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.match(blob, /Pick the best:/);
    assert.doesNotMatch(blob, /probabilities:/);
    await until("the media result to persist", async () => {
      const raw = await readFile(stateFile, "utf8").catch(() => "");
      if (!raw) return false;
      const q = JSON.parse(raw).quotes.find((x) => x.id === pay.paymentId);
      return q && q.status === "consumed" && q.result;
    });
    const callsAfterRun = requests.length;

    const chain2 = miniChain();
    const gate2 = createChargeGate({
      address: GATE_ADDR, ops: chain2.ops, usd: 0.05, xnoUsd: 1,
      publicBase: "http://pay.test", pollMs: 10, waitMs: 1000, stateFile,
      validate: (p) => registry.prepareCall(p), log: () => {},
    }).wrapRegistry(registry);
    const replay = await gate2.callTool({ name: "pick-best-image", arguments: { ...args, _payment_id: pay.paymentId } });
    assert.ok(!replay.isError);
    assert.equal(requests.length, callsAfterRun, "replay serves the persisted image and does not call a model");
    const replayBlob = replay.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.match(replayBlob, /Pick the best:/);
    assert.doesNotMatch(replayBlob, /probabilities:/);
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
