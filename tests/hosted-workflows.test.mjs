import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAddress, derivePublicKey, deriveSecretKey } from "nanocurrency";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { creatorAgentInstructions } from "../src/creator-instructions.mjs";
import { serveHttp } from "../src/http.mjs";

const author = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 2)), { useNanoPrefix: true });
const graph = { ...WORKED_GRAPH, x402: { author } };
let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });
const rig = (extra = {}) => createHostedWorkflows({ dir: mkdtempSync(join(tmpdir(), "hosted-workflows-")), publicBase: "https://near.example", merchant: "merchant.near", network: "mainnet", usdc: { enabled: true }, baseUrl: nano.url, ...extra });
const submission = { name: "Idea into a poster", description: "Supply an idea; receive a finished poster.", graph };

test("creator intake checks real pricing without execution; recipes are private, immutable and durable", async () => {
  const creators = rig(), before = nano.runs();
  const result = await creators.submit(submission), again = await creators.submit(submission);
  assert.equal(result.id, again.id); assert.equal(creators.all().length, 1); assert.equal(nano.runs(), before);
  assert.deepEqual(Object.keys(result.schema.properties), ["Idea"]); assert.equal(result.author, author);
  assert.equal(result.status, "live"); assert.equal(result.market, undefined); assert.ok(result.recommendedPriceUsd >= .02);
  const publicText = JSON.stringify(result); assert.ok(!publicText.includes("Write one vivid image prompt")); assert.ok(!publicText.includes('"graph"'));
  const restored = rig({ dir: creators.dir }); assert.deepEqual(restored.publicView(result.id), result);
  assert.equal(statSync(join(creators.dir, "workflows.json")).mode & 0o777, 0o600);
  const revision = await creators.submit({ ...submission, description: "A new version" }); assert.notEqual(revision.id, result.id);
  const mutated = creators.get(result.id); mutated.graph.x402.author = "bad"; assert.equal(creators.get(result.id).author, author);
});

test("creator intake refuses missing/invalid author, ambiguous briefs, unsafe/unpriced graphs and capacity exhaustion", async () => {
  const creators = rig({ maxWorkflows: 1 });
  for (const bad of [ { ...graph, x402: undefined }, { ...graph, x402: { author: "nano_bad" } },
    { ...graph, nodes: [...graph.nodes, { id: "other", type: "text", name: "Other", fields: { text: "x" } }] },
    { ...graph, nodes: [...graph.nodes, { id: "code", type: "code", fields: { code: "run()" } }] } ]) {
    await assert.rejects(creators.submit({ ...submission, graph: bad }));
  }
  const first = await creators.submit(submission); await assert.rejects(creators.submit({ ...submission, name: "Second" }), /capacity/);
  assert.equal((await creators.submit(submission)).id, first.id, "dedup works at capacity");
});

test("hosted calls bind graph and payout, map sanitized names, forward progress and use the shared payment gate", async () => {
  const calls = [], ctx = { report: () => {} }, creators = rig({ callTool: async (params, context) => { calls.push({ params, context }); return { content: [], structuredContent: { payment: {} } }; } });
  const renamed = structuredClone(graph); renamed.nodes[0].name = "Poster idea";
  const record = await creators.submit({ ...submission, graph: renamed });
  const result = await creators.callTool(record.id, { name: "run_workflow", arguments: { Poster_idea: "An otter", _pay_with: "usdc", _payment_id: "nq_example" } }, ctx);
  assert.equal(calls[0].params.name, "run_noodle"); assert.equal(calls[0].params.arguments.inputs["Poster idea"], "An otter");
  assert.equal(calls[0].params.arguments.graph.x402.author, author); assert.equal(calls[0].context.report, ctx.report); assert.equal(calls[0].context.paymentTool, "run_workflow");
  assert.match(result.structuredContent.payment.next, /run_workflow/);
  for (const args of [{ graph: {} }, { x402: {} }, { "Poster idea": "wrong key" }]) await assert.rejects(creators.callTool(record.id, { name: "run_workflow", arguments: args }), /Unexpected/);
  assert.equal(calls.length, 1);
});

test("creator HTTP surfaces expose a bound MCP tool without publishing the recipe", async () => {
  const creators = rig({ callTool: async () => ({ content: [{ type: "text", text: "same gate" }] }) });
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "test", version: "test", publicBase: "https://near.example", listTools: () => [], callTool: async () => ({}), creators, nearHealth: { merchant: "merchant.near", network: "mainnet" }, usdc: { enabled: true }, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post("/creators/workflows", submission, { Origin: "https://evil.example" })).status, 403);
    const response = await post("/creators/workflows", submission); assert.equal(response.status, 201); const record = await response.json();
    const page = await (await fetch(`${base}/workflows/${record.id}`)).text();
    assert.match(page, /Idea into a poster/); assert.match(page, /Payment instructions for your agent/); assert.doesNotMatch(page, /market\.near\.ai|marketplace|storefront/i); assert.doesNotMatch(page, /pending Nanoodle review|Nanoodle reviews|owner-account adoption/); assert.match(page, /\/workflows\/wf_.*?\/mcp/); assert.ok(!page.includes("Write one vivid image prompt"));
    const tools = await (await post(`/workflows/${record.id}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    assert.deepEqual(tools.result.tools.map(t => t.name), ["run_workflow", "price_workflow"]);
    assert.equal((await post(`/workflows/${record.id}/mcp`, {}, { Origin: "null" })).status, 403);
    const call = await (await post(`/workflows/${record.id}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_workflow", arguments: { Idea: "an otter" } } })).json();
    assert.equal(call.result.content[0].text, "same gate");
    const guide = await (await fetch(`${base}/workflows/${record.id}/llms.txt`)).text(); assert.match(guide, /Continue automatically/);
    assert.equal((await fetch(`${base}/workflows/${record.id}/graph.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("hosted agent instructions use the bound MCP endpoint, payment ID and result without promoting storefronts", async () => {
  const creators = rig(), record = await creators.submit(submission), text = creatorAgentInstructions(record);
  assert.ok(text.includes(record.mcpUrl)); assert.match(text, /authorized funded wallet/);
  assert.match(text, /Show the final media or text to the user/); assert.doesNotMatch(text, /marketplace|storefront|listing/i);
  assert.match(text, /_payment_id/); assert.match(text, /price_workflow/); assert.doesNotMatch(text, /Write one vivid image prompt/);
  assert.match(creators.instructions(record.id), /Hosting requires no Nanoodle approval/);
});

test("existing uploads with legacy pending-market metadata remain live without adoption or review", async () => {
  const creators = rig(), record = await creators.submit(submission), path = join(creators.dir, "workflows.json");
  const state = JSON.parse(readFileSync(path)); state.workflows[record.id].market = { status: "pending" }; writeFileSync(path, JSON.stringify(state));
  let called = false;
  const restored = rig({ dir: creators.dir, callTool: async () => { called = true; return { content: [] }; } });
  assert.equal(restored.publicView(record.id).status, "live"); assert.equal(restored.publicView(record.id).market, undefined);
  await restored.callTool(record.id, { name: "run_workflow", arguments: { Idea: "A lighthouse" } }); assert.ok(called);
});
