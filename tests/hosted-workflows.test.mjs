import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAddress, derivePublicKey, deriveSecretKey } from "nanocurrency";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { createHostedPublisher, marketFiles, readHostedMarket, startHostedMarket } from "../src/market/hosted.mjs";
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
  assert.equal(result.market.status, "pending"); assert.ok(result.recommendedPriceUsd >= .02);
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

test("creator HTTP surfaces expose a bound MCP tool and keep recipes, tokens and adoption links private", async () => {
  const creators = rig({ callTool: async () => ({ content: [{ type: "text", text: "same gate" }] }) });
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "test", version: "test", publicBase: "https://near.example", listTools: () => [], callTool: async () => ({}), creators, nearHealth: { merchant: "merchant.near", network: "mainnet" }, usdc: { enabled: true }, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    assert.equal((await post("/creators/workflows", submission, { Origin: "https://evil.example" })).status, 403);
    const response = await post("/creators/workflows", submission); assert.equal(response.status, 201); const record = await response.json();
    const page = await (await fetch(`${base}/workflows/${record.id}`)).text();
    assert.match(page, /Idea into a poster/); assert.match(page, /\/workflows\/wf_.*?\/mcp/); assert.ok(!page.includes("Write one vivid image prompt"));
    const tools = await (await post(`/workflows/${record.id}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    assert.deepEqual(tools.result.tools.map(t => t.name), ["run_workflow", "price_workflow"]);
    assert.equal((await post(`/workflows/${record.id}/mcp`, {}, { Origin: "null" })).status, 403);
    const call = await (await post(`/workflows/${record.id}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_workflow", arguments: { Idea: "an otter" } } })).json();
    assert.equal(call.result.content[0].text, "same gate");
    const guide = await (await fetch(`${base}/workflows/${record.id}/llms.txt`)).text(); assert.match(guide, /Continue automatically/);
    assert.equal((await fetch(`${base}/workflows/${record.id}/graph.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("market publication persists one-time registration, requires operator adoption, reprices and emits the existing worker catalog", async () => {
  const owner = "11111111-1111-1111-1111-111111111111", fresh = "22222222-2222-2222-2222-222222222222";
  const creators = rig(), record = await creators.submit(submission), calls = []; let adopted = false;
  const request = async (url, options) => {
    const path = new URL(url).pathname, body = options.body && JSON.parse(options.body); calls.push({ path, ...options, body });
    const result = path.endsWith("/register") ? { agentId: "33333333-3333-3333-3333-333333333333", accountId: fresh, apiToken: "aat_PRIVATE" }
      : path.endsWith("adoption-code") ? { adoptionUrl: "https://market.near.ai/PRIVATE", expiresAt: "soon" }
      : path.endsWith("pricing-plans") ? options.method === "GET" ? [] : { pricing_plan_id: "44444444-4444-4444-4444-444444444444" }
      : options.method === "GET" ? { ownerAccountId: adopted ? owner : fresh } : {};
    return Response.json(result);
  };
  const publisher = createHostedPublisher({ creators, ownerAccountId: owner, fetch: request });
  await publisher.register(record.id); await publisher.register(record.id);
  assert.equal(calls.filter(c => c.path.endsWith("/register")).length, 1);
  assert.equal(readHostedMarket(creators.dir, record.id).token, "aat_PRIVATE");
  await assert.rejects(publisher.publish(record.id), /must adopt/); assert.equal(calls.filter(c => c.method === "PATCH").length, 0);
  assert.match((await publisher.adoption(record.id)).adoptionUrl, /PRIVATE/); adopted = true;
  const result = await publisher.publish(record.id); assert.match(result.url, /nn-/);
  const catalog = JSON.parse(readFileSync(marketFiles(creators.dir, record.id).catalog)); assert.equal(catalog.agents[0].custom, false);
  assert.equal(JSON.parse(readFileSync(catalog.agents[0].graph)).x402.author, author);
  assert.equal(creators.publicView(record.id).market.status, "live");
  assert.ok(!JSON.stringify(creators.publicView(record.id)).includes("PRIVATE"));
  let started = 0, stopped = 0, release; const done = new Promise(r => { release = r; });
  const runtime = startHostedMarket({ creators, creatorPayments: {}, payment: () => {}, env: {}, start: async (cfg, options) => {
    started++; assert.equal(cfg.catalog.agents[0].defaultWorkflow.graph.x402.author, author); assert.ok(options.creatorPayments); return { done, stop: () => { stopped++; release(0); } };
  } });
  await new Promise(r => setTimeout(r, 20)); await runtime.stop(); assert.equal(started, 1); assert.equal(stopped, 1);
});

test("an uncertain registration is never retried into a fresh marketplace account", async () => {
  const creators = rig(), record = await creators.submit(submission); let requests = 0;
  const publisher = createHostedPublisher({ creators, fetch: async () => { requests++; throw new Error("lost response"); } });
  await assert.rejects(publisher.register(record.id), /lost response/);
  await assert.rejects(publisher.register(record.id), /uncertain/); assert.equal(requests, 1);
});
