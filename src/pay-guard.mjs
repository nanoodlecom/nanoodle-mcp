/**
 * Deposit-cap math and the cancel check shared by every x402 payment path.
 *
 * A quoted deposit is a ceiling: worst-case provider cost × 1.2, then a small
 * margin. Settlement is min(metered × 1.2, that quote). beginPayment is the
 * queued callback: it checks the abort signal after the invoice has been read
 * and again inside the microtask, before payment() runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { strictUsd } from "nanoodle";

/** Slack on top of worst-case cost × 1.2. The quote is ceil(charge × 1.12) to 1e-8 USD. */
export const DEPOSIT_MARGIN = 0.12;
/** What the payer is charged per metered dollar, and what a stage must fit inside. */
export const SETTLE_MARKUP = 1.2;
export const BYTES_PER_TOKEN = 3.5;
export const TOKEN_MARGIN = 1.1;
/** Overhead counted once per chat message, on top of the byte estimate. */
export const MESSAGE_TOKENS = 4;

/**
 * The deposit the caller actually paid, while a gated run is in flight.
 * registry.callTool does not receive the quote, so the gate binds it here.
 * Concurrent runs stay isolated. Outside the gate (BYOK) the store is empty
 * and the caller quotes the worst case.
 */
export const paidDeposit = new AsyncLocalStorage();

export function ceilUsd(n) {
  if (!(n > 0) || !Number.isFinite(n)) return 0;
  // Subtract a hair so a value already on a 1e-8 boundary is not bumped by float noise.
  return Math.ceil(n * 1e8 - 1e-6) / 1e8;
}

/** Quote for a known charge: the charge plus the small margin, ceiled to 1e-8 USD. */
export function depositFromCharge(charge) {
  if (!(charge > 0) || !Number.isFinite(charge)) throw new Error("cannot price a call with no cost");
  return ceilUsd(charge * (1 + DEPOSIT_MARGIN));
}

/**
 * An explicit budget. null/undefined means no budget was set.
 * A value that does not parse is refused — it is not "no limit".
 * Returns the same non-negative number Number() would have produced for a
 * decimal or exponent, including 0.
 */
function readBudget(quote) {
  if (quote == null) return null;
  const n = strictUsd(quote);
  if (n == null) {
    const e = new Error("budget is not a usable USD amount");
    e.code = "budget-skip";
    e.paymentNotSent = true;
    e.budgetRefused = true;
    throw e;
  }
  return n;
}

/** What the payer is charged. Metered × 1.2, and never more than the quoted deposit. */
export function settledCharge(metered, quote) {
  const m = strictUsd(metered);
  const raw = (m == null ? 0 : m) * SETTLE_MARKUP;
  const cap = readBudget(quote);
  if (cap == null || !(cap > 0)) return raw;
  return Math.min(raw, cap);
}

/**
 * Metered total reported to the charge gate, so its own +20% cannot pass the quote.
 * The gate charges about cost + cost/5 and keeps the payer at the deposit when that
 * would exceed it; clamping here makes the charge min(metered × 1.2, quote).
 */
export function meteredWithinQuote(metered, quote) {
  const m = strictUsd(metered);
  const known = m == null ? 0 : m;
  const cap = readBudget(quote);
  if (cap == null || !(cap > 0)) return known;
  return Math.min(known, cap / SETTLE_MARKUP);
}

/** Remaining deposit while a run is in flight. `fits` is the pre-stage check. */
export function openBudget(quote) {
  let metered = 0;
  // An explicit budgetUsd that does not parse throws. It does not become an unlimited cap.
  const parsed = readBudget(quote);
  const cap = parsed != null && parsed > 0 ? parsed : 0;
  return {
    quote: cap,
    get metered() { return metered; },
    remaining() { return cap - metered * SETTLE_MARKUP; },
    fits(stageSettled) {
      const need = strictUsd(stageSettled);
      if (need == null) return false;
      return need <= this.remaining() + 1e-9;
    },
    add(usd) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) metered += usd;
    },
    /** Give back a reservation that was not sent. Never drops the total below zero. */
    release(usd) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) metered = Math.max(0, metered - usd);
    },
  };
}

/**
 * A known invoice price, in USD. The raw type is checked before conversion.
 * A finite number, or trimmed decimal / exponent text (including a leading
 * dot), is a price. A blank, whitespace, false, an array, null, a missing
 * value, NaN, Infinity, and a negative are unknown, not 0. An explicit 0 is known.
 */
export function knownInvoiceUsd(amount) {
  return strictUsd(amount);
}

/**
 * Run payment(inv) so a synchronous throw and a rejected promise reject the
 * same promise. Promise.resolve(payment(inv)) does not: the throw happens
 * before Promise.resolve, and a rejection handler never sees it.
 */
export function callPayment(payment, inv) {
  return Promise.resolve().then(() => payment(inv));
}

/**
 * One synchronous payment decision. Call it inside the queued payment callback,
 * with no await before it returns, so the check and the reservation cannot split
 * across two requests. Refuses an unknown USD price, a paymentId already
 * reserved, and an amount whose 1.2 markup does not fit the remaining budget.
 * The first body stored for a paymentId is kept; a later request cannot replace it.
 * The reservation counts against the budget before payment() runs.
 */
export function reserveInvoice({ signal, inv, bodyStr, paidIds, bodies, budget, stageLabel }) {
  if (signal && signal.aborted) {
    const e = new Error(signal.reason && signal.reason.message ? signal.reason.message : "cancelled before payment");
    e.paymentNotSent = true;
    e.cause = signal.reason;
    throw e;
  }
  const id = inv && inv.paymentId ? String(inv.paymentId) : "";
  if (!id || !inv.completeUrl) {
    const e = new Error("payment required, but the 402 response offered no usable Nano option");
    e.code = "x402";
    e.paymentNotSent = true;
    throw e;
  }
  if (typeof bodyStr === "string" && bodyStr.length && !bodies.has(id)) bodies.set(id, bodyStr);
  if (paidIds.has(id)) {
    const e = new Error(`x402 invoice ${id} was already paid; not paying it again`);
    e.code = "x402";
    e.paymentNotSent = true;
    throw e;
  }
  const usd = knownInvoiceUsd(inv.amountUsd);
  if (usd == null) {
    const e = new Error("invoice has no USD price; not paying");
    e.code = "x402";
    e.paymentNotSent = true;
    e.unknownPrice = true;
    throw e;
  }
  if (budget && !budget.fits(usd * SETTLE_MARKUP)) {
    const e = new Error(`remaining deposit cannot cover ${stageLabel || "this stage"}`);
    e.code = "budget-skip";
    e.paymentNotSent = true;
    e.budgetRefused = true;
    throw e;
  }
  paidIds.add(id);
  if (budget && usd > 0) budget.add(usd);
  return { id, usd, body: bodies.has(id) ? bodies.get(id) : bodyStr, committed: usd > 0 ? usd : 0 };
}

/** Undo a reservation that proved nothing was sent. */
export function releaseInvoice({ id, usd, paidIds, budget }) {
  if (id && paidIds) paidIds.delete(String(id));
  if (budget && usd > 0 && typeof budget.release === "function") budget.release(usd);
}

/**
 * Record a payment whose outcome is not known, then the caller rethrows.
 * `inv` is the invoice parsed outside the try, so a throw still names it.
 */
export function noteUncertainPayment(ledger, inv, status) {
  ledger.costUnknown = true;
  const entry = {
    paymentId: inv && inv.paymentId,
    amountUsd: inv && inv.amountUsd,
    ambiguous: true,
    status,
  };
  ledger.reconcile.push(entry);
  const usd = knownInvoiceUsd(inv && inv.amountUsd);
  if (usd > 0) ledger.unreportedUsd += usd;
  return entry;
}

/** bytes/3.5, rounded up, then the small token margin. */
export function estimateTokensFromBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  return Math.ceil(n / BYTES_PER_TOKEN * TOKEN_MARGIN);
}

/** Provider USD for one chat call. Output is the max_tokens this request sends. */
export function chatCallUsd(rates, inputBytes, messages, outTokens) {
  const inTok = estimateTokensFromBytes(inputBytes) + Math.max(0, messages) * MESSAGE_TOKENS;
  return (inTok * rates[0] + Math.max(0, Number(outTokens) || 0) * rates[1]) / 1e6;
}

/**
 * Queue `pay` only if `signal` is still live, and check again inside the
 * callback. A cancel during the invoice read (before this is called, or in the
 * microtask gap before the callback runs) must not send.
 * The sync throw is the caller's signal.reason. The callback throw carries
 * paymentNotSent so the caller does not treat it as money that may have moved.
 */
export function beginPayment(signal, pay) {
  if (signal && signal.aborted) throw signal.reason;
  return Promise.resolve().then(() => {
    if (signal && signal.aborted) {
      const e = new Error("cancelled before payment");
      e.paymentNotSent = true;
      e.cause = signal.reason;
      throw e;
    }
    return pay();
  });
}
