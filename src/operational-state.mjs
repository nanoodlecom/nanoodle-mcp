// Read-only accounting for probes and admission checks. Never opens a ledger,
// signs a transaction, retries an assignment, or returns customer content.
import { parseUsdNano } from "./usd.mjs";
import { nanoFundingLiabilities, nanoQuoteClaim, marketCreatorLiabilities } from "./funding-liabilities.mjs";
import { NEAR_OPERATING_RESERVE, nearRefundClaims, nearFundingNeed } from "./near/funding.mjs";
import { holdsNearQuoteAmount, nearPaymentWatchCoverage, PAYMENT_WATCH_META, RETAIN_NEAR_QUOTE_MS } from "./near/quote-capacity.mjs";
import { NANO_LATE_WATCH_MS, nanoQuoteNeedsHistory, readNanoPaymentHistory } from "./nano-payment-history.mjs";
import { creatorNanoTransferClaims, gateNanoTransferClaims, hasConflictingNanoTransferClaims } from "./nano-transfer-journal.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const U128_MAX = (1n << 128n) - 1n;
const NANO_EXECUTION_GRACE_MS = 5 * 60_000;
function amount(value) {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128_MAX) throw Error("invalid-state-amount");
  return BigInt(value);
}
function values(value) { if (!object(value)) throw Error("invalid-state-shape"); return Object.values(value); }

export function paymentLiabilities({ nano, near, market = [] }, { now = Date.now(), stuckMs = 3_600_000, debtMs = 900_000 } = {}) {
  if (![1, 2].includes(nano?.v) || !Array.isArray(nano.quotes) || !Array.isArray(nano.owed)
    || near?.v !== 1 || !object(near.quotes) || !object(near.refunds) || !object(near.payouts ?? {})
    || !object(near.consumedTx ?? {})) throw Error("invalid-state-shape");
  let nanoRaw = nanoFundingLiabilities({ quotes: nano.quotes, owed: nano.owed }), marketUsdNano = 0n;
  const nearClaims = nearRefundClaims(near, { now });
  const watch = near.meta?.[PAYMENT_WATCH_META];
  const coveredThroughMs = nearPaymentWatchCoverage(watch, !!watch?.backfill);
  const issues = new Set();
  for (const [hash, id] of Object.entries(near.consumedTx ?? {})) {
    const quote = near.quotes[id];
    // The replay index outlives intentionally pruned quotes.
    if (quote && quote.payTx !== hash) issues.add("near-payment-claim-unattached");
  }
  const old = (stamp, ms) => Number.isFinite(stamp) && now - stamp > ms;
  const nanoRefundIds = new Set(nano.owed.filter(d => d.event === "refund").map(d => d.fields?.paymentId));
  const nanoHistory = readNanoPaymentHistory(nano.historyScan);
  const delayedNanoBackfill = old(nanoHistory.backfill?.startedAt, debtMs);
  if (hasConflictingNanoTransferClaims(gateNanoTransferClaims(nano), creatorNanoTransferClaims(Object.values(near.payouts ?? {})))) {
    issues.add("nano-settlement-duplicate-block");
  }
  for (const q of nano.quotes) {
    if (!["pending", "paid", "consumed", "expired", "refunded"].includes(q.status)) throw Error("invalid-nano-quote-status");
    // Text-only results can persist as paid + settled after restart. They are
    // completed financial settlements, not fresh refundable deposits.
    if (["paid", "consumed"].includes(q.status) && !q.settled && !q.result && !q.error) {
      if (q.executionNeedsReconciliation) issues.add("nano-execution-legacy-unverified");
      else if (q.status === "consumed" && Number.isSafeInteger(q.runDeadlineAt)) {
        if (old(q.runDeadlineAt, NANO_EXECUTION_GRACE_MS)) issues.add("nano-execution-overdue");
      } else if (old(q.paidAt ?? q.createdAt, stuckMs)) issues.add("nano-paid-work-stuck");
    }
    if (nanoQuoteClaim(q) > 0n && ((q.error && !nanoRefundIds.has(q.id)) || q.settled)) issues.add("nano-refund-unresolved");
    if (q.historyUnproven === true) issues.add("nano-history-payment-unproven");
    if (delayedNanoBackfill && !q.payHash && (q.status === "pending" || nanoQuoteNeedsHistory(q, nanoHistory.coveredAt, now))) {
      issues.add("nano-history-backfill-delayed");
    }
    if (nano.historyScan && old(q.expiresAt, NANO_LATE_WATCH_MS) && nanoQuoteNeedsHistory(q, nanoHistory.coveredAt, now)) {
      issues.add("nano-quote-history-overdue");
    }
    if (q.status === "expired" && q.payHash && old(q.paidAt ?? q.expiresAt, debtMs) && !nanoRefundIds.has(q.id)) {
      issues.add("nano-late-refund-intent-unknown");
    }
  }
  for (const debt of nano.owed) {
    if (debt.journaled !== true) issues.add("nano-settlement-legacy-unverified");
    if (debt.held || debt.tries >= 5 || old(debt.createdAt ?? debt.at, debtMs)) issues.add("nano-settlement-stuck");
  }
  const refunds = values(near.refunds), refundPayments = new Set(refunds.map(r => r.paymentId));
  for (const refund of refunds) {
    if (refund.status === "sent") continue;
    if (!["queued", "signed", "failed_permanent"].includes(refund.status)) throw Error("invalid-refund-status");
    const unknownLineage = refund.status === "signed" && refund.supersededTxHashes?.length && refund.replacementNonce !== refund.nonce;
    if (refund.outcomeUnverified === true || refund.lastError === "UNPROVABLE" || unknownLineage) {
      issues.add("near-refund-outcome-unverified");
    } else if (refund.status === "failed_permanent") issues.add("near-refund-failed");
    else if (old(refund.createdAt, debtMs)) issues.add("near-refund-stuck");
  }
  const payouts = values(near.payouts ?? {}), payoutPayments = new Set(payouts.map(p => p.paymentId));
  for (const payout of payouts) {
    if (payout.status === "sent") continue;
    if (!["queued", "signed"].includes(payout.status)) throw Error("invalid-payout-status");
    nanoRaw += amount(payout.amountRaw);
    if (old(payout.createdAt, debtMs)) issues.add("creator-payout-stuck");
  }
  for (const q of values(near.quotes)) {
    if (!["pending", "paid", "running", "settled", "failed", "rejected", "expired"].includes(q.status)) throw Error("invalid-near-quote-status");
    if (q.expiresAt + RETAIN_NEAR_QUOTE_MS < now && holdsNearQuoteAmount(q, now, RETAIN_NEAR_QUOTE_MS, coveredThroughMs)) {
      issues.add("near-quote-payment-scan-overdue");
    }
    if (["paid", "running"].includes(q.status)) {
      if (old(q.paidAtBlockMs ?? q.createdAt, stuckMs)) issues.add("near-paid-work-stuck");
    } else if (q.settlement && !refundPayments.has(q.id)) {
      // A crash can happen after settlement is persisted but before the refund
      // intent is created. That money is still owed and must not disappear.
      if (amount(q.settlement.refundYocto) > 0n) {
        issues.add("near-refund-intent-missing");
      }
    }
    if (q.settlement?.authorPayout && !payoutPayments.has(q.id)) {
      nanoRaw += amount(q.settlement.authorPayout.amountRaw);
      issues.add("creator-payout-intent-missing");
    }
  }
  for (const state of market) {
    if (state?.v !== 1 || !object(state.assignments)) throw Error("invalid-market-state");
    nanoRaw += marketCreatorLiabilities(values(state.assignments), { payouts });
    for (const rec of values(state.assignments)) {
      if (rec.phase === "stuck") issues.add("market-assignment-stuck");
      if (["new", "reworking", "running", "submitting", "delivering", "started", "starting", "pricing", "declining"].includes(rec.phase)
        && old(rec.runStartedAt ?? rec.updatedAt ?? rec.createdAt, stuckMs)) issues.add("market-work-stuck");
      if (["running", "started", "starting"].includes(rec.phase)) {
        const usd = rec.pricing?.depositUsd ?? rec.budgetUsd;
        if (!(typeof usd === "number" && Number.isFinite(usd) && usd >= 0)) throw Error("invalid-market-reservation");
        marketUsdNano += parseUsdNano(String(usd));
      }
    }
  }
  for (const issue of nearClaims.issues) issues.add(issue);
  return { ...nearClaims, nanoRaw, marketUsdNano, issues: [...issues].sort() };
}

export function nanoLiquidityCheck({ liabilities, nanoBalanceRaw, xnoUsd, providerReserveUsd = "2" }) {
  const xnoUsdNano = parseUsdNano(xnoUsd);
  if (xnoUsdNano <= 0n) throw Error("invalid-funding-rate");
  const requiredUsd = parseUsdNano(providerReserveUsd) + liabilities.marketUsdNano;
  if (requiredUsd < 0n) throw Error("invalid-provider-reserve");
  const raw = 10n ** 30n;
  const providerRaw = (requiredUsd * raw + xnoUsdNano - 1n) / xnoUsdNano;
  return amount(nanoBalanceRaw) >= liabilities.nanoRaw + providerRaw
    ? { stage: "nano-liquidity", ok: true }
    : { stage: "nano-liquidity", ok: false, code: "nano-pool-insufficient-after-obligations" };
}

/** Reserve in-progress obligations before declaring any funds available. */
export function nearLiquidityChecks({ liabilities, nearBalanceYocto, storageUsage, costs,
  usdcBalanceAtomic, nearReserveYocto = NEAR_OPERATING_RESERVE.toString() }) {
  const nativeNeed = nearFundingNeed({ claims: liabilities, costs, storageUsage, reserveYocto: amount(nearReserveYocto) });
  return [
    { stage: "near-liquidity", ok: amount(nearBalanceYocto) >= nativeNeed, code: "near-insufficient-for-obligations-storage-and-gas" },
    { stage: "usdc-liquidity", ok: amount(usdcBalanceAtomic) >= liabilities.usdcAtomic, code: "usdc-refunds-underfunded" },
  ].map(check => check.ok ? { stage: check.stage, ok: true } : check);
}

export function liquidityChecks(config) {
  return [nanoLiquidityCheck(config), ...nearLiquidityChecks(config)];
}
