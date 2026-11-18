import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nearRefundClaims, nearRefundCosts, nearFundingNeed, readNearFunding, createNearFunding, NEAR_OPERATING_RESERVE } from "../src/near/funding.mjs";
import { createNearRpc, openNearLedger, createRefunder, parseNearSecretKey, USDC_CONTRACTS } from "../src/near/index.mjs";
import { base58Encode } from "../src/near/base58.mjs";
import { createFakeChain } from "./fixtures/near-fake-chain.mjs";
import { nearProtocol } from "./fixtures/near-fees.mjs";

const MERCHANT = "merchant.testnet", TOKEN = USDC_CONTRACTS.testnet;
const SIGNER = parseNearSecretKey(`ed25519:${base58Encode(Buffer.alloc(32, 19))}`); // public test seed
function world() {
  let at = Date.now();
  const chain = createFakeChain({ now: () => at });
  chain.addAccount(MERCHANT, 10n ** 25n, SIGNER.publicKey);
  chain.addAccount("payer.testnet", 10n ** 25n);
  chain.addFt(TOKEN, { [MERCHANT]: 1_000_000_000n, "payer.testnet": 1_000_000_000n });
  const rpc = createNearRpc({ url: "https://rpc.test", fetch: chain.fetch });
  const ledger = openNearLedger({ file: join(mkdtempSync(join(tmpdir(), "near-funding-")), "state.json"), network: "testnet", merchant: MERCHANT, now: () => at });
  const options = { rpc, ledger, network: "testnet", accountId: MERCHANT, publicKey: SIGNER.publicKey, usdcToken: TOKEN, now: () => at };
  const funding = createNearFunding(options);
  const costs = nearRefundCosts(nearProtocol(), chain.gasPrice);
  const storage = 182n * costs.storagePriceYocto;
  return { chain, rpc, ledger, options, funding, costs, storage, now: () => at, tick: ms => { at += ms; },
    setNear: value => { chain.accounts.get(MERCHANT).balance = value; },
    putQuote: (id, patch = {}) => ledger.putQuote({ id, status: "pending", expiresAt: at + 600_000, ...patch }) };
}

test("refund claims cover paid/running work, failed handoffs and pending quotes without counting an outbox twice", () => {
  const claims = nearRefundClaims({ quotes: [
    { id: "native", status: "paid", paidYocto: "7" },
    { id: "token", status: "running", asset: "usdc", paidYocto: "30" },
    { id: "handoff", status: "running", asset: "usdc", paidYocto: "20", settlement: { refundYocto: "3" } },
    { id: "failed", status: "failed", paidYocto: "20" },
    { id: "pending", status: "pending", expiresAt: 100 },
    { id: "late", status: "expired", asset: "usdc", expiresAt: 99 },
    { id: "old", status: "expired", expiresAt: 1 },
  ], refunds: [
    { paymentId: "handoff", status: "signed", asset: "usdc", amountYocto: "3" },
    { paymentId: "manual", status: "failed_permanent", amountYocto: "11" },
  ] }, { now: 150, unpaidRetainMs: 100 });
  assert.equal(claims.nearYocto, 38n); assert.equal(claims.usdcAtomic, 33n);
  assert.equal(claims.nativeRefunds, 3); assert.equal(claims.tokenRefunds, 2);
  assert.equal(claims.pendingNativeRefunds, 1); assert.equal(claims.pendingTokenRefunds, 1);
  assert.deepEqual(claims.issues, ["near-refund-intent-missing"]);
  assert.throws(() => nearRefundClaims({ quotes: [], refunds: null }));
});

test("fee reserves include the gas-purchase floor, implicit-account creation and FT action/argument costs", () => {
  const protocol = nearProtocol({ floor: "10", feeGas: 100 });
  const costs = nearRefundCosts(protocol, "1");
  assert.equal(costs.nativeRefundFeeYocto, 16_000n, "four fees (send + execution), floor 10, 2x reserve");
  assert.ok(costs.tokenRefundFeeYocto > 2n * 30_000_000_000_000n * 10n + 1n);
  const base = nearRefundCosts(nearProtocol({ floor: "1", feeGas: 100 }), "1");
  assert.equal(costs.nativeRefundFeeYocto, base.nativeRefundFeeYocto * 10n);
  delete protocol.runtime_config.min_gas_purchase_price;
  assert.throws(() => nearRefundCosts(protocol, "1"), { code: "NEAR_FUNDING_INVALID" });
  const bad = nearProtocol(); bad.runtime_config.transaction_costs.pessimistic_gas_price_inflation_ratio = [1, 0];
  assert.throws(() => nearRefundCosts(bad, "1"));
});

test("read-only funding views bind account, authorized key and token balance to one finalized block", async () => {
  const w = world();
  const frame = await readNearFunding({ ...w.options, tokenContract: TOKEN });
  assert.equal(frame.usdcAtomic, 1_000_000_000n); assert.equal(frame.balanceYocto, 10n ** 25n);
  const queries = w.chain.log.filter(row => row.method === "query");
  assert.ok(queries.every(row => row.params.block_id === queries[0].params.block_id && !row.params.finality));
  const gas = w.chain.log.find(row => row.method === "gas_price");
  assert.deepEqual(gas.params, [queries[0].params.block_id]);
  const changed = { ...w.rpc, call: async (method, params) => {
    const r = await w.rpc.call(method, params);
    return params?.request_type === "view_account" ? { ...r, block_hash: "another-block" } : r;
  } };
  await assert.rejects(readNearFunding({ ...w.options, rpc: changed }), { code: "NEAR_FUNDING_INVALID" });
  assert.equal(w.chain.sendTxCount, 0);
});

test("free quotes cannot tie up gas; concurrent paid USDC obligations must all fit before work starts", async () => {
  const w = world();
  w.setNear(NEAR_OPERATING_RESERVE + w.storage + w.costs.tokenRefundFeeYocto);
  const results = await Promise.allSettled(["a", "b"].map(id => w.funding.quote("usdc", () => w.putQuote(id, { asset: "usdc" }))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  for (const q of w.ledger.quotes()) w.ledger.updateQuote(q.id, { status: "paid", paidYocto: "17" });
  const runs = await Promise.allSettled([w.funding.run("usdc"), w.funding.run("usdc")]);
  assert.ok(runs.every(r => r.reason?.code === "NEAR_FUNDING_INSUFFICIENT"));
  assert.equal(w.chain.sendTxCount, 0);
});

test("paid USDC work retains its fee claim and cannot run after a native balance or gas-price change", async () => {
  const w = world(), enough = NEAR_OPERATING_RESERVE + w.storage + w.costs.tokenRefundFeeYocto;
  w.setNear(enough);
  await w.funding.quote("usdc", () => w.putQuote("q", { asset: "usdc" }));
  w.ledger.updateQuote("q", { status: "paid", paidYocto: "17" });
  await w.funding.run("usdc");
  const claims = nearRefundClaims({ quotes: w.ledger.quotes(), refunds: [] }, { now: w.now() });
  assert.equal(claims.tokenRefunds, 1); assert.equal(claims.pendingTokenRefunds, 0);
  w.setNear(enough - 1n);
  await assert.rejects(w.funding.run("usdc"), { code: "NEAR_FUNDING_INSUFFICIENT" });
  assert.equal(w.ledger.getQuote("q").status, "paid");
  w.setNear(enough); w.chain.gasPrice = "2000000000";
  await assert.rejects(w.funding.run("usdc"), { code: "NEAR_FUNDING_INSUFFICIENT" });
  assert.equal(w.chain.sendTxCount, 0);
});

test("existing refunds may use the operating float, but never another customer's principal or fees", async () => {
  const w = world();
  const first = { id: "r1", paymentId: "p1", status: "queued", to: "payer.testnet", amountYocto: "1000" };
  w.ledger.putRefund(first);
  w.setNear(w.storage + 1000n + w.costs.nativeRefundFeeYocto);
  await assert.rejects(w.funding.quote("near", () => assert.fail("must not quote")));
  await w.funding.beforeSign(first);
  w.ledger.putRefund({ ...first, id: "r2", paymentId: "p2" });
  await assert.rejects(w.funding.beforeSign(first), { code: "NEAR_FUNDING_INSUFFICIENT" });
  w.setNear(w.storage + 2000n + 2n * w.costs.nativeRefundFeeYocto);
  await w.funding.beforeSign(first);
  await assert.rejects(w.funding.beforeSign({ ...first, amountYocto: "1" }), { code: "NEAR_FUNDING_INVALID" });
  assert.equal(w.chain.sendTxCount, 0);
});

test("native wealth cannot cover missing USDC principal, and revoked keys or stale health pause admission", async () => {
  const w = world(); w.putQuote("q", { status: "paid", asset: "usdc", paidYocto: "1000000001" });
  await assert.rejects(w.funding.run("usdc"));
  w.ledger.updateQuote("q", { status: "settled", settlement: { refundYocto: "0" } });
  assert.equal((await w.funding.refresh()).ok, true);
  w.tick(60_001); assert.equal(w.funding.status().ok, false);
  w.chain.accounts.get(MERCHANT).keys.clear();
  assert.equal((await w.funding.refresh()).ok, false);
  await assert.rejects(w.funding.quote("near", () => assert.fail("revoked key")));
  assert.ok(w.chain.log.every(row => ["block", "query", "gas_price", "EXPERIMENTAL_protocol_config"].includes(row.method)));
});

test("deposits discovered during a funding read are included before the quote commits", async () => {
  const w = world();
  let release, waiting;
  const paused = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { waiting = resolve; });
  const rpc = { ...w.rpc, call: async (method, params) => {
    const result = await w.rpc.call(method, params);
    if (params?.request_type === "view_account") { waiting(); await paused; }
    return result;
  } };
  const funding = createNearFunding({ ...w.options, rpc });
  const quote = funding.quote("near", () => assert.fail("stale balance must not admit new work"));
  await started;
  w.putQuote("incoming", { status: "paid", paidYocto: (10n ** 25n).toString() });
  release();
  await assert.rejects(quote, { code: "NEAR_FUNDING_INSUFFICIENT" });
});

test("refunds bypass queued free quotes, and the quote queue has a finite bound", async () => {
  const w = world(), events = [];
  const rec = { id: "refund", paymentId: "p", status: "queued", to: "payer.testnet", amountYocto: "1000" };
  w.ledger.putRefund(rec);
  let release, waiting, once = false;
  const hold = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { waiting = resolve; });
  const rpc = { ...w.rpc, call: async (method, params) => {
    const result = await w.rpc.call(method, params);
    if (!once && params?.request_type === "view_account") { once = true; waiting(); await hold; }
    return result;
  } };
  const funding = createNearFunding({ ...w.options, rpc });
  const first = funding.quote("near", () => events.push("first"));
  await started;
  const quotes = Array.from({ length: 17 }, (_, i) => funding.quote("near", () => events.push(`quote${i}`)));
  const observed = Promise.allSettled(quotes);
  const refund = funding.beforeSign(rec).then(() => events.push("refund"));
  release(); await first; await refund;
  const results = await observed;
  assert.equal(results.filter(r => r.reason?.code === "NEAR_FUNDING_BUSY").length, 1);
  assert.ok(events.indexOf("refund") < events.indexOf("quote0"));
  assert.equal(w.chain.sendTxCount, 0);
});

test("a completed refund persists its account-height floor before an older balance can be reused", async () => {
  const w = world(), old = await w.rpc.block({ finality: "final" });
  const refunder = createRefunder({ ...w.options, signer: SIGNER, schedule: () => null,
    minRefundYocto: 1n, beforeSign: w.funding.beforeSign, beforeComplete: w.funding.beforeComplete });
  const refund = await refunder.refund({ paymentId: "p", to: "payer.testnet", amountYocto: 1000n, reason: "change" });
  assert.equal(refund.status, "sent");
  assert.ok(w.ledger.getMeta("refundFinalHeight") > old.header.height);
  const reopened = openNearLedger({ file: w.ledger.file, merchant: MERCHANT, network: "testnet" });
  const rpc = { ...w.rpc, block: ref => ref.finality ? old : w.rpc.block(ref) };
  const funding = createNearFunding({ ...w.options, rpc, ledger: reopened });
  await assert.rejects(funding.quote("near", () => assert.fail("old funds cannot be reused")));
  assert.equal((await funding.refresh()).ok, false);
  assert.equal(w.chain.sendTxCount, 1);
});

test("a mismatched transaction result cannot discharge a refund or advance the funding floor", async () => {
  const w = world();
  const rec = { id: "r", paymentId: "p", txHash: "expected", to: "payer.testnet", amountYocto: "1000", status: "signed" };
  w.ledger.putRefund(rec);
  const result = { transaction: { hash: "wrong", signer_id: MERCHANT, receiver_id: rec.to, actions: [{ Transfer: { deposit: "1000" } }] } };
  await assert.rejects(w.funding.beforeComplete(rec, result));
  assert.equal(w.ledger.getRefund(rec.id).status, "signed"); assert.equal(w.ledger.getMeta("refundFinalHeight"), undefined);
});

test("recent legacy completed refunds seed the persistent floor without paying or rerunning anything", async () => {
  const w = world(), old = await w.rpc.block({ finality: "final" });
  const legacy = createRefunder({ ...w.options, signer: SIGNER, schedule: () => null, minRefundYocto: 1n });
  assert.equal((await legacy.refund({ paymentId: "old", to: "payer.testnet", amountYocto: 1000n, reason: "change" })).status, "sent");
  assert.equal(w.ledger.getMeta("refundFundingV"), undefined);
  await w.funding.refresh();
  assert.equal(w.ledger.getMeta("refundFundingV"), 1);
  assert.ok(w.ledger.getMeta("refundFinalHeight") > old.header.height);
  assert.equal(w.chain.sendTxCount, 1);
  assert.equal(w.chain.log.filter(row => row.method === "tx").length, 1);
});

test("an exhausted persisted nonce pauses new work even when the key and balances are healthy", async () => {
  const w = world(); w.ledger.setMeta("lastNonce", ((1n << 64n) - 1n).toString());
  await assert.rejects(w.funding.quote("near", () => assert.fail("there is no usable refund nonce")));
  assert.equal((await w.funding.refresh()).ok, false); assert.equal(w.chain.sendTxCount, 0);
});
