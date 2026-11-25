export const NANO_LATE_WATCH_MS = 60 * 60_000;
// Keep enough room for a payment burst and bound each history page.
export const NANO_RECEIVABLE_COUNT = 500;
export const NANO_HISTORY_PAGE = 100;
// Match quotes at the 1e-8 XNO precision displayed by wallets.
export const NANO_PAYMENT_GRAIN = 10n ** 22n;
export const isNanoHistoryHash = value => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) && !/^0+$/.test(value);
export const isNanoHistoryHeight = value => typeof value === "string" && /^\d{1,20}$/.test(value);
export const isNanoBlockHeight = value => isNanoHistoryHeight(value) && BigInt(value) > 0n && BigInt(value) < 2n ** 64n;
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
      || seen.has(expected) || !isNanoBlockHeight(row.height)) throw badHistory();
    const at = BigInt(row.height);
    const kind = nanoHistoryKind(row);
    const previous = row.type === "open" && row.previous == null ? null : previousHash(row.previous);
    if ((expectedHeight !== null && at !== expectedHeight) || !rawTypes.has(kind)
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

/** Some proxies return compact history even with raw:true. Reconstruct only
 * missing predecessor links from a single, bounded read of confirmed blocks. */
export async function completeAnchoredNanoHistory(page, request, { rpc, checkAddress, hashBlock, height = null }) {
  const count = Number(request.count), rows = page?.history;
  if (!rpc || !Array.isArray(rows) || !rows.length || rows.length > count || count > NANO_HISTORY_PAGE) {
    return checkedAnchoredNanoHistory(page, request, checkAddress, height);
  }
  const missing = rows.filter(row => row?.previous == null && row?.type !== "open");
  if (!missing.length) return checkedAnchoredNanoHistory(page, request, checkAddress, height);
  const owner = canon(request.account);
  if (!owner || owner !== canon(page.account) || !Number.isSafeInteger(count)
      || !isNanoHistoryHash(request.head) || !isNanoHistoryHash(rows[0]?.hash)
      || rows[0].hash.toUpperCase() !== request.head.toUpperCase()
      || missing.some(row => !isNanoHistoryHash(row?.hash) || !isNanoBlockHeight(row.height))) throw badHistory();
  const hashes = missing.map(row => row.hash.toUpperCase());
  if (new Set(hashes).size !== hashes.length) throw badHistory();
  const { blocks } = await rpc({ action: "blocks_info", hashes, json_block: "true", source: "true" });
  const filled = new Map();
  for (const row of missing) {
    const hash = row.hash.toUpperCase(), witness = blocks?.[hash];
    const contents = witness?.contents;
    const kind = nanoHistoryKind(row);
    if (!["true", true].includes(witness?.confirmed) || witness.height !== row.height || witness.subtype !== kind
      || contents?.type !== "state" || canon(contents.account) !== owner
      || (kind === "receive" && (witness.amount !== row.amount || canon(witness.source_account) !== canon(row.account)))) {
      throw badHistory();
    }
    let computedHash;
    try { computedHash = hashBlock(contents); } catch { throw badHistory(); }
    if (computedHash.toUpperCase() !== hash) throw badHistory();
    filled.set(row, { ...row, previous: contents.previous });
  }
  return checkedAnchoredNanoHistory({ ...page, history: rows.map(row => filled.get(row) ?? row) }, request, checkAddress, height);
}

export function readNanoPaymentHistory(value) {
  if (value === undefined) return { through: null, coveredAt: null, backfill: null };
  if (!value || (value.through !== null && !isNanoHistoryHash(value.through))
    || (value.coveredAt !== null && !stamp(value.coveredAt))) throw Error("invalid Nano payment history checkpoint");
  const replay = value.backfill;
  if (replay !== null && (!replay || !isNanoHistoryHash(replay.next) || (replay.newest !== null && !isNanoHistoryHash(replay.newest))
    || !stamp(replay.startedAt) || typeof replay.fullReceivableWindow !== "boolean"
    || (replay.quotaDeferred !== undefined && typeof replay.quotaDeferred !== "boolean")
    || ((replay.nextHeight !== undefined || replay.advancedAt !== undefined)
      && (!isNanoBlockHeight(replay.nextHeight) || !stamp(replay.advancedAt) || replay.advancedAt < replay.startedAt)))) {
    throw Error("invalid Nano history backfill checkpoint");
  }
  return {
    through: value.through?.toUpperCase() ?? null,
    coveredAt: value.coveredAt,
    backfill: replay && { newest: replay.newest?.toUpperCase() ?? null, next: replay.next.toUpperCase(),
      startedAt: replay.startedAt, fullReceivableWindow: replay.fullReceivableWindow,
      ...(replay.quotaDeferred === true && { quotaDeferred: true }),
      ...(replay.nextHeight !== undefined && { nextHeight: BigInt(replay.nextHeight).toString(), advancedAt: replay.advancedAt }) },
  };
}

export function nanoQuoteNeedsHistory(quote, coveredAt, now) {
  return quote.status === "expired" && !quote.payHash
    && Math.min(coveredAt ?? 0, now) <= quote.expiresAt + NANO_LATE_WATCH_MS;
}
