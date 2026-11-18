import { isNanoHistoryHash, NANO_LATE_WATCH_MS, NANO_PAYMENT_GRAIN, nanoQuoteNeedsHistory, readNanoPaymentHistory,
  NANO_RECEIVABLE_COUNT as RECEIVABLE_LIMIT, NANO_HISTORY_PAGE as HISTORY_LIMIT } from "./nano-payment-history.mjs";

export const NANO_SCAN_GRACE_MS = 120_000;
const DEPOSIT_PROOF_LIMIT = 8;
const confirmed = value => value === true || value === "true";
const bucket = amount => typeof amount === "string" && /^\d{1,39}$/.test(amount) && BigInt(amount) < 2n ** 128n
  ? BigInt(amount) / NANO_PAYMENT_GRAIN : null;
const hashKey = value => isNanoHistoryHash(value) ? value.toUpperCase() : null;
const invalid = () => Object.assign(Error("Invalid Nano payment observation"), { code: "NANO_PAYMENT_OBSERVATION_INVALID" });

export function nanoWatchDemand(ledger, now) {
  const history = readNanoPaymentHistory(ledger.historyScan);
  const waiting = ledger.quotes.filter(q => !q.payHash && Number.isSafeInteger(q.createdAt) && Number.isSafeInteger(q.expiresAt)
    && now - q.createdAt >= NANO_SCAN_GRACE_MS
    && (q.status === "pending" || (q.status === "expired"
      && (now <= q.expiresAt + NANO_LATE_WATCH_MS || ledger.historyScan !== undefined && nanoQuoteNeedsHistory(q, history.coveredAt, now)))));
  return { waiting, history };
}

/** The legacy writer has no coverage cursor. Sample confirmed deposits from
 * both sides of pocketing. Check the original send time, since a receive
 * block can be written long after the payment was sent. */
export async function findUnrecordedNanoPayments({ rpc, matchesSend, account, head, ledger, waiting, now }) {
  const [history, receivable] = await Promise.all([
    rpc({ action: "account_history", account, head, count: String(HISTORY_LIMIT), raw: "true" }),
    rpc({ action: "receivable", account, count: String(RECEIVABLE_LIMIT), threshold: "1",
      source: "true", include_only_confirmed: "true" }),
  ]);
  if (typeof history.account !== "string" || history.account.replace(/^xrb_/, "nano_") !== account
    || (history.history !== "" && !Array.isArray(history.history))
    || history.history.length > HISTORY_LIMIT || (receivable.blocks !== "" && (!receivable.blocks
      || typeof receivable.blocks !== "object" || Array.isArray(receivable.blocks)))) throw invalid();
  const blocks = Object.entries(receivable.blocks || {});
  if (blocks.length > RECEIVABLE_LIMIT) throw invalid();

  const staged = new Map(), consumed = new Set(ledger.quotes.map(q => hashKey(q.payHash)).filter(Boolean));
  const amounts = new Map(waiting.map(q => [bucket(q.amountRaw), q]).filter(([key]) => key !== null && key > 0n));
  const collect = ({ sendHash, receiveHash = null, amount }) => {
    const hash = hashKey(sendHash), receipt = hashKey(receiveHash);
    if (!hash) return;
    // The writer may have saved the receiving block's ID. Remove a
    // receivable entry that a later history response identifies as consumed.
    if (consumed.has(hash) || consumed.has(receipt)) {
      staged.delete(hash);
      return;
    }
    const quote = amounts.get(bucket(amount));
    if (quote) staged.set(hash, { quote, hash, receipt });
  };
  for (const [sendHash, value] of blocks) collect({ sendHash, amount: value?.amount });
  for (const row of history.history || []) {
    if (!confirmed(row.confirmed)) continue;
    if (row.type === "state" && ["receive", "open"].includes(row.subtype)) collect({ sendHash: row.link, receiveHash: row.hash, amount: row.amount });
    if (["receive", "open"].includes(row.type)) collect({ sendHash: row.source, receiveHash: row.hash, amount: row.amount });
  }
  if (staged.size > DEPOSIT_PROOF_LIMIT) {
    throw Object.assign(Error("Nano payment observation exceeded its bound"), { code: "NANO_PAYMENT_OBSERVATION_LIMIT" });
  }
  return (await Promise.all([...staged.values()].map(async ({ quote, hash, receipt }) => {
    const hit = await rpc({ action: "block_info", hash, json_block: "true" });
    const sentAt = typeof hit.local_timestamp === "string" && /^[1-9]\d{0,11}$/.test(hit.local_timestamp)
      ? Number(hit.local_timestamp) * 1000 : 0;
    if (!confirmed(hit.confirmed) || hit.subtype !== "send" || !sentAt || sentAt + 999 < quote.createdAt
      || sentAt > quote.expiresAt + NANO_LATE_WATCH_MS || now - sentAt < NANO_SCAN_GRACE_MS
      || bucket(hit.amount) !== bucket(quote.amountRaw)) return null;
    const block = typeof hit.contents === "string" ? JSON.parse(hit.contents) : hit.contents;
    if (block?.type !== "state" || !matchesSend(block, hash)) return null;
    return { id: quote.id, hash, receipt };
  }))).filter(Boolean);
}
