/**
 * USD amounts from a payload. The type is checked before any conversion, so
 * "", whitespace, false, [], null, and a missing value stay unknown. They must
 * not become 0 through Number(), String(), or a boolean/array coercion.
 *
 * A finite number is kept, including 0. A string is kept when its trimmed text
 * is a non-negative decimal the old Number() parser accepted, including an
 * exponent (1e-3, 2.5e-3) and a leading dot (.001). The Number() call runs
 * only after that check. Garbage, NaN, Infinity, negatives, and other types
 * stay unknown.
 */

const USD_NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function knownUsd(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!USD_NUMERIC.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * A missing budget (null or undefined) is no cap. Any other value is explicit:
 * it becomes the non-negative number knownUsd accepts, including 0. An explicit
 * value that does not parse is an error. It is never treated as "no cap".
 */
export function budgetCap(raw) {
  if (raw == null) return null;
  const n = knownUsd(raw);
  if (n == null) {
    const err = new Error("budgetUsd is not a usable USD amount");
    err.budgetRejected = true;
    throw err;
  }
  return n;
}

/** Exact decimal USD to integer nano-dollars; optional conservative ceiling. */
export function parseUsdNano(v, { roundUp = false } = {}) {
  let s;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new Error(`unusable USD amount: ${JSON.stringify(v)}`);
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    throw new Error(`unusable USD amount: ${JSON.stringify(v)}`);
  }
  // Same numeric text knownUsd accepts: optional sign, a leading dot, a
  // trailing dot. The digits stay in the string so the nano conversion is exact.
  s = s.replace(/^([+-])?\./, (_, sign) => (sign === "-" ? "-0." : "0."));
  if (/^\d+\.$/.test(s)) s = s.slice(0, -1);
  if (s.startsWith("+")) s = s.slice(1);
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!m || m[1] === "-") throw new Error(`unusable USD amount: ${JSON.stringify(v)}`);
  const digits = m[2] + (m[3] || "");
  const exp = (m[4] ? parseInt(m[4], 10) : 0) - (m[3] ? m[3].length : 0) + 9; // scale to nano-USD
  if (exp >= 0) return BigInt(digits) * 10n ** BigInt(exp);
  const keep = Math.max(0, digits.length + exp);
  const floor = BigInt(digits.slice(0, keep) || "0");
  return floor + (roundUp && /[1-9]/.test(digits.slice(keep)) ? 1n : 0n);
}
