// Read-only accounting for probes and admission checks. Never opens a ledger,
// signs a transaction, retries an assignment, or returns customer content.
import { knownUsd, parseUsdNano } from "./usd.mjs";
import { nanoFundingCoverage, nanoQuoteClaim, nearCreatorCoverage, marketCreatorCoverage, nearRunFundingBudget } from "./funding-liabilities.mjs";
import { NEAR_OPERATING_RESERVE, nearRefundClaims, nearFundingNeed } from "./near/funding.mjs";
import { holdsNearQuoteAmount, nearPaymentWatchCoverage, PAYMENT_WATCH_META, RETAIN_NEAR_QUOTE_MS } from "./near/quote-capacity.mjs";
import { NANO_LATE_WATCH_MS, nanoQuoteNeedsHistory, readNanoPaymentHistory } from "./nano-payment-history.mjs";
import { creatorNanoTransferClaims, gateNanoTransferClaims, hasConflictingNanoTransferClaims } from "./nano-transfer-journal.mjs";
import { runFundingBudget } from "./run-funding.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const U128_MAX = (1n << 128n) - 1n;
const RAW_PER_XNO = 10n ** 30n;
const NANO_EXECUTION_GRACE_MS = 5 * 60_000;
function amount(value) {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128_MAX) throw Error("invalid-state-amount");
  return BigInt(value);
}
function values(value) { if (!object(value)) throw Error("invalid-state-shape"); return Object.values(value); }
function marketAssignments(ledger) {
  if (ledger?.v !== 1 || !object(ledger.assignments)) throw Error("invalid-market-state");
  return values(ledger.assignments);
}
function marketReservationUsd(record) {
  if (!["running", "started", "starting"].includes(record.phase)) return 0;
  const usd = record.pricing?.depositUsd ?? record.budgetUsd;
  if (!(typeof usd === "number" && Number.isFinite(usd) && usd >= 0)) throw Error("invalid-market-reservation");
  return usd;
}

export function paymentLiabilities({ nano, near, market = [] }, { now = Date.now(), stuckMs = 3_600_000, debtMs = 900_000 } = {}) {
  if (![1, 2].includes(nano?.v) || !Array.isArray(nano.quotes) || !Array.isArray(nano.owed)
    || near?.v !== 1 || !object(near.quotes) || !object(near.refunds) || !object(near.payouts ?? {})
    || !object(near.consumedTx ?? {})) throw Error("invalid-state-shape");
  const nanoCoverage = nanoFundingCoverage({ quotes: nano.quotes, owed: nano.owed });
  let nanoRaw = nanoCoverage.totalRaw, marketUsdNano = 0n;
  const nearClaims = nearRefundClaims(near, { now });
  const watch = near.meta?.[PAYMENT_WATCH_META];
  const coveredThroughMs = nearPaymentWatchCoverage(watch, !!watch?.backfill);
  const issues = new Set();
  if (nanoCoverage.missing) issues.add("nano-settlement-intent-missing");
  if (nanoCoverage.mismatch) issues.add("nano-settlement-evidence-mismatch");
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
  const refunds = values(near.refunds);
  for (const refund of refunds) {
    if (refund.status === "sent") continue;
    if (!["queued", "signed", "failed_permanent"].includes(refund.status)) throw Error("invalid-refund-status");
    const unknownLineage = refund.status === "signed" && refund.supersededTxHashes?.length && refund.replacementNonce !== refund.nonce;
    if (refund.outcomeUnverified === true || refund.lastError === "UNPROVABLE" || unknownLineage) {
      issues.add("near-refund-outcome-unverified");
    } else if (refund.status === "failed_permanent") issues.add("near-refund-failed");
    else if (old(refund.createdAt, debtMs)) issues.add("near-refund-stuck");
  }
  const payouts = values(near.payouts ?? {});
  const addCreatorCoverage = coverage => {
    nanoRaw += coverage.totalRaw;
    if (coverage.missing) issues.add("creator-payout-intent-missing");
    if (coverage.mismatch) issues.add("creator-payout-evidence-mismatch");
  };
  addCreatorCoverage(nearCreatorCoverage({ quotes: values(near.quotes), payouts }));
  for (const payout of payouts) {
    if (payout.status === "sent") continue;
    if (old(payout.createdAt, debtMs)) issues.add("creator-payout-stuck");
  }
  for (const q of values(near.quotes)) {
    if (!["pending", "paid", "running", "settled", "failed", "rejected", "expired"].includes(q.status)) throw Error("invalid-near-quote-status");
    if (q.expiresAt + RETAIN_NEAR_QUOTE_MS < now && holdsNearQuoteAmount(q, now, RETAIN_NEAR_QUOTE_MS, coveredThroughMs)) {
      issues.add("near-quote-payment-scan-overdue");
    }
    if (["paid", "running"].includes(q.status)) {
      if (old(q.paidAtBlockMs ?? q.createdAt, stuckMs)) issues.add("near-paid-work-stuck");
    }
  }
  for (const state of market) {
    const assignments = marketAssignments(state);
    addCreatorCoverage(marketCreatorCoverage(assignments, { payouts }));
    for (const rec of assignments) {
      if (rec.phase === "stuck") issues.add("market-assignment-stuck");
      if (["new", "reworking", "running", "submitting", "delivering", "started", "starting", "pricing", "declining"].includes(rec.phase)
        && old(rec.runStartedAt ?? rec.updatedAt ?? rec.createdAt, stuckMs)) issues.add("market-work-stuck");
      const budgetUsd = marketReservationUsd(rec);
      if (budgetUsd > 0) marketUsdNano += parseUsdNano(budgetUsd);
    }
  }
  for (const issue of nearClaims.issues) issues.add(issue);
  return { ...nearClaims, nanoRaw, marketUsdNano, issues: [...issues].sort() };
}

/** Accepted NEAR and USDC payments waiting to acquire a Nano run reservation. */
export function paidNearRunFundingRaw(quotes, { providerUsesWallet = true } = {}) {
  let requiredRaw = 0n;
  for (const quote of values(quotes)) {
    if (quote.status !== "paid" || quote.settlement || quote.fundingOutcomeReady === true) continue;
    if (!providerUsesWallet && !quote.author) continue;
    if (amount(quote.paidYocto) === 0n) throw Error("invalid-paid-near-amount");
    const { maxRaw, overheadRaw } = nearRunFundingBudget(quote);
    requiredRaw += overheadRaw + (providerUsesWallet ? maxRaw : 0n);
  }
  return requiredRaw;
}

/** Accepted Nano payments waiting to acquire a Nano run reservation. */
export function paidNanoRunFundingRaw(quotes) {
  if (!Array.isArray(quotes)) throw Error("invalid-state-shape");
  let requiredRaw = 0n;
  for (const quote of quotes) {
    if (quote.status !== "paid" || quote.settled || quote.result || quote.error
      || quote.refundExpected || quote.executionNeedsReconciliation) continue;
    if (nanoQuoteClaim(quote) === 0n || !(knownUsd(quote.usd) > 0)) throw Error("invalid-paid-nano-amount");
    const rateUsd = amount(quote.pair?.usdNano), rateRaw = amount(quote.pair?.raw);
    const depositUsd = parseUsdNano(quote.usd);
    if (rateUsd === 0n || rateRaw === 0n || depositUsd === 0n) throw Error("invalid-paid-nano-rate");
    // Creator configuration is resolved at execution. The ceiling covers
    // the possible combination of rounded-down model funds and rounded-up overhead.
    requiredRaw += (depositUsd * rateRaw + rateUsd - 1n) / rateUsd;
  }
  return requiredRaw;
}

/** Accepted Market launches and running work, priced at the sampled Nano rate. */
export function marketRunFunding(market, xnoUsd) {
  const pair = { usdNano: xnoUsd == null ? null : parseUsdNano(xnoUsd), raw: RAW_PER_XNO };
  let waitingRaw = 0n, totalRaw = 0n;
  for (const state of market) {
    for (const rec of marketAssignments(state)) {
      const budgetUsd = marketReservationUsd(rec);
      if (budgetUsd === 0) continue;
      const { maxRaw, overheadRaw } = runFundingBudget({ id: rec.id, budgetUsd, pair, creator: !!rec.creator });
      const requiredRaw = maxRaw + overheadRaw;
      totalRaw += requiredRaw;
      if (rec.phase !== "running") waitingRaw += requiredRaw;
    }
  }
  return { waitingRaw, totalRaw };
}

export function nanoLiquidityCheck({ liabilities, nanoBalanceRaw, xnoUsd, providerReserveUsd = "2", marketFundingRaw = 0n }) {
  const xnoUsdNano = parseUsdNano(xnoUsd);
  if (xnoUsdNano <= 0n) throw Error("invalid-funding-rate");
  const bufferUsd = parseUsdNano(providerReserveUsd), requiredUsd = bufferUsd + liabilities.marketUsdNano;
  if (requiredUsd < 0n) throw Error("invalid-provider-reserve");
  const toRaw = usd => (usd * RAW_PER_XNO + xnoUsdNano - 1n) / xnoUsdNano;
  const baseline = toRaw(requiredUsd), recent = marketFundingRaw + toRaw(bufferUsd);
  const providerRaw = recent > baseline ? recent : baseline;
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
