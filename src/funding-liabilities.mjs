// Money-only live snapshots. No prompts/results, RPCs, transfers or execution.
import { fundingRaw, runFundingBudget } from "./run-funding.mjs";
import { parseUsdNano, knownUsd } from "./usd.mjs";
import { authorPayoutRaw } from "./author-payouts.mjs";

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

/** Amount still owed to a Nano payer, independently of retained result text. */
export function nanoQuoteClaim(q) {
  if (!nanoStates.has(q?.status)) throw Error("invalid-nano-quote-status");
  if (!q.settled && (["paid", "consumed"].includes(q.status) || (q.status === "expired" && q.payHash))) {
    return stateRaw(q.amountRaw);
  }
  if (q.settled && !q.source && q.settleReceipt?.change != null) return stateRaw(q.settleReceipt.change);
  return 0n;
}

export function nanoFundingLiabilities({ quotes, owed, pending = [] }) {
  array(quotes); array(owed); array(pending);
  const coveredByPayment = new Map();
  let total = 0n;
  for (const debt of [...owed, ...pending]) {
    const amount = stateRaw(debt.amountRaw);
    total += amount;
    if (["refund", "change"].includes(debt.event) && typeof debt.fields?.paymentId === "string") {
      const id = debt.fields.paymentId;
      coveredByPayment.set(id, (coveredByPayment.get(id) ?? 0n) + amount);
    }
  }
  for (const q of quotes) {
    if (typeof q.id !== "string" || !q.id) throw Error("invalid-funding-quote");
    const claim = nanoQuoteClaim(q);
    const covered = coveredByPayment.get(q.id) ?? 0n;
    if (claim > covered) total += claim - covered;
  }
  return total;
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
