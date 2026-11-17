// Read-only accounting for probes and admission checks. Never opens a ledger,
// signs a transaction, retries an assignment, or returns customer content.
import { parseUsdNano } from "./gate.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const U128_MAX = (1n << 128n) - 1n;
function amount(value) {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128_MAX) throw Error("invalid-state-amount");
  return BigInt(value);
}
function values(value) { if (!object(value)) throw Error("invalid-state-shape"); return Object.values(value); }

export function paymentLiabilities({ nano, near, market = [] }, { now = Date.now(), stuckMs = 3_600_000, debtMs = 900_000 } = {}) {
  if (![1, 2].includes(nano?.v) || !Array.isArray(nano.quotes) || !Array.isArray(nano.owed)
    || near?.v !== 1 || !object(near.quotes) || !object(near.refunds) || !object(near.payouts ?? {})) throw Error("invalid-state-shape");
  let nanoRaw = 0n, nearYocto = 0n, usdcAtomic = 0n, marketUsdNano = 0n;
  let nativeRefunds = 0, tokenRefunds = 0;
  const issues = new Set();
  const old = (stamp, ms) => Number.isFinite(stamp) && now - stamp > ms;
  const reserve = (asset, value) => {
    const n = amount(value);
    if (asset === "usdc") usdcAtomic += n;
    else if (asset == null || asset === "near") nearYocto += n;
    else throw Error("invalid-state-asset");
  };
  for (const q of nano.quotes) {
    if (!["pending", "paid", "consumed", "expired", "refunded"].includes(q.status)) throw Error("invalid-nano-quote-status");
    // Text-only results can persist as paid + settled after restart. They are
    // completed financial settlements, not fresh refundable deposits.
    if (["paid", "consumed"].includes(q.status) && !q.settled && !q.result && !q.error) {
      nanoRaw += amount(q.amountRaw);
      if (old(q.paidAt ?? q.createdAt, stuckMs)) issues.add("nano-paid-work-stuck");
    }
  }
  for (const debt of nano.owed) {
    nanoRaw += amount(debt.amountRaw);
    // Legacy debts have a next-attempt time, not an original creation time.
    if (debt.tries >= 5 || old(debt.at, debtMs)) issues.add("nano-settlement-stuck");
  }
  const refunds = values(near.refunds), refundPayments = new Set(refunds.map(r => r.paymentId));
  for (const refund of refunds) {
    if (refund.status === "sent") continue;
    if (!["queued", "signed", "failed_permanent"].includes(refund.status)) throw Error("invalid-refund-status");
    reserve(refund.asset, refund.amountYocto);
    if (refund.asset === "usdc") tokenRefunds++; else nativeRefunds++;
    if (refund.status === "failed_permanent") issues.add("near-refund-failed");
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
    if (["paid", "running"].includes(q.status)) {
      reserve(q.asset, q.paidYocto);
      if (old(q.paidAtBlockMs ?? q.createdAt, stuckMs)) issues.add("near-paid-work-stuck");
    } else if (q.settlement && !refundPayments.has(q.id)) {
      // A crash can happen after settlement is persisted but before the refund
      // intent is created. That money is still owed and must not disappear.
      reserve(q.asset, q.settlement.refundYocto);
      if (amount(q.settlement.refundYocto) > 0n) {
        if (q.asset === "usdc") tokenRefunds++; else nativeRefunds++;
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
  return { nanoRaw, nearYocto, usdcAtomic, marketUsdNano, nativeRefunds, tokenRefunds, issues: [...issues].sort() };
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
export function liquidityChecks({ liabilities, nanoBalanceRaw, nearBalanceYocto, storageUsage, storagePriceYocto,
  usdcBalanceAtomic, gasPriceYocto, transferGas, xnoUsd, providerReserveUsd = "2", nearReserveYocto = "50000000000000000000000" }) {
  const gasPrice = amount(gasPriceYocto), storagePrice = amount(storagePriceYocto);
  if (!Number.isSafeInteger(storageUsage) || storageUsage < 0 || gasPrice <= 0n || storagePrice <= 0n
    || typeof transferGas !== "bigint" || transferGas <= 0n) throw Error("invalid-protocol-costs");
  const storage = BigInt(storageUsage) * storagePrice;
  // A token refund attaches 30 Tgas plus one yocto; keep an extra 2x fee
  // allowance for price movement between periodic observations.
  const gas = gasPrice * 2n * (BigInt(liabilities.tokenRefunds) * 30_000_000_000_000n + BigInt(liabilities.nativeRefunds) * transferGas);
  const nativeNeed = liabilities.nearYocto + storage + gas + amount(nearReserveYocto) + BigInt(liabilities.tokenRefunds);
  return [
    nanoLiquidityCheck({ liabilities, nanoBalanceRaw, xnoUsd, providerReserveUsd }),
    { stage: "near-liquidity", ok: amount(nearBalanceYocto) >= nativeNeed, code: "near-insufficient-for-obligations-storage-and-gas" },
    { stage: "usdc-liquidity", ok: amount(usdcBalanceAtomic) >= liabilities.usdcAtomic, code: "usdc-refunds-underfunded" },
  ].map(check => check.ok ? { stage: check.stage, ok: true } : check);
}
