import { test } from "node:test";
import assert from "node:assert/strict";
import { nanoFundingCoverage, nanoFundingLiabilities, nearCreatorCoverage, nearCreatorLiabilities,
  nearRunFundingBudget, marketCreatorCoverage, marketCreatorLiabilities } from "../src/funding-liabilities.mjs";
import { createRunFunding, runFundingBudget } from "../src/run-funding.mjs";

const XNO = 10n ** 30n;
const payer = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const creator = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const quote = patch => ({ id: "q", status: "paid", amountRaw: "100", ...patch });
const debt = (amountRaw, event = "refund") => ({ amountRaw, event, fields: { paymentId: "q" } });

test("Nano customer deposits, in-flight sends and exhausted retry debts stay reserved", () => {
  assert.equal(nanoFundingLiabilities({ quotes: [quote()], owed: [] }), 100n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote()], owed: [], pending: [debt("100")] }), 100n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote()], owed: [{ ...debt("100"), held: true, tries: 100 }] }), 100n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote()], owed: [debt("40")] }), 100n,
    "a partial intent cannot erase the rest of a full refund claim");
  assert.equal(nanoFundingLiabilities({ quotes: [quote()], owed: [debt("100"), { amountRaw: "20", event: "author_payout" }] }), 120n);
});

test("completed text records reserve no new deposit; unknown-payer refunds and change remain claims", () => {
  assert.equal(nanoFundingLiabilities({ quotes: [quote({ settled: true, source: "payer" })], owed: [] }), 0n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote({ status: "consumed", error: "redacted" })], owed: [] }), 100n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote({ settled: true, source: null, settleReceipt: { change: "60" } })], owed: [] }), 60n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote({ settled: true, source: null, settleReceipt: { change: "60" } })], owed: [debt("60", "change")] }), 60n);
  assert.equal(nanoFundingLiabilities({ quotes: [quote({ status: "expired", payHash: "late-transfer" })], owed: [] }), 100n);
});

test("modern Nano settlement evidence reserves each missing or short leg independently", async () => {
  const q = quote({ settled: true, source: payer, runDeadlineAt: 123, settleReceipt: {
    author: true, authorAddress: creator, change: "30", take: "20",
  } });
  const change = { ...debt("30", "change"), to: payer, journaled: true };
  const shortPayout = { ...debt("10", "author_payout"), to: creator, journaled: true };
  const inspect = (owed = []) => nanoFundingCoverage({ quotes: [q], owed });
  assert.equal(inspect().totalRaw, 50n);
  assert.equal(inspect().missing, true);
  assert.deepEqual([...inspect().unresolvedQuotes], ["q"]);
  assert.equal(inspect([change, shortPayout]).totalRaw, 50n);
  assert.equal(inspect([change, shortPayout]).mismatch, true);
  assert.deepEqual([...inspect([change, shortPayout]).unsafeDebts], [shortPayout]);

  const pool = createRunFunding({ serial: fn => fn(), balance: async () => 50n, liabilitiesRaw: () => inspect().totalRaw });
  const terms = runFundingBudget({ id: "another-run", budgetUsd: 0.01, pair: { usdNano: 1_000_000_000n, raw: 1_000n } });
  let calls = 0;
  await assert.rejects(pool.run(terms, () => { calls++; }), { code: "FUNDING_INSUFFICIENT" });
  assert.equal(calls, 0);

  const hash = "A".repeat(64);
  q.transferReceipts = { change: { hash, amountRaw: "30", to: payer },
    author_payout: { hash: "B".repeat(64), amountRaw: "20", to: creator } };
  assert.equal(inspect().totalRaw, 0n);
  assert.equal(inspect().mismatch, false);
  await pool.run(terms, () => { calls++; });
  assert.equal(calls, 1);
  assert.equal(inspect([{ ...change, completing: true, confirmedHash: hash }]).totalRaw, 30n,
    "an in-memory completion keeps its debt reserved until the snapshot is durable");
  q.transferReceipts.change.to = creator;
  assert.equal(inspect().totalRaw, 30n, "the creator's address does not prove the customer's change");
  assert.equal(inspect().mismatch, true);
  q.settleReceipt.change = "81";
  assert.equal(inspect().totalRaw, 100n, "impossible settlement amounts preserve the deposit");
});

test("a marked Nano refund requires proof even when its quote already says refunded", () => {
  const q = quote({ status: "refunded", source: payer, refundExpected: true });
  const snapshot = { quotes: [q], owed: [] };
  const inspect = () => nanoFundingCoverage(snapshot);
  assert.equal(inspect().totalRaw, 100n);
  assert.equal(inspect().missing, true);
  q.transferReceipts = { refund: { hash: "A".repeat(64), amountRaw: "60", to: payer } };
  assert.equal(inspect().totalRaw, 40n);
  assert.equal(inspect().mismatch, true);
  q.transferReceipts.refund.amountRaw = "100";
  assert.equal(inspect().totalRaw, 0n);
  assert.equal(inspect().mismatch, false);
});

test("earlier Nano outcomes preserve the receipt formats their writer actually emitted", () => {
  const receipt = { hash: "A".repeat(64), amountRaw: "25" };
  const q = quote({ settled: true, source: payer, settleReceipt: { author: false, change: "25", take: "0" } });
  const snapshot = { quotes: [q], owed: [] };
  assert.equal(nanoFundingCoverage(snapshot).totalRaw, 0n, "pre-journal settlements had no transfer receipts");
  q.runDeadlineAt = 123;
  q.transferReceipts = { change: receipt };
  assert.equal(nanoFundingCoverage(snapshot).totalRaw, 0n, "the preceding journal stored hash and amount before recipient");
  q.settleReceipt.authorAddress = null;
  assert.equal(nanoFundingCoverage(snapshot).totalRaw, 25n, "the current format requires a confirmed recipient");
});

test("creator fees move from active overhead to the durable NEAR completion checkpoint", () => {
  const q = { id: "q", author: "creator", status: "running", depositUsd: "1.2", rate: { xnoUsd: "1" } };
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }), 0n, "unstarted conditional fees cannot take another run's reservation");
  q.fundingOutcomeReady = true;
  const context = { overheadRawByRun: new Map([["near:q", XNO / 5n]]) };
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }, context), 0n);
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }), XNO / 5n);
  q.settlement = { authorPayout: { amountRaw: "10" } };
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }), 10n);
  const payout = { paymentId: "q", status: "queued", amountRaw: "10" };
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [payout] }), 10n);
  payout.status = "sent";
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [payout] }), 0n);
});

test("NEAR and USDC payment dust is covered without increasing model spend authority", () => {
  for (const [paidYocto, denominator] of [["1800000000000000000000000", "1000000000000000000000000"], ["1800000", "1000000"]]) {
    const q = { id: "dust", author: "creator", status: "running", fundingOutcomeReady: true, depositUsd: "1.2", paidYocto,
      rate: { usdNano: "1000000000", yocto: denominator, xnoUsd: "1" } };
    const terms = nearRunFundingBudget(q);
    assert.equal(terms.maxRaw, XNO);
    assert.equal(terms.overheadRaw, 3n * XNO / 10n);
    assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }), terms.overheadRaw);
  }
});

test("Market fees remain held after a run and deduplicate against actual payout intents", () => {
  const r = { id: "a", phase: "running", budgetUsd: 1.2, creator: { status: "awaiting_acceptance", xnoUsd: "1" } };
  assert.equal(marketCreatorLiabilities([r]), 0n);
  r.creator.reserveRaw = "20";
  assert.equal(marketCreatorLiabilities([r], { overheadRawByRun: new Map([["market:a", 20n]]) }), 0n);
  assert.equal(marketCreatorLiabilities([r]), 20n);
  r.phase = "submitted"; r.creator.status = "owed"; r.creator.amountRaw = "20";
  assert.equal(marketCreatorLiabilities([r]), 20n);
  const payouts = [{ paymentId: "market_a", status: "signed", amountRaw: "20" }];
  assert.equal(marketCreatorLiabilities([r], { payouts }) + nearCreatorLiabilities({ quotes: [], payouts }), 20n);
  payouts[0].status = "sent";
  assert.equal(marketCreatorLiabilities([r], { payouts }) + nearCreatorLiabilities({ quotes: [], payouts }), 0n);
  r.creator.status = "cancelled";
  assert.equal(marketCreatorLiabilities([r]), 0n);
});

test("NEAR and Market creator payout evidence covers only the matching amount and recipient", () => {
  const quote = { id: "near-job", status: "settled", settlement: { authorPayout: { amountRaw: "100", to: creator } } };
  const assignment = { id: "market-job", phase: "submitted", creator: { status: "queued", author: creator, amountRaw: "100" } };
  const base = { to: creator, amountRaw: "50", status: "sent" };
  const payouts = [{ ...base, paymentId: quote.id }, { ...base, paymentId: `market_${assignment.id}` }];
  const near = () => nearCreatorCoverage({ quotes: [quote], payouts });
  const market = () => marketCreatorCoverage([assignment], { payouts });
  assert.deepEqual(near(), { totalRaw: 50n, missing: false, mismatch: true });
  assert.deepEqual(market(), { totalRaw: 50n, missing: false, mismatch: true });

  payouts[0].to = payer; payouts[1].to = payer;
  assert.equal(near().totalRaw, 100n);
  assert.equal(market().totalRaw, 100n);
  for (const record of payouts) Object.assign(record, { to: creator, amountRaw: "60", status: "signed" });
  const context = { overheadRawByRun: new Map([["near:near-job", 70n], ["market:market-job", 70n]]) };
  assert.equal(nearCreatorLiabilities({ quotes: [quote], payouts }, context)
    + marketCreatorLiabilities([assignment], { ...context, payouts }), 60n,
  "each run's overhead offsets the recorded debt and the uncovered remainder only once");

  for (const record of payouts) Object.assign(record, { amountRaw: "100", status: "sent" });
  assert.deepEqual(near(), { totalRaw: 0n, missing: false, mismatch: false });
  assert.deepEqual(market(), { totalRaw: 0n, missing: false, mismatch: false });
  assignment.creator.status = "awaiting_acceptance";
  assignment.creator.reserveRaw = "100";
  assert.equal(market().totalRaw, 100n, "an outbox row cannot prove a Market buyer accepted the work");
  assert.equal(market().mismatch, true);
});

test("legacy completed Market work still reserves its earned fee without counting deferred revenue", () => {
  const r = { id: "a", phase: "submitted", budgetUsd: 1.2, run: { costUsd: 1 },
    creator: { status: "awaiting_acceptance", xnoUsd: "0.5" } };
  assert.equal(marketCreatorLiabilities([r]), 4n * XNO / 10n);
  r.phase = "declined";
  assert.equal(marketCreatorLiabilities([r]), 0n);
});

test("candidate overhead is not double reserved, and its completion handoff cannot free creator money", async () => {
  const q = { id: "q", status: "running", author: "creator", depositUsd: "1.2", rate: { xnoUsd: "1" } };
  const terms = runFundingBudget({ id: "near:q", budgetUsd: q.depositUsd, creator: true,
    pair: { usdNano: 1_000_000_000n, raw: XNO } });
  const pool = createRunFunding({ serial: fn => fn(), balance: async () => 12n * XNO / 10n,
    liabilitiesRaw: context => nearCreatorLiabilities({ quotes: [q], payouts: [] }, context) });
  await pool.run(terms, () => {
    q.fundingOutcomeReady = true;
    assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }, { overheadRawByRun: new Map([[terms.id, terms.overheadRaw]]) }), 0n);
  });
  assert.equal(nearCreatorLiabilities({ quotes: [q], payouts: [] }), XNO / 5n);
  assert.equal(pool.snapshot().reservedRaw, "0", "closed engine capital is released while the fee stays in live debts");
});

test("malformed financial snapshots fail closed instead of becoming zero liabilities", () => {
  for (const value of [undefined, -1, 1n, "NaN", "1.5", "9".repeat(40)]) {
    assert.throws(() => nanoFundingLiabilities({ quotes: [], owed: [{ amountRaw: value }] }), /state-amount/);
  }
  assert.throws(() => nearCreatorLiabilities({ quotes: [], payouts: [{ paymentId: "x", status: "unknown" }] }), /payout-status/);
  assert.throws(() => marketCreatorLiabilities([{ creator: { status: "unknown" } }]), /creator-status/);
});
