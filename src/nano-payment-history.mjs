export const NANO_LATE_WATCH_MS = 60 * 60_000;
export const isNanoHistoryHash = value => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) && !/^0+$/.test(value);
export const isNanoHistoryHeight = value => typeof value === "string" && /^\d{1,20}$/.test(value);
const stamp = value => Number.isSafeInteger(value) && value >= 0;

export function readNanoPaymentHistory(value) {
  if (value === undefined) return { through: null, coveredAt: null, backfill: null };
  if (!value || (value.through !== null && !isNanoHistoryHash(value.through))
    || (value.coveredAt !== null && !stamp(value.coveredAt))) throw Error("invalid Nano payment history checkpoint");
  const replay = value.backfill;
  if (replay !== null && (!replay || !isNanoHistoryHash(replay.next) || (replay.newest !== null && !isNanoHistoryHash(replay.newest))
    || !stamp(replay.startedAt) || typeof replay.fullReceivableWindow !== "boolean")) throw Error("invalid Nano history backfill checkpoint");
  return {
    through: value.through?.toUpperCase() ?? null,
    coveredAt: value.coveredAt,
    backfill: replay && { newest: replay.newest?.toUpperCase() ?? null, next: replay.next.toUpperCase(),
      startedAt: replay.startedAt, fullReceivableWindow: replay.fullReceivableWindow },
  };
}

export function nanoQuoteNeedsHistory(quote, coveredAt, now) {
  return quote.status === "expired" && !quote.payHash
    && Math.min(coveredAt ?? 0, now) <= quote.expiresAt + NANO_LATE_WATCH_MS;
}
