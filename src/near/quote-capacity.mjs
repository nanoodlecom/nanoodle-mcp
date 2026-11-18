export const MAX_OPEN_NEAR_QUOTES = 1000;
export const RETAIN_NEAR_QUOTE_MS = 3_600_000;

export function countOpenNearQuotes(quotes, now) {
  let count = 0;
  for (const quote of quotes) if (quote.status === "pending" && now <= quote.expiresAt) count++;
  return count;
}

export function holdsNearQuoteAmount(quote, now, retainMs) {
  return (quote.status === "pending" || quote.status === "expired") && now <= quote.expiresAt + retainMs;
}

export function heldNearQuoteAmounts(quotes, asset, now, retainMs, additionallyHeld) {
  const amounts = new Set();
  for (const quote of quotes) {
    if ((quote.asset === "usdc" ? "usdc" : "near") === asset
      && (holdsNearQuoteAmount(quote, now, retainMs) || additionallyHeld?.(quote.id))) {
      amounts.add(quote.amountYocto);
    }
  }
  return amounts;
}
