import assert from "node:assert/strict";
import test from "node:test";
import { runPublicMcpCheck } from "../scripts/public-mcp-check.mjs";

const NOW = Date.parse("2026-11-18T04:30:00Z");
const stamp = new Date(NOW).toISOString();

function fixture({ missingTool = false, scanAt = stamp, funded = true, usdcUnavailable = false, lostHost, transientRates = false,
  missingDecision = false, invalidDeposit = false } = {}) {
  const calls = [];
  async function fetch(url, init) {
    const { hostname, pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ hostname, pathname, method: body?.method, tool: body?.params?.name });
    if (hostname === lostHost) throw Error("private transport details");
    if (hostname === "babel.255bits.com" && pathname === "/mcp/v1") {
      return Response.json({ error: "private challenge details" }, { status: 401 });
    }
    if (pathname === "/rates") {
      if (transientRates && calls.filter(call => call.pathname === pathname).length === 1) return new Response(null, { status: 503 });
      return Response.json({ xnoUsd: "0.61", sources: { xnoUsd: { usable: true, at: stamp } } });
    }
    if (pathname === "/near/health") {
      return Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near",
        watcher: { listening: true, lastScanAt: scanAt, backfilling: false },
        funding: { enforced: true, checkedAt: NOW, ok: funded, canQuoteNear: funded, canQuoteUsdc: funded && !usdcUnavailable,
          ...(usdcUnavailable ? { usdcCode: "USDC_FUNDING_UNAVAILABLE" } : {}),
          ...(funded ? {} : { code: "NEAR_FUNDING_INSUFFICIENT" }) } });
    }
    if (pathname === "/mcp" && body?.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "nanoodle-mcp" } } });
    }
    if (pathname === "/mcp" && body?.method === "tools/list") {
      const names = ["price_noodle", "noodle_guide"];
      if (!missingTool || hostname !== "mcp-near.nanoodle.com") names.push("run_noodle");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: names.map(name => ({ name })) } });
    }
    if (pathname === "/mcp" && body?.method === "tools/call") {
      assert.equal(hostname, "near.nanoodle.com");
      assert.equal(body.params.name, "price_noodle");
      const { graph, _pay_with: asset } = body.params.arguments;
      assert.ok(graph.nodes.some(node => node.type === "decide-branch"));
      assert.deepEqual(graph.links.filter(link => link.from.node === "decision").map(link => link.from.port), ["yes", "no"]);
      const items = graph.nodes.filter(node => node.fields.model && !(missingDecision && asset === "near" && node.id === "decision"))
        .map(node => ({ nodeId: node.id, model: node.fields.model, usd: "0.0001" }));
      return Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent: {
        [asset]: { network: "mainnet" }, pricing: { currency: "USD", safety: { ok: true }, unpriced: [],
          estimatedCost: { usd: "0.0003", items }, likelyCharge: { usd: "0.00036" },
          deposit: { usd: invalidDeposit && asset === "usdc" ? "0.0003" : "0.01" } },
      } } });
    }
    return new Response(null, { status: 405 });
  }
  return { calls, run: () => runPublicMcpCheck({ fetch, now: () => NOW, retryMs: 0 }) };
}

test("public availability uses discovery, status and free pricing, and retries a transient failure", async () => {
  const { calls, run } = fixture({ transientRates: true });
  const report = await run();
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 9);
  assert.equal(report.checks.find(check => check.stage === "nano-rates").attempts, 2);
  assert.deepEqual([...new Set(calls.filter(call => call.method).map(call => call.method))].sort(), ["initialize", "tools/call", "tools/list"]);
  assert.equal(calls.filter(call => call.tool === "price_noodle").length, 2);
  assert.deepEqual([...new Set(calls.map(call => call.pathname))].sort(), ["/mcp", "/mcp/v1", "/near/health", "/rates"]);
});

test("public readiness reports missing USDC proof as a token-specific check failure", async () => {
  const { run } = fixture({ usdcUnavailable: true });
  const report = await run();
  assert.deepEqual(report.checks.filter(check => !check.ok), [
    { stage: "near-refund-funding", ok: false, attempts: 2, code: "usdc-refund-funding-unavailable" },
  ]);
});

test("conditional pricing verifies the decision model and both branches fit the deposit", async () => {
  const { run } = fixture({ missingDecision: true, invalidDeposit: true });
  const report = await run();
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(check => !check.ok).map(({ stage, code }) => [stage, code]), [
    ["near-conditional-pricing", "conditional-price-branch-missing"],
    ["usdc-conditional-pricing", "conditional-price-deposit-invalid"],
  ]);
});

test("public availability distinguishes missing tools, a stale watcher, a funding shortfall and failed Babel ingress", async () => {
  const { run } = fixture({ missingTool: true, scanAt: "2026-11-18T04:20:00Z", funded: false, lostHost: "babel.255bits.com" });
  const report = await run();
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(check => !check.ok).map(({ stage, attempts, code }) => [stage, attempts, code]), [
    ["near-alias-mcp", 2, "mcp-tools-missing"],
    ["near-payment-watcher", 2, "near-watcher-stale"],
    ["near-refund-funding", 2, "near-refund-funding-insufficient"],
    ["babel-ingress", 2, "request-failed"],
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private (transport|challenge) details/);
});
