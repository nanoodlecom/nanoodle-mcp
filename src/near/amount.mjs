/**
 * NEAR money math. Every on-chain amount is a BigInt of yoctoNEAR
 * (1 NEAR = 10^24 yocto); no floating point touches an amount, a comparison
 * or a conversion.
 *
 * A NEAR/USD rate is an exact pair: `usdNano` nano-dollars (1e-9 USD) buy
 * `yocto` yoctoNEAR. USD values are parsed into nano-dollars from their decimal
 * text (parseUsdNano, shared with the Nano rail), so "3.64" is exactly
 * 3_640_000_000 nano-dollars.
 */
import { randomInt as cryptoRandomInt } from "node:crypto";
import { parseUsdNano } from "../gate.mjs";
import { knownUsd } from "../usd.mjs";
import { NearError } from "./errors.mjs";

export const YOCTO_PER_NEAR = 10n ** 24n;
/** 0.000001 NEAR: deposits are whole multiples of this, so they are typeable. */
export const DUST_STEP_YOCTO = 10n ** 18n;
/** 0.00001 NEAR: refunds below this are not sent (gas would exceed them). */
export const MIN_REFUND_YOCTO = 10n ** 19n;

const NEAR_DECIMAL = /^(\d{1,15})(?:\.(\d{1,24}))?$/;

export function parseNearToYocto(text) {
  if (typeof text !== "string") throw new NearError("BAD_AMOUNT", "a NEAR amount must be a decimal string");
  const m = text.trim().match(NEAR_DECIMAL);
  if (!m) throw new NearError("BAD_AMOUNT", `not a NEAR amount: ${JSON.stringify(text.slice(0, 64))}`);
  const frac = (m[2] || "").padEnd(24, "0");
  return BigInt(m[1]) * YOCTO_PER_NEAR + BigInt(frac);
}

function toYocto(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new NearError("BAD_AMOUNT", "a yocto amount must be a bigint or an integer string");
}

/**
 * Exact decimal NEAR, trailing zeros trimmed, never an exponent. With
 * maxDecimals < 24 the value is rounded half-up for display only.
 */
export function formatYoctoAsNear(yocto, { maxDecimals = 24 } = {}) {
  let v = toYocto(yocto);
  if (v < 0n) throw new NearError("BAD_AMOUNT", "negative NEAR amount");
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0 || maxDecimals > 24) {
    throw new RangeError("maxDecimals must be an integer from 0 to 24");
  }
  const cut = 10n ** BigInt(24 - maxDecimals);
  if (cut > 1n) v = ((v + cut / 2n) / cut) * cut;
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function usdNano(v, code) {
  try {
    return parseUsdNano(v);
  } catch (cause) {
    throw new NearError(code, `not a usable USD amount: ${JSON.stringify(typeof v === "string" ? v.slice(0, 64) : v)}`, { cause });
  }
}

export function rateFromNearUsd(nearUsd) {
  if (typeof nearUsd !== "string" && typeof nearUsd !== "number") {
    throw new NearError("BAD_RATE", "the NEAR/USD rate must be a number or a decimal string");
  }
  const nano = usdNano(nearUsd, "BAD_RATE");
  if (nano <= 0n) throw new NearError("BAD_RATE", "the NEAR/USD rate must be greater than zero");
  return { usdNano: nano, yocto: YOCTO_PER_NEAR, nearUsd: String(nearUsd).trim() };
}

function checkRate(rate) {
  if (!rate || typeof rate.usdNano !== "bigint" || typeof rate.yocto !== "bigint" || rate.usdNano <= 0n || rate.yocto <= 0n) {
    throw new NearError("BAD_RATE", "a rate needs positive bigint usdNano and yocto");
  }
}

export function usdToYocto(usd, rate, mode) {
  checkRate(rate);
  if (mode !== "floor" && mode !== "ceil") throw new TypeError('mode must be "floor" or "ceil"');
  const num = usdNano(usd, "BAD_AMOUNT") * rate.yocto;
  return mode === "ceil" ? (num + rate.usdNano - 1n) / rate.usdNano : num / rate.usdNano;
}

function roundUpToStep(v, step) {
  return ((v + step - 1n) / step) * step;
}

/**
 * The deposit for a quote: the USD deposit converted at the rate (rounded up to
 * a whole 0.000001 NEAR), plus 1-999 steps of random dust so the amount is
 * unique among open quotes. `isTaken(amount)` reports amounts already in use.
 */
export function depositYocto(depositUsd, rate, isTaken, randomInt = cryptoRandomInt) {
  if (typeof isTaken !== "function") throw new TypeError("isTaken must be a function");
  const base = roundUpToStep(usdToYocto(depositUsd, rate, "ceil"), DUST_STEP_YOCTO);
  // Dust stays within 1-999 steps (at most 0.000999 NEAR), always.
  for (let tries = 0; tries < 200; tries++) {
    const amount = base + BigInt(randomInt(1, 1000)) * DUST_STEP_YOCTO;
    if (!isTaken(amount)) return amount;
  }
  for (let k = 1n; k < 1000n; k++) {
    const amount = base + k * DUST_STEP_YOCTO;
    if (!isTaken(amount)) return amount;
  }
  throw new NearError("NO_UNIQUE_AMOUNT", "every deposit amount at this price is held by an open quote; try again later");
}

/**
 * Settlement at the quote's locked rate:
 *   cost    = ceil(costUsd at rate)
 *   fee     = floor(cost / 5)                  (20% of the actual cost)
 *   charged = min(cost + fee, deposit)
 *   refund  = deposit - charged, folded into charged when below minRefundYocto
 * An unknown cost charges nothing and refunds the whole deposit.
 */
export function settleYocto({ depositYocto: deposit, costUsd, rate, minRefundYocto = MIN_REFUND_YOCTO }) {
  if (typeof deposit !== "bigint" || deposit < 0n) throw new NearError("BAD_AMOUNT", "depositYocto must be a non-negative bigint");
  if (typeof minRefundYocto !== "bigint" || minRefundYocto < 0n) throw new NearError("BAD_AMOUNT", "minRefundYocto must be a non-negative bigint");
  checkRate(rate);
  const known = knownUsd(costUsd) != null;
  let costYocto = 0n;
  let feeYocto = 0n;
  let chargedYocto = 0n;
  if (known) {
    costYocto = usdToYocto(typeof costUsd === "string" ? costUsd.trim() : costUsd, rate, "ceil");
    feeYocto = costYocto / 5n;
    chargedYocto = costYocto + feeYocto;
    if (chargedYocto > deposit) chargedYocto = deposit;
  }
  let refundYocto = deposit - chargedYocto;
  if (refundYocto > 0n && refundYocto < minRefundYocto) {
    chargedYocto += refundYocto;
    refundYocto = 0n;
  }
  return { known, costYocto, feeYocto, chargedYocto, refundYocto };
}
