import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentLiabilities, liquidityChecks, paidNearRunFundingRaw, paidNanoRunFundingRaw } from "../src/operational-state.mjs";

const snapshots = () => ({ nano: { v: 2, quotes: [], owed: [] }, near: { v: 1, quotes: {}, refunds: {}, payouts: {} }, market: [] });
const NOW = 10_000_000;
const balances = liabilities => ({ liabilities, nanoBalanceRaw: (10n ** 31n).toString(), nearBalanceYocto: (10n ** 24n).toString(),
  storageUsage: 500, usdcBalanceAtomic: "1000000000", xnoUsd: "1", providerReserveUsd: "2",
  costs: { storagePriceYocto: 10_000_000_000_000_000_000n, nativeRefundFeeYocto: 200_000_000_000_000_000_000n, tokenRefundFeeYocto: 6_000_000_000_000_000_000_001n } });

test("the monitor recognizes overdue Nano recovery windows without making an unknown late refund spendable", () => {
  const s = snapshots(), expiresAt = NOW - 3_600_001;
  s.nano.historyScan = { through: null, coveredAt: expiresAt, backfill: {
    newest: "A".repeat(64), next: "B".repeat(64), startedAt: NOW - 900_001, fullReceivableWindow: false,
  } };
  s.nano.quotes.push(
    { id: "old", status: "expired", amountRaw: "10", expiresAt, historyUnproven: true },
    { id: "late", status: "expired", amountRaw: "200", expiresAt, paidAt: expiresAt + 1, payHash: "C".repeat(64) },
  );
  const result = paymentLiabilities(s, { now: NOW });
  assert.equal(result.nanoRaw, 200n);
  assert.deepEqual(result.issues, ["nano-history-backfill-delayed", "nano-history-payment-unproven", "nano-late-refund-intent-unknown", "nano-quote-history-overdue"]);
  s.nano.historyScan = { through: "A".repeat(64), coveredAt: NOW, backfill: null };
  s.nano.quotes[0].historyUnproven = false;
  s.nano.owed.push({ event: "refund", amountRaw: "200", journaled: true, createdAt: NOW, fields: { paymentId: "late" } });
  assert.deepEqual(paymentLiabilities(s, { now: NOW }).issues, []);
});

test("all unsettled currencies and creator payouts are reserved without double-counting settlement intents", () => {
  const s = snapshots();
  s.nano.quotes.push({ id: "nano1", status: "paid", amountRaw: "10" }, { id: "nano2", status: "paid", settled: true, amountRaw: "999" });
  s.nano.owed.push({ amountRaw: "20", journaled: true, tries: 0 });
  s.near.quotes.q1 = { id: "q1", status: "settled", settlement: { refundYocto: "100", authorPayout: { amountRaw: "200" } } };
  s.near.refunds.r1 = { paymentId: "q1", amountYocto: "100", status: "signed" };
  s.near.payouts.q1 = { paymentId: "q1", amountRaw: "200", status: "signed" };
  s.near.quotes.q2 = { id: "q2", status: "running", asset: "usdc", paidYocto: "300" };
  s.near.quotes.q3 = { id: "q3", status: "paid", paidYocto: "400" };
  const before = JSON.stringify(s), l = paymentLiabilities(s, { now: NOW });
  assert.equal(l.nanoRaw, 230n); assert.equal(l.nearYocto, 500n); assert.equal(l.usdcAtomic, 300n);
  assert.equal(l.nativeRefunds, 2); assert.equal(l.tokenRefunds, 1); assert.deepEqual(l.issues, []);
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

test("the paid workflow funding check keeps creator overhead and the last unit of USDC deposit dust", () => {
  const raw = 10n ** 30n;
  const paid = { id: "authored", status: "paid", asset: "usdc", author: "nano_author",
    depositUsd: "0.6", paidYocto: "600001", rate: { xnoUsd: "0.2", usdNano: "1000000000", yocto: "1000000" } };
  const total = paidNearRunFundingRaw({ paid, reserved: { ...paid, status: "running" }, unpaid: { ...paid, status: "pending" },
    completed: { ...paid, fundingOutcomeReady: true } });
  const modelCap = 5n * raw / 2n;
  const creatorCap = (600001n * raw + 1199999n) / 1200000n;
  assert.equal(total, modelCap + creatorCap);
  assert.throws(() => paidNearRunFundingRaw({ paid: { ...paid, paidYocto: "0" } }), /invalid-paid-near-amount/);
});

test("only unstarted Nano payments consume additional capital at their locked rates", () => {
  const raw = 10n ** 30n;
  const paid = { status: "paid", amountRaw: String(raw), usd: "0.5", pair: { usdNano: "500000000", raw: String(raw) } };
  const rounding = { ...paid, usd: "0.3", pair: { usdNano: "700000000", raw: String(raw) } };
  const total = paidNanoRunFundingRaw([paid, rounding, { status: "pending" }, { status: "consumed" },
    { status: "paid", settled: true }, { status: "paid", error: "redacted" },
    { status: "paid", result: {} }, { status: "paid", refundExpected: true },
    { status: "paid", executionNeedsReconciliation: true }, { status: "refunded" }]);
  assert.equal(total, raw + (3n * raw + 6n) / 7n);
  assert.throws(() => paidNanoRunFundingRaw([{ ...paid, pair: null }]), /invalid-state-amount/);
  assert.throws(() => paidNanoRunFundingRaw([{ ...paid, usd: null }]), /invalid-paid-nano-amount/);
  assert.throws(() => paidNanoRunFundingRaw([{ ...paid, pair: { ...paid.pair, raw: "0" } }]), /invalid-paid-nano-rate/);
});

test("stuck work, permanently failed refunds and long-pending creator payouts remain visible and reserved", () => {
  const s = snapshots();
  s.nano.quotes.push({ id: "nano1", status: "paid", amountRaw: "10", paidAt: 1 });
  s.nano.owed.push({ amountRaw: "20", journaled: true, tries: 5, at: NOW + 60_000 });
  s.near.quotes.q = { status: "running", paidYocto: "30", paidAtBlockMs: 1 };
  s.near.refunds.r = { amountYocto: "40", status: "failed_permanent" };
  s.near.payouts.p = { paymentId: "p", amountRaw: "50", status: "signed", createdAt: 1 };
  s.market.push({ v: 1, assignments: { a: { phase: "stuck" }, b: { phase: "delivering", updatedAt: 1 } } });
  const l = paymentLiabilities(s, { now: NOW });
  assert.equal(l.nanoRaw, 80n); assert.equal(l.nearYocto, 70n);
  assert.deepEqual(l.issues, ["creator-payout-stuck", "market-assignment-stuck", "market-work-stuck", "nano-paid-work-stuck", "nano-settlement-stuck", "near-paid-work-stuck", "near-refund-failed"]);
});

test("the Nano debt alert uses the original age when the next retry is in the future", () => {
  const s = snapshots();
  const debt = { amountRaw: "20", journaled: true, createdAt: NOW - 900_001, nextAttemptAt: NOW + 60_000, tries: 1 };
  s.nano.owed.push(debt);
  let result = paymentLiabilities(s, { now: NOW });
  assert.deepEqual(result.issues, ["nano-settlement-stuck"]);
  assert.equal(result.nanoRaw, 20n);
  debt.createdAt++;
  result = paymentLiabilities(s, { now: NOW });
  assert.deepEqual(result.issues, []);
});

test("the read-only monitor flags and reserves a legacy Nano debt from its first observation", () => {
  const s = snapshots();
  s.nano.owed.push({ event: "change", amountRaw: "37", createdAt: NOW, tries: 0 });
  const result = paymentLiabilities(s, { now: NOW });
  assert.deepEqual(result.issues, ["nano-settlement-legacy-unverified"]);
  assert.equal(result.nanoRaw, 37n);
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
  config.costs.tokenRefundFeeYocto *= 2n;
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
