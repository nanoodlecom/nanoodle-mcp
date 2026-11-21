import assert from "node:assert/strict";
import test from "node:test";
import { runPublicMcpCheck } from "../scripts/public-mcp-check.mjs";

const NOW = Date.parse("2026-11-18T04:30:00Z");
const stamp = new Date(NOW).toISOString();
const archives = ["archival-rpc.mainnet.fastnear.com", "archival-rpc.mainnet.near.org"];
const archivedTx = "34E7weKCDqXh3xPKdBgSWRqo44yTWjbka9deMK8JbAxx";
const archivedBlock = "7p16wv59nxnrVWD9zwzD1XN9F6z9ZiEMXe26piwnAbUL";
const archivedReceipt = "EmdtjzQtQWvmbkeZrgSQwqbyAuevicEYTVUxLhAmUEe4";
const receiptBlock = "3bssBpNw6rN4sbthUgELgdT4xpkWL2ZDUnrt9yddDB8q";

function fixture({ missingTool = false, scanAt = stamp, funded = true, usdcUnavailable = false, lostHost, transientRates = false,
  missingDecision = false, missingNanoBranch = false, invalidDeposit = false, demo = null,
  missingHistory = [], wrongHistoricalBlock = [], missingReceiptChanges = [], wrongReceiptOrigin = [] } = {}) {
  const calls = [];
  async function fetch(url, init) {
    const { hostname, pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ hostname, pathname, method: body?.method, tool: body?.params?.name });
    if (hostname === lostHost) throw Error("private transport details");
    if (archives.includes(hostname)) {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(body.jsonrpc, "2.0");
      const reply = result => Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "EXPERIMENTAL_changes") {
        assert.deepEqual(body.params, { changes_type: "account_changes", account_ids: ["escrow.ai.near"], block_id: receiptBlock });
        return reply({ block_hash: receiptBlock, changes: missingReceiptChanges.includes(hostname) ? [] : [
          { cause: { type: "receipt_processing", receipt_hash: archivedReceipt }, change: { account_id: "escrow.ai.near" } },
        ] });
      }
      if (body.method === "EXPERIMENTAL_receipt_to_tx") {
        assert.deepEqual(body.params, { receipt_id: archivedReceipt, block_height: 194263443 });
        return reply({ transaction_hash: archivedTx,
          sender_account_id: wrongReceiptOrigin.includes(hostname) ? "other.near" : "escrow.ai.near" });
      }
      assert.equal(body.id, 1);
      if (body.method === "tx") {
        assert.deepEqual(body.params, { tx_hash: archivedTx, sender_account_id: "escrow.ai.near", wait_until: "NONE" });
        if (missingHistory.includes(hostname)) {
          return Response.json({ jsonrpc: "2.0", id: 1, error: { cause: { name: "UNKNOWN_TRANSACTION" }, details: "private provider details" } });
        }
        return Response.json({ jsonrpc: "2.0", id: 1, result: { final_execution_status: "FINAL",
          status: { Failure: {} }, transaction: { hash: archivedTx, signer_id: "escrow.ai.near" },
          transaction_outcome: { block_hash: archivedBlock } } });
      }
      assert.equal(body.method, "block");
      assert.deepEqual(body.params, { block_id: archivedBlock });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { header: {
        hash: archivedBlock, height: wrongHistoricalBlock.includes(hostname) ? 194263440 : 194263441,
      } } });
    }
    if (demo && (pathname === "/" || pathname.startsWith("/examples/") || pathname.startsWith("/hub-assets/")
      || hostname === "media.nanoodle.com")) return demo(url, init);
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
      assert.equal(body.params.name, "price_noodle");
      const { graph, _pay_with: asset } = body.params.arguments;
      if (hostname === "near.nanoodle.com") assert.ok(["near", "usdc"].includes(asset));
      else {
        assert.ok(["mcp.nanoodle.com", "nano.nanoodle.com"].includes(hostname));
        assert.equal(asset, undefined);
      }
      assert.ok(graph.nodes.some(node => node.type === "decide-branch"));
      assert.deepEqual(graph.links.filter(link => link.from.node === "decision").map(link => link.from.port), ["yes", "no"]);
      const missingNode = missingDecision && asset === "near" ? "decision"
        : missingNanoBranch && hostname === "nano.nanoodle.com" ? "no-answer" : null;
      const items = graph.nodes.filter(node => node.fields.model && node.id !== missingNode)
        .map(node => ({ nodeId: node.id, model: node.fields.model, usd: "0.0001" }));
      return Response.json({ jsonrpc: "2.0", id: 1, result: { structuredContent: {
        ...(asset ? { [asset]: { network: "mainnet" } } : {}), pricing: { currency: "USD", safety: { ok: true }, unpriced: [],
          estimatedCost: { usd: "0.0003", items }, likelyCharge: { usd: "0.00036" },
          deposit: { usd: invalidDeposit && asset === "usdc" ? "0.0003" : "0.01" } },
      } } });
    }
    return new Response(null, { status: 405 });
  }
  return { calls, run: () => runPublicMcpCheck({ fetch, now: () => NOW, retryMs: 0, demoMedia: Boolean(demo) }) };
}

test("public availability uses discovery, status and free pricing, and retries a transient failure", async () => {
  const { calls, run } = fixture({ transientRates: true });
  const report = await run();
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 14);
  assert.equal(report.checks.find(check => check.stage === "nano-rates").attempts, 2);
  assert.deepEqual([...new Set(calls.filter(call => call.method).map(call => call.method))].sort(),
    ["EXPERIMENTAL_changes", "EXPERIMENTAL_receipt_to_tx", "block", "initialize", "tools/call", "tools/list", "tx"]);
  assert.deepEqual(calls.filter(call => call.tool === "price_noodle").map(call => call.hostname), [
    "mcp.nanoodle.com", "nano.nanoodle.com", "near.nanoodle.com", "near.nanoodle.com",
  ]);
  assert.deepEqual([...new Set(calls.map(call => call.pathname))].sort(), ["/", "/mcp", "/mcp/v1", "/near/health", "/rates"]);
});

test("archival history distinguishes missing redundancy from complete history loss", async () => {
  const check = report => report.checks.find(row => row.stage === "near-archival-history");
  const single = await fixture({ missingHistory: [archives[0]] }).run();
  assert.equal(single.ok, true);
  assert.deepEqual(check(single).peers, [
    { host: archives[0], ok: false, attempts: 2, code: "near-history-transaction-missing" },
    { host: archives[1], ok: true, attempts: 1 },
  ]);
  const lost = await fixture({ missingHistory: [archives[0]], wrongHistoricalBlock: [archives[1]] }).run();
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.checks.filter(row => !row.ok).map(row => row.code), ["near-no-readable-archive"]);
  assert.equal(check(lost).peers[1].code, "near-history-block-unverified");
  assert.doesNotMatch(JSON.stringify(lost), /private provider details/);
});

test("archival payment discovery requires the expected account change and receipt origin", async () => {
  const discovery = report => report.checks.find(row => row.stage === "near-archival-payment-discovery");
  const single = await fixture({ missingReceiptChanges: [archives[0]] }).run();
  assert.equal(single.ok, true);
  assert.deepEqual(discovery(single).peers, [
    { host: archives[0], ok: false, attempts: 2, code: "near-history-account-change-unverified" },
    { host: archives[1], ok: true, attempts: 1 },
  ]);
  const { calls, run } = fixture({ missingReceiptChanges: [archives[0]], wrongReceiptOrigin: [archives[1]] });
  const lost = await run();
  assert.equal(lost.ok, false);
  assert.equal(lost.checks.find(row => row.stage === "near-archival-history").ok, true);
  assert.equal(discovery(lost).code, "near-no-archive-payment-discovery");
  assert.equal(discovery(lost).peers[1].code, "near-history-receipt-origin-unverified");
  assert.equal(calls.filter(call => call.hostname === archives[0] && call.method === "EXPERIMENTAL_receipt_to_tx").length, 0);
  assert.doesNotMatch(JSON.stringify(lost), /escrow\.ai\.near|other\.near/);
});

test("public readiness reports missing USDC proof as a token-specific check failure", async () => {
  const { run } = fixture({ usdcUnavailable: true });
  const report = await run();
  assert.deepEqual(report.checks.filter(check => !check.ok), [
    { stage: "near-refund-funding", ok: false, attempts: 2, code: "usdc-refund-funding-unavailable" },
  ]);
});

test("conditional pricing verifies the decision model and both branches fit the deposit", async () => {
  const { run } = fixture({ missingDecision: true, missingNanoBranch: true, invalidDeposit: true });
  const report = await run();
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.filter(check => !check.ok).map(({ stage, code }) => [stage, code]), [
    ["nano-alias-conditional-graph-pricing", "conditional-price-branch-missing"],
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

function demoFixture({ missingAudio = false, blockedImage = false, brokenVideo = false } = {}) {
  return (url, init) => {
    const { hostname, pathname } = new URL(url);
    if (pathname === "/") {
      const near = `<img src="https://media.nanoodle.com/mcp/examples/frame.webp">
        <video poster='/examples/clip.webp'><source src="/examples/clip.mp4"></video>
        ${missingAudio ? '<img src="/examples/song.mp3">' : '<audio><source src="/examples/song.mp3"></audio>'}
        <img src="https://other.example/mcp/examples/untrusted.png">
        <img src="/examples/token.png?value=private">
        <script>const template = '<img src="/examples/script-only.webp">';</script>
        <!-- <img src="/examples/comment.webp"> -->`;
      return new Response(hostname === "near.nanoodle.com" ? near : '<img src="/hub-assets/scene.webp">',
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname.endsWith(".webp")) {
      assert.equal(init.method, "HEAD");
      if (hostname === "media.nanoodle.com") assert.equal(init.headers.origin, "https://near.nanoodle.com");
      return new Response(null, { headers: { "content-type": "image/webp",
        ...(blockedImage && hostname === "media.nanoodle.com" && { "cross-origin-resource-policy": "same-origin" }) } });
    }
    const audio = pathname.endsWith(".mp3");
    assert.equal(init.headers.range, "bytes=0-0");
    assert.equal(init.redirect, "error");
    const bytes = new Uint8Array(brokenVideo && !audio ? 2 : 1);
    return new Response(bytes, { status: 206, headers: { "content-type": audio ? "audio/mpeg" : "video/mp4",
      "content-range": "bytes 0-0/200" } });
  };
}

test("the public demo probe follows rendered media using image headers and one-byte ranges", async () => {
  const { calls, run } = fixture({ demo: demoFixture() });
  const report = await run();
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.filter(({ stage }) => stage.endsWith("-demo-media")).map(({ stage }) => stage),
    ["nano-demo-media", "near-demo-media"]);
  assert.deepEqual(calls.filter(({ pathname }) => /\.(?:mp3|mp4|webp|png)$/.test(pathname)).map(({ pathname }) => pathname).sort(),
    ["/examples/clip.mp4", "/examples/clip.webp", "/examples/song.mp3", "/hub-assets/scene.webp", "/mcp/examples/frame.webp"]);
});

test("the public demo probe flags missing playback, broken range responses and blocked previews", async t => {
  for (const [option, code] of [["missingAudio", "demo-audio-missing"], ["brokenVideo", "demo-video-range-invalid"],
    ["blockedImage", "demo-image-cross-origin-blocked"]]) {
    await t.test(option, async () => {
      const { run } = fixture({ demo: demoFixture({ [option]: true }) });
      const report = await run();
      assert.deepEqual(report.checks.filter(({ ok }) => !ok), [{ stage: "near-demo-media", ok: false, attempts: 2, code }]);
    });
  }
});
