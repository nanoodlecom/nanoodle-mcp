/** Synthetic quotes and local HTTP only. No live invoices, signing or payments. */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRailRouter } from "../src/rail-router.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { serveHttp } from "../src/http.mjs";
import { qrDecode, svgToMatrix } from "./qr-decode.mjs";

const address = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const originalId = "pay_synthetic";
const tool = { name: "poster", description: "Make a poster", inputSchema: { type: "object", properties: {} } };
const text = r => r.content.map(c => c.text || "").join("\n");
function router(usdc = true) {
  const calls = [];
  const rail = name => ({
    listTools: () => [tool],
    callTool: async params => { calls.push({ name, params }); return { content: [] }; },
  });
  return {
    calls,
    value: createRailRouter({ nano: rail("nano"), near: {
      ...rail("near"), nearOnly: new Set(), assets: new Set(usdc ? ["near", "usdc"] : ["near"]), sells: () => true,
    } }),
  };
}

test("Nano-selected stray transaction fields explain how to retry in Nano without another transfer", async () => {
  const r = router();
  const result = await r.value.callTool({ name: "poster", arguments: {
    _pay_with: "nano", _payment_tx: "synthetic-tx", _payment_sender: "synthetic.near",
  } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Nano \(XNO\)/);
  assert.match(text(result), /remove.*_payment_tx.*_payment_sender/i);
  assert.doesNotMatch(text(result), /send the transfer|ask for one with|request a NEAR quote/i);
  assert.match(text(result), /original _payment_id/);
  assert.deepEqual(r.calls, []);
});

test("a Nano payment id with a conflicting asset retains the original payment on retry", async () => {
  const r = router();
  const result = await r.value.callTool({ name: "poster", arguments: { _payment_id: originalId, _pay_with: "usdc" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Nano \(XNO\)/);
  assert.match(text(result), /keep the same _payment_id/i);
  assert.match(text(result), /remove.*_pay_with.*_payment_tx.*_payment_sender/i);
  assert.doesNotMatch(text(result), /send.*(?:USDC|NEAR)|fresh quote|new payment/i);
  assert.deepEqual(r.calls, []);
});

test("disabled USDC never instructs an existing Nano payer to replace it with a NEAR quote", async () => {
  const r = router(false);
  const result = await r.value.callTool({ name: "poster", arguments: { _payment_id: originalId, _pay_with: "usdc" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /USDC on NEAR is not enabled/);
  assert.match(text(result), /original _payment_id and payment rail/);
  assert.doesNotMatch(text(result), /request a NEAR quote instead/i);
  assert.deepEqual(r.calls, []);
});

test("valid Nano and NEAR USDC calls keep their existing routing and advertised assets", async () => {
  const r = router();
  const nano = { name: "poster", arguments: { _pay_with: "nano", _payment_id: originalId } };
  const usdc = { name: "poster", arguments: { _pay_with: "usdc" } };
  await r.value.callTool(nano); await r.value.callTool(usdc);
  assert.equal(r.calls[0].name, "nano");
  assert.equal(r.calls[0].params.arguments._payment_id, originalId);
  assert.equal(r.calls[0].params.arguments._pay_with, undefined);
  assert.equal(r.calls[1].name, "near");
  assert.equal(r.calls[1].params.arguments._pay_with, "usdc");
  const schema = r.value.listTools()[0].inputSchema.properties._pay_with;
  assert.match(schema.description, /Circle-issued USDC on NEAR/);
  assert.deepEqual(schema.enum, ["nano", "near", "usdc"]);
});

test("Nano QR, waiting, expiry, paid, refund and polling copy stay on Nano while NEAR USDC stays on NEAR", async t => {
  const quote = {
    id: originalId, tool: "poster", status: "pending", amountRaw: "50000000000000000000000000000",
    amountXno: "0.05", usd: 0.05, address, expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  quote.uri = `nano:${address}?amount=${quote.amountRaw}`;
  const nearQuote = { id: "nq_synthetic", tool: "poster", status: "pending", asset: "USDC", amount: "0.05",
    tokenContract: "circle-usdc.testnet", network: "testnet", expiresAt: quote.expiresAt };
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "copy-fixture", version: "0",
    publicBase: "http://fixture.invalid", gate: { quote: id => id === originalId ? quote : null },
    nearGate: { quote: id => id === nearQuote.id ? nearQuote : null }, usdc: { enabled: true },
    listTools: () => [tool], callTool: async () => { throw Error("tools must not run"); }, log: () => {},
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(`${base}/pay/${originalId}`)).text();
  assert.match(html, /Pay 0.05 XNO/);
  assert.match(html, /scan with any Nano wallet/);
  assert.doesNotMatch(html, /USDC|\bNEAR\b/);
  assert.equal(qrDecode(svgToMatrix(html.match(/<svg[\s\S]*?<\/svg>/)[0])), quote.uri);
  const nearHtml = await (await fetch(`${base}/pay/${nearQuote.id}`)).text();
  assert.match(nearHtml, /Pay in USDC/);
  assert.match(nearHtml, /Circle-issued USDC on NEAR/);
  assert.match(nearHtml, /ft_transfer/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  function page() {
    const elements = new Map(["paybox", "status", "expiry"].map(id => [id, { textContent: "", innerHTML: "" }]));
    const fetched = [], watched = []; let polls = 0;
    const context = vm.createContext({ document: { getElementById: id => elements.get(id) }, Date,
      setTimeout() {}, EventSource: class { constructor(url) { watched.push(url); } addEventListener() {} close() {} },
      fetch: async url => { fetched.push(url); return { json: async () => ({ status: ++polls === 1 ? "pending" : "refunded" }) }; },
    });
    for (const script of scripts) vm.runInContext(script, context);
    return { context, elements, fetched, watched };
  }
  for (const status of ["paid", "consumed", "expired", "unknown", "refunded"]) {
    const p = page(); assert.equal(p.context.apply(status), true);
    const rendered = [...p.elements.values()].map(x => x.innerHTML + x.textContent).join(" ");
    assert.doesNotMatch(rendered, /USDC|\bNEAR\b/);
    assert.match(rendered, status === "refunded" ? /returned to your wallet/ : ["paid", "consumed"].includes(status) ? /Paid/ : /expired/);
  }
  const p = page(); await p.context.poll();
  assert.deepEqual(p.watched, [`/x402/watch/${originalId}`]);
  assert.equal(p.fetched.length, 2);
  assert.ok(p.fetched.every(url => url === `/x402/status/${originalId}?wait=1`));
  assert.match(p.elements.get("paybox").innerHTML, /Payment refunded/);
});

test("real Nano gate quote, waiting and expiry MCP messages contain no NEAR or USDC instructions", async () => {
  let now = 1000;
  const gate = createChargeGate({ address, publicBase: "http://fixture.invalid", usd: 0.05, xnoUsd: 1,
    now: () => now, waitMs: 1, pollMs: 1, ops: {
      rpc: async q => q.action === "receivable" ? { blocks: {} } : { history: [] },
      transfer: async () => { throw Error("no transfers permitted"); }, pocket: async () => {},
    } });
  const wrapped = gate.wrapRegistry({ tools: [tool], listTools: () => [tool],
    callTool: async () => { throw Error("no workflows permitted"); } });
  const quote = await wrapped.callTool({ name: "poster", arguments: {} });
  assert.match(text(quote), /paid in Nano/);
  assert.match(quote.structuredContent.x402.uri, /^nano:/);
  const args = { _payment_id: quote.structuredContent.x402.paymentId };
  const pending = await wrapped.callTool({ name: "poster", arguments: args });
  assert.match(text(pending), /hasn't arrived yet/);
  now += 16 * 60 * 1000;
  const deadline = Date.now() + 1000;
  while (gate.quote(args._payment_id).status !== "expired") {
    assert.ok(Date.now() < deadline, "synthetic watcher must expire the quote");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const expired = await wrapped.callTool({ name: "poster", arguments: args });
  assert.match(text(expired), /expired unpaid/);
  for (const response of [quote, pending, expired]) assert.doesNotMatch(JSON.stringify(response), /USDC|\bNEAR\b/);
});
