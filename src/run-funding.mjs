import { AsyncLocalStorage } from "node:async_hooks";
import { knownUsd, parseUsdNano } from "./usd.mjs";

const U128_MAX = (1n << 128n) - 1n;
export class FundingError extends Error {
  constructor(code, message) { super(message); this.name = "FundingError"; this.code = code; }
}
function raw(value, positive = false) {
  if ((typeof value !== "bigint" && !(typeof value === "string" && /^\d{1,39}$/.test(value)))
    || BigInt(value) < (positive ? 1n : 0n) || BigInt(value) > U128_MAX) {
    throw new FundingError("FUNDING_INVALID", "Funding requires an exact unsigned Nano raw amount");
  }
  return BigInt(value);
}
function usd(value, roundUp = false) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).length > 128
    || !(knownUsd(value) > 0)) throw new FundingError("FUNDING_INVALID", "Funding requires a positive finite USD amount");
  const n = parseUsdNano(value, { roundUp });
  if (n <= 0n) throw new FundingError("FUNDING_INVALID", "Funding USD amount is below supported precision");
  return n;
}

/** Locked quote funding terms; 20% creator markup stays outside model authority. */
export function runFundingBudget({ id, budgetUsd, pair, creator = false }) {
  const totalUsd = usd(budgetUsd);
  const rateUsd = raw(pair?.usdNano, true), rateRaw = raw(pair?.raw, true);
  const providerUsd = creator ? totalUsd * 5n / 6n : totalUsd;
  const overheadUsd = totalUsd - providerUsd;
  const decimal = n => `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, "0")}`;
  return { id, maxUsd: decimal(providerUsd), maxRaw: raw(providerUsd * rateRaw / rateUsd, true),
    overheadRaw: raw((overheadUsd * rateRaw + rateUsd - 1n) / rateUsd) };
}

/**
 * One wallet's run-level working-capital reservations. `serial` MUST be the
 * wallet's existing block queue. `balance(requiredRaw)` may pocket receivables,
 * but must return the actual spendable account balance, not a pending refund or
 * Market revenue. `liabilitiesRaw` reads live customer/creator obligations.
 *
 * A draw counts maximum provider prepayment, never an estimated final cost.
 * Provider refunds increase future spendable balance, not the current run's cap.
 * The engine and nested/late work inherit the opaque scope through async context;
 * no prompt, graph field or tools/call argument can grant itself another budget.
 */
export function createRunFunding({ serial, balance, liabilitiesRaw = () => 0n, requireScope = false } = {}) {
  if (typeof serial !== "function" || typeof balance !== "function" || typeof liabilitiesRaw !== "function"
    || typeof requireScope !== "boolean") throw new TypeError("run funding needs a serial wallet queue, balance and liability readers");
  const context = new AsyncLocalStorage();
  const active = new Map();
  const held = () => [...active.values()].reduce((n, s) => n + s.maxRaw - s.drawnRaw + s.overheadRaw, 0n);
  const obligations = () => raw(liabilitiesRaw());
  const open = scope => {
    if (!scope || active.get(scope.id) !== scope || scope.closed) {
      throw new FundingError("FUNDING_CLOSED", "Provider payment has no open approved run budget");
    }
  };

  async function run({ id, maxUsd, maxRaw, overheadRaw = 0n }, execute) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(id) || typeof execute !== "function") {
      throw new FundingError("FUNDING_INVALID", "Funding needs a stable run identity and an execution function");
    }
    if (context.getStore()) throw new FundingError("FUNDING_NESTED", "A nested run cannot reset an existing funding budget");
    const scope = { id, maxUsd: usd(maxUsd), maxRaw: raw(maxRaw, true), overheadRaw: raw(overheadRaw),
      drawnUsd: 0n, drawnRaw: 0n, invoices: new Set(), closed: false };
    await serial(async () => {
      if (active.has(id)) throw new FundingError("FUNDING_DUPLICATE", "This run already has a funding reservation");
      const required = obligations() + held() + scope.maxRaw + scope.overheadRaw;
      const available = raw(await balance(required));
      // Obligations can increase during an RPC/work await. Re-read them before
      // admitting any model work; no other reservation mutates outside `serial`.
      if (available < obligations() + held() + scope.maxRaw + scope.overheadRaw) {
        throw new FundingError("FUNDING_INSUFFICIENT", "Shared Nano pool cannot cover this run after reservations and obligations");
      }
      active.set(id, scope);
    });
    try { return await context.run(scope, execute); }
    finally {
      scope.closed = true; // detached/late callers cannot reopen the budget
      // Earlier payment tasks must finish resolving before unused capital is
      // released. The wallet captures each enqueuer's scope explicitly.
      await serial(() => { active.delete(id); });
    }
  }

  // Called only inside `serial`, before signing/publishing a provider invoice.
  function authorize(scope, invoice, balanceRaw) {
    const amount = raw(invoice?.amountRaw, true);
    if (scope) open(scope);
    else if (requireScope) throw new FundingError("FUNDING_REQUIRED", "Provider payment requires an approved run budget");
    const available = raw(balanceRaw);
    const liability = obligations(), reserved = held();
    if (available < liability + reserved + (scope ? 0n : amount)) {
      throw new FundingError("FUNDING_INSUFFICIENT", "Shared Nano pool cannot pay this invoice after reservations and obligations");
    }
    if (!scope) return;
    const invoiceUsd = usd(invoice.amountUsd, true);
    if (typeof invoice.paymentId !== "string" || !invoice.paymentId || invoice.paymentId.length > 256) {
      throw new FundingError("FUNDING_INVALID", "Provider invoice needs a payment identity");
    }
    if (scope.invoices.has(invoice.paymentId)) throw new FundingError("FUNDING_INVOICE_USED", "Provider invoice was already authorized for this run");
    if (scope.drawnUsd + invoiceUsd > scope.maxUsd || scope.drawnRaw + amount > scope.maxRaw) {
      throw new FundingError("FUNDING_OVER_BUDGET", "Provider invoices exceed the approved run budget");
    }
    // Debit before external side effects. A refused/ambiguous invoice never
    // restores spend authority or allows a second transfer of that invoice.
    scope.invoices.add(invoice.paymentId);
    scope.drawnUsd += invoiceUsd;
    scope.drawnRaw += amount;
  }

  return {
    run, capture: () => context.getStore() || null, authorize,
    snapshot: () => ({ activeRuns: active.size, reservedRaw: held().toString() }),
  };
}
