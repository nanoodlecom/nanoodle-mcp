// Money-only live snapshots. No prompts/results, RPCs, transfers or execution.
import { fundingRaw, runFundingBudget } from "./run-funding.mjs";
import { parseUsdNano, knownUsd } from "./usd.mjs";
import { authorPayoutRaw } from "./author-payouts.mjs";
import { isNanoHistoryHash } from "./nano-payment-history.mjs";

const nanoStates = new Set(["pending", "paid", "consumed", "expired", "refunded"]);
const nearStates = new Set(["pending", "paid", "running", "settled", "failed", "rejected", "expired"]);
const potentialMarket = new Set(["starting", "started", "running", "delivering", "submitting", "submitted", "reworking", "stuck"]);
const array = value => { if (!Array.isArray(value)) throw Error("invalid-funding-snapshot"); return value; };
const stateRaw = value => {
  if (typeof value !== "string") throw Error("invalid-state-amount");
  try { return fundingRaw(value); } catch { throw Error("invalid-state-amount"); }
};

function legacyMarketReserve(record) {
  const cost = knownUsd(record.run?.costUsd);
  if (cost == null) return 0n;
  const proceeds = knownUsd(record.creator.proceedsCapUsd ?? record.budgetUsd);
  if (!(proceeds > 0)) throw Error("invalid-market-creator-budget");
  const n = parseUsdNano(cost);
  return authorPayoutRaw({ costYocto: n, feeYocto: n / 5n, chargedYocto: parseUsdNano(proceeds) },
    { usdNano: 1_000_000_000n, yocto: 1_000_000_000n }, parseUsdNano(record.creator.xnoUsd));
}

/** Unsettled payer principal and change on legacy records without a known payer. */
export function nanoQuoteClaim(q) {
  if (!nanoStates.has(q?.status)) throw Error("invalid-nano-quote-status");
  if (!q.settled && (["paid", "consumed"].includes(q.status) || (q.status === "expired" && q.payHash))) {
    return stateRaw(q.amountRaw);
  }
  if (q.settled && !q.source && !q.refundExpected && !Number.isSafeInteger(q.runDeadlineAt)
    && q.settleReceipt?.authorAddress === undefined && q.settleReceipt?.change != null) return stateRaw(q.settleReceipt.change);
  return 0n;
}

function nanoAccount(value) {
  return typeof value === "string" && /^(?:nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(value)
    ? value.replace(/^xrb_/, "nano_") : null;
}

function recordedNanoAmount(value) {
  try { return stateRaw(value); } catch { return null; }
}

/** Only newer outcomes promise matching journal or confirmation records. */
function nanoSettlementEvidence(q, debts) {
  const claimed = Number.isSafeInteger(q.runDeadlineAt);
  const refund = q.refundExpected === true || (claimed && !q.settled && (q.error || q.status === "refunded"));
  const r = q.settleReceipt;
  if (!refund && !(q.settled && (claimed || r?.authorAddress !== undefined))) return null;
  const deposit = stateRaw(q.amountRaw);
  const confirmed = q.transferReceipts ?? {};
  const expected = new Map();
  if (refund && !q.settled) {
    expected.set("refund", { amount: deposit, to: nanoAccount(q.source), requireRecipient: q.refundExpected === true });
  } else {
    const change = recordedNanoAmount(r?.change), take = recordedNanoAmount(r?.take);
    if (refund || change === null || take === null || change + take > deposit
      || typeof r.author !== "boolean" || (r.authorAddress !== undefined && r.author !== Boolean(nanoAccount(r.authorAddress)))) {
      return { missing: false, mismatch: true, uncoveredRaw: deposit, unsafeDebts: debts };
    }
    const requireRecipient = r.authorAddress !== undefined;
    expected.set("change", { amount: change, to: nanoAccount(q.source), requireRecipient });
    if (r.author) expected.set("author_payout", { amount: take, to: nanoAccount(r.authorAddress), requireRecipient });
  }

  let missing = false, mismatch = false, uncoveredRaw = 0n;
  const unsafeDebts = new Set();
  for (const [event, { amount, to, requireRecipient }] of expected) {
    if (amount === 0n) continue;
    const associated = debts.filter(o => o.event === event);
    const [debt] = associated;
    const receipt = confirmed[event];
    const recipientKnown = to !== null || (event === "author_payout" && !requireRecipient);
    const correctRecipient = entry => recipientKnown && (to === null ? nanoAccount(entry.to) !== null : nanoAccount(entry.to) === to);
    const debtRaw = debt?.journaled === true && correctRecipient(debt) ? stateRaw(debt.amountRaw) : null;
    const receiptRaw = receipt && isNanoHistoryHash(receipt.hash) && recipientKnown
      && (receipt.to == null && !requireRecipient || correctRecipient(receipt)) ? recordedNanoAmount(receipt.amountRaw) : null;
    const completionInProgress = debt?.completing === true && debt.confirmedHash === receipt?.hash;
    const completedRefund = event === "refund" && q.status === "refunded";
    if ((!debt || completedRefund) && !receipt) missing = true;
    if (associated.length > 1 || (debt && (completedRefund || debtRaw !== amount || (receipt && !completionInProgress)))
      || (receipt && receiptRaw !== amount)) {
      mismatch = true;
      for (const o of associated) unsafeDebts.add(o);
    }
    // The in-flight form retains its debt until the receipt is durable. An
    // overlapping receipt and debt can cover an obligation only once.
    const covered = receiptRaw ?? debtRaw ?? 0n;
    if (amount > covered) uncoveredRaw += amount - covered;
  }
  for (const debt of debts) {
    if (!expected.get(debt.event)?.amount) { mismatch = true; unsafeDebts.add(debt); }
  }
  if (Object.keys(confirmed).some(event => !expected.get(event)?.amount)) mismatch = true;
  return { missing, mismatch, uncoveredRaw, unsafeDebts };
}

/** Shared reserve and diagnostics for the writer and the read-only monitor. */
export function nanoFundingCoverage({ quotes, owed, pending = [] }) {
  array(quotes); array(owed); array(pending);
  const debtsByPayment = new Map(), unresolvedQuotes = new Set(), unsafeDebts = new Set();
  let totalRaw = 0n, missing = false, mismatch = false;
  for (const debt of [...owed, ...pending]) {
    const amount = stateRaw(debt.amountRaw);
    totalRaw += amount;
    const id = debt.fields?.paymentId;
    if (typeof id === "string") {
      if (!debtsByPayment.has(id)) debtsByPayment.set(id, []);
      debtsByPayment.get(id).push(debt);
    }
  }
  for (const q of quotes) {
    if (typeof q.id !== "string" || !q.id) throw Error("invalid-funding-quote");
    if (!nanoStates.has(q.status)) throw Error("invalid-nano-quote-status");
    const debts = debtsByPayment.get(q.id) ?? [];
    const evidence = nanoSettlementEvidence(q, debts);
    if (evidence) {
      totalRaw += evidence.uncoveredRaw;
      if (evidence.missing || evidence.mismatch) unresolvedQuotes.add(q.id);
      missing ||= evidence.missing;
      mismatch ||= evidence.mismatch;
      for (const debt of evidence.unsafeDebts) unsafeDebts.add(debt);
      continue;
    }
    const claim = nanoQuoteClaim(q);
    const covered = debts.filter(d => ["refund", "change"].includes(d.event)).reduce((sum, d) => sum + stateRaw(d.amountRaw), 0n);
    if (claim > covered) totalRaw += claim - covered;
  }
  return { totalRaw, missing, mismatch, unresolvedQuotes, unsafeDebts };
}

export function nanoFundingLiabilities(snapshot) {
  return nanoFundingCoverage(snapshot).totalRaw;
}

function nearCreatorMaximum(q) {
  const base = runFundingBudget({ id: `near:${q.id}`, budgetUsd: q.depositUsd, creator: true,
    pair: { usdNano: parseUsdNano(q.rate?.xnoUsd), raw: 10n ** 30n } }).overheadRaw;
  if (q.paidYocto == null) return base;
  const paid = stateRaw(q.paidYocto), rateUsd = stateRaw(q.rate.usdNano), denominator = stateRaw(q.rate.yocto);
  const xno = parseUsdNano(q.rate.xnoUsd);
  if (!denominator || xno <= 0n) throw Error("invalid-funding-rate");
  // Unique payment dust also exists in the accepted deposit. The maximum
  // collected markup is bounded by one sixth of that exact asset amount.
  const num = paid * rateUsd * 10n ** 30n, den = 6n * denominator * xno;
  const full = (num + den - 1n) / den;
  return full > base ? full : base;
}

export function nearRunFundingBudget(q) {
  const terms = runFundingBudget({ id: `near:${q.id}`, budgetUsd: q.depositUsd,
    pair: { usdNano: parseUsdNano(q.rate?.xnoUsd), raw: 10n ** 30n }, creator: !!q.author });
  if (q.author) terms.overheadRaw = nearCreatorMaximum(q);
  return terms;
}

/** All actual Nano payout intents, plus creator obligations before their intent. */
export function nearCreatorLiabilities({ quotes, payouts }, context) {
  array(quotes); array(payouts);
  const payoutIds = new Set();
  let total = 0n;
  for (const p of payouts) {
    if (payoutIds.has(p.paymentId) || typeof p.paymentId !== "string") throw Error("invalid-payout-snapshot");
    payoutIds.add(p.paymentId);
    if (!["queued", "signed", "sent"].includes(p.status)) throw Error("invalid-payout-status");
    if (p.status !== "sent") {
      const id = p.paymentId.startsWith("market_") ? `market:${p.paymentId.slice(7)}` : `near:${p.paymentId}`;
      const held = fundingRaw(context?.overheadRawByRun?.get(id) ?? 0n);
      const amount = stateRaw(p.amountRaw);
      total += amount > held ? amount - held : 0n;
    }
  }
  for (const q of quotes) {
    if (!nearStates.has(q?.status)) throw Error("invalid-near-quote-status");
    if (payoutIds.has(q.id)) continue; // Sent is final; pending is counted above.
    if (q.settlement?.authorPayout) {
      const amount = stateRaw(q.settlement.authorPayout.amountRaw);
      const held = fundingRaw(context?.overheadRawByRun?.get(`near:${q.id}`) ?? 0n);
      total += amount > held ? amount - held : 0n;
    } else if (q.author && q.fundingOutcomeReady === true && ["paid", "running"].includes(q.status) && !q.settlement) {
      const amount = nearCreatorMaximum(q);
      const held = fundingRaw(context?.overheadRawByRun?.get(`near:${q.id}`) ?? 0n);
      total += amount > held ? amount - held : 0n;
    }
  }
  return total;
}

/** Future creator earnings are a liability; Market revenue is never cash here. */
export function marketCreatorLiabilities(records, { payouts = [], ...context } = {}) {
  array(records); array(payouts);
  const payoutIds = new Set(payouts.map(p => p.paymentId));
  let total = 0n;
  for (const r of records) {
    const c = r.creator;
    if (!c) continue;
    if (!["awaiting_acceptance", "owed", "queued", "none", "cancelled"].includes(c.status)) throw Error("invalid-market-creator-status");
    if (["none", "cancelled"].includes(c.status) || payoutIds.has(`market_${r.id}`)) continue;
    const claim = ["owed", "queued"].includes(c.status) ? stateRaw(c.amountRaw)
      : potentialMarket.has(r.phase) ? c.reserveRaw != null ? stateRaw(c.reserveRaw) : legacyMarketReserve(r) : 0n;
    const held = fundingRaw(context.overheadRawByRun?.get(`market:${r.id}`) ?? 0n);
    total += claim > held ? claim - held : 0n;
  }
  return total;
}
