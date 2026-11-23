// Built-in safe-for-work checks and MCP retirement of subnano_comment.
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
import { SETTLE_MARKUP, SFW_MODEL, SFW_INSTRUCTIONS, sfwChargeUsd, settledCharge } from "../src/subnano.mjs";

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

test("safe-for-work pricing uses a positive catalog input rate", () => {
  const baseline = sfwChargeUsd({ images: 1 });
  const price = prompt => sfwChargeUsd({ images: 1 }, { chat: [{ id: SFW_MODEL, pricing: { prompt, completion: 0 } }] });
  assert.equal(price(0), baseline);
  assert.ok(price(1) > baseline);
});

test("empty graphs stay empty and graph names cannot claim built-in or retired tool names", async () => {
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
    assert.ok(!names.includes("subnano_comment"));
    assert.equal(reg.tools.find((t) => t.name === "sfw_check").builtin, true);
    assert.ok(names.includes("subnano_comment-2") && names.includes("sfw_check-2"));
    assert.equal(reg.tools.find((t) => t.name === "subnano_comment-2").builtin, undefined);
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(named, { recursive: true, force: true });
  }
});

test("sfw_check rejects invalid inputs before any request", async () => {
  const { dir, registry } = await loadHumanize();
  let hits = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { hits++; return new Response("no", { status: 500 }); };
  try {
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

test("repeated builtin calls replace the last-run cost instead of concatenating it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-cost-"));
  await writeFile(join(dir, "hello.json"), TINY);
  let cost = 0.0011;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.9 } }, usage: { cost } }));
    });
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  const sfw = registry.tools.find((t) => t.name === "sfw_check");
  sfw.deps.fit = async (url) => url;
  const call = () => registry.callTool({ name: "sfw_check", arguments: { image: "data:image/jpeg;base64,OK" } });
  const desc = () => registry.tools.find((t) => t.name === "sfw_check").description;
  try {
    await call();
    assert.match(desc(), /; last run \$0\.0011\.$/);
    assert.equal(desc().match(/last run/g).length, 1);
    cost = 0.0026;
    await call();
    assert.match(desc(), /; last run \$0\.0026\.$/);
    assert.equal(desc().match(/last run/g).length, 1);
    assert.doesNotMatch(desc(), /0\.0011/);
    assert.doesNotMatch(desc(), /\$0\.0011\.0026|\$0\.0026\.0011/);
    // A duration and an inexact marker also have to come off in one piece.
    sfw.description = desc().replace("; last run $0.0026.", "; last run $0.0234+, ~2m 10s.");
    cost = 0.0011;
    await call();
    assert.match(desc(), /; last run \$0\.0011\.$/);
    assert.equal(desc().match(/last run/g).length, 1);
    assert.doesNotMatch(desc(), /0\.0234|2m 10s/);
    sfw.description = desc().replace("; last run $0.0011.", "; last run <$0.0001, ~15s.");
    cost = 0.0026;
    await call();
    assert.match(desc(), /; last run \$0\.0026\.$/);
    assert.doesNotMatch(desc(), /<\$0\.0001|~15s/);
    assert.match(sfw.costKey, /^builtin:v2:sfw_check:/);
    await writeFile(join(dir, "sfw_check.json"), TINY);
    const reopened = await loadTools({ dirs: [dir], baseUrl: `http://127.0.0.1:${port}/`, outDir: join(dir, "out"), log: () => {} });
    assert.equal(reopened.costs.sfw_check.usd, 0.0026);
    assert.equal(reopened.costs["sfw_check-2"], undefined);
    const otherProvider = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    assert.equal(otherProvider.costs.sfw_check, undefined);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the charge gate refuses the retired tool and quotes the remaining tools", async () => {
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
    await assert.rejects(
      wrapped.callTool({ name: "subnano_comment", arguments: { Draft: "d", Context: "c" } }),
      (error) => error.mcpCode === -32602 && /unknown tool "subnano_comment"/.test(error.message),
    );
    assert.ok(!wrapped.listTools().some((tool) => tool.name === "subnano_comment"));
    const args = { image: "data:image/jpeg;base64,OK" };
    const sfw = await wrapped.callTool({ name: "sfw_check", arguments: args });
    assert.equal(sfw.structuredContent.x402.amountUsd, reg.quoteDeposit("sfw_check", args));
    const poster = await wrapped.callTool({ name: "poster", arguments: {} });
    assert.match(poster.content[0].text, /\$0\.05 deposit/);
    const posterListed = wrapped.listTools().find((t) => t.name === "poster");
    assert.match(posterListed.description, /\$0\.05 deposit per call/);
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
    assert.doesNotMatch(html, /subnano_comment/);
    assert.doesNotMatch(txt, /graph\/sfw_check\.json/);
    assert.doesNotMatch(txt, /subnano_comment/);
    assert.equal((await fetch(base + "/graph/sfw_check.json")).status, 404);
    assert.equal((await fetch(base + "/graph/humanize-comment.json")).status, 200);
    assert.equal(toolsNeedingFfmpeg(registry.tools).includes("sfw_check"), true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sfw_check skips a picture the remaining budget cannot cover and never charges above the quote", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subnano-sfw-budget-"));
  await writeFile(join(dir, "hello.json"), TINY);
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      calls++;
      const cost = calls === 1 ? 5 : 0.000002;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.9 } }, usage: { cost } }));
    });
  });
  const port = await listen(server);
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  const sfw = registry.tools.find((t) => t.name === "sfw_check");
  sfw.deps.fit = async (url) => url;
  sfw.deps.sampleFrames = async (_src, count) => Array.from({ length: count }, () => "data:image/jpeg;base64,OK");
  try {
    const oneArgs = { image: "data:image/jpeg;base64,OK" };
    const oneQuote = registry.quoteDeposit("sfw_check", oneArgs);
    const image = await registry.callTool({ name: "sfw_check", arguments: oneArgs });
    const imagePayload = JSON.parse(image.content[0].text);
    assert.equal(imagePayload.sfw, true);
    assert.equal(imagePayload.partial, undefined);
    assert.equal(calls, 1);
    assert.ok(image.costUsd <= oneQuote / SETTLE_MARKUP + 1e-12);
    assert.ok(settledCharge(image.costUsd, oneQuote) <= oneQuote + 1e-12);

    calls = 0;
    const videoArgs = { video: "https://example.com/clip.mp4", frames: 3 };
    const videoQuote = registry.quoteDeposit("sfw_check", videoArgs);
    const video = await registry.callTool({ name: "sfw_check", arguments: videoArgs });
    const videoPayload = JSON.parse(video.content[0].text);
    assert.equal(videoPayload.partial, true);
    assert.equal(videoPayload.stopped, "picture");
    assert.equal(videoPayload.sfw, false);
    assert.equal(videoPayload.verdict, "unchecked");
    assert.equal(videoPayload.frames.length, 1);
    assert.equal(calls, 1, "the next frame is not sent once the budget is spent");
    assert.ok(video.costUsd <= videoQuote / SETTLE_MARKUP + 1e-12);
    assert.ok(settledCharge(video.costUsd, videoQuote) <= videoQuote + 1e-12);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
