/**
 * Minimal NEAR JSON-RPC client. fetch is injected, so tests run offline.
 *
 * Integers are parsed exactly: NEAR returns some values (block
 * `header.timestamp`, nonces on long-lived keys) as JSON numbers above 2^53;
 * those come back as exact decimal strings instead of rounded floats.
 *
 * Errors are NearError with:
 *   RPC_HTTP         non-2xx without a JSON-RPC error body, a network failure, or a
 *                    rate limit (HTTP 429 or JSON-RPC code -429; `data.status` is 429)
 *   RPC_TIMEOUT      the request took longer than timeoutMs
 *   RPC_BAD_RESPONSE unparsable body, wrong envelope id, no result
 *   <cause name>     the JSON-RPC error's cause name verbatim (UNKNOWN_TRANSACTION,
 *                    TIMEOUT_ERROR, INVALID_TRANSACTION, PARSE_ERROR, ...). `data`
 *                    is the whole JSON-RPC error object.
 *   QUERY_ERROR      a `query` result that carries an `error` string (an access
 *                    key that does not exist is reported this way, with HTTP 200)
 *
 * NEAR RPC nodes send some JSON-RPC errors with a non-2xx status (PARSE_ERROR
 * with 400, a `tx` wait that hit the server's limit as TIMEOUT_ERROR with 408).
 * Those are mapped by their cause like any other JSON-RPC error.
 */
import { NearError } from "./errors.mjs";
import { assertFreshBlock, assertFreshStatus, assertFreshTime, MAX_CLOCK_SKEW_MS, nearBlockIdentity } from "./freshness.mjs";
import { isNearAccountId } from "./account.mjs";
import { base58Decode } from "./base58.mjs";

export function parseRpcJson(text) {
  return JSON.parse(text, (key, value, ctx) => {
    if (typeof value === "number" && !Number.isSafeInteger(value) && typeof ctx?.source === "string" && /^-?\d+$/.test(ctx.source)) {
      return ctx.source;
    }
    return value;
  });
}

function rpcError(error) {
  const code = (typeof error?.cause?.name === "string" && error.cause.name) || (typeof error?.name === "string" && error.name) || "RPC_ERROR";
  let message;
  if (typeof error?.data === "string") message = error.data;
  else if (error?.data !== undefined) message = JSON.stringify(error.data);
  else message = typeof error?.message === "string" ? error.message : "RPC error";
  return new NearError(code, message, { data: error });
}

function isNearHash(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try { base58Decode(value, 32); return true; } catch { return false; }
}

export function requireNearAccountChanges(result, blockHash, accounts) {
  if (result?.block_hash !== blockHash || !Array.isArray(result?.changes)) {
    throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received changes for a different block");
  }
  for (const row of result.changes) {
    const account = row?.change?.account_id, cause = row?.cause;
    if (!isNearAccountId(account) || typeof cause?.type !== "string"
        || (accounts.includes(account) && cause.type === "receipt_processing" && !isNearHash(cause.receipt_hash))) {
      throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received malformed account changes");
    }
  }
  return result;
}

export function requireNearReceiptTransaction(result) {
  if (!isNearHash(result?.transaction_hash) || !isNearAccountId(result?.sender_account_id)) {
    throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher could not resolve a receipt's transaction");
  }
  return result;
}

const isAnchoredAccountChanges = (method, params) => method === "EXPERIMENTAL_changes"
  && params?.changes_type === "account_changes" && typeof params.block_id === "string" && Array.isArray(params.account_ids);

export function createNearRpc({ url, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new TypeError("createNearRpc needs an http(s) url");
  if (typeof fetch !== "function") throw new TypeError("createNearRpc needs a fetch function");
  let seq = 0;

  async function call(method, params, { timeoutMs: perCall } = {}) {
    const id = `nanoodle-${++seq}`;
    const ms = perCall ?? timeoutMs;
    let res;
    let text;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(ms),
        redirect: "error",
      });
      text = await res.text();
    } catch (cause) {
      if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        throw new NearError("RPC_TIMEOUT", `NEAR RPC ${method} timed out after ${ms} ms`, { cause });
      }
      throw new NearError("RPC_HTTP", `NEAR RPC ${method} request failed`, { cause });
    }
    let body = null;
    try {
      body = parseRpcJson(text);
    } catch {
      body = null;
    }
    const envelope = body && typeof body === "object" && !Array.isArray(body) ? body : null;
    // Public RPCs rate-limit with HTTP 429 and/or a JSON-RPC error with code -429.
    // Either way it is a transport condition ("ask again, or ask another node"), not an answer.
    if (res.status === 429 || envelope?.error?.code === -429) {
      throw new NearError("RPC_HTTP", `NEAR RPC ${method} was rate limited`, { data: { status: 429 } });
    }
    if (!res.ok) {
      if (envelope?.error && envelope.id === id) throw rpcError(envelope.error);
      throw new NearError("RPC_HTTP", `NEAR RPC ${method} answered HTTP ${res.status}`, { data: { status: res.status } });
    }
    if (!envelope) throw new NearError("RPC_BAD_RESPONSE", `NEAR RPC ${method} returned an unparsable body`);
    if (envelope.id !== id) throw new NearError("RPC_BAD_RESPONSE", `NEAR RPC ${method} answered a different request id`);
    if (envelope.error) throw rpcError(envelope.error);
    if (!Object.hasOwn(envelope, "result") || envelope.result === null || typeof envelope.result !== "object") {
      throw new NearError("RPC_BAD_RESPONSE", `NEAR RPC ${method} returned no result`);
    }
    const result = envelope.result;
    if (method === "query" && typeof result.error === "string") {
      throw new NearError("QUERY_ERROR", result.error, { data: result });
    }
    if (isAnchoredAccountChanges(method, params)) requireNearAccountChanges(result, params.block_id, params.account_ids);
    if (method === "EXPERIMENTAL_receipt_to_tx") requireNearReceiptTransaction(result);
    return result;
  }

  return { url, call, ...methods(call) };
}

/** The typed helpers every client shares, built over a `call(method, params, opts)`. */
function methods(call) {
  return {
    status() {
      return call("status", []);
    },
    block(ref) {
      const id = ref?.blockId;
      if (typeof id === "string" || (Number.isSafeInteger(id) && id >= 0)) return call("block", { block_id: id });
      if (ref && typeof ref.finality === "string") return call("block", { finality: ref.finality });
      throw new TypeError("block() needs { finality } or { blockId }");
    },
    txStatus({ txHash, senderId, waitUntil = "FINAL", timeoutMs: perCall } = {}) {
      return call("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil }, { timeoutMs: perCall });
    },
    viewAccessKey({ accountId, publicKey }) {
      return call("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
    },
    sendTx(signedTxBase64, waitUntil = "INCLUDED_FINAL", { timeoutMs: perCall } = {}) {
      return call("send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil }, { timeoutMs: perCall });
    },
  };
}

/** "a, b ,c" or ["a","b"] → ["a","b","c"], duplicates removed, order kept. */
export function parseRpcUrls(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(",")).map((u) => String(u).trim()).filter(Boolean);
  return [...new Set(list)];
}

const TRANSPORT_CODES = new Set(["RPC_HTTP", "RPC_TIMEOUT", "RPC_BAD_RESPONSE", "RPC_STALE", "RPC_SYNCING"]);
const RECOVERABLE_READS = new Set(["status", "block", "query", "gas_price", "EXPERIMENTAL_protocol_config",
  "EXPERIMENTAL_changes", "EXPERIMENTAL_receipt_to_tx"]);
const RECEIPT_LOOKUP_NODE_ERRORS = new Set(["UNKNOWN_RECEIPT", "UNSUPPORTED", "OUTCOMES_NOT_STORED",
  "DEPTH_EXCEEDED", "BUDGET_EXCEEDED", "INTERNAL_ERROR"]);
const ACCOUNT_CHANGES_NODE_ERRORS = new Set(["UNKNOWN_BLOCK", "NOT_SYNCED_YET", "SHARD_NOT_APPLIED", "INTERNAL_ERROR"]);

function discoveryReadCanFailOver(method, params, error) {
  const missingMethod = error?.code === "METHOD_NOT_FOUND" || error?.data?.code === -32601;
  if (method === "EXPERIMENTAL_receipt_to_tx") return missingMethod || RECEIPT_LOOKUP_NODE_ERRORS.has(error?.code);
  if (isAnchoredAccountChanges(method, params)) return missingMethod || ACCOUNT_CHANGES_NODE_ERRORS.has(error?.code);
  // A missing numeric height may be a skipped block. A missing known hash
  // can come from a provider with a shorter history than its peer.
  return method === "block" && typeof params?.block_id === "string" && error?.code === "UNKNOWN_BLOCK";
}

/**
 * The same client over several endpoints, tried in order with failover.
 *
 * Verification and the shared finalized-block payment watcher use this pool.
 * No node or external indexer is required. An additional endpoint covers the
 * first being down or rate limiting.
 *
 *  - A call moves to the next endpoint on transport or node-health failures.
 *    Unnamed server errors also allow failover on watcher and funding reads.
 *    A named answer such as "unknown transaction" is final for that call.
 *    Node-local discovery misses and missing historical hashes can fail over.
 *  - Once attempted, `send_tx` moves on only for RPC_HTTP. Preflight health
 *    failures may move on before any bytes are broadcast. Signed bytes are identical on
 *    every endpoint, so a second submission is the same transaction, never a
 *    second transfer; a timeout is left to the caller, which resolves it by hash.
 *  - An endpoint that failed rests for `cooldownMs`, then is tried again in its
 *    place, so a dead first entry does not slow every call.
 *  - With `chainId`, an endpoint's network is rechecked every `recheckMs`.
 *    One on another network is dropped for good: a testnet node must
 *    never vouch for a mainnet payment.
 *  - Hosted callers enable `maxHeadAgeMs`: syncing/stale status or latest blocks
 *    fail over before authorizing work. A replacement endpoint verifies the
 *    last accepted finalized block before it is used for reads or submission.
 *    Historical blocks remain readable.
 *
 * Every endpoint is equally trusted for finality; list only ones you trust.
 */
export function createNearRpcPool({ urls, chainId = null, fetch = globalThis.fetch, timeoutMs = 10_000, cooldownMs = 30_000, minIntervalMs = 0, recheckMs = 30_000, maxHeadAgeMs = null, maxClockSkewMs = MAX_CLOCK_SKEW_MS, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), log = () => {} } = {}) {
  const list = parseRpcUrls(urls);
  if (!list.length) throw new TypeError("createNearRpcPool needs at least one url");
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60_000) throw new TypeError("minIntervalMs must be between 0 and 60000");
  if (!Number.isSafeInteger(recheckMs) || recheckMs < 0 || recheckMs > 60_000) throw new TypeError("recheckMs must be between 0 and 60000");
  if (maxHeadAgeMs !== null && (!Number.isSafeInteger(maxHeadAgeMs) || maxHeadAgeMs <= 0)) throw new TypeError("maxHeadAgeMs must be a positive integer or null");
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) throw new TypeError("maxClockSkewMs must be a nonnegative integer");
  const eps = list.map((url) => ({ url, client: createNearRpc({ url, fetch, timeoutMs }), checkedAt: null, headAt: null,
    checking: null, finalAnchor: null, finalChecking: null, wrongChain: false, downUntil: 0 }));
  const host = (url) => { try { return new URL(url).host; } catch { return "rpc"; } };
  let nextStart = 0;
  let latestFinal = null;
  const freshness = () => ({ now: now(), maxHeadAgeMs, maxClockSkewMs });
  async function request(ep, method, params, opts, beforeDispatch) {
    if (minIntervalMs) {
      const at = Math.max(now(), nextStart), delay = at - now();
      nextStart = at + minIntervalMs; // reserve before awaiting: concurrent callers share the budget
      if (delay > 0) await pause(delay);
    }
    beforeDispatch?.();
    return ep.client.call(method, params, opts);
  }

  function markWrong(ep, got) {
    if (!ep.wrongChain) log(`NEAR RPC ${host(ep.url)} is on "${got}", not ${chainId}; it will not be used`);
    ep.wrongChain = true;
  }

  function checkStatus(ep, status) {
    if (chainId && status.chain_id !== chainId) {
      markWrong(ep, status.chain_id);
      throw new NearError("RPC_WRONG_NETWORK", "NEAR RPC changed network");
    }
    if (maxHeadAgeMs !== null) ep.headAt = assertFreshStatus(status, freshness());
    ep.checkedAt = now();
  }

  async function ensureChecked(ep) {
    if (!chainId && maxHeadAgeMs === null) return;
    if (ep.checkedAt !== null && now() >= ep.checkedAt && now() - ep.checkedAt < recheckMs) {
      try {
        if (maxHeadAgeMs !== null) assertFreshTime(ep.headAt, freshness());
        return;
      } catch { /* a cached status can expire sooner than the recheck interval */ }
    }
    if (!ep.checking) ep.checking = request(ep, "status", []).then(st => checkStatus(ep, st)).finally(() => { ep.checking = null; });
    await ep.checking;
  }

  async function proveFinalAnchor(ep, anchor) {
    let actual;
    try {
      actual = nearBlockIdentity(await request(ep, "block", { block_id: anchor.height }));
    } catch (error) {
      if (TRANSPORT_CODES.has(error?.code)) throw error;
      throw new NearError("RPC_BAD_RESPONSE", "NEAR RPC could not prove the previous finalized block", { cause: error });
    }
    if (actual.height !== anchor.height || actual.hash !== anchor.hash) {
      throw new NearError("RPC_BAD_RESPONSE", "NEAR RPC disagrees with the previous finalized block");
    }
    if (!ep.finalAnchor || ep.finalAnchor.height <= anchor.height) ep.finalAnchor = anchor;
  }

  async function ensureFinalAnchor(ep) {
    // Coalesce concurrent reads and recheck if another endpoint advanced the
    // checkpoint while the proof was in flight.
    for (let attempt = 0; attempt < 3; attempt++) {
      const anchor = latestFinal;
      if (!anchor || ep.finalAnchor === anchor) return;
      if (ep.finalChecking?.anchor !== anchor) {
        const pending = { anchor, promise: null };
        pending.promise = proveFinalAnchor(ep, anchor).finally(() => {
          if (ep.finalChecking === pending) ep.finalChecking = null;
        });
        ep.finalChecking = pending;
      }
      await ep.finalChecking.promise;
      if (ep.finalAnchor === latestFinal) return;
    }
    throw new NearError("RPC_STALE", "NEAR finalized checkpoint advanced before this endpoint could verify it");
  }

  async function call(method, params, opts) {
    const usable = eps.filter((ep) => !ep.wrongChain);
    if (!usable.length) throw new NearError("RPC_WRONG_NETWORK", `no NEAR RPC endpoint is on ${chainId}`);
    const t = now();
    const rested = usable.filter((ep) => ep.downUntil <= t);
    const order = rested.length ? [...rested, ...usable.filter((ep) => ep.downUntil > t)] : usable;
    let lastErr = null;
    for (const ep of order) {
      if (ep.wrongChain) continue;
      let attempted = false;
      try {
        if (method !== "status") {
          await ensureChecked(ep);
          if (latestFinal && ep.finalAnchor !== latestFinal) await ensureFinalAnchor(ep);
        }
        const result = await request(ep, method, params, opts, () => {
          if (method !== "status" && latestFinal && ep.finalAnchor !== latestFinal) {
            throw new NearError("RPC_STALE", "NEAR finalized checkpoint advanced before dispatch");
          }
          attempted = true;
        });
        if (method === "status") checkStatus(ep, result);
        if (maxHeadAgeMs !== null && method === "block" && params?.finality) {
          assertFreshBlock(result, freshness());
          if (params.finality === "final") {
            const next = nearBlockIdentity(result);
            if (latestFinal && ep.finalAnchor !== latestFinal) await ensureFinalAnchor(ep);
            if (latestFinal) {
              if (ep.finalAnchor !== latestFinal) throw new NearError("RPC_STALE", "NEAR finalized checkpoint advanced before verification");
              if (next.height < latestFinal.height) throw new NearError("RPC_STALE", "NEAR finalized head regressed");
              const sameHeight = next.height === latestFinal.height, sameHash = next.hash === latestFinal.hash;
              if (sameHeight !== sameHash) {
                ep.finalAnchor = null;
                throw new NearError("RPC_BAD_RESPONSE", "NEAR finalized block identity changed");
              }
            }
            if (!latestFinal || next.height > latestFinal.height) latestFinal = next;
            ep.finalAnchor = latestFinal;
          }
        }
        ep.downUntil = 0;
        return result;
      } catch (e) {
        if (e?.code === "RPC_WRONG_NETWORK" && ep.wrongChain) continue;
        const retry = TRANSPORT_CODES.has(e?.code)
          || discoveryReadCanFailOver(method, params, e)
          || (e?.code === "RPC_ERROR" && (!attempted || RECOVERABLE_READS.has(method)));
        if (!retry || (method === "send_tx" && attempted && e.code !== "RPC_HTTP")) throw e;
        lastErr = e;
        ep.checkedAt = null;
        ep.headAt = null;
        const status = e?.data?.status;
        const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? ` ${status}` : "";
        if (ep.downUntil <= now() && eps.length > 1) log(`NEAR RPC ${host(ep.url)} failed (${e.code}${httpStatus}); trying the next endpoint`);
        ep.downUntil = now() + cooldownMs;
      }
    }
    if (lastErr) throw lastErr;
    throw new NearError("RPC_WRONG_NETWORK", `no NEAR RPC endpoint is on ${chainId}`);
  }

  return { url: list[0], urls: list, call, ...methods(call) };
}
