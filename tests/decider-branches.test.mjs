import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computePrice, loadTools } from "../src/tools.mjs";
import { checkGraphSafety, priceGraph, pricingVocabulary } from "../src/custom-workflow.mjs";

const { cases, legacy, ...graph } = JSON.parse(readFileSync(new URL("./fixtures/conditional/decider-branches.json", import.meta.url)));
const models = Object.fromEntries(graph.nodes.filter(n => n.type === "llm").map(n => [n.fields.model, n.id]));
const chat = Object.keys(models).map(id => ({
  id, name: id, pricing: { prompt: 0.1, completion: 0.1 }, context_length: 32768,
}));

const decision = [{ id: graph.nodes[1].fields.model, pricing: { prompt: 0.02, completion: 0 }, context_length: 262144 }];

test("paid graph validation and reserve keep both branches priceable", async () => {
  const checked = checkGraphSafety(graph);
  assert(checked.ok, JSON.stringify(checked.refusals));
  const requested = new Set();
  const { safety, pricing } = await computePrice({ graph }, {
    baseUrl: "https://decision-catalog.test",
    fetch: async (input) => {
      const { pathname } = new URL(input);
      requested.add(pathname);
      if (pathname === "/api/v1/models") return Response.json({ data: chat });
      if (pathname === "/api/v1/decision-models") return Response.json({ data: decision });
      assert.fail(`unexpected catalog: ${pathname}`);
    },
  });
  assert(safety.ok, JSON.stringify(safety.refusals));
  assert.deepEqual(requested, new Set(["/api/v1/models", "/api/v1/decision-models"]));
  assert.equal(pricing.unpriced.length, 0);
  assert.equal(pricing.items.length, 6);
  assert.equal(pricing.items.filter(item => item.type === "decide" && item.usd > 0).length, 2);
  assert.equal(priceGraph(checked.workflowGraph, { chat: [...chat, ...decision] }).unpriced.length, 2);
  assert.match(pricingVocabulary(pricing).text, /estimate reserves for all branches/);

  const malformed = structuredClone(graph);
  malformed.nodes.find(n => n.id === "n2").type = "decide";
  const refused = checkGraphSafety(malformed);
  assert(!refused.ok);
  assert(refused.refusals.some(r => r.code === "BAD_GRAPH" && /enable branching/.test(r.message)));
});

test("run_noodle executes and meters only the selected branch", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls, answers;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if ((opts.method || "GET") === "GET") return Response.json({ data: path === "/api/v1/decision-models" ? decision : chat });
    const data = JSON.parse(opts.body);
    if (path === "/api/v1/decisions") {
      calls.push(calls.includes("n2") ? "n5" : "n2");
      const value = answers.shift();
      return Response.json({
        answers: { answer: value == null ? null : { type: "noul", noul: value } },
        usage: { cost: 0.001 },
      });
    }
    assert.equal(path, "/api/v1/chat/completions");
    const id = models[data.model];
    assert(id);
    calls.push(id);
    return Response.json({ choices: [{ message: { content: id } }], cost: 0.001 });
  };
  const outDir = await mkdtemp(join(tmpdir(), "decider-mcp-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const registry = await loadTools({ dirs: [], outDir, apiKey: "offline-fixture", log() {} });
  for (const scenario of cases) {
    calls = [];
    answers = [...scenario.answers];
    const run = registry.callTool({ name: "run_noodle", arguments: { graph } });
    if (scenario.error) {
      await assert.rejects(run, /valid yes\/no answer/);
    } else {
      const result = await run;
      assert(result.content.some(block => block.text === scenario.output));
      assert.equal(result.costUsd, scenario.calls.length * 0.001);
    }
    assert.deepEqual(calls.sort(), [...scenario.calls].sort());
  }
  calls = [];
  answers = [0];
  const result = await registry.callTool({ name: "run_noodle", arguments: { graph: JSON.stringify(legacy) } });
  assert(result.content.some(block => /gate.*answered no/.test(block.text)));
  assert.deepEqual(calls, ["n2"]);
  assert.equal(result.costUsd, 0.001);
});
