/**
 * Durable state for the NEAR rail: quotes, consumed transaction hashes and
 * refunds, in one JSON file.
 *
 * Every mutation is written synchronously before it returns (temp file, fsync,
 * rename), so a crash never loses a consumed hash or an owed refund that a
 * caller was told about. A file that exists but cannot be read is an error,
 * never an empty start: starting empty could forget a consumed hash.
 *
 * Values must be JSON-safe; callers store yocto amounts as integer strings.
 * One process owns a state file.
 */
import { readFileSync } from "node:fs";
import { writePrivateStateSync } from "../private-state.mjs";
import { NearError } from "./errors.mjs";

const FINAL_QUOTE = new Set(["settled", "failed", "expired", "rejected"]);

function awaitingPayment(quote) {
  return (quote?.status === "pending" || quote?.status === "expired") && !quote.payTx;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertJsonSafe(value, path = "value") {
  if (typeof value === "bigint") throw new TypeError(`${path} is a bigint; store it as a string`);
  if (typeof value === "function" || typeof value === "symbol") throw new TypeError(`${path} is not JSON-safe`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertJsonSafe(v, `${path}.${k}`);
  }
}

function copy(v) {
  return v === undefined ? undefined : structuredClone(v);
}

export function openNearLedger({ file, network, merchant, now = Date.now, requireExisting = false }) {
  if (typeof requireExisting !== "boolean") throw TypeError("requireExisting must be a boolean");
  if (typeof file !== "string" || !file) throw new TypeError("openNearLedger needs a file path");
  if (network !== "testnet" && network !== "mainnet") throw new TypeError('network must be "testnet" or "mainnet"');
  if (typeof merchant !== "string" || !merchant) throw new TypeError("openNearLedger needs a merchant account");

  let state;
  let text = null;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT" || requireExisting) throw new NearError("STATE_UNREADABLE", `NEAR state file ${file} could not be read; refusing to start empty`, { cause: e });
  }
  if (text === null) {
    state = { v: 1, network, merchant, quotes: {}, consumedTx: {}, refunds: {}, payouts: {}, meta: {} };
  } else {
    try {
      state = JSON.parse(text);
    } catch (cause) {
      throw new NearError("STATE_UNREADABLE", `NEAR state file ${file} is not valid JSON; refusing to start empty`, { cause });
    }
    if (!isPlainObject(state) || state.v !== 1 || typeof state.network !== "string" || typeof state.merchant !== "string"
      || !isPlainObject(state.quotes) || !isPlainObject(state.consumedTx) || !isPlainObject(state.refunds)
      || (state.payouts !== undefined && !isPlainObject(state.payouts))
      || (state.meta !== undefined && !isPlainObject(state.meta))) {
      throw new NearError("STATE_UNREADABLE", `NEAR state file ${file} does not have the expected shape; refusing to start empty`);
    }
    state.meta ??= {};
    state.payouts ??= {};
    if (state.network !== network || state.merchant !== merchant) {
      throw new NearError("STATE_MISMATCH",
        `NEAR state file ${file} belongs to ${state.merchant} on ${state.network}, not ${merchant} on ${network}`);
    }
  }
  let persisted = JSON.stringify(state), persistenceFailed = false;
  // Earlier releases could persist the claim before attaching it to its quote.
  // Index those exceptions once so watching blocks does not scan the tx history.
  const unattachedPayments = new Set();
  for (const id of Object.values(state.consumedTx)) {
    if (awaitingPayment(state.quotes[id])) unattachedPayments.add(id);
  }

  function persist() {
    const next = JSON.stringify(state);
    try {
      writePrivateStateSync(file, next);
      persistenceFailed = false;
      persisted = next;
    } catch (e) {
      persistenceFailed = true;
      state = JSON.parse(persisted); // roll the in-memory state back to what is on disk
      throw e;
    }
  }

  function mutate(fn) {
    fn();
    persist();
  }

  const ledger = {
    file,
    persistenceStatus: () => ({ ok: !persistenceFailed, pendingWrites: 0 }),

    getQuote(id) {
      return Object.hasOwn(state.quotes, id) ? copy(state.quotes[id]) : null;
    },
    putQuote(quote) {
      if (!isPlainObject(quote) || typeof quote.id !== "string" || !quote.id) throw new TypeError("a quote needs a string id");
      assertJsonSafe(quote, "quote");
      if (Object.hasOwn(state.quotes, quote.id)) throw new NearError("DUPLICATE_ID", `quote ${quote.id} already exists`);
      mutate(() => { state.quotes[quote.id] = copy(quote); });
    },
    updateQuote(id, patch) {
      if (!Object.hasOwn(state.quotes, id)) throw new NearError("NOT_FOUND", `no quote ${id}`);
      if (!isPlainObject(patch)) throw new TypeError("patch must be an object");
      assertJsonSafe(patch, "patch");
      mutate(() => { state.quotes[id] = { ...state.quotes[id], ...copy(patch), id }; });
      return copy(state.quotes[id]);
    },
    quotes() {
      return Object.values(state.quotes).map(copy);
    },

    consumeTx(txHash, paymentId) {
      if (typeof txHash !== "string" || !txHash || typeof paymentId !== "string" || !paymentId) {
        throw new TypeError("consumeTx needs a tx hash and a payment id");
      }
      if (Object.hasOwn(state.consumedTx, txHash)) return false;
      mutate(() => { state.consumedTx[txHash] = paymentId; });
      if (awaitingPayment(state.quotes[paymentId])) unattachedPayments.add(paymentId);
      return true;
    },
    consumedBy(txHash) {
      return Object.hasOwn(state.consumedTx, txHash) ? state.consumedTx[txHash] : null;
    },
    hasUnattachedPayment(id) {
      return unattachedPayments.has(id) && awaitingPayment(state.quotes[id]);
    },
    recordPayment(id, txHash, patch) {
      if (typeof txHash !== "string" || !txHash || !isPlainObject(patch) || !["paid", "rejected"].includes(patch.status)) {
        throw new TypeError("recordPayment needs a tx hash and payment fields");
      }
      assertJsonSafe(patch, "payment");
      const quote = state.quotes[id], owner = ledger.consumedBy(txHash);
      if (!awaitingPayment(quote) || (owner !== null && owner !== id)
        || (unattachedPayments.has(id) && owner !== id)) return null;
      mutate(() => {
        state.consumedTx[txHash] = id;
        state.quotes[id] = { ...quote, ...copy(patch), id, payTx: txHash };
      });
      unattachedPayments.delete(id);
      return copy(state.quotes[id]);
    },

    putRefund(refund) {
      if (!isPlainObject(refund) || typeof refund.id !== "string" || !refund.id || typeof refund.paymentId !== "string") {
        throw new TypeError("a refund needs a string id and paymentId");
      }
      assertJsonSafe(refund, "refund");
      if (Object.hasOwn(state.refunds, refund.id)) throw new NearError("DUPLICATE_ID", `refund ${refund.id} already exists`);
      mutate(() => { state.refunds[refund.id] = copy(refund); });
    },
    updateRefund(id, patch) {
      if (!Object.hasOwn(state.refunds, id)) throw new NearError("NOT_FOUND", `no refund ${id}`);
      if (!isPlainObject(patch)) throw new TypeError("patch must be an object");
      assertJsonSafe(patch, "patch");
      mutate(() => { state.refunds[id] = { ...state.refunds[id], ...copy(patch), id }; });
      return copy(state.refunds[id]);
    },
    getRefund(id) {
      return Object.hasOwn(state.refunds, id) ? copy(state.refunds[id]) : null;
    },
    refundForPayment(paymentId) {
      for (const r of Object.values(state.refunds)) if (r.paymentId === paymentId) return copy(r);
      return null;
    },
    refunds() {
      return Object.values(state.refunds).map(copy);
    },

    // Creator payouts are in Nano, independently of the customer's payment asset.
    // Keep this outbox after quote pruning, like refunds and consumed hashes.
    putPayout(payout) {
      if (!isPlainObject(payout) || typeof payout.paymentId !== "string" || !payout.paymentId) throw new TypeError("a payout needs a paymentId");
      assertJsonSafe(payout, "payout");
      if (Object.hasOwn(state.payouts, payout.paymentId)) throw new NearError("DUPLICATE_ID", "a payout already exists for this payment");
      mutate(() => { state.payouts[payout.paymentId] = copy(payout); });
    },
    getPayout(paymentId) {
      return Object.hasOwn(state.payouts, paymentId) ? copy(state.payouts[paymentId]) : null;
    },
    updatePayout(paymentId, patch) {
      if (!Object.hasOwn(state.payouts, paymentId)) throw new NearError("NOT_FOUND", "no payout for this payment");
      assertJsonSafe(patch, "payout patch");
      mutate(() => { state.payouts[paymentId] = { ...state.payouts[paymentId], ...copy(patch), paymentId }; });
      return copy(state.payouts[paymentId]);
    },
    payouts() {
      return Object.values(state.payouts).map(copy);
    },

    getMeta(key) {
      return Object.hasOwn(state.meta, key) ? copy(state.meta[key]) : undefined;
    },
    setMeta(key, value) {
      assertJsonSafe(value, `meta.${key}`);
      mutate(() => { state.meta[key] = copy(value); });
    },

    /**
     * Delete old finished quotes and unpaid quotes past retention. Preserve
     * unpaid quotes that still need to be reconciled with a recorded tx claim.
     * Consumed hashes and refunds are never pruned.
     */
    prune({ retainMs = 86_400_000, unpaidRetainMs = 86_400_000 } = {}) {
      const t = now();
      const doomed = [];
      for (const [id, q] of Object.entries(state.quotes)) {
        if (awaitingPayment(q)) {
          if (!unattachedPayments.has(id) && typeof q.expiresAt === "number" && t - q.expiresAt > unpaidRetainMs) doomed.push(id);
          continue;
        }
        if (!FINAL_QUOTE.has(q.status)) continue;
        const at = typeof q.finishedAt === "number" ? q.finishedAt : null;
        if (at !== null && t - at > retainMs) doomed.push(id);
      }
      if (doomed.length) mutate(() => { for (const id of doomed) delete state.quotes[id]; });
      return doomed.length;
    },
  };
  return ledger;
}
