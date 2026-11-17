import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentLiabilities, liquidityChecks } from "../src/operational-state.mjs";

const snapshots = () => ({ nano: { v: 2, quotes: [], owed: [] }, near: { v: 1, quotes: {}, refunds: {}, payouts: {} }, market: [] });
const NOW = 10_000_000;
const balances = liabilities => ({ liabilities, nanoBalanceRaw: (10n ** 31n).toString(), nearBalanceYocto: (10n ** 24n).toString(),
  storageUsage: 500, storagePriceYocto: "10000000000000000000", usdcBalanceAtomic: "1000000000", gasPriceYocto: "100000000", transferGas: 1_000_000_000_000n, xnoUsd: "1", providerReserveUsd: "2" });

test("all unsettled currencies and creator payouts are reserved without double-counting settlement intents", () => {
  const s = snapshots();
  s.nano.quotes.push({ status: "paid", amountRaw: "10" }, { status: "paid", settled: true, amountRaw: "999" });
  s.nano.owed.push({ amountRaw: "20", tries: 0 });
  s.near.quotes.q1 = { id: "q1", status: "settled", settlement: { refundYocto: "100", authorPayout: { amountRaw: "200" } } };
  s.near.refunds.r1 = { paymentId: "q1", amountYocto: "100", status: "signed" };
  s.near.payouts.q1 = { paymentId: "q1", amountRaw: "200", status: "signed" };
  s.near.quotes.q2 = { id: "q2", status: "running", asset: "usdc", paidYocto: "300" };
  s.near.quotes.q3 = { id: "q3", status: "paid", paidYocto: "400" };
  const before = JSON.stringify(s), l = paymentLiabilities(s, { now: NOW });
  assert.equal(l.nanoRaw, 230n); assert.equal(l.nearYocto, 500n); assert.equal(l.usdcAtomic, 300n);
  assert.equal(l.nativeRefunds, 1); assert.deepEqual(l.issues, []);
  assert.equal(JSON.stringify(s), before, "accounting must never mutate or retry money state");
});

test("a crash before refund/payout intent creation cannot erase those liabilities", () => {
  const s = snapshots();
  s.near.quotes.q1 = { id: "q1", status: "settled", asset: "usdc", settlement: { refundYocto: "200", authorPayout: { amountRaw: "300" } } };
  const l = paymentLiabilities(s);
  assert.equal(l.usdcAtomic, 200n); assert.equal(l.nanoRaw, 300n); assert.equal(l.tokenRefunds, 1);
  assert.deepEqual(l.issues, ["creator-payout-intent-missing", "near-refund-intent-missing"]);
  s.near.refunds.r = { paymentId: "q1", asset: "usdc", amountYocto: "200", status: "sent" };
  s.near.payouts.q1 = { paymentId: "q1", amountRaw: "300", status: "sent" };
  const done = paymentLiabilities(s); assert.equal(done.nanoRaw, 0n); assert.equal(done.usdcAtomic, 0n); assert.deepEqual(done.issues, []);
});

test("stuck work, permanently failed refunds and long-pending creator payouts remain visible and reserved", () => {
  const s = snapshots();
  s.nano.quotes.push({ status: "paid", amountRaw: "10", paidAt: 1 });
  s.nano.owed.push({ amountRaw: "20", tries: 5, at: NOW + 60_000 });
  s.near.quotes.q = { status: "running", paidYocto: "30", paidAtBlockMs: 1 };
  s.near.refunds.r = { amountYocto: "40", status: "failed_permanent" };
  s.near.payouts.p = { amountRaw: "50", status: "signed", createdAt: 1 };
  s.market.push({ v: 1, assignments: { a: { phase: "stuck" }, b: { phase: "delivering", updatedAt: 1 } } });
  const l = paymentLiabilities(s, { now: NOW });
  assert.equal(l.nanoRaw, 80n); assert.equal(l.nearYocto, 70n);
  assert.deepEqual(l.issues, ["creator-payout-stuck", "market-assignment-stuck", "market-work-stuck", "nano-paid-work-stuck", "nano-settlement-stuck", "near-paid-work-stuck", "near-refund-failed"]);
});

test("deferred Market income is not spendable and concurrent accepted work reserves the shared pool", () => {
  const s = snapshots();
  s.market.push({ v: 1, assignments: { a: { phase: "running", pricing: { depositUsd: 2 } }, b: { phase: "starting", budgetUsd: 3 }, c: { phase: "submitted", budgetUsd: 999 } } });
  const l = paymentLiabilities(s); assert.equal(l.marketUsdNano, 5_000_000_000n);
  const config = balances(l); config.nanoBalanceRaw = (6n * 10n ** 30n).toString();
  assert.equal(liquidityChecks(config).find(c => c.stage === "nano-liquidity").ok, false, "five dollars reserved plus two dollars of new work exceeds six dollars");
  config.nanoBalanceRaw = (7n * 10n ** 30n).toString();
  assert.equal(liquidityChecks(config).find(c => c.stage === "nano-liquidity").ok, true);
});

test("a workflow without paid model steps requires no Market model-cost reservation", () => {
  const s = snapshots(); s.market.push({ v: 1, assignments: { free: { phase: "running", pricing: { depositUsd: 0 } } } });
  assert.equal(paymentLiabilities(s).marketUsdNano, 0n);
});

test("USDC funds do not cover NEAR gas or storage, and gas price increases are included", () => {
  const s = snapshots();
  s.near.refunds.r = { status: "queued", asset: "usdc", amountYocto: "100" };
  const config = balances(paymentLiabilities(s));
  config.nearBalanceYocto = "60000000000000000000000"; // .06 NEAR; .05 reserve + .005 storage + .006 maximum gas allowance
  let checks = liquidityChecks(config);
  assert.equal(checks.find(c => c.stage === "near-liquidity").ok, false);
  assert.equal(checks.find(c => c.stage === "usdc-liquidity").ok, true);
  config.nearBalanceYocto = "62000000000000000000000";
  assert.equal(liquidityChecks(config).find(c => c.stage === "near-liquidity").ok, true);
  config.gasPriceYocto = "200000000";
  assert.equal(liquidityChecks(config).find(c => c.stage === "near-liquidity").ok, false);
});

test("a pool cannot spend funds already owed to customers, including rounding at one raw unit", () => {
  const s = snapshots(); s.nano.owed.push({ amountRaw: "1" });
  const config = balances(paymentLiabilities(s)); config.nanoBalanceRaw = (2n * 10n ** 30n).toString();
  assert.equal(liquidityChecks(config)[0].ok, false);
  config.nanoBalanceRaw = (2n * 10n ** 30n + 1n).toString();
  assert.equal(liquidityChecks(config)[0].ok, true);
  config.xnoUsd = "3"; config.nanoBalanceRaw = "666666666666666666666666666667";
  assert.equal(liquidityChecks(config)[0].ok, false, "provider need rounds up before adding the one raw customer liability");
});

test("missing ledgers and malformed money or reservations are never treated as zero obligations", () => {
  assert.throws(() => paymentLiabilities({}), /state-shape/);
  for (const value of [undefined, -1, "-1", "NaN", "0.1", "9".repeat(40)]) {
    const s = snapshots(); s.nano.owed.push({ amountRaw: value }); assert.throws(() => paymentLiabilities(s), /state-amount/);
  }
  const s = snapshots(); s.market.push({ v: 1, assignments: { x: { phase: "running", budgetUsd: Infinity } } });
  assert.throws(() => paymentLiabilities(s), /market-reservation/);
  const config = balances(paymentLiabilities(snapshots())); config.xnoUsd = "0";
  assert.throws(() => liquidityChecks(config), /funding-rate/);
});
