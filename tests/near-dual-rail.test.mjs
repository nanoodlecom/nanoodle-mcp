/**
 * The NEAR gate with the rates service (swap margin, XNO/USD, three-leg
 * receipts, operator accounting, quote lifetime, old persisted quotes), and the
 * dual-rail router (src/rail-router.mjs) in front of a real Nano charge gate and
 * a real NEAR gate sharing one tool registry. Offline: NanoGPT, the NEAR chain
 * and the Nano node are local stand-ins; no keys, no funds.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools, ParamsError } from "../src/tools.mjs";
import { createNearGate } from "../src/near-gate.mjs";
import { createChargeGate, hashArgs } from "../src/gate.mjs";
import { createRailRouter } from "../src/rail-router.mjs";
import {
  createNearRpc, openNearLedger, createNearUsdRate, createNearRates, createRefunder, parseNearSecretKey, parseNearToYocto,
} from "../src/near/index.mjs";
import { createFakeChain, throwawayNearKey, WORKED_GRAPH, nanoGptMock } from "./fixtures/near-fake-chain.mjs";

const MERCHANT = "merchant.testnet";
const PAYER = "payer.testnet";
const INPUTS = { Idea: "a lighthouse at dawn" };
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const NANO_PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

let realFetch, mock, key, graphsDir;
before(async () => {
  realFetch = globalThis.fetch;
  mock = nanoGptMock();
  globalThis.fetch = mock.fetch;
  key = await throwawayNearKey();
  graphsDir = await mkdtemp(join(tmpdir(), "dual-graphs-"));
  await writeFile(join(graphsDir, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
});
after(() => { globalThis.fetch = realFetch; });

const staticRates = (o = {}) => createNearRates({ nearUsd: "3.64", xnoUsd: "0.95", refreshMs: 0, fetch: async () => { throw new Error("offline"); }, ...o });

async function world({ rate = staticRates(), modelPayment = "api_key", quoteTtlMs, hosted = false } = {}) {
  const out = await mkdtemp(join(tmpdir(), "dual-out-"));
  await mkdir(out, { recursive: true });
  const chain = createFakeChain();
  chain.addAccount(MERCHANT, parseNearToYocto("10"), key.publicKey);
  chain.addAccount(PAYER, parseNearToYocto("5"));
  const registry = await loadTools({ dirs: [graphsDir], apiKey: "test-key", outDir: out, publicBase: "http://127.0.0.1:1", log: () => {}, hosted, remote: true });
  const file = join(out, "near-state.json");
  const events = [];
  let dust = 137;
  const make = (r) => {
    const rpc = createNearRpc({ url: "https://rpc.fake", fetch: chain.fetch });
    const ledger = openNearLedger({ file, network: "testnet", merchant: MERCHANT });
    const refunder = createRefunder({ rpc, signer: parseNearSecretKey(key.secretKey), accountId: MERCHANT, ledger, schedule: () => null });
    const gate = createNearGate({
      merchantId: MERCHANT, network: "testnet", rpc, ledger, refunder, rate: r, fetch: mock.fetch, randomInt: () => dust++,
      usage: (event, fields) => events.push({ event, ...fields }), modelPayment, ...(quoteTtlMs ? { quoteTtlMs } : {}),
    });
    return { gate, ledger, wrapped: gate.wrapRegistry(registry) };
  };
  const g = make(rate);
  return { ...g, chain, registry, out, events, restartWith: async (r) => { const n = make(r); await n.gate.resume(); return n; } };
}

const text = (r) => r.content.map((c) => c.text || "").join("\n");

async function nearPay(callTool, name, args, chain, { extra = {} } = {}) {
  const q = await callTool({ name, arguments: args });
  assert.ok(!q.isError, text(q));
  const p = q.structuredContent.payment;
  const tx = chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto));
  const call = () => callTool({ name, arguments: { ...args, ...extra, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER } });
  return { q, p, tx, call };
}

/* ---------------- NEAR gate + rates service ---------------- */

test("swap margin: the quote, settlement and receipt use the locked spread pair, to the yocto", async () => {
  const w = await world({ rate: staticRates({ spreadBps: 150 }) });
  const { q, p, call } = await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, w.chain);
  // $0.03 at 3.64 USD/NEAR with 1.5% margin = 0.008366 NEAR before dust; dust 137 steps
  assert.equal(p.amountYocto, "8503000000000000000000");
  assert.equal(p.rate.spreadBps, 150);
  assert.equal(p.rate.effectiveNearUsd, "3.586206897");
  assert.equal(p.rate.xnoPerNear, "3.831578947");
  assert.match(text(q), /Rate: 1 NEAR = \$3\.64 \(static, [^)]+\); 1 XNO = \$0\.95 \(static, [^)]+\), so 1 NEAR = 3\.831578947 XNO; swap margin 1\.5%: NEAR amounts use 1 NEAR = \$3\.586206897, locked for this quote; network testnet/);
  const stored = w.ledger.getQuote(p.paymentId);
  assert.equal(stored.rate.yocto, "1015000000000000000000000");
  const paid = await call();
  const rc = paid.structuredContent.receipt;
  assert.equal(rc.outcome, "succeeded");
  assert.equal(rc.charged.yocto, "3148730769230769230769");
  assert.equal(rc.refund.yocto, (8503000000000000000000n - 3148730769230769230769n).toString());
  assert.equal(rc.rate.spreadBps, 150);
  assert.match(text(paid), /Rate 3\.64 USD\/NEAR \(static, [^)]+\); 1 XNO = \$0\.95 .*swap margin 1\.5%.*, locked when quoted\./);
});

test("with 0 bps the numbers are the worked example's, byte for byte", async () => {
  const w = await world();
  const { p, call } = await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, w.chain);
  assert.equal(p.amountYocto, "8379000000000000000000");
  const rc = (await call()).structuredContent.receipt;
  assert.equal(rc.charged.yocto, "3102197802197802197803");
  assert.equal(rc.refund.yocto, "5276802197802197802197");
});

test("three-leg receipt and operator accounting: wallet-funded runs derive the XNO spent at the locked rate", async () => {
  const w = await world({ modelPayment: "wallet" });
  const { p, tx, call } = await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, w.chain);
  const paid = await call();
  const rc = paid.structuredContent.receipt;
  assert.equal(rc.legs.length, 3);
  assert.deepEqual(rc.legs.map((l) => l.leg), ["caller payment", "model payment", "refund"]);
  assert.equal(rc.legs[0].status, "final");
  assert.equal(rc.legs[0].txHash, tx);
  assert.equal(rc.legs[0].yocto, p.amountYocto);
  assert.equal(rc.legs[1].status, "paid");
  assert.equal(rc.legs[1].usd, "0.00941");
  assert.equal(rc.legs[1].xno, "0.009905263"); // $0.00941 / $0.95 per XNO, 9 decimals
  assert.match(rc.legs[1].basis, /derived from the reported cost at the locked XNO\/USD rate/);
  assert.equal(rc.legs[2].status, "sent");
  assert.equal(rc.legs[2].yocto, rc.refund.yocto);
  const t = text(paid);
  assert.match(t, /Leg 1, caller payment: 0\.008379 NEAR, tx \w+, final\./);
  assert.match(t, /Leg 2, model payment to NanoGPT: \$0\.00941 = 0\.009905263 XNO \(XNO derived from the reported cost at the locked XNO\/USD rate\)\./);
  assert.match(t, /Leg 3, refund: ≈0\.005277 NEAR, sent \(tx \w+/);
  // every pre-existing receipt field is still there
  for (const k of ["rail", "network", "paymentId", "deposit", "actualCost", "serviceFee", "charged", "refund", "rate", "outcome"]) assert.ok(k in rc, k);

  const settle = w.events.find((e) => e.event === "change");
  assert.equal(settle.chargedYocto, "3102197802197802197803");
  assert.equal(settle.refundYocto, "5276802197802197802197");
  assert.equal(settle.chargedNear, "0.003102197802197802197803");
  assert.equal(settle.refundNear, "0.005276802197802197802197");
  assert.equal(settle.paidYocto, "8379000000000000000000");
  assert.equal(settle.modelUsd, "0.00941");
  assert.equal(settle.modelXno, "0.009905263");
  assert.equal(settle.modelXnoBasis, "derived");
  assert.equal(settle.modelPayment, "wallet");
  assert.deepEqual(
    { nearUsd: settle.rate.nearUsd, xnoUsd: settle.rate.xnoUsd, xnoPerNear: settle.rate.xnoPerNear, spreadBps: settle.rate.spreadBps },
    { nearUsd: "3.64", xnoUsd: "0.95", xnoPerNear: "3.831578947", spreadBps: 0 });
  assert.ok(JSON.parse(JSON.stringify(settle)), "the ledger line is plain JSON");
});

test("receipt legs: API-key funding, a failed run (unknown, never zero) and a wrong amount (nothing ran)", async () => {
  const w = await world({ modelPayment: "api_key" });
  const ok = await (await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, w.chain)).call();
  const m = ok.structuredContent.receipt.legs[1];
  assert.equal(m.basis, "paid from the operator's NanoGPT balance");
  assert.equal(m.xno, null);
  assert.match(text(ok), /Leg 2, model payment to NanoGPT: \$0\.00941 \(paid from the operator's NanoGPT balance\)\./);

  const failed = await (await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "FAIL please" } }, w.chain)).call();
  const fl = failed.structuredContent.receipt.legs;
  assert.equal(fl[1].status, "unknown");
  assert.equal(fl[1].usd, null);
  assert.match(text(failed), /Leg 2, model payment to NanoGPT: unknown \(/);

  const q = await w.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "short" } } });
  const p = q.structuredContent.payment;
  const tx = w.chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto) - 500_000_000_000_000_000n);
  const wrong = await w.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "short" }, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER } });
  const wl = wrong.structuredContent.receipt.legs;
  assert.equal(wl[1].status, "none");
  assert.match(text(wrong), /Leg 2, model payment to NanoGPT: none \(nothing ran\)\./);
});

test("quote lifetime: 30 minutes by default, configurable, and the rate stays locked for all of it", async () => {
  const w = await world();
  const q = await w.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  const rec = w.ledger.getQuote(q.structuredContent.payment.paymentId);
  assert.equal(rec.expiresAt - rec.createdAt, 30 * 60_000);
  assert.match(text(q), /expires in about 30 minutes/);
  const w5 = await world({ quoteTtlMs: 5 * 60_000 });
  const q5 = await w5.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  const r5 = w5.ledger.getQuote(q5.structuredContent.payment.paymentId);
  assert.equal(r5.expiresAt - r5.createdAt, 5 * 60_000);

  // the rate moves after the quote: the payment still settles at the locked one
  const rates = staticRates();
  const wm = await world({ rate: rates });
  const { call } = await nearPay(wm.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, wm.chain);
  await rates.reload({ nearUsd: "7.28", xnoUsd: "0.5", spreadBps: 500 });
  const rc = (await call()).structuredContent.receipt;
  assert.equal(rc.charged.yocto, "3102197802197802197803");
  assert.equal(rc.rate.nearUsd, "3.64");
  assert.equal(rc.rate.xnoUsd, "0.95");
});

test("a quote persisted before the rates service (no XNO/swap fields) still loads, settles and gets a receipt", async () => {
  const w = await world({ rate: createNearUsdRate({ staticUsd: "3.64" }) });
  const { p, tx } = await nearPay(w.wrapped.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, w.chain);
  const old = w.ledger.getQuote(p.paymentId);
  assert.equal("xnoUsd" in old.rate, false, "an old-style record");
  // restart on the new rates service and pay the old quote
  const n = await w.restartWith(staticRates({ spreadBps: 300 }));
  const paid = await n.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER } });
  const rc = paid.structuredContent.receipt;
  assert.equal(rc.outcome, "succeeded");
  assert.equal(rc.charged.yocto, "3102197802197802197803", "settled at the old record's own pair, not today's margin");
  assert.deepEqual(rc.rate, { nearUsd: "3.64", source: "static", at: old.rate.at });
  assert.match(text(paid), /Rate 3\.64 USD\/NEAR \(static, [^)]+\), locked when quoted\./);
  assert.equal(rc.legs.length, 3);
});

test("wallet-funded server with no XNO/USD: no NEAR quote, nothing stored; API-key server quotes and shows it unavailable", async () => {
  const down = { fetch: async () => { throw new Error("offline"); } };
  const ww = await world({ rate: createNearRates({ nearUsd: "3.64", xnoRequired: true, refreshMs: 0, ...down }), modelPayment: "wallet" });
  const r = await ww.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  assert.equal(r.isError, true);
  assert.match(text(r), /no current XNO\/USD rate \(this server pays its model provider in XNO, so the NEAR to XNO swap rate is unknown\)/);
  assert.equal(ww.ledger.quotes().length, 0);

  const wk = await world({ rate: createNearRates({ nearUsd: "3.64", refreshMs: 0, ...down }) });
  const ok = await wk.wrapped.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  assert.ok(!ok.isError);
  assert.equal(ok.structuredContent.payment.rate.xnoUsd, null);
  assert.match(text(ok), /; XNO\/USD unavailable, locked for this quote/);
});

/* ---------------- the dual-rail router ---------------- */

/** Nano node stand-in: the receivable set the Nano gate polls, and the sends it makes. */
function nanoNode() {
  const state = { receivable: {}, transfers: [] };
  return {
    state,
    ops: {
      rpc: async (b) => (b.action === "receivable" ? { blocks: { ...state.receivable } } : { history: [] }),
      transfer: async (to, amountRaw, describe) => { state.transfers.push({ to, amountRaw, describe }); return "F".repeat(64); },
    },
  };
}

async function dual() {
  const w = await world({ hosted: true });
  const node = nanoNode();
  const nanoGate = createChargeGate({
    address: GATE_ADDR, ops: node.ops, usd: 0.05, xnoUsd: 1,
    validate: (p) => w.registry.prepareCall(p), publicBase: "http://pay.test", pollMs: 5, waitMs: 2_000,
  });
  const nano = nanoGate.wrapRegistry(w.registry);
  const router = createRailRouter({ nano, near: w.wrapped });
  return { ...w, node, nano, router };
}

test("router tools/list: the Nano list unchanged, NEAR-only tools added, saved tools say they can be paid in NEAR", async () => {
  const d = await dual();
  const nanoList = d.nano.listTools();
  const list = d.router.listTools();
  assert.deepEqual(list.map((t) => t.name), [...nanoList.map((t) => t.name), "run_noodle", "price_noodle", "noodle_guide"]);
  const poster = list.find((t) => t.name === "idea-poster");
  const nanoPoster = nanoList.find((t) => t.name === "idea-poster");
  assert.ok(poster.description.startsWith(nanoPoster.description), "the Nano description and price stay first");
  assert.match(poster.description, /It can also be paid in NEAR: add "_pay_with": "near"/);
  assert.deepEqual(poster.inputSchema.properties._pay_with.enum, ["nano", "near"]);
  assert.ok(poster.inputSchema.properties._payment_tx && poster.inputSchema.properties._payment_sender);
  assert.deepEqual(poster.inputSchema.properties._payment_id, nanoPoster.inputSchema.properties._payment_id);
  // a tool the NEAR gate does not sell keeps its Nano entry exactly
  const builtin = nanoList.find((t) => t.name !== "idea-poster");
  assert.deepEqual(list.find((t) => t.name === builtin.name), builtin);
});

test("router: every routing branch", async () => {
  const d = await dual();
  const R = (name, args) => d.router.route({ name, arguments: args });
  assert.equal(R("run_noodle", { graph: {} }).gate, "near");
  assert.equal(R("price_noodle", { _pay_with: "near" }).gate, "near");
  assert.equal(R("noodle_guide", undefined).gate, "near");
  assert.equal(R("idea-poster", { Idea: "x", _payment_id: "nq_abc" }).gate, "near");
  assert.equal(R("idea-poster", { Idea: "x", _payment_id: "nq_abc", _pay_with: "near" }).gate, "near");
  assert.equal(R("idea-poster", { Idea: "x", _payment_id: "pay_abc" }).gate, "nano");
  assert.equal(R("idea-poster", { Idea: "x", _pay_with: "near" }).gate, "near");
  assert.equal(R("idea-poster", { Idea: "x", _pay_with: "nano" }).gate, "nano");
  assert.equal(R("idea-poster", { Idea: "x" }).gate, "nano");
  assert.equal(R("idea-poster", { Idea: "x", _payment_id: "other" }).gate, "nano");
  assert.equal(R("idea-poster", { Idea: "x", _payment_id: "other", _payment_tx: "t" }).gate, "near");
  assert.equal(d.router.route(null).gate, "nano");
  // _pay_with never reaches a gate
  assert.deepEqual(R("idea-poster", { Idea: "x", _pay_with: "near" }).params.arguments, { Idea: "x" });
  assert.deepEqual(R("idea-poster", { Idea: "x", _payment_id: "nq_a", _pay_with: "near" }).params.arguments, { Idea: "x", _payment_id: "nq_a" });
  // refusals
  for (const [name, args, re] of [
    ["idea-poster", { Idea: "x", _pay_with: "bitcoin" }, /_pay_with must be "nano" or "near"/],
    ["idea-poster", { Idea: "x", _payment_id: "nq_a", _pay_with: "nano" }, /is a NEAR quote, but "_pay_with" says nano/],
    ["idea-poster", { Idea: "x", _payment_id: "pay_a", _pay_with: "near" }, /is a Nano \(XNO\) quote/],
    ["idea-poster", { Idea: "x", _payment_id: "pay_a", _payment_tx: "t" }, /is a Nano \(XNO\) quote/],
    ["idea-poster", { Idea: "x", _payment_tx: "t", _payment_sender: "a.testnet" }, /ask for one with "_pay_with": "near"/],
    ["run_noodle", { graph: {}, _pay_with: "nano" }, /paid in NEAR only on this server/],
    ["sfw_check", { _pay_with: "near" }, /cannot be paid in NEAR on this server\. Pay in Nano \(XNO\) instead: call it again without "_pay_with"/],
  ]) {
    const r = R(name, args);
    assert.match(r.refusal || "", re, JSON.stringify(args));
    const res = await d.router.callTool({ name, arguments: args });
    assert.equal(res.isError, true);
    assert.match(text(res), /Nothing was (charged|consumed)/);
  }
  assert.equal(d.ledger.quotes().length, 0, "no refusal created a NEAR quote");
  await assert.rejects(d.router.callTool({ name: "nope", arguments: {} }), (e) => e instanceof ParamsError && /available: .*idea-poster.*run_noodle/.test(e.message));
});

test("router: a saved tool paid in NEAR; the paying call hashes the same with or without _pay_with; replay through the router", async () => {
  const d = await dual();
  const args = { Idea: "a lighthouse at dawn" };
  assert.equal(hashArgs("idea-poster", args), hashArgs("idea-poster", d.router.route({ name: "idea-poster", arguments: { ...args, _pay_with: "near" } }).params.arguments));
  for (const repeat of [true, false]) {
    const runs0 = mock.runs();
    const { p, call } = await nearPay(d.router.callTool, "idea-poster", { ...args, _pay_with: "near" }, d.chain, { extra: repeat ? {} : { _pay_with: undefined } });
    assert.match(p.paymentId, /^nq_/);
    assert.equal(d.ledger.getQuote(p.paymentId).argsHash, hashArgs("idea-poster", args));
    // The paying call either repeats "_pay_with": "near" or leaves it out (undefined is absent).
    const paid = await call();
    assert.equal(paid.structuredContent.receipt.outcome, "succeeded", text(paid));
    const replay = await call();
    assert.equal(replay.structuredContent.receipt.paymentId, p.paymentId);
    assert.equal(mock.runs(), runs0 + 1, "ran once, replayed once");
  }
});

test("router: the same saved tool paid in Nano; replay through the router; and a NEAR-paid custom graph", async () => {
  const d = await dual();
  const args = { Idea: "a lighthouse at dawn" };
  const q = await d.router.callTool({ name: "idea-poster", arguments: args });
  const x = q.structuredContent.x402;
  assert.match(x.paymentId, /^pay_/);
  d.node.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: NANO_PAYER };
  const runs0 = mock.runs();
  const paid = await d.router.callTool({ name: "idea-poster", arguments: { ...args, _payment_id: x.paymentId } });
  assert.ok(!paid.isError, text(paid));
  assert.match(text(paid), /XNO deposit/);
  const replay = await d.router.callTool({ name: "idea-poster", arguments: { ...args, _payment_id: x.paymentId, _pay_with: "nano" } });
  assert.deepEqual(replay, paid);
  assert.equal(mock.runs(), runs0 + 1);
  assert.equal(d.ledger.quotes().length, 0, "the NEAR gate saw nothing");

  const { call } = await nearPay(d.router.callTool, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, d.chain);
  const custom = await call();
  assert.equal(custom.structuredContent.receipt.charged.yocto, "3102197802197802197803");
});
