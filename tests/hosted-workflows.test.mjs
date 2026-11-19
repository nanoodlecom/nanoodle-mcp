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

test("creator intake refuses invalid author, unsafe/unpriced graphs and capacity exhaustion", async () => {
  const creators = rig({ maxWorkflows: 1 });
  for (const bad of [ { ...graph, x402: { author: "nano_bad" } },
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
    const guide = await (await fetch(`${base}/workflows/${record.id}/llms.txt`)).text();
    assert.match(guide, /anyone with this link can quote and pay/);
    assert.match(guide, /price_workflow/); assert.match(guide, /run_workflow/);
    assert.match(guide, /NEAR, USDC on NEAR/); assert.match(guide, /\x60Idea\x60/);
    assert.doesNotMatch(guide, /Write one vivid image prompt|Supply an idea; receive a finished poster/);
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

test("optional creator payout checks, hosts and restores sanitized graphs without inventing an author", async () => {
  const creators = rig(), plain = { ...WORKED_GRAPH, providerKey: "SYNTHETIC-NEVER-PERSIST", x402: undefined };
  const before = nano.runs(), checked = await creators.check({ ...submission, graph: plain });
  assert.equal(checked.author, null); assert.equal(Object.hasOwn(checked.graph, "x402"), false);
  assert.equal(Object.hasOwn(checked.graph, "providerKey"), false); assert.equal(nano.runs(), before);
  const hosted = await creators.submit({ ...submission, graph: plain });
  assert.equal(hosted.author, null); assert.ok(hosted.estimatedCostUsd > 0); assert.equal(creators.get(hosted.id).graph.x402, undefined);
  const restored = rig({ dir: creators.dir }); assert.deepEqual(restored.publicView(hosted.id), hosted);
  assert.match(restored.instructions(hosted.id), /execution still requires payment/);
  assert.doesNotMatch(restored.listTools(hosted.id)[0].description, /earnings go/);
  assert.match(creatorAgentInstructions(hosted), /No creator payout/);
  assert.doesNotMatch(creatorAgentInstructions(hosted), /Successful runs send/);
  for (const x402 of [undefined, null, {}, { author: "" }, { author: "  " }, { author: null }]) {
    assert.equal((await creators.submit({ ...submission, graph: { ...WORKED_GRAPH, x402 } })).id, hosted.id);
  }
  // Recorded from main a9191d1 before this fix; opting in retains the old identity.
  assert.equal((await creators.submit({ graph, name: "Idea into a poster", description: "Make a poster from an idea" })).id, "wf_69f23750674d4599bdd14c69");
});

test("both HTTP intake routes allow missing payout but reject malformed explicit metadata", async () => {
  const creators = rig();
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "test", version: "test", publicBase: "https://near.example", listTools: () => [], callTool: async () => ({}), creators, log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, graph) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...submission, graph }) });
  try {
    for (const path of ["/creators/check", "/creators/workflows"]) {
      const response = await post(path, WORKED_GRAPH); assert.equal(response.status, path.endsWith("/check") ? 200 : 201);
      const result = await response.json(); assert.equal(result.author, null); assert.ok(result.estimatedCostUsd > 0);
      for (const x402 of ["bad", [], 1, { author: 1 }, { author: {} }, { author: "nano_bad" }]) {
        const invalid = await post(path, { ...WORKED_GRAPH, x402 }); assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /x402|Nano/);
      }
      const unsafe = await post(path, { ...WORKED_GRAPH, nodes: [...WORKED_GRAPH.nodes, { id: "code", type: "code", fields: { code: "no()" } }] }); assert.equal(unsafe.status, 400);
      if (result.id) {
        const page = await (await fetch(base + `/workflows/${result.id}`)).text();
        assert.match(page, /No creator payout is configured/); assert.match(page, /Pay per run in NEAR or USDC/);
        assert.doesNotMatch(page, /earnings go to null|Creator payouts: null|Successful runs send the collected/);
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
