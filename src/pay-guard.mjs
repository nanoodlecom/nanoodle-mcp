/**
 * Deposit-cap math and the cancel check shared by every x402 payment path.
 *
 * A quoted deposit is a ceiling: worst-case provider cost × 1.2, then a small
 * margin. Settlement is min(metered × 1.2, that quote). beginPayment is the
 * queued callback: it checks the abort signal after the invoice has been read
 * and again inside the microtask, before payment() runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/** What the payer is charged. Metered × 1.2, and never more than the quoted deposit. */
export function settledCharge(metered, quote) {
  const raw = (Number(metered) > 0 && Number.isFinite(Number(metered)) ? Number(metered) : 0) * SETTLE_MARKUP;
  const cap = Number(quote);
  if (!(cap > 0) || !Number.isFinite(cap)) return raw;
  return Math.min(raw, cap);
}

/**
 * Metered total reported to the charge gate, so its own +20% cannot pass the quote.
 * The gate charges about cost + cost/5 and keeps the payer at the deposit when that
 * would exceed it; clamping here makes the charge min(metered × 1.2, quote).
 */
export function meteredWithinQuote(metered, quote) {
  const m = Number(metered) > 0 && Number.isFinite(Number(metered)) ? Number(metered) : 0;
  const cap = Number(quote);
  if (!(cap > 0) || !Number.isFinite(cap)) return m;
  return Math.min(m, cap / SETTLE_MARKUP);
}

/** Remaining deposit while a run is in flight. `fits` is the pre-stage check. */
export function openBudget(quote) {
  let metered = 0;
  const cap = Number(quote) > 0 && Number.isFinite(Number(quote)) ? Number(quote) : 0;
  return {
    quote: cap,
    get metered() { return metered; },
    remaining() { return cap - metered * SETTLE_MARKUP; },
    fits(stageSettled) {
      const need = Number(stageSettled) > 0 ? Number(stageSettled) : 0;
      return need <= this.remaining() + 1e-9;
    },
    add(usd) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) metered += usd;
    },
  };
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
