import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTools } from "../src/tools.mjs";
import { nearShowcase } from "../src/near-showcase.mjs";
import { nearAgentGuide } from "../src/near/agent-guide.mjs";
import { checkGraphSafety } from "../src/custom-workflow.mjs";
import { serveHttp } from "../src/http.mjs";

test("3D showcase reuses the mounted graph as a safe custom template while retaining the Nano original", async () => {
  const registry = await loadTools({ dirs: ["tests/fixtures/hosted"], outDir: "/tmp/nanoodle-showcase-test", log() {}, catalogTimeoutMs: 1 });
  const original = registry.tools.find(t => t.name === "idea-to-3d-model"), raw = original.rawText;
  assert.equal(checkGraphSafety(JSON.parse(raw)).ok, false, "the original has unpriced model options");
  const offered = [{ name: "image-model-arena" }, { name: "sing" }, { name: "run_noodle" }];
  const showcase = nearShowcase(offered, registry.tools), template = showcase.tools[0];
  assert.equal(template.name, "idea-to-3d-model");
  assert.ok(template.graph); assert.equal(checkGraphSafety(template.graph).ok, true);
  assert.equal(original.rawText, raw); assert.ok(original.wf.graph.nodes.find(n => n.type === "model3d").fields.modelOpts);
  assert.equal(showcase.tools.some(t => t.name === "image-model-arena"), false);
  assert.deepEqual(template.graph.links, JSON.parse(raw).links);
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "examples", version: "0", publicBase: "http://example.test",
    listTools: () => offered, callTool: async () => assert.fail("Viewing a sample cannot start a paid run"),
    toolInfo: registry.tools, nearGate: {}, usdc: { enabled: true }, log() {} });
  try {
    const base = `http://127.0.0.1:${server.address().port}`, html = await (await fetch(base)).text();
    assert.doesNotMatch(html, /FIX A FLAT|data-choose="image-model-arena"/);
    assert.match(html, /data-choose="idea-to-3d-model"/);
    assert.match(html, /poster="\/examples\/idea-to-3d-model.png"/);
    assert.deepEqual(await (await fetch(base + "/examples/idea-to-3d-model.json")).json(), template.graph);
    const llms = await (await fetch(base + "/llms.txt")).text();
    assert.match(llms, /Featured ready-made template: idea-to-3d-model/);
    assert.match(llms, /amountAtomic/); assert.match(llms, /ft_transfer/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("agent guide makes direct NEAR/USDC payment and automatic continuation discoverable", () => {
  const guide = nearAgentGuide({ publicBase: "https://near.nanoodle.com", usdc: true });
  for (const term of ["_pay_with", "amountYocto", "amountAtomic", "tokenContract", "ft_transfer", "payment.watchUrl", "payment.statusUrl", "_payment_id", "progressToken", 'status "paid"', "SAME asset"]) assert.ok(guide.includes(term), term);
  assert.match(guide, /do not wait for a follow-up/);
  assert.match(guide, /spending authorization/);
  assert.doesNotMatch(nearAgentGuide({ publicBase: "http://localhost", usdc: false }), /ft_transfer|amountAtomic|"usdc"/);
});
