// NanoUSD units.
//
// Amounts on the wire are integers in "raw". Stock Nano uses 10^30 raw per
// unit, and the yxse/nan-node fork changes genesis/prefix, not unit scaling,
// so 10^30 is the working assumption — BUT it is UNVERIFIED against a live
// NanUSD node (RESEARCH §4). Every conversion in this prototype flows
// through this one constant, so the day a node says otherwise the fix is a
// one-line change plus a test. Do not scatter the exponent.
//
// Display precision: USD amounts are quoted to 6 decimal places (USDC-on-NEAR
// parity), and quote tags use the last 6th decimal (1 micro-NANUSD) the way
// gate.mjs tags deposits in 1e-8 XNO steps.

export const RAW_EXPONENT_UNVERIFIED = 30; // verify against a live NanUSD node before any real money moves
export const RAW_PER_NANUSD = 10n ** BigInt(RAW_EXPONENT_UNVERIFIED);
export const DISPLAY_DECIMALS = 6;
export const MICRO_PER_NANUSD = 1_000_000n; // 1 NANUSD = 1,000,000 micro units at display precision

/** USD string/number -> raw BigInt, exact. Throws on >6 decimal places or non-positive. */
export function usdToRaw(usd) {
  const s = String(usd);
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`amount must be USD with at most 6 decimals, got ${s}`);
  const [whole, frac = ""] = s.split(".");
  const micro = BigInt(whole) * MICRO_PER_NANUSD + BigInt((frac + "000000").slice(0, 6));
  return (micro * RAW_PER_NANUSD) / MICRO_PER_NANUSD;
}

/** raw BigInt -> USD string with up to 6 decimals. */
export function rawToUsd(raw) {
  const micro = (BigInt(raw) * MICRO_PER_NANUSD) / RAW_PER_NANUSD;
  const whole = micro / MICRO_PER_NANUSD;
  const frac = (micro % MICRO_PER_NANUSD).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Exact amount in NANUSD (1:1 USD peg) for a quoted USD cost. No oracle. */
export const nanusdForUsd = (usd) => usdToRaw(usd);
