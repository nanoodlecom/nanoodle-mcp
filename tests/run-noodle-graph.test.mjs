/**
 * Custom workflows on a free server: run_noodle takes an inline `graph`,
 * price_noodle prices it without running, noodle_guide explains how to write
 * one. The Nano charge gate withdraws the two helpers along with run_noodle.
 * Offline: NanoGPT is a mocked fetch.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools, editorShareUrl } from "../src/tools.mjs";
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
