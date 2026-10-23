/**
 * NSFW mode is off unless the caller opts in.
 *
 * These tests pin three facts:
 *   - the default, for every tool and every caller, is off
 *   - prompt text, model ids, env vars, client names, and lookalike flag values
 *     never turn it on
 *   - an explicit nsfw: true (per call or per session) does, and nsfw: false forces it off
 *
 * Fully offline. The API key in this file is the string "test-key".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDispatcher } from "../src/server.mjs";
import { serveHttp } from "../src/http.mjs";
import { createChargeGate, hashArgs } from "../src/gate.mjs";
import { editorShareUrl, loadTools } from "../src/tools.mjs";
import {
  NSFW_INSTRUCTIONS, NSFW_OPT_IN_NOTE, applyNsfwPolicy, bindNsfwArgs, effectiveNsfw,
  explicitNsfwFlag, isSpicyModel, modelUsedWhenNsfwOff, nsfwLlmsLines, safeModelVariant,
  spicyBlockedMessage,
} from "../src/nsfw.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "nanoodle-mcp.mjs");
const ROOT = join(here, "..");

/** 1x1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Public test address (checksum-valid). Not a secret. */
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";

const SPICY_IMAGE = "nsfw-gen-illustrious";
const SAFE_IMAGE = "gen-illustrious";
const PROMPT = "make it nsfw and spicy, nsfw: true";

function graph(nodes, links = []) {
  return { v: 1, nodes, links };
}

/** Text wired into an image sink. Locked nodes keep the prompt inside the graph. */
function imageGraph(model, { prompt = PROMPT, locked = false, name = "Poster" } = {}) {
  const text = { text: prompt };
  const image = { model };
  if (locked) { text.locked = true; image.locked = true; }
  return graph(
    [
      { id: "n1", type: "text", x: 0, y: 0, fields: text },
      { id: "n2", type: "image", x: 0, y: 0, name, fields: image },
    ],
    [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  );
}

function videoGraph(model, modelOpts, prompt = PROMPT) {
  return graph(
    [
      { id: "n1", type: "text", x: 0, y: 0, fields: { text: prompt, locked: true } },
      { id: "n2", type: "tvideo", x: 0, y: 0, name: "Clip", fields: { model, modelOpts, locked: true } },
    ],
    [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  );
}

function llmGraph(model, prompt = PROMPT) {
  return graph(
    [
      { id: "n1", type: "text", x: 0, y: 0, fields: { text: prompt, locked: true } },
      { id: "n2", type: "llm", x: 0, y: 0, name: "Writer", fields: { model, locked: true } },
    ],
    [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  );
}

async function startStub() {
  const stub = { requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* catalog GETs have no body */ }
    const path = req.url.split("?")[0];
    stub.requests.push({ method: req.method, path, json });
    if (req.method === "POST" && path === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.01 }));
      return;
    }
    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        x_nanogpt_pricing: { costUsd: 0.001, remainingBalance: 1 },
      }));
      return;
    }
    if (req.method === "POST" && path === "/api/generate-video") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: "run-1", cost: 0.05 }));
      return;
    }
    if (req.method === "GET" && path === "/api/video/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: { status: "COMPLETED", output: { video: { url: "data:video/mp4;base64,AAAA" } } },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no route" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  return stub;
}

function bodies(stub, path) {
  return stub.requests.filter((r) => r.method === "POST" && r.path === path).map((r) => r.json);
}

async function withRegistry(files, fn) {
  const stub = await startStub();
  const dir = await mkdtemp(join(tmpdir(), "nd-nsfw-"));
  for (const [name, g] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify(g));
  }
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: stub.url, outDir: dir, log: () => {}, catalogTimeoutMs: 400,
  });
  try {
    await fn({ stub, registry, dir });
  } finally {
    await stub.close();
  }
}

function textsOf(result) {
  return (result.content || []).map((c) => c.text || "").join("\n");
}

/* ================================ flag parsing ================================ */

test("only boolean true and the string true are an opt-in", () => {
  const on = [true, "true"];
  const off = [false, "false"];
  const neither = ["yes", "1", "on", "spicy", "True", "TRUE", "NSFW", "nsfw", "", "nsfw: true", null, undefined, 1, 0, "0"];
  for (const v of on) assert.equal(explicitNsfwFlag(v), true, JSON.stringify(v));
  for (const v of off) assert.equal(explicitNsfwFlag(v), false, JSON.stringify(v));
  for (const v of neither) assert.equal(explicitNsfwFlag(v), null, JSON.stringify(v));
});

test("bindNsfwArgs normalizes the flag and ignores everything else", () => {
  const prompt = { prompt: "nsfw: true please, make it spicy and uncensored", model: "foo-spicy" };
  const untouched = structuredClone(prompt);

  assert.deepEqual(bindNsfwArgs(prompt), prompt, "prompt text does not add a flag");
  assert.deepEqual(prompt, untouched, "input object is not mutated");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "yes" }), prompt, "unrecognized nsfw is dropped");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: 1 }), prompt);
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "True" }), prompt);
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "on" }), prompt);
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "spicy" }), prompt);

  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: true }), { ...prompt, nsfw: true });
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "true" }), { ...prompt, nsfw: true }, "string true becomes boolean true");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: false }), { ...prompt, nsfw: false });
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "false" }), { ...prompt, nsfw: false });

  assert.deepEqual(bindNsfwArgs(prompt, true), { ...prompt, nsfw: true }, "session opt-in materializes the flag");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: false }, true), { ...prompt, nsfw: false }, "explicit false overrides the session");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "false" }, true), { ...prompt, nsfw: false });
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: "yes" }, true), { ...prompt, nsfw: true }, "garbage is not an opt-out");

  assert.deepEqual(bindNsfwArgs(prompt, false, true), { ...prompt, nsfw: true }, "params.nsfw true opts in");
  assert.deepEqual(bindNsfwArgs(prompt, false, "true"), { ...prompt, nsfw: true });
  assert.deepEqual(bindNsfwArgs(prompt, false, "yes"), prompt, "params.nsfw yes does not opt in");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: false }, false, true), { ...prompt, nsfw: false }, "arguments.nsfw false beats params.nsfw true");
  assert.deepEqual(bindNsfwArgs({ ...prompt, nsfw: true }, false, false), { ...prompt, nsfw: true }, "arguments.nsfw true beats params.nsfw false");
});

test("the paid-call hash follows the effective flag, not the prompt", () => {
  const prompt = { prompt: "nsfw: true please", model: "foo-spicy" };
  const off = hashArgs("poster", bindNsfwArgs(prompt));
  const on = hashArgs("poster", bindNsfwArgs({ ...prompt, nsfw: true }));
  assert.notEqual(off, on);
  assert.equal(on, hashArgs("poster", bindNsfwArgs({ ...prompt, nsfw: "true" })));
  assert.equal(off, hashArgs("poster", bindNsfwArgs({ ...prompt, nsfw: "yes" })));
  assert.equal(off, hashArgs("poster", bindNsfwArgs({ ...prompt, nsfw: "True" })));
  assert.equal(on, hashArgs("poster", bindNsfwArgs(prompt, true)), "session opt-in hashes like an explicit true");
  assert.notEqual(on, hashArgs("poster", bindNsfwArgs({ ...prompt, nsfw: false }, true)));
  assert.notEqual(off, hashArgs("poster", bindNsfwArgs({ prompt: "a lighthouse" })), "a different prompt is a different call; the words nsfw and spicy are not themselves the flag");
});

test("effectiveNsfw reads only the flag and an already-explicit session latch", () => {
  assert.equal(effectiveNsfw({ arguments: { prompt: "nsfw: true", model: "x-spicy" } }), false);
  assert.equal(effectiveNsfw({ arguments: { nsfw: true } }), true);
  assert.equal(effectiveNsfw({ arguments: { nsfw: "true" } }), true);
  assert.equal(effectiveNsfw({ arguments: { nsfw: "yes" } }), false);
  assert.equal(effectiveNsfw({ arguments: { nsfw: 1 } }), false);
  assert.equal(effectiveNsfw({ arguments: {} }, { sessionNsfw: true }), true);
  assert.equal(effectiveNsfw({ arguments: { nsfw: false } }, { sessionNsfw: true }), false);
  assert.equal(effectiveNsfw({ arguments: { nsfw: "yes" } }, { sessionNsfw: true }), true);
  assert.equal(effectiveNsfw({ nsfw: true, arguments: {} }), true);
  assert.equal(effectiveNsfw({ nsfw: "yes", arguments: {} }), false);
  assert.equal(effectiveNsfw({ nsfw: true, arguments: { nsfw: false } }), false);
  assert.equal(effectiveNsfw({ arguments: {} }, { sessionNsfw: "true" }), false, "only boolean true on the latch counts");
});

/* ================================ model policy ================================ */

test("spicy means the id token, and the safe sibling is that token removed", () => {
  const pairs = [
    ["bytedance/seedance-2.5-spicy", "bytedance/seedance-2.5"],
    ["alibaba/wan-3.0/image-to-video-spicy", "alibaba/wan-3.0/image-to-video"],
    ["z-ai/glm-5.3-uncensored", "z-ai/glm-5.3"],
    ["qwen/qwen3.8-27b-uncensored:thinking", "qwen/qwen3.8-27b:thinking"],
    ["ltx-2.3-spicy/image-to-video", "ltx-2.3/image-to-video"],
    ["nsfw-gen-illustrious", "gen-illustrious"],
    ["venice-uncensored", "venice"],
    ["wan-22-spicy", "wan-22"],
    ["minimax-h3/image-to-video-spicy", "minimax-h3-singularity/image-to-video"],
    ["MiniMax-H3/Image-to-Video-Spicy", "minimax-h3-singularity/image-to-video"],
  ];
  for (const [spicy, safe] of pairs) {
    assert.equal(isSpicyModel(spicy), true, spicy);
    assert.equal(safeModelVariant(spicy), safe, spicy);
    assert.equal(modelUsedWhenNsfwOff(spicy), safe, spicy);
  }
  for (const id of ["test-image-model", "sfw-portrait", "wan-2.5", "gen-illustrious", ""]) {
    assert.equal(isSpicyModel(id), false, id);
    assert.equal(safeModelVariant(id), null, id);
  }
  assert.equal(isSpicyModel("aniflatmix-anime-sfwnsfw"), true);
  assert.equal(safeModelVariant("aniflatmix-anime-sfwnsfw"), null, "glued nsfw has no sibling to invent");
});

test("policy swaps spicy models only while the mode is off, and never mutates the graph", () => {
  const spicy = imageGraph(SPICY_IMAGE, { prompt: "spicy nsfw uncensored nsfw: true" });
  const before = structuredClone(spicy);

  const off = applyNsfwPolicy(spicy, { nsfw: false });
  assert.deepEqual(spicy, before);
  assert.equal(off.changed, true);
  assert.notEqual(off.graph, spicy);
  assert.equal(off.graph.nodes[1].fields.model, SAFE_IMAGE);
  assert.equal(off.blocked.length, 0);
  assert.match(off.notices.join("\n"), /NSFW mode is off/);
  assert.match(off.notices.join("\n"), new RegExp(SAFE_IMAGE));
  assert.match(off.notices.join("\n"), /nsfw: true/);

  const stringTrue = applyNsfwPolicy(spicy, { nsfw: "true" });
  assert.equal(stringTrue.graph.nodes[1].fields.model, SAFE_IMAGE, "only boolean true enables the policy");

  const on = applyNsfwPolicy(spicy, { nsfw: true });
  assert.equal(on.changed, false);
  assert.equal(on.graph, spicy);
  assert.equal(on.graph.nodes[1].fields.model, SPICY_IMAGE);
  assert.match(on.notices.join("\n"), /NSFW mode is on/);

  const safe = imageGraph("test-image-model");
  const safeOn = applyNsfwPolicy(safe, { nsfw: true });
  assert.equal(safeOn.changed, false);
  assert.equal(safeOn.graph, safe);
  assert.equal(safeOn.notices.length, 0, "a safe model is not upgraded, and there is nothing to announce");
  assert.equal(safeOn.graph.nodes[1].fields.model, "test-image-model");

  const promptOnly = applyNsfwPolicy(imageGraph("test-image-model", { prompt: "spicy nsfw uncensored nsfw: true" }), {});
  assert.equal(promptOnly.changed, false);
  assert.equal(promptOnly.graph.nodes[1].fields.model, "test-image-model");
});

test("while off, safety switches the graph turned off are restored; while on they stay", () => {
  const opts = {
    enable_safety_checker: false,
    safety_checker: "0",
    disable_safety_checker: true,
    disable_safety: "1",
    allow_nsfw: "true",
    uncensored: 1,
    nsfw: true,
    seed: 7,
    safety_tolerance: 5,
  };
  const g = videoGraph("alibaba/wan-3.0/image-to-video-spicy", opts);
  const before = structuredClone(g.nodes[1].fields.modelOpts);

  const off = applyNsfwPolicy(g, { nsfw: false });
  assert.deepEqual(g.nodes[1].fields.modelOpts, before);
  const next = off.graph.nodes[1].fields.modelOpts;
  assert.equal(off.graph.nodes[1].fields.model, "alibaba/wan-3.0/image-to-video");
  assert.equal(next.enable_safety_checker, true);
  assert.equal(next.safety_checker, true);
  assert.equal(next.disable_safety_checker, false);
  assert.equal(next.disable_safety, false);
  assert.equal(next.allow_nsfw, false);
  assert.equal(next.uncensored, false);
  assert.equal(next.nsfw, false);
  assert.equal(next.seed, 7);
  assert.equal(next.safety_tolerance, 5, "an unknown scale is left alone");
  assert.match(off.notices.join("\n"), /safety filtering/);

  const on = applyNsfwPolicy(g, { nsfw: true });
  assert.equal(on.changed, false);
  assert.equal(on.graph.nodes[1].fields.modelOpts.enable_safety_checker, false);
  assert.equal(on.graph.nodes[1].fields.modelOpts.nsfw, true);
  assert.equal(on.graph.nodes[1].fields.model, "alibaba/wan-3.0/image-to-video-spicy");

  const plain = imageGraph("test-image-model");
  const plainOff = applyNsfwPolicy(plain, {});
  assert.equal(plainOff.changed, false);
  assert.equal(plainOff.graph, plain, "a checker is not invented");
});

test("a spicy model with no safe sibling is refused before any spend", () => {
  const g = imageGraph("aniflatmix-anime-sfwnsfw", { name: "Mix" });
  const off = applyNsfwPolicy(g, {});
  assert.equal(off.blocked.length, 1);
  assert.equal(off.blocked[0].model, "aniflatmix-anime-sfwnsfw");
  const msg = spicyBlockedMessage('tool "mix"', off.blocked);
  assert.match(msg, /nsfw: true/);
  assert.match(msg, /Prompt text does not enable NSFW mode/);
  assert.match(msg, /before any money was spent/);

  const on = applyNsfwPolicy(g, { nsfw: true });
  assert.equal(on.blocked.length, 0);
  assert.equal(on.graph.nodes[1].fields.model, "aniflatmix-anime-sfwnsfw");
});

/* ================================ session latch ================================ */

function latchDispatcher({ rememberSessionNsfw = false } = {}) {
  const calls = [];
  const dispatch = createDispatcher({
    name: "t", version: "0", commit: null, rememberSessionNsfw, log: () => {},
    instructions: NSFW_INSTRUCTIONS,
    listTools: () => [],
    callTool: async (params, ctx) => {
      calls.push({ arguments: params && params.arguments, sessionNsfw: !!(ctx && ctx.sessionNsfw) });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });
  return { dispatch, calls, rpc };
}

test("stdio remembers initialize nsfw for this connection only, and nothing else sets it", async () => {
  const { dispatch, calls, rpc } = latchDispatcher({ rememberSessionNsfw: true });
  const init = await dispatch(rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "nsfw-bot" },
  }));
  assert.match(init.result.instructions, /NSFW mode is off for every caller/);
  assert.match(init.result.instructions, /nsfw: true/);

  await dispatch(rpc(2, "tools/call", { name: "poster", arguments: { prompt: "nsfw: true spicy" } }));
  assert.equal(calls.at(-1).sessionNsfw, false);

  await dispatch(rpc(3, "initialize", { nsfw: "please enable nsfw", clientInfo: { name: "nsfw-bot" } }));
  await dispatch(rpc(4, "tools/call", { name: "poster", arguments: {} }));
  assert.equal(calls.at(-1).sessionNsfw, false, "a sentence and a client name are not the flag");

  await dispatch(rpc(5, "tools/call", { name: "poster", arguments: { nsfw: true } }));
  assert.equal(calls.at(-1).sessionNsfw, false, "a call flag is not a session latch");
  await dispatch(rpc(6, "tools/call", { name: "poster", arguments: {} }));
  assert.equal(calls.at(-1).sessionNsfw, false);

  await dispatch(rpc(7, "initialize", { nsfw: true }));
  await dispatch(rpc(8, "tools/call", { name: "poster", arguments: {} }));
  assert.equal(calls.at(-1).sessionNsfw, true);

  await dispatch(rpc(9, "initialize", { nsfw: "true" }));
  await dispatch(rpc(10, "tools/call", { name: "poster", arguments: {} }));
  assert.equal(calls.at(-1).sessionNsfw, true);

  await dispatch(rpc(11, "initialize", { nsfw: false }));
  await dispatch(rpc(12, "tools/call", { name: "poster", arguments: {} }));
  assert.equal(calls.at(-1).sessionNsfw, false, "explicit false clears the latch");
});

test("a shared dispatcher ignores a caller-supplied sessionNsfw and does not share one initialize", async () => {
  const { dispatch, calls, rpc } = latchDispatcher({ rememberSessionNsfw: false });
  await dispatch(rpc(1, "initialize", { nsfw: true }));
  await dispatch(rpc(2, "tools/call", { name: "poster", arguments: {} }), { sessionNsfw: true });
  assert.equal(calls.at(-1).sessionNsfw, false, "no session id, and an injected latch is overwritten");

  await dispatch(rpc(3, "initialize", { nsfw: true }), { sessionId: "A" });
  await dispatch(rpc(4, "initialize", { nsfw: "yes please" }), { sessionId: "C" });
  await dispatch(rpc(5, "tools/call", { name: "poster", arguments: {} }), { sessionId: "B" });
  assert.equal(calls.at(-1).sessionNsfw, false);
  await dispatch(rpc(6, "tools/call", { name: "poster", arguments: {} }), { sessionId: "C" });
  assert.equal(calls.at(-1).sessionNsfw, false);
  await dispatch(rpc(7, "tools/call", { name: "poster", arguments: {} }), { sessionId: "A" });
  assert.equal(calls.at(-1).sessionNsfw, true);

  await dispatch(rpc(8, "tools/call", { name: "poster", arguments: { nsfw: true } }), { sessionId: "B" });
  await dispatch(rpc(9, "tools/call", { name: "poster", arguments: {} }), { sessionId: "B" });
  assert.equal(calls.at(-1).sessionNsfw, false, "tools/call does not opt the session in");

  await dispatch(rpc(10, "initialize", { nsfw: false }), { sessionId: "A" });
  await dispatch(rpc(11, "tools/call", { name: "poster", arguments: {} }), { sessionId: "A" });
  assert.equal(calls.at(-1).sessionNsfw, false);
});

/* ================================ runs ================================ */

test("default run sends the safe model; prompt text and env vars do not flip it", async () => {
  const prev = { NSFW: process.env.NSFW, NANOODLE_NSFW: process.env.NANOODLE_NSFW };
  process.env.NSFW = "true";
  process.env.NANOODLE_NSFW = "true";
  try {
    await withRegistry({ poster: imageGraph(SPICY_IMAGE, { locked: true }) }, async ({ stub, registry }) => {
      const listed = registry.listTools();
      for (const t of listed) {
        assert.equal(t.inputSchema.properties.nsfw.type, "boolean", t.name);
        assert.equal(t.inputSchema.properties.nsfw.default, false, t.name);
        assert.ok(!t.inputSchema.required || !t.inputSchema.required.includes("nsfw"), t.name);
        assert.match(t.description, /NSFW mode is off/);
        assert.match(t.inputSchema.properties.nsfw.description, /Default false/);
      }
      const poster = listed.find((t) => t.name === "poster");
      assert.match(poster.description, new RegExp(SAFE_IMAGE));
      assert.doesNotMatch(poster.description, new RegExp(SPICY_IMAGE));
      assert.ok(poster.description.endsWith(NSFW_OPT_IN_NOTE));

      const authored = registry.tools[0].wf.graph.nodes.find((n) => n.type === "image").fields.model;
      assert.equal(authored, SPICY_IMAGE);

      const off = await registry.callTool({ name: "poster", arguments: {} });
      assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SAFE_IMAGE);
      assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, PROMPT);
      assert.match(textsOf(off), /NSFW mode is off/);
      assert.equal(registry.tools[0].wf.graph.nodes.find((n) => n.type === "image").fields.model, SPICY_IMAGE, "the stored graph stays spicy");

      for (const nsfw of ["yes", 1, "True", "on", "spicy", "TRUE"]) {
        const before = bodies(stub, "/v1/images/generations").length;
        await registry.callTool({ name: "poster", arguments: { nsfw } });
        const sent = bodies(stub, "/v1/images/generations");
        assert.equal(sent.length, before + 1, JSON.stringify(nsfw));
        assert.equal(sent.at(-1).model, SAFE_IMAGE, JSON.stringify(nsfw));
      }

      const postsBefore = bodies(stub, "/v1/images/generations").length;
      await assert.rejects(
        () => registry.callTool({ name: "poster", arguments: { NSFW: true, model: "something-spicy" } }),
        (err) => err.mcpCode === -32602,
      );
      assert.equal(bodies(stub, "/v1/images/generations").length, postsBefore, "a lookalike key is not the flag and spends nothing");
    });
  } finally {
    if (prev.NSFW === undefined) delete process.env.NSFW;
    else process.env.NSFW = prev.NSFW;
    if (prev.NANOODLE_NSFW === undefined) delete process.env.NANOODLE_NSFW;
    else process.env.NANOODLE_NSFW = prev.NANOODLE_NSFW;
  }
});

test("nsfw true and the string true allow the authored spicy model, and do not upgrade a safe one", async () => {
  await withRegistry({
    poster: imageGraph(SPICY_IMAGE, { locked: true }),
    plain: imageGraph("test-image-model", { locked: true, prompt: "a lighthouse" }),
  }, async ({ stub, registry }) => {
    for (const nsfw of [true, "true"]) {
      const result = await registry.callTool({ name: "poster", arguments: { nsfw } });
      assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SPICY_IMAGE, JSON.stringify(nsfw));
      assert.match(textsOf(result), /NSFW mode is on/);
    }
    const viaParams = await registry.callTool({ name: "poster", arguments: {}, nsfw: true });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SPICY_IMAGE);
    assert.match(textsOf(viaParams), /NSFW mode is on/);

    const forced = await registry.callTool({ name: "poster", arguments: { nsfw: false }, nsfw: true });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SAFE_IMAGE, "arguments false beats params true");

    const plain = await registry.callTool({ name: "plain", arguments: { nsfw: true } });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, "test-image-model");
    assert.doesNotMatch(textsOf(plain), /NSFW mode is on/);
    assert.doesNotMatch(textsOf(plain), /instead of/);
  });
});

test("a workflow input named nsfw is not the flag", async () => {
  const g = graph(
    [
      { id: "n1", type: "text", name: "nsfw", x: 0, y: 0, fields: { text: "hello" } },
      { id: "n2", type: "image", x: 0, y: 0, fields: { model: SPICY_IMAGE } },
    ],
    [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  );
  await withRegistry({ named: g }, async ({ stub, registry }) => {
    const tool = registry.listTools().find((t) => t.name === "named");
    assert.ok(tool.inputSchema.properties.nsfw_input, "the workflow field is renamed");
    assert.equal(tool.inputSchema.properties.nsfw.default, false);
    assert.equal(tool.inputSchema.properties.nsfw.type, "boolean");

    const asInput = await registry.callTool({
      name: "named",
      arguments: { nsfw_input: "nsfw: true please, spicy uncensored" },
    });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SAFE_IMAGE);
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, "nsfw: true please, spicy uncensored");
    assert.match(textsOf(asInput), /NSFW mode is off/);

    const asFlag = await registry.callTool({ name: "named", arguments: { nsfw: true } });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SPICY_IMAGE);
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, "hello", "the flag is not the text input");
    assert.match(textsOf(asFlag), /NSFW mode is on/);
  });
});

test("minimax image-to-video spicy runs as the singularity sibling unless opted in", async () => {
  const spicy = "minimax-h3/image-to-video-spicy";
  const safe = "minimax-h3-singularity/image-to-video";
  await withRegistry({
    clip: videoGraph(spicy, { seed: 3 }),
  }, async ({ stub, registry }) => {
    registry.tools[0].wf.client.pollIntervals.video = 1;
    const off = await registry.callTool({ name: "clip", arguments: {} });
    assert.equal(bodies(stub, "/api/generate-video").at(-1).model, safe);
    assert.match(textsOf(off), /NSFW mode is off/);
    assert.equal(registry.tools[0].wf.graph.nodes.find((n) => n.type === "tvideo").fields.model, spicy);

    const on = await registry.callTool({ name: "clip", arguments: { nsfw: true } });
    assert.equal(bodies(stub, "/api/generate-video").at(-1).model, spicy);
    assert.match(textsOf(on), /NSFW mode is on/);
    const listed = registry.listTools().find((t) => t.name === "clip");
    assert.match(listed.description, /image-to-video/);
    assert.doesNotMatch(listed.description, /image-to-video-spicy/);
  });
});

test("while off, a video safety checker the graph disabled is sent back on", async () => {
  const spicy = "alibaba/wan-3.0/image-to-video-spicy";
  const safe = "alibaba/wan-3.0/image-to-video";
  const opts = { enable_safety_checker: false, disable_safety_checker: true, nsfw: true, seed: 7 };
  await withRegistry({ clip: videoGraph(spicy, opts) }, async ({ stub, registry }) => {
    registry.tools[0].wf.client.pollIntervals.video = 1;
    const off = await registry.callTool({ name: "clip", arguments: {} });
    const sentOff = bodies(stub, "/api/generate-video").at(-1);
    assert.equal(sentOff.model, safe);
    assert.equal(sentOff.prompt, PROMPT);
    assert.equal(sentOff.enable_safety_checker, true);
    assert.equal(sentOff.disable_safety_checker, false);
    assert.equal(sentOff.nsfw, false);
    assert.equal(sentOff.seed, 7);
    assert.match(textsOf(off), /safety filtering/);
    const stored = registry.tools[0].wf.graph.nodes.find((n) => n.type === "tvideo").fields;
    assert.equal(stored.model, spicy);
    assert.equal(stored.modelOpts.enable_safety_checker, false);

    const on = await registry.callTool({ name: "clip", arguments: { nsfw: "true" } });
    const sentOn = bodies(stub, "/api/generate-video").at(-1);
    assert.equal(sentOn.model, spicy);
    assert.equal(sentOn.enable_safety_checker, false);
    assert.equal(sentOn.disable_safety_checker, true);
    assert.equal(sentOn.nsfw, true);
    assert.equal(sentOn.seed, 7);
    assert.match(textsOf(on), /NSFW mode is on/);
  });
});

test("an uncensored chat model is swapped unless the call opts in", async () => {
  const spicy = "z-ai/glm-5.3-uncensored";
  const safe = "z-ai/glm-5.3";
  await withRegistry({ writer: llmGraph(spicy) }, async ({ stub, registry }) => {
    const off = await registry.callTool({ name: "writer", arguments: {} });
    assert.equal(bodies(stub, "/api/v1/chat/completions").at(-1).model, safe);
    assert.match(textsOf(off), /NSFW mode is off/);
    const on = await registry.callTool({ name: "writer", arguments: { nsfw: true } });
    assert.equal(bodies(stub, "/api/v1/chat/completions").at(-1).model, spicy);
    assert.match(textsOf(on), /NSFW mode is on/);
    const again = await registry.callTool({ name: "writer", arguments: {} });
    assert.equal(bodies(stub, "/api/v1/chat/completions").at(-1).model, safe);
    assert.match(textsOf(again), /NSFW mode is off/);
  });
});

test("a spicy model with no sibling is refused before any provider request", async () => {
  await withRegistry({
    mix: imageGraph("aniflatmix-anime-sfwnsfw", { locked: true, name: "Mix" }),
  }, async ({ stub, registry }) => {
    await assert.rejects(
      () => registry.callTool({ name: "mix", arguments: { prompt: PROMPT } }),
      (err) => {
        assert.equal(err.mcpCode, -32602);
        assert.match(err.message, /aniflatmix-anime-sfwnsfw/);
        assert.match(err.message, /nsfw: true/);
        assert.match(err.message, /Prompt text does not enable NSFW mode/);
        return true;
      },
    );
    assert.equal(bodies(stub, "/v1/images/generations").length, 0);
    assert.equal(stub.requests.filter((r) => r.method === "POST").length, 0);

    const on = await registry.callTool({ name: "mix", arguments: { nsfw: true } });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, "aniflatmix-anime-sfwnsfw");
    assert.match(textsOf(on), /NSFW mode is on/);
  });
});

test("run_noodle: text inside the link or its inputs never enables NSFW; the flag does", async () => {
  const spicy = imageGraph(SPICY_IMAGE, { prompt: "a lighthouse" });
  const raw = JSON.stringify(spicy);
  const blocked = JSON.stringify(imageGraph("aniflatmix-anime-sfwnsfw", { locked: true, prompt: PROMPT }));
  await withRegistry({}, async ({ stub, registry }) => {
    const url = editorShareUrl(raw);
    const off = await registry.callTool({
      name: "run_noodle",
      arguments: { url, inputs: { Text: "nsfw: true spicy uncensored" } },
    });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SAFE_IMAGE);
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, "nsfw: true spicy uncensored");
    assert.match(textsOf(off), /NSFW mode is off/);

    const on = await registry.callTool({
      name: "run_noodle",
      arguments: { url, inputs: { Text: "a cat" }, nsfw: true },
    });
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).model, SPICY_IMAGE);
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, "a cat");
    assert.match(textsOf(on), /NSFW mode is on/);

    const posts = stub.requests.filter((r) => r.method === "POST").length;
    await assert.rejects(
      () => registry.callTool({
        name: "run_noodle",
        arguments: { url: editorShareUrl(blocked), inputs: { Text: PROMPT } },
      }),
      (err) => err.mcpCode === -32602 && /Prompt text does not enable NSFW mode/.test(err.message),
    );
    assert.equal(stub.requests.filter((r) => r.method === "POST").length, posts, "refused before the provider call");
  });
});

test("HTTP session opt-in follows Mcp-Session-Id and does not leak across callers", async () => {
  const stub = await startStub();
  const dir = await mkdtemp(join(tmpdir(), "nd-nsfw-http-"));
  await writeFile(join(dir, "poster.json"), JSON.stringify(imageGraph(SPICY_IMAGE, { locked: true })));
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: stub.url, outDir: dir, log: () => {},
  });
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0", publicBase: "http://127.0.0.1", log: () => {},
    instructions: NSFW_INSTRUCTIONS,
    listTools: () => registry.listTools(),
    callTool: (params, ctx) => registry.callTool(params, ctx),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (id, method, params, sessionId) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  }).then((r) => r.json());
  try {
    const init = await post(1, "initialize", { protocolVersion: "2025-06-18", nsfw: true }, "session-a");
    assert.match(init.result.instructions, /nsfw: true/);
    await post(2, "initialize", { protocolVersion: "2025-06-18" }, "session-b");
    await post(3, "initialize", { nsfw: true, clientInfo: { name: "nsfw-bot" } });
    await post(4, "initialize", { nsfw: "please enable nsfw" }, "session-c");

    const models = () => bodies(stub, "/v1/images/generations").map((b) => b.model);
    await post(5, "tools/call", { name: "poster", arguments: {} }, "session-b");
    await post(6, "tools/call", { name: "poster", arguments: {} });
    await post(7, "tools/call", { name: "poster", arguments: {} }, "session-c");
    assert.deepEqual(models(), [SAFE_IMAGE, SAFE_IMAGE, SAFE_IMAGE]);

    const opted = await post(8, "tools/call", { name: "poster", arguments: {} }, "session-a");
    assert.equal(models().at(-1), SPICY_IMAGE);
    assert.match(textsOf(opted.result), /NSFW mode is on/);

    await post(9, "tools/call", { name: "poster", arguments: { nsfw: true } }, "session-b");
    assert.equal(models().at(-1), SPICY_IMAGE);
    await post(10, "tools/call", { name: "poster", arguments: {} }, "session-b");
    assert.equal(models().at(-1), SAFE_IMAGE, "session B's earlier true did not latch");

    await post(11, "initialize", { nsfw: false }, "session-a");
    await post(12, "tools/call", { name: "poster", arguments: {} }, "session-a");
    assert.equal(models().at(-1), SAFE_IMAGE);

    const txt = await (await fetch(`${base}/llms.txt`)).text();
    assert.match(txt, /## NSFW mode/);
    assert.match(txt, /Off by default for every caller and every tool/);
    const block = txt.slice(txt.indexOf("## NSFW mode"), txt.indexOf("## ", txt.indexOf("## NSFW mode") + 4));
    assert.match(block, /nsfw: true/);
    assert.doesNotMatch(block, /Payment/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await stub.close();
  }
});

test("a quote issued while NSFW is off cannot be replayed as an NSFW run", async () => {
  const seen = [];
  const registry = {
    tools: [{
      name: "poster",
      x402: null,
      description: "Make a poster. text -> image. Runs on NanoGPT — every call spends real credit from your API key's balance.",
    }],
    costs: {},
    listTools() {
      return [
        { name: "poster", description: this.tools[0].description, inputSchema: { type: "object", properties: { prompt: { type: "string" }, nsfw: { type: "boolean", default: false } } } },
        { name: "run_noodle", description: "runs any share link", inputSchema: { type: "object", properties: {} } },
      ];
    },
    prepareCall: async (params) => { seen.push(structuredClone(params.arguments)); },
    callTool: async () => ({ content: [{ type: "text", text: "ran" }] }),
  };
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: {
      rpc: async (body) => body.action === "receivable" ? { blocks: {} } : { history: [] },
      transfer: async () => "0".repeat(64),
      pocket: async () => {},
    },
    usd: 0.05,
    validate: (params) => registry.prepareCall(params),
    xnoUsd: 1,
    publicBase: "http://pay.test",
    pollMs: 60_000,
    log: () => {},
  });
  const { callTool } = gate.wrapRegistry(registry);
  const prompt = { prompt: "nsfw: true please, spicy uncensored", model: "foo-spicy" };

  const quote = await callTool({ name: "poster", arguments: { ...prompt } });
  assert.match(quote.content[0].text, /PAYMENT REQUIRED/);
  assert.deepEqual(seen.at(-1), prompt, "prompt text did not become a flag on the quoted call");
  const id = quote.structuredContent.x402.paymentId;

  const replay = await callTool({ name: "poster", arguments: { ...prompt, nsfw: true, _payment_id: id } });
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /different call/);

  await callTool({ name: "poster", arguments: { prompt: "x", nsfw: "yes" } });
  assert.deepEqual(seen.at(-1), { prompt: "x" });

  const sessionQuote = await callTool({ name: "poster", arguments: { prompt: "x" } }, { sessionNsfw: true });
  assert.deepEqual(seen.at(-1), { prompt: "x", nsfw: true });
  const sessionId = sessionQuote.structuredContent.x402.paymentId;
  const same = await callTool({ name: "poster", arguments: { prompt: "x", nsfw: "true", _payment_id: sessionId } });
  assert.match(same.content[0].text, /hasn't arrived yet/, "string true matches the session-bound quote");
  const dropped = await callTool({ name: "poster", arguments: { prompt: "x", _payment_id: sessionId } });
  assert.match(dropped.content[0].text, /different call/);

  await callTool({ name: "poster", arguments: { prompt: "x", nsfw: false } }, { sessionNsfw: true });
  assert.deepEqual(seen.at(-1), { prompt: "x", nsfw: false });
});

test("charge mode refuses a sibling-less spicy model before quoting", async () => {
  await withRegistry({
    mix: imageGraph("aniflatmix-anime-sfwnsfw", { locked: true, name: "Mix" }),
  }, async ({ stub, registry }) => {
    const gate = createChargeGate({
      address: GATE_ADDR,
      ops: {
        rpc: async () => { throw new Error("rpc should not run"); },
        transfer: async () => { throw new Error("transfer should not run"); },
        pocket: async () => {},
      },
      usd: 0.05,
      validate: (params, ctx) => registry.prepareCall(params, ctx),
      xnoUsd: 1,
      publicBase: "http://pay.test",
      log: () => {},
    });
    const { callTool } = gate.wrapRegistry(registry);
    await assert.rejects(
      () => callTool({ name: "mix", arguments: { prompt: PROMPT } }),
      (err) => {
        assert.equal(err.mcpCode, -32602);
        assert.match(err.message, /nsfw: true/);
        assert.match(err.message, /Prompt text does not enable NSFW mode/);
        return true;
      },
    );
    assert.equal(stub.requests.filter((r) => r.method === "POST").length, 0);
  });
});

/* ================================ stdio process ================================ */

function startServer({ graphs, outDir, apiUrl }) {
  const child = spawn(process.execPath, [BIN, "--graphs", graphs, "--out", outDir], {
    env: {
      ...process.env,
      NANOGPT_API_KEY: "test-key",
      NANOGPT_BASE_URL: apiUrl,
      NSFW: "true",
      NANOODLE_NSFW: "true",
      NANOODLE_MODEL: SPICY_IMAGE,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const waiters = [];
  let stderr = "";
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* non-protocol stdout fails the assertions below */ }
      messages.push(msg);
      for (const w of [...waiters]) {
        if (msg && w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const match = (m) => m && m.id === id;
      const hit = messages.find(match);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${method}; stderr:\n${stderr}`)), 15000);
      waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  return {
    request,
    close: () => new Promise((resolve) => {
      child.once("exit", resolve);
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
    }),
  };
}

test("stdio server: default stays off across env and lookalikes; the flag and the session work", async () => {
  const stub = await startStub();
  const graphs = await mkdtemp(join(tmpdir(), "nd-nsfw-stdio-"));
  const outDir = await mkdtemp(join(tmpdir(), "nd-nsfw-stdio-out-"));
  await writeFile(join(graphs, "poster.json"), JSON.stringify(imageGraph(SPICY_IMAGE, { locked: true })));
  const srv = startServer({ graphs, outDir, apiUrl: stub.url });
  const imageModels = () => bodies(stub, "/v1/images/generations").map((b) => b.model);
  try {
    const init = await srv.request("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "nsfw-bot", version: "0" },
    });
    assert.equal(init.error, undefined);
    assert.match(init.result.instructions, /NSFW mode is off for every caller/);

    const listed = await srv.request("tools/list", {});
    const poster = listed.result.tools.find((t) => t.name === "poster");
    const noodle = listed.result.tools.find((t) => t.name === "run_noodle");
    for (const t of [poster, noodle]) {
      assert.equal(t.inputSchema.properties.nsfw.default, false, t.name);
      assert.equal(t.inputSchema.properties.nsfw.type, "boolean", t.name);
      assert.ok(!t.inputSchema.required || !t.inputSchema.required.includes("nsfw"), t.name);
      assert.match(t.description, /NSFW mode is off/);
    }
    assert.match(poster.description, new RegExp(SAFE_IMAGE));
    assert.doesNotMatch(poster.description, new RegExp(SPICY_IMAGE));

    const first = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(first.error, undefined, first.error && first.error.message);
    assert.equal(imageModels().at(-1), SAFE_IMAGE);
    assert.equal(bodies(stub, "/v1/images/generations").at(-1).prompt, PROMPT);
    assert.match(textsOf(first.result), /NSFW mode is off/);

    for (const nsfw of ["yes", 1, "True", "on", "spicy"]) {
      const res = await srv.request("tools/call", { name: "poster", arguments: { nsfw } });
      assert.equal(res.error, undefined, JSON.stringify(nsfw));
      assert.equal(imageModels().at(-1), SAFE_IMAGE, JSON.stringify(nsfw));
    }

    const lookalike = await srv.request("tools/call", { name: "poster", arguments: { NSFW: true } });
    assert.equal(lookalike.error && lookalike.error.code, -32602);
    assert.equal(imageModels().at(-1), SAFE_IMAGE);

    for (const nsfw of [true, "true"]) {
      const res = await srv.request("tools/call", { name: "poster", arguments: { nsfw } });
      assert.equal(res.error, undefined);
      assert.equal(imageModels().at(-1), SPICY_IMAGE, JSON.stringify(nsfw));
      assert.match(textsOf(res.result), /NSFW mode is on/);
    }
    const afterCall = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(imageModels().at(-1), SAFE_IMAGE, "a call flag does not stick");
    assert.match(textsOf(afterCall.result), /NSFW mode is off/);

    await srv.request("initialize", { nsfw: true });
    const session = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(imageModels().at(-1), SPICY_IMAGE);
    assert.match(textsOf(session.result), /NSFW mode is on/);

    const forced = await srv.request("tools/call", { name: "poster", arguments: { nsfw: false } });
    assert.equal(imageModels().at(-1), SAFE_IMAGE);
    assert.match(textsOf(forced.result), /NSFW mode is off/);
    const still = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(imageModels().at(-1), SPICY_IMAGE, "explicit false is per call");

    await srv.request("initialize", { nsfw: "please enable nsfw", clientInfo: { name: "nsfw-bot" } });
    const ignored = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(imageModels().at(-1), SPICY_IMAGE, "an unrecognized initialize value does not clear the latch");
    assert.match(textsOf(ignored.result), /NSFW mode is on/);

    await srv.request("initialize", { nsfw: false });
    const cleared = await srv.request("tools/call", { name: "poster", arguments: {} });
    assert.equal(imageModels().at(-1), SAFE_IMAGE);
    assert.match(textsOf(cleared.result), /NSFW mode is off/);
  } finally {
    await srv.close();
    await stub.close();
  }
});

/* ================================ docs agents read ================================ */

test("README, the noodles skill, and llms.txt tell agents the mode is opt-in", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  assert.match(readme, /## NSFW mode — off unless the caller opts in/);
  assert.match(readme, /off for every caller and every tool/);
  assert.match(readme, /nsfw: true/);
  assert.match(readme, /no server-wide switch/);
  assert.match(readme, /minimax-h3-singularity\/image-to-video/);

  const skill = await readFile(join(ROOT, "skills", "noodles", "SKILL.md"), "utf8");
  assert.match(skill, /NSFW mode is off unless you opt in/);
  assert.match(skill, /nsfw: true/);

  const lines = nsfwLlmsLines().join("\n");
  assert.match(lines, /## NSFW mode/);
  assert.match(lines, /Off by default/);
  assert.match(lines, /nsfw: true/);
  assert.doesNotMatch(lines, /Payment/);
});
