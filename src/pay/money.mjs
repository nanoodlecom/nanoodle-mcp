/**
 * Exact money for every payment route — the shared layer's arithmetic.
 *
 * USD amounts are integer nano-dollars (1e-9 USD), parsed from decimal
 * text with no floating point anywhere near an on-chain amount
 * (parseUsdNano lives in src/usd.mjs; this module is its route-facing
 * home, so adapters stop importing it out of gate.mjs).
 *
 * A rate is an exact pair { usdNano, atomic }: usdNano nano-dollars buy
 * `atomic` atomic units of the asset. Both production gates already price
 * through this shape (the Nano gate's x402 oracle pair, the NEAR gate's
 * rate pair); the NanoUSD peg is the degenerate pair. Conversions are
 * BigInt ratio arithmetic with an explicit floor/ceil.
 */
export { parseUsdNano } from "../usd.mjs";

/** USD (nano-dollars) -> atomic units at a rate pair. mode: "floor" (default) or "ceil". */
export function usdNanoToAtomic(usdNano, pair, mode = "floor") {
  const num = BigInt(usdNano) * BigInt(pair.atomic);
  const den = BigInt(pair.usdNano);
  return mode === "ceil" ? (num + den - 1n) / den : num / den;
}

/** Atomic units -> USD nano-dollars at a rate pair, floor. */
export function atomicToUsdNano(atomic, pair) {
  return (BigInt(atomic) * BigInt(pair.usdNano)) / BigInt(pair.atomic);
}

/** Nano-dollars -> USD display string (up to 6 decimals, trailing zeros trimmed). */
export function formatUsdNano(nano) {
  const micro = BigInt(nano) / 1000n;
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
