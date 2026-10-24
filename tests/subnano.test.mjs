/**
 * subnano_comment and sfw_check: pricing locks, the paid pipeline, and the
 * per-request x402 deposit. No live NanoGPT calls — chat and decisions are
 * stubbed, and video frames are injected so ffmpeg is not required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { serveHttp } from "../src/http.mjs";
import { toolsNeedingFfmpeg } from "../src/ffmpeg-check.mjs";
import {
  HUMANIZE_V27_CAP_CHARGE, DEPOSIT_MARGIN, SETTLE_MARKUP,
  REFINE_MODEL, REFINE_SYSTEM, REFINE_TEMPERATURE, REFINE_MAX_TOKENS,
  D1_MODEL, SFW_MODEL, SFW_INSTRUCTIONS, GATE_INSTRUCTIONS, FUNNY_INSTRUCTIONS, FUNNY_LEVELS,
  GUIDANCE_DEFAULT, depositFromCharge, humanizeProviderUsd, subnanoChargeUsd, sfwChargeUsd,
  exactUsd,
} from "../src/subnano.mjs";
import { HUMANIZE_INPUT_CAPS } from "../src/humanize.mjs";

const GRAPH_URL = new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url);
const TINY = JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } },
    { id: "n2", type: "llm", x: 0, y: 0, fields: { model: "m" } },
  ],
  links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
});

async function loadHumanize() {
  const dir = await mkdtemp(join(tmpdir(), "subnano-"));
  await copyFile(GRAPH_URL, join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), log: () => {} });
  return { dir, registry, graph: registry.tools.find((t) => t.name === "humanize-comment").wf.graph };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("humanize portion of the ceiling matches the published v2.7 charge, and the deposit is that charge plus 12%", async () => {
  const { dir, registry, graph } = await loadHumanize();
  try {
    const caps = HUMANIZE_INPUT_CAPS;
    const provider = humanizeProviderUsd(graph, {
      draftChars: caps.Draft, contextChars: caps.Context, guidanceChars: caps.Guidance,
    });
    assert.equal((provider * SETTLE_MARKUP).toFixed(8), "0.01304480");
    assert.equal(HUMANIZE_V27_CAP_CHARGE.toFixed(8), "0.01304480");

    const full = subnanoChargeUsd({
      graph, draftChars: caps.Draft, contextChars: caps.Context, guidanceChars: caps.Guidance,
    });
    assert.ok(full > provider * SETTLE_MARKUP, "refine and the two d1 calls sit on top of humanize");
    const deposit = depositFromCharge(full);
    assert.equal(deposit, Math.ceil(full * (1 + DEPOSIT_MARGIN) * 1e8 - 1e-6) / 1e8);
    assert.ok(deposit >= full);
    assert.ok(deposit <= full * (1 + DEPOSIT_MARGIN) + 1e-8);
    // no $0.001 floor — the margin itself is the slack
    assert.ok(deposit - full < full * DEPOSIT_MARGIN + 1e-8);

    const tool = registry.tools.find((t) => t.name === "subnano_comment");
    assert.equal(full.toFixed(8), "0.01359361");
    assert.equal(deposit.toFixed(8), "0.01522485");
    assert.equal(tool.x402.usd, deposit, "the pinned cold ceiling is the full-cap deposit");
    const typicalCharge = subnanoChargeUsd({
      graph, draftChars: 240, contextChars: 480, guidanceChars: GUIDANCE_DEFAULT.length,
    });
    assert.equal(typicalCharge.toFixed(8), "0.01137790");
    assert.equal(depositFromCharge(typicalCharge).toFixed(8), "0.01274326");
    const quoted = registry.quoteDeposit("subnano_comment", {
      Draft: "d".repeat(caps.Draft),
      Context: "c".repeat(caps.Context),
      Guidance: "g".repeat(caps.Guidance),
    });
    assert.equal(quoted, deposit);

    const shorter = registry.quoteDeposit("subnano_comment", {
      Draft: "Nice work on the launch.",
      Context: "We shipped the editor today.",
    });
    assert.ok(shorter < deposit, "a shorter context quotes a smaller deposit");
    assert.ok(shorter > provider * SETTLE_MARKUP * 0.5, "the humanize leg still assumes the draft cap");

    const one = sfwChargeUsd({ images: 1, frames: 0 });
    const five = sfwChargeUsd({ images: 0, frames: 5 });
    const cold = sfwChargeUsd({ images: 1, frames: 8 });
    assert.ok(one < five && five < cold);
    const sfw = registry.tools.find((t) => t.name === "sfw_check");
    assert.equal(one.toFixed(8), "0.00002902");
    assert.equal(depositFromCharge(one).toFixed(8), "0.00003250");
    assert.equal(five.toFixed(8), "0.00014508");
    assert.equal(depositFromCharge(five).toFixed(8), "0.00016249");
    assert.equal(cold.toFixed(8), "0.00026114");
    assert.equal(sfw.x402.usd, depositFromCharge(cold));
    assert.equal(sfw.x402.usd.toFixed(8), "0.00029249");
    assert.ok(sfw.x402.usd < 0.001, "the vision deposit stays under a tenth of a cent — no $0.001 floor");
    assert.equal(registry.quoteDeposit("sfw_check", { image: "https://example.com/a.jpg" }), depositFromCharge(one));
    assert.equal(registry.quoteDeposit("sfw_check", { video: "https://example.com/a.mp4" }), depositFromCharge(five));
    assert.equal(registry.quoteDeposit("sfw_check", { video: "https://example.com/a.mp4", frames: 2, image: "https://example.com/a.jpg" }), depositFromCharge(sfwChargeUsd({ images: 1, frames: 2 })));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a higher catalog rate replaces the fallback and a decision row may have a $0 completion price", async () => {
  const { dir, graph } = await loadHumanize();
  try {
    const base = subnanoChargeUsd({
      graph, draftChars: 200, contextChars: 400, guidanceChars: GUIDANCE_DEFAULT.length,
    });
    const higher = subnanoChargeUsd({
      graph, draftChars: 200, contextChars: 400, guidanceChars: GUIDANCE_DEFAULT.length,
      catalogs: { chat: [{ id: REFINE_MODEL, pricing: { prompt: 1, completion: 1 } }] },
    });
    assert.ok(higher > base);
    const d1 = subnanoChargeUsd({
      graph, draftChars: 200, contextChars: 400, guidanceChars: GUIDANCE_DEFAULT.length,
      catalogs: { chat: [{ id: D1_MODEL, pricing: { prompt: 1, completion: 0 } }] },
    });
    assert.ok(d1 > base, "liquid/d1's catalog prompt price is used even though completion is 0");
    const ignored = sfwChargeUsd({ images: 1 }, { chat: [{ id: SFW_MODEL, pricing: { prompt: 0, completion: 0 } }] });
    assert.equal(ignored, sfwChargeUsd({ images: 1 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty --graphs does not invent the built-ins, and a graph cannot take their names", async () => {
  const empty = await mkdtemp(join(tmpdir(), "subnano-empty-"));
  const named = await mkdtemp(join(tmpdir(), "subnano-named-"));
  try {
    const none = await loadTools({ dirs: [empty], apiKey: "test-key", outDir: join(empty, "out"), log: () => {} });
    assert.deepEqual(none.tools, []);
    await writeFile(join(named, "subnano_comment.json"), TINY);
    await writeFile(join(named, "sfw_check.json"), TINY);
    await writeFile(join(named, "hello.json"), TINY);
    const reg = await loadTools({ dirs: [named], apiKey: "test-key", outDir: join(named, "out"), log: () => {} });
    const names = reg.tools.map((t) => t.name).sort();
    assert.ok(names.includes("subnano_comment") && names.includes("sfw_check"));
    assert.ok(names.includes("subnano_comment-2") && names.includes("sfw_check-2"));
    assert.equal(reg.tools.find((t) => t.name === "subnano_comment").builtin, true);
    assert.equal(reg.tools.find((t) => t.name === "subnano_comment-2").builtin, undefined);
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(named, { recursive: true, force: true });
  }
});

test("over-cap, missing humanize, and nsfw are refused before any request", async () => {
  const { dir, registry } = await loadHumanize();
  const bare = await mkdtemp(join(tmpdir(), "subnano-bare-"));
  let hits = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { hits++; return new Response("no", { status: 500 }); };
  try {
    await assert.rejects(
      registry.prepareCall({ name: "subnano_comment", arguments: { Draft: "x".repeat(1501), Context: "c" } }),
      (e) => e.mcpCode === -32602 && /subnano_comment accepts at most 1500/.test(e.message) && /nothing was charged/i.test(e.message),
    );
    await assert.rejects(
      registry.prepareCall({ name: "subnano_comment", arguments: { Draft: "d", Context: "c", nsfw: true } }),
      /no NSFW switch/,
    );
    await writeFile(join(bare, "hello.json"), TINY);
    const bareReg = await loadTools({ dirs: [bare], apiKey: "test-key", outDir: join(bare, "out"), log: () => {} });
    await assert.rejects(
      bareReg.prepareCall({ name: "subnano_comment", arguments: { Draft: "d", Context: "c" } }),
      /needs the humanize-comment graph mounted/,
    );
    await assert.rejects(
      registry.prepareCall({ name: "sfw_check", arguments: { nsfw: false } }),
      /cannot be turned off/,
    );
    await assert.rejects(
      registry.prepareCall({ name: "sfw_check", arguments: {} }),
      /needs an image, a video, or both/,
    );
    await assert.rejects(
      registry.prepareCall({ name: "sfw_check", arguments: { video: "https://example.com/a.mp4", frames: 9 } }),
      /frames must be an integer from 1 to 8/,
    );
    await assert.rejects(
      registry.prepareCall({ name: "sfw_check", arguments: { image: join(dir, "missing.jpg") } }),
      /file was not found/,
    );
    assert.equal(hits, 0);
  } finally {
    globalThis.fetch = prev;
    await rm(dir, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("subnano_comment runs refine, then humanize, then the gate, then the funny score", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-run-"));
  await copyFile(GRAPH_URL, join(dir, "humanize-comment.noodle-graph.json"));
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url, model: body.model, body });
      if (req.url.startsWith("/api/v1/decisions")) {
        const q = body.questions && body.questions.answer;
        const usage = { cost: q && q.type === "score" ? 0.00004 : 0.00003 };
        const answer = q && q.type === "score"
          ? { type: "score", score: 4, probabilities: { "0": 0.1, "4": 0.7, "9": 0.2 } }
          : { type: "noul", noul: 0.82 };
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ answers: { answer }, usage }));
      }
      let content = "That launch note is the one I would reply to.";
      let cost = 0.001;
      if (body.model === REFINE_MODEL) { content = "The launch post is worth a close look."; cost = 0.0002; }
      if (body.model === "z-ai/glm-5.3") {
        cost = 0.002;
        content = JSON.stringify({
          winner: "A",
          text: "decider copy, discarded",
          why: "specific",
          ranked: ["A", "B", "C", "D", "E"].map((writer) => ({ writer, faithful: true, disqualified: false, reason: "ok" })),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], cost }));
    });
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  try {
    const result = await registry.callTool({
      name: "subnano_comment",
      arguments: { Draft: "Please welcome the launch.", Context: "The editor shipped today.", Guidance: "keep it short" },
    });
    assert.equal(result.textOutput, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.comment, "That launch note is the one I would reply to.");
    assert.deepEqual(payload.gate, { verdict: "yes", yes: 0.82 });
    assert.equal(payload.funny.score, 4);
    assert.equal(payload.funny.max, 9);
    assert.equal(payload.funny.label, FUNNY_LEVELS[4]);
    assert.equal(payload.steps.refine.model, REFINE_MODEL);
    assert.equal(payload.steps.refine.usd, 0.0002);
    assert.equal(payload.steps.humanize.usd, 0.007);
    assert.equal(payload.steps.gate.usd, 0.00003);
    assert.equal(payload.steps.funny.usd, 0.00004);
    assert.equal(result.costUsd, 0.0002 + 0.007 + 0.00003 + 0.00004);
    assert.equal(result.costExact, true);
    assert.match(result.content[1].text, /^cost: \$0\.0073/);

    assert.equal(seen[0].model, REFINE_MODEL);
    assert.equal(seen[0].body.temperature, REFINE_TEMPERATURE);
    assert.equal(seen[0].body.max_tokens, REFINE_MAX_TOKENS);
    assert.equal(seen[0].body.messages[0].content, REFINE_SYSTEM);
    assert.match(seen[0].body.messages[1].content, /Please welcome the launch\./);
    const firstDecision = seen.findIndex((r) => r.path.startsWith("/api/v1/decisions"));
    assert.ok(firstDecision > 1);
    assert.ok(seen.slice(0, firstDecision).every((r) => r.path.startsWith("/api/v1/chat")));
    assert.ok(seen.slice(0, firstDecision).some((r) => r.model === "z-ai/glm-5.3"));
    const refineAt = seen.findIndex((r) => r.model === REFINE_MODEL);
    const judgeAt = seen.findIndex((r) => r.model === "z-ai/glm-5.3");
    assert.ok(refineAt < judgeAt && judgeAt < firstDecision);
    assert.equal(seen[firstDecision].body.questions.answer.type, "noul");
    assert.equal(seen[firstDecision].body.questions.answer.instructions, GATE_INSTRUCTIONS);
    assert.match(seen[firstDecision].body.state, /That launch note is the one I would reply to\./);
    assert.equal(seen[firstDecision + 1].body.questions.answer.type, "score");
    assert.equal(seen[firstDecision + 1].body.questions.answer.instructions, FUNNY_INSTRUCTIONS);
    assert.deepEqual(seen[firstDecision + 1].body.questions.answer.criteria, [...FUNNY_LEVELS]);
    // humanize saw the refine output, not the original draft
    const writer = seen.find((r) => r.model === "qwen/qwen3.8-27b-novelist");
    assert.match(JSON.stringify(writer.body.messages), /The launch post is worth a close look\./);
    assert.doesNotMatch(JSON.stringify(writer.body.messages), /Please welcome the launch\./);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a no from the gate still returns the comment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-no-"));
  await copyFile(GRAPH_URL, join(dir, "humanize-comment.noodle-graph.json"));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url.startsWith("/api/v1/decisions")) {
        const score = body.questions.answer.type === "score";
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          answers: { answer: score ? { type: "score", score: 0 } : { type: "noul", noul: 0.2 } },
          usage: { cost: 0.00001 },
        }));
      }
      const content = body.model === "z-ai/glm-5.3"
        ? JSON.stringify({ winner: "A", text: "x", why: "y", ranked: ["A", "B", "C", "D", "E"].map((writer) => ({ writer, faithful: true, disqualified: false, reason: "ok" })) })
        : "A reply with its own wording here.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], cost: 0.0001 }));
    });
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  try {
    const result = await registry.callTool({
      name: "subnano_comment",
      arguments: { Draft: "Hello there friend.", Context: "A post about shipping." },
    });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.gate.verdict, "no");
    assert.equal(payload.gate.yes, 0.2);
    assert.equal(payload.comment, "A reply with its own wording here.");
    assert.equal(payload.funny.score, 0);
    assert.equal(payload.funny.label, FUNNY_LEVELS[0]);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sfw_check judges the image and every sampled frame, and fails closed only when one is no", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-sfw-"));
  await writeFile(join(dir, "hello.json"), TINY);
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      const url = JSON.stringify(body.state);
      const noul = url.includes("BAD") ? 0.1 : 0.9;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { answer: { type: "noul", noul } }, usage: { cost: 0.000002 } }));
    });
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  const sfw = registry.tools.find((t) => t.name === "sfw_check");
  sfw.deps.fit = async (url) => url;
  sfw.deps.sampleFrames = async (_src, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,${i === 1 ? "BAD" : "OK"}`);
  try {
    const image = await registry.callTool({
      name: "sfw_check",
      arguments: { image: "data:image/jpeg;base64,OK" },
    });
    const imagePayload = JSON.parse(image.content[0].text);
    assert.equal(imagePayload.sfw, true);
    assert.equal(imagePayload.frames.length, 1);
    assert.equal(imagePayload.frames[0].verdict, "yes");
    assert.equal(seen[0].model, SFW_MODEL);
    assert.equal(seen[0].questions.answer.instructions, SFW_INSTRUCTIONS);
    assert.equal(seen.length, 1);

    seen.length = 0;
    const video = await registry.callTool({
      name: "sfw_check",
      arguments: { video: "https://example.com/clip.mp4", frames: 3 },
    });
    const videoPayload = JSON.parse(video.content[0].text);
    assert.equal(videoPayload.sfw, false);
    assert.equal(videoPayload.verdict, "no");
    assert.equal(videoPayload.frames.length, 3);
    assert.deepEqual(videoPayload.frames.map((f) => f.verdict), ["yes", "no", "yes"]);
    assert.equal(seen.length, 3, "a no frame does not skip the frames the quote already paid for");
    assert.ok(videoPayload.frames.every((f) => typeof f.usd === "number"));
    assert.equal(video.costUsd, 0.000006);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the charge gate quotes the per-request deposit exactly and leaves a pinned graph on its own price", async () => {
  const { dir, registry } = await loadHumanize();
  await writeFile(join(dir, "poster.json"), TINY);
  // reload so poster is a tool; humanize stays mounted
  const reg = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), log: () => {} });
  const gate = createChargeGate({
    address: "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet",
    ops: {
      rpc: async (body) => body.action === "account_history" ? { history: [] } : { blocks: {} },
      transfer: async () => "F".repeat(64),
      pocket: async () => {},
    },
    usd: 0.05,
    validate: (p) => reg.prepareCall(p),
    xnoUsd: 1,
    publicBase: "http://pay.test",
    pollMs: 60_000,
    log: () => {},
  });
  const wrapped = gate.wrapRegistry(reg);
  try {
    const args = { Draft: "Nice work on the launch.", Context: "We shipped the editor today." };
    const quoted = reg.quoteDeposit("subnano_comment", args);
    const pay = await wrapped.callTool({ name: "subnano_comment", arguments: args });
    const x402 = pay.structuredContent.x402;
    assert.equal(x402.amountUsd, quoted);
    assert.match(pay.content[0].text, new RegExp(exactUsd(quoted).replace(/[$.]/g, "\\$&")));
    assert.doesNotMatch(pay.content[0].text, /\$0\.01 deposit/);
    const listed = wrapped.listTools().find((t) => t.name === "subnano_comment");
    assert.match(listed.description, /quoted for each request from its context and guidance/);
    assert.doesNotMatch(listed.description, /\$0\.\d+ deposit per call/);
    const poster = await wrapped.callTool({ name: "poster", arguments: {} });
    assert.match(poster.content[0].text, /\$0\.05 deposit/);
    const posterListed = wrapped.listTools().find((t) => t.name === "poster");
    assert.match(posterListed.description, /\$0\.05 deposit per call/);
    await assert.rejects(
      wrapped.callTool({ name: "subnano_comment", arguments: { Draft: "d", Context: "c", nsfw: "yes" } }),
      /no NSFW switch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("landing and llms.txt do not invent a graph link for a built-in", async () => {
  const { dir, registry } = await loadHumanize();
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0", publicBase: "http://pay.test", log: () => {},
    listTools: () => registry.listTools(),
    callTool: async () => { throw new Error("no run"); },
    toolInfo: registry.tools,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base + "/")).text();
    const txt = await (await fetch(base + "/llms.txt")).text();
    assert.doesNotMatch(html, /href="undefined"/);
    assert.doesNotMatch(html, /graph\/subnano_comment\.json/);
    assert.doesNotMatch(html, /graph\/sfw_check\.json/);
    assert.match(html, /graph\/humanize-comment\.json/);
    assert.match(html, /subnano_comment/);
    assert.doesNotMatch(txt, /graph\/sfw_check\.json/);
    assert.match(txt, /subnano_comment/);
    assert.equal((await fetch(base + "/graph/sfw_check.json")).status, 404);
    assert.equal((await fetch(base + "/graph/humanize-comment.json")).status, 200);
    assert.equal(toolsNeedingFfmpeg(registry.tools).includes("sfw_check"), true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed step throws so the caller is not charged for a partial comment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-fail-"));
  await copyFile(GRAPH_URL, join(dir, "humanize-comment.noodle-graph.json"));
  const server = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  try {
    await assert.rejects(
      registry.callTool({ name: "subnano_comment", arguments: { Draft: "Hello there.", Context: "A post." } }),
      /refine failed/,
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
