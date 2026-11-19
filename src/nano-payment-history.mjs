export const NANO_LATE_WATCH_MS = 60 * 60_000;
// Keep enough room for a payment burst and bound each history page.
export const NANO_RECEIVABLE_COUNT = 500;
export const NANO_HISTORY_PAGE = 100;
// Match quotes at the 1e-8 XNO precision displayed by wallets.
export const NANO_PAYMENT_GRAIN = 10n ** 22n;
export const isNanoHistoryHash = value => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) && !/^0+$/.test(value);
export const isNanoHistoryHeight = value => typeof value === "string" && /^\d{1,20}$/.test(value);
const canon = address => typeof address === "string" ? address.replace(/^xrb_/, "nano_") : "";
const rawTypes = new Set(["send", "receive", "open", "change", "epoch"]);
const previousHash = value => {
  if (typeof value === "string" && /^0{64}$/.test(value)) return null;
  return isNanoHistoryHash(value) ? value.toUpperCase() : undefined;
};
const badHistory = () => Object.assign(Error("Nano RPC did not prove the requested confirmed history page"),
  { code: "NANO_RPC_UNPROVEN_HISTORY" });
const stamp = value => Number.isSafeInteger(value) && value >= 0;

export function nanoHistoryKind(row) {
  return row.type === "state" ? row.subtype : row.type;
}

/** Raw history includes change and epoch blocks. An anchored, confirmed page
 * must follow every predecessor, including the continuation to the next page. */
export function checkedAnchoredNanoHistory(page, { account, head, count }, checkAddress, height = null) {
  const limit = Number(count), owner = canon(account);
  if (!isNanoHistoryHash(head) || !owner || canon(page?.account) !== owner || !Number.isSafeInteger(limit)
    || limit < 1 || !Array.isArray(page?.history) || !page.history.length || page.history.length > limit) throw badHistory();
  let expected = head.toUpperCase();
  let expectedHeight = height === null ? null : BigInt(height);
  const history = [], seen = new Set();
  for (const row of page.history) {
    if (!isNanoHistoryHash(row?.hash) || row.hash.toUpperCase() !== expected || ![true, "true"].includes(row.confirmed)
      || seen.has(expected) || !isNanoHistoryHeight(row.height)) throw badHistory();
    const at = BigInt(row.height);
    const kind = nanoHistoryKind(row);
    const previous = row.type === "open" && row.previous == null ? null : previousHash(row.previous);
    if (at < 1n || (expectedHeight !== null && at !== expectedHeight) || !rawTypes.has(kind)
      || previous === undefined || (at === 1n) !== (previous === null) || (kind === "open" && at !== 1n)) throw badHistory();
    if (["receive", "open"].includes(kind) && (!checkAddress(canon(row.account)) || typeof row.amount !== "string"
      || !/^\d{1,39}$/.test(row.amount) || BigInt(row.amount) <= 0n || BigInt(row.amount) >= 2n ** 128n)) throw badHistory();
    history.push({ ...row, hash: expected });
    seen.add(expected);
    expected = previous;
    expectedHeight = at - 1n;
  }
  const next = page.previous == null ? null : previousHash(page.previous);
  if (next !== expected || seen.has(next)) throw badHistory();
  return { ...page, history, previous: next };
}

export function readNanoPaymentHistory(value) {
  if (value === undefined) return { through: null, coveredAt: null, backfill: null };
  if (!value || (value.through !== null && !isNanoHistoryHash(value.through))
    || (value.coveredAt !== null && !stamp(value.coveredAt))) throw Error("invalid Nano payment history checkpoint");
  const replay = value.backfill;
  if (replay !== null && (!replay || !isNanoHistoryHash(replay.next) || (replay.newest !== null && !isNanoHistoryHash(replay.newest))
    || !stamp(replay.startedAt) || typeof replay.fullReceivableWindow !== "boolean"
    || (replay.quotaDeferred !== undefined && typeof replay.quotaDeferred !== "boolean"))) throw Error("invalid Nano history backfill checkpoint");
  return {
    through: value.through?.toUpperCase() ?? null,
    coveredAt: value.coveredAt,
    backfill: replay && { newest: replay.newest?.toUpperCase() ?? null, next: replay.next.toUpperCase(),
      startedAt: replay.startedAt, fullReceivableWindow: replay.fullReceivableWindow,
      ...(replay.quotaDeferred === true && { quotaDeferred: true }) },
  };
}

export function nanoQuoteNeedsHistory(quote, coveredAt, now) {
  return quote.status === "expired" && !quote.payHash
    && Math.min(coveredAt ?? 0, now) <= quote.expiresAt + NANO_LATE_WATCH_MS;
}
