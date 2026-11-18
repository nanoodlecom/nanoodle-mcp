export const MAX_OPEN_NEAR_QUOTES = 1000;
export const RETAIN_NEAR_QUOTE_MS = 3_600_000;
export const PAYMENT_WATCH_META = "paymentWatch";

export function nearPaymentWatchCoverage(cursor, required = false) {
  if (Number.isSafeInteger(cursor?.coveredThroughMs) && cursor.coveredThroughMs >= 0) return cursor.coveredThroughMs;
  // An old or absent cursor supplies no proof when the writer requires it.
  return required || cursor?.coveredThroughMs !== undefined ? -Infinity : Infinity;
}

export function countOpenNearQuotes(quotes, now) {
  let count = 0;
  for (const quote of quotes) if (quote.status === "pending" && now <= quote.expiresAt) count++;
  return count;
}

export function holdsNearQuoteAmount(quote, now, retainMs, coveredThroughMs = Infinity) {
  const deadline = quote.expiresAt + retainMs;
  return (quote.status === "pending" || quote.status === "expired") && !quote.payTx
    && (now <= deadline || coveredThroughMs <= deadline);
}

export function heldNearQuoteAmounts(quotes, asset, now, retainMs, { coveredThroughMs, additionallyHeld } = {}) {
  const amounts = new Set();
  for (const quote of quotes) {
    if ((quote.asset === "usdc" ? "usdc" : "near") === asset
      && (holdsNearQuoteAmount(quote, now, retainMs, coveredThroughMs) || additionallyHeld?.(quote.id))) {
      amounts.add(quote.amountYocto);
    }
  }
  return amounts;
}
