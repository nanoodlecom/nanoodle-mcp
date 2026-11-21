/**
 * Custom workflows on a free server: run_noodle takes an inline `graph`,
 * price_noodle prices it without running, noodle_guide explains how to write
 * one. The Nano charge gate withdraws the two helpers along with run_noodle.
 * Offline: NanoGPT is a mocked fetch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadTools, editorShareUrl, noodleGuide } from "../src/tools.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { WORKED_GRAPH, nanoGptMock } from "./fixtures/near-fake-chain.mjs";

let realFetch, mock, registry, outDir;

before(async () => {
  realFetch = globalThis.fetch;
  mock = nanoGptMock();
  globalThis.fetch = mock.fetch;
  const graphs = await mkdtemp(join(tmpdir(), "rn-graph-"));
  outDir = await mkdtemp(join(tmpdir(), "rn-graph-out-"));
  await writeFile(join(graphs, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
  registry = await loadTools({ dirs: [graphs], apiKey: "test-key", outDir, log: () => {} });
});
after(() => { globalThis.fetch = realFetch; });

const text = (r) => r.content.map((c) => c.text || "").join("\n");

test("a local model file drives both the sprite preview and turntable MP4", async () => {
  const inputs = { Character: fileURLToPath(new URL("./fixtures/triangle.gltf", import.meta.url)) };
  const graph = {
    v: 1,
    nodes: [
      { id: "source", type: "mupload", name: "Character", fields: {} },
      { id: "slice", type: "slice-3d", fields: { resolution: 16, slices: 8 } },
      { id: "view", type: "sprite-stack-render", name: "View", fields: { scale: 1, turntable: true, duration: 0.25, fps: 8 } },
    ],
    links: [
      { id: "model", from: { node: "source", port: "model" }, to: { node: "slice", port: "model" } },
      { id: "layers", from: { node: "slice", port: "sheet" }, to: { node: "view", port: "sheet" } },
    ],
  };
  const result = await registry.callTool({ name: "run_noodle", arguments: { graph, inputs } });
  assert.match(text(result), /^View: saved .*\.png$/m);
  const video = text(result).match(/^View\.video: saved (.*\.mp4)$/m);
  assert.ok(video, text(result));
  assert.equal((await readFile(video[1])).toString("ascii", 4, 8), "ftyp");
});

test("free mode: run_noodle runs an inline graph object (and the same graph as a JSON string)", async () => {
  const runs = mock.runs();
  const r = await registry.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dawn" } } });
  assert.ok(!r.isError);
  const saved = r.content.find((c) => /saved /.test(c.text || ""));
  assert.ok(saved && saved.text.endsWith(".png"), JSON.stringify(r.content));
  assert.equal(r.costUsd, 0.00941);
  const again = await registry.callTool({ name: "run_noodle", arguments: { graph: JSON.stringify(WORKED_GRAPH), inputs: { Idea: "x" } } });
  assert.ok(again.content.some((c) => /saved /.test(c.text || "")));
  assert.equal(mock.runs(), runs + 2);
});

test("run_noodle: url and graph together, or neither, are invalid params (-32602)", async () => {
  const url = editorShareUrl(JSON.stringify(WORKED_GRAPH));
  await assert.rejects(registry.callTool({ name: "run_noodle", arguments: { url, graph: WORKED_GRAPH } }), (e) => e.mcpCode === -32602);
  await assert.rejects(registry.callTool({ name: "run_noodle", arguments: {} }), (e) => e.mcpCode === -32602);
  await assert.rejects(registry.callTool({ name: "run_noodle", arguments: { graph: "{not json" } }), (e) => e.mcpCode === -32602);
  await assert.rejects(registry.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Nope: "x" } } }), (e) => e.mcpCode === -32602);
});

test("price_noodle: itemized pricing in the fixed vocabulary, nothing runs", async () => {
  const runs = mock.runs();
  const r = await registry.callTool({ name: "price_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dawn" } } });
  assert.ok(!r.isError);
  const p = r.structuredContent.pricing;
  assert.equal(p.currency, "USD");
  assert.equal(p.estimatedCost.usd, "0.00962");
  assert.deepEqual(p.estimatedCost.items.map((i) => [i.nodeId, i.model, i.usd]), [
    ["n2", "z-ai/glm-5.3-flash", "0.000622"],
    ["n3", "blackforestlabs/flux-3/klein/text-to-image", "0.009"],
  ]);
  assert.equal(p.serviceFee.rate, "0.2");
  assert.equal(p.serviceFee.appliesTo, "actual model cost");
  assert.equal(p.likelyCharge.usd, "0.0115");
  assert.equal(p.deposit.usd, "0.03");
  assert.equal(p.deposit.headroom, "2");
  assert.equal(p.refund.likelyUsd, "0.0185");
  assert.equal(p.safety.ok, true);
  assert.match(p.summary, /^You will most likely pay about \$0\.0115: the estimated cost plus a 20% service fee\./);
  for (const term of ["Estimated cost", "Service fee", "Deposit", "Refund"]) assert.match(text(r), new RegExp(term));
  assert.match(r.structuredContent.note, /free to call/);
  assert.equal(mock.runs(), runs, "pricing never runs the graph");
});

test("price_noodle reports problems instead of failing: unsafe nodes, unknown inputs, unreadable graphs", async () => {
  const unsafe = await registry.callTool({ name: "price_noodle", arguments: { graph: {
    nodes: [{ id: "e", type: "endpoint", fields: { url: "http://10.0.0.1/x" } }, { id: "l", type: "llm", fields: { model: "nope/model" } }], links: [],
  } } });
  assert.ok(!unsafe.isError);
  const s = unsafe.structuredContent.pricing;
  assert.equal(s.safety.ok, false);
  assert.ok(s.safety.refusals.some((x) => x.code === "NODE_NOT_ALLOWED"));
  assert.deepEqual(s.unpriced.map((u) => u.model), ["nope/model"]);

  const badInput = await registry.callTool({ name: "price_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Nope: "x" } } });
  assert.ok(badInput.structuredContent.pricing.safety.refusals.some((x) => x.code === "BAD_INPUTS"));

  const unreadable = await registry.callTool({ name: "price_noodle", arguments: { url: "https://nanoodle.com/#g=!!!" } });
  assert.ok(!unreadable.isError);
  assert.equal(unreadable.structuredContent.pricing, null);
  assert.equal(unreadable.structuredContent.safety.ok, false);
});

test("noodle_guide lists the allowed node types, the wiring rules, an example and priced models", async () => {
  const r = await registry.callTool({ name: "noodle_guide", arguments: { kind: "chat" } });
  const g = r.structuredContent;
  const allowed = g.nodeTypes.filter((t) => t.allowed).map((t) => t.type);
  for (const t of ["text", "llm", "image", "tvideo", "tts"]) assert.ok(allowed.includes(t), t);
  for (const t of ["upload", "endpoint", "resize"]) assert.ok(!allowed.includes(t), t);
  assert.ok(g.wiringRules.length >= 5);
  assert.deepEqual(g.example.nodes.map((n) => n.type), ["text", "llm", "image"]);
  assert.deepEqual(g.models.map((m) => m.id), ["z-ai/glm-5.3-flash"]);
  assert.match(text(r), /price_noodle/);
  await assert.rejects(registry.callTool({ name: "noodle_guide", arguments: { kind: "nope" } }), (e) => e.mcpCode === -32602);
});

test("noodle_guide format-only reads no model catalog; node type fetches only its catalog", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push(url);
    return mock.fetch(url, options);
  };
  const options = { fetch, baseUrl: "https://guide-fixture.example" };
  const format = await noodleGuide({ format_only: true }, options);
  assert.deepEqual(requests, []);
  assert.deepEqual(format.structuredContent.models, []);
  assert.ok(format.structuredContent.minimalExample.graph.links.length);
  assert.match(text(format), /Models omitted by request/);
  const chat = await noodleGuide({ node_type: "llm", limit: 1 }, options);
  assert.deepEqual(requests, ["https://guide-fixture.example/api/v1/models?detailed=true"]);
  assert.deepEqual(chat.structuredContent.models.map(m => m.nodeTypes), [["llm"]]);
  await assert.rejects(noodleGuide({ node_type: "endpoint" }, options), (e) => e.mcpCode === -32602);
  await assert.rejects(noodleGuide({ node_type: "llm", kind: "image" }, options), (e) => e.mcpCode === -32602);
  await assert.rejects(noodleGuide({ format_only: "true" }, options), (e) => e.mcpCode === -32602);
});

test("noodle_guide advertises the local sprite workflow and its engine ports and settings", async () => {
  const tool = registry.listTools().find(t => t.name === "noodle_guide");
  const enumTypes = tool.inputSchema.properties.node_type.enum;
  const guide = await registry.callTool({ name: tool.name, arguments: { format_only: true } });
  const byType = Object.fromEntries(guide.structuredContent.nodeTypes.map(t => [t.type, t]));
  for (const type of ["slice-3d", "sprite-stack-render"]) {
    assert.ok(enumTypes.includes(type));
    assert.equal(byType[type].allowed, false, "paid custom graphs exclude local media processing");
    assert.equal(byType[type].exampleUrl, "https://nanoodle.com/guide/examples/slice-3d");
    const detail = await registry.callTool({ name: tool.name, arguments: { node_type: type } });
    assert.deepEqual(detail.structuredContent.models, []);
    assert.match(text(detail), new RegExp(type + " runs locally"));
    assert.ok(text(guide).includes(byType[type].fields));
  }
  const slicer = byType["slice-3d"], render = byType["sprite-stack-render"];
  assert.deepEqual(slicer.inputs, ["model", "paletteImage"]);
  assert.deepEqual(slicer.outputs.map(p => p.name), ["sheet", "layout", "image"]);
  assert.deepEqual(render.inputs, ["sheet"]);
  assert.deepEqual(render.outputs.map(p => p.name), ["image", "video"]);
  assert.match(slicer.fields, /model3d\.model/);
  assert.match(slicer.fields, /resolution=128, slices=80, palette=0/);
  assert.deepEqual(slicer.settings.find(s => s.field === "preset").options, ["default", "character"]);
  const frames = slicer.settings.find(s => s.field === "frames");
  assert.deepEqual([frames.def, frames.min, frames.max], ["1", 1, 64]);
  assert.ok(slicer.keyFields.includes("clip"));
  assert.ok(render.keyFields.includes("turntable"));
  assert.match(render.fields, /slice-3d\.sheet/);
});

test("every mode lists price_noodle and noodle_guide next to run_noodle; a graph file cannot take their names", async () => {
  const names = registry.listTools().map((t) => t.name);
  assert.deepEqual(names.slice(-3), ["run_noodle", "price_noodle", "noodle_guide"]);
  const dir = await mkdtemp(join(tmpdir(), "rn-names-"));
  await writeFile(join(dir, "price_noodle.json"), JSON.stringify(WORKED_GRAPH));
  const r2 = await loadTools({ dirs: [dir], apiKey: "k", outDir, log: () => {} });
  assert.ok(r2.tools.some((t) => t.name === "price_noodle-2"));
  await assert.rejects(r2.prepareCall({ name: "nope", arguments: {} }), /available: .*run_noodle, price_noodle, noodle_guide/);
});

test("the Nano charge gate withdraws price_noodle and noodle_guide like run_noodle", async () => {
  const gate = createChargeGate({
    address: "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet",
    ops: { rpc: async () => ({ blocks: {} }), transfer: async () => "F".repeat(64), pocket: async () => {} },
    usd: 0.05, xnoUsd: 1, publicBase: "http://pay.test",
  });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const names = listTools().map((t) => t.name);
  for (const n of ["run_noodle", "price_noodle", "noodle_guide"]) assert.ok(!names.includes(n), n);
  for (const n of ["price_noodle", "noodle_guide"]) {
    const r = await callTool({ name: n, arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not available on this Nano-paid server/);
  }
});
