/**
 * USD amounts from a payload. The type is checked before any conversion, so
 * "", whitespace, false, [], null, and a missing value stay unknown. They must
 * not become 0 through Number(), String(), or a boolean/array coercion.
 *
 * A finite number is kept, including 0. A string is kept only when its trimmed
 * text is a plain decimal (digits, optional fraction). The Number() call runs
 * only after that check.
 */

const USD_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function knownUsd(raw) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!USD_DECIMAL.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}
