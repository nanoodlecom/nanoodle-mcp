import { test } from "node:test";
import assert from "node:assert/strict";
import { nanoFundingLiabilities, nearCreatorLiabilities, nearRunFundingBudget, marketCreatorLiabilities } from "../src/funding-liabilities.mjs";
import { createRunFunding, runFundingBudget } from "../src/run-funding.mjs";

const XNO = 10n ** 30n;
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
