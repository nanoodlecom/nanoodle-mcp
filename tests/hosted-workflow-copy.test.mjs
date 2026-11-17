import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { creatorAgentInstructions } from "../src/creator-instructions.mjs";
import { hostedWorkflowPage } from "../src/creator-site.mjs";
import { serveHttp } from "../src/http.mjs";

const target = "wf_9f17576586b5b53ecf7fcc27", other = "wf_111111111111111111111111";
const author = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";
const description = "Day to night between two keyframes. Synthetic credit: @fixture_creator_only (https://creator-fixture.invalid/example).";
const creatorText = /fixture_creator_only|creator-fixture\.invalid|[Cc]reator payout|[Cc]reator earnings|Nano earnings|embedded.*author|A CREATOR WORKFLOW/;
const link = (id, from, to, port, out = "text") => ({ id, from: { node: from, port: out }, to: { node: to, port } });
// Synthetic day/night recipe. No production record, private prompts or providers.
const graph = {
  v: 1, nodes: [
    { id: "day-prompt", type: "text", name: "Day keyframe prompt", fields: { text: "Synthetic day default" } },
    { id: "night-prompt", type: "text", name: "Night keyframe instruction", fields: { text: "Synthetic night default" } },
    { id: "motion", type: "text", fields: { text: "Synthetic fixed motion" } },
    { id: "day", type: "image", fields: { model: "meta/muse-image/text-to-image" } },
    { id: "night", type: "edit", fields: { model: "meta/muse-image/edit" } },
    { id: "clip", type: "ivideo", fields: { model: "minimax/h3-max", duration: "5", resolution: "768p" } },
  ], links: [link("1", "day-prompt", "day", "prompt"), link("2", "night-prompt", "night", "prompt"),
    link("3", "day", "night", "image", "image"), link("4", "day", "clip", "image", "image"),
    link("5", "night", "clip", "endframe", "image"), link("6", "motion", "clip", "prompt")],
};
function setup(t, optedIn = false) {
  const dir = mkdtempSync(join(tmpdir(), "hosted-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = { name: "Recovered visit Day to night between tw", description, author: optedIn ? author : null,
    graph: { ...graph, ...(optedIn ? { x402: { author } } : {}) }, inputNodeIds: ["day-prompt", "night-prompt"], inputName: null,
    estimatedCostUsd: .42, recommendedPriceUsd: .5, createdAt: 123 };
  const state = { v: 1, workflows: Object.fromEntries([target, other].map(id => [id, { ...record, id }])) };
  const file = join(dir, "workflows.json"), original = JSON.stringify(state); writeFileSync(file, original);
  const calls = [], receipt = { outputs: { clip: "synthetic-result.mp4" }, authorPayout: optedIn ? { author, status: "pending" } : null };
  const creators = createHostedWorkflows({ dir, publicBase: "https://near.example", usdc: { enabled: true },
    fetch: async () => { throw new Error("No external requests allowed"); },
    callTool: async (params, ctx) => { calls.push({ params, ctx }); return { content: [], structuredContent: structuredClone(receipt) }; } });
  return { creators, calls, receipt, original, file };
}

test("only the requested workflow loses creator copy across HTML, metadata and agent instructions", t => {
  const { creators } = setup(t), record = creators.publicView(target), control = creators.publicView(other);
  const page = hostedWorkflowPage(record, { publicBase: "https://near.example" });
  for (const text of [page.head, page.body, creators.instructions(target), creatorAgentInstructions(record), JSON.stringify(creators.listTools(target))]) {
    assert.doesNotMatch(text, creatorText);
  }
  assert.match(page.head, /MiniMax H3 Max/); assert.match(page.head, new RegExp(`/workflows/${target}`));
  assert.match(page.body, /Pay per run in NEAR or USDC/);
  assert.equal(control.description, description);
  assert.match(hostedWorkflowPage(control, { publicBase: "https://near.example" }).body, /No creator payout is configured/);
  assert.match(creators.instructions(other), /No creator payout is configured/);
  assert.match(creators.listTools(other)[0].description, /fixture_creator_only/);
  const copy = creatorAgentInstructions(record), core = creators.instructions(target);
  assert.ok(copy.includes(core)); assert.ok(copy.includes(record.mcpUrl));
  for (const requirement of [/Day_keyframe_prompt/, /Night_keyframe_instruction/, /optional strings with saved defaults/, /motion prompt stay hosted/]) assert.match(copy, requirement);
  for (const requirement of [/price_workflow is free/, /authorized wallet/, /payment link for approval/, /payment\.watchUrl/, /payment\.statusUrl\?wait=1/,
    /automatically call run_workflow with identical arguments/, /_pay_with/, /_payment_id: payment\.paymentId/, /Never create another quote or payment to retry/,
    /progressToken/, /Show final media\/text/, /same asset/]) assert.match(core, requirement);
  assert.deepEqual(copy.match(/^(?:Input|Quote|Pay|Resume|Result):/gm), ["Input:", "Quote:", "Pay:", "Resume:", "Result:"]);
  assert.match(core, /After authorization, pay the exact quote once/);
  assert.match(core, /Reuse that ID and arguments on retries\/disconnects/);
  assert.ok(copy.split(/\s+/).length < 166, "copy panel is shorter than the 166-word public original");
  assert.ok(core.split(/\s+/).length < 102, "discovery instructions are shorter than the 102-word public original");
});

for (const optedIn of [false, true]) test(`public copy preserves persisted identity, schemas and execution ${optedIn ? "with" : "without"} payout metadata`, async t => {
  const { creators, calls, receipt, original, file } = setup(t, optedIn);
  const before = creators.get(target), schemas = creators.listTools(other).map(t => t.inputSchema);
  assert.deepEqual(creators.listTools(target).map(t => t.inputSchema), schemas);
  assert.deepEqual(Object.keys(creators.publicView(target).schema.properties), ["Day_keyframe_prompt", "Night_keyframe_instruction"]);
  assert.deepEqual(creators.publicView(target).schema.required, []);
  const cases = [{}, { Day_keyframe_prompt: "A red house at noon" },
    { Day_keyframe_prompt: "A red house at noon", Night_keyframe_instruction: "Same house at midnight" },
    { Day_keyframe_prompt: "A bare plot", Night_keyframe_instruction: "Same view with a finished house" }];
  const ctx = { report: () => {} };
  for (const name of ["price_workflow", "run_workflow"]) for (const _pay_with of ["near", "usdc"]) for (const inputs of cases) {
    const args = { ...inputs, _pay_with, ...(name === "run_workflow" ? { _payment_id: "synthetic-payment", _payment_tx: "synthetic-tx", _payment_sender: "synthetic.near" } : {}) };
    const result = await creators.callTool(target, { name, arguments: args }, ctx);
    const control = await creators.callTool(other, { name, arguments: args }, ctx);
    assert.deepEqual(result, control); assert.deepEqual(result.structuredContent, receipt);
    assert.deepEqual(calls.at(-2), calls.at(-1)); assert.deepEqual(calls.at(-2).params.arguments.graph, before.graph);
    assert.equal(calls.at(-2).ctx.report, ctx.report);
  }
  for (const args of [{ graph: {} }, { x402: {} }, { Transition_motion_prompt: "change recipe" }, { Day_keyframe_prompt: 42 }]) {
    await assert.rejects(creators.callTool(target, { name: "run_workflow", arguments: args }), /Unexpected/);
  }
  const publicRecord = creators.publicView(target);
  assert.equal(publicRecord.author, before.author, "author stays available to internal and intake callers");
  assert.doesNotMatch(hostedWorkflowPage(publicRecord, { publicBase: "https://near.example" }).body, creatorText);
  assert.deepEqual(creators.get(target), before); assert.equal(readFileSync(file, "utf8"), original);
});

test("HTTP HTML, llms.txt, MCP initialize and tools/list consistently use the public copy", async t => {
  const { creators } = setup(t);
  const server = await serveHttp({ host: "127.0.0.1", port: 0, publicBase: "https://near.example", name: "test", version: "test",
    listTools: () => [], callTool: async () => ({}), creators, usdc: { enabled: true }, log: () => {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/workflows/${target}`;
  for (const path of ["", "/llms.txt"]) {
    const res = await fetch(base + path); assert.equal(res.status, 200);
    const body = await res.text(); assert.doesNotMatch(body, creatorText); assert.match(body, /MiniMax H3 Max/);
  }
  for (const method of ["initialize", "tools/list"]) {
    const res = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.error, undefined);
    assert.doesNotMatch(JSON.stringify(body), creatorText);
    if (method === "initialize") assert.equal(body.result.instructions, creators.instructions(target));
    else assert.deepEqual(body.result.tools.map(t => t.inputSchema), creators.listTools(other).map(t => t.inputSchema));
  }
});
