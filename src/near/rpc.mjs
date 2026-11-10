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
      if (ref && typeof ref.blockId === "string") return call("block", { block_id: ref.blockId });
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

const TRANSPORT_CODES = new Set(["RPC_HTTP", "RPC_TIMEOUT", "RPC_BAD_RESPONSE"]);

/**
 * The same client over several endpoints, tried in order with failover.
 *
 * There is no node to run: the server never listens to the chain. It looks up
 * the one transaction a caller names, so any RPC it trusts will do, and a
 * second one covers the first being down or rate limiting.
 *
 *  - A call moves to the next endpoint only on a transport failure (RPC_HTTP,
 *    including rate limits; RPC_TIMEOUT; RPC_BAD_RESPONSE). An answer, including
 *    "unknown transaction", is final for that call.
 *  - `send_tx` moves on only for RPC_HTTP. The signed bytes are identical on
 *    every endpoint, so a second submission is the same transaction, never a
 *    second transfer; a timeout is left to the caller, which resolves it by hash.
 *  - An endpoint that failed rests for `cooldownMs`, then is tried again in its
 *    place, so a dead first entry does not slow every call.
 *  - With `chainId`, an endpoint is used only after its own `status` reports that
 *    chain. One on another network is dropped for good: a testnet node must
 *    never vouch for a mainnet payment.
 *
 * Every endpoint is equally trusted for finality; list only ones you trust.
 */
export function createNearRpcPool({ urls, chainId = null, fetch = globalThis.fetch, timeoutMs = 10_000, cooldownMs = 30_000, now = Date.now, log = () => {} } = {}) {
  const list = parseRpcUrls(urls);
  if (!list.length) throw new TypeError("createNearRpcPool needs at least one url");
  const eps = list.map((url) => ({ url, client: createNearRpc({ url, fetch, timeoutMs }), checked: !chainId, wrongChain: false, downUntil: 0 }));
  const host = (url) => { try { return new URL(url).host; } catch { return "rpc"; } };

  function markWrong(ep, got) {
    if (!ep.wrongChain) log(`NEAR RPC ${host(ep.url)} is on "${got}", not ${chainId}; it will not be used`);
    ep.wrongChain = true;
  }

  async function call(method, params, opts) {
    const usable = eps.filter((ep) => !ep.wrongChain);
    if (!usable.length) throw new NearError("RPC_WRONG_NETWORK", `no NEAR RPC endpoint is on ${chainId}`);
    const t = now();
    const rested = usable.filter((ep) => ep.downUntil <= t);
    const order = rested.length ? [...rested, ...usable.filter((ep) => ep.downUntil > t)] : usable;
    let lastErr = null;
    for (const ep of order) {
      try {
        if (!ep.checked && method !== "status") {
          const st = await ep.client.call("status", []);
          if (st.chain_id !== chainId) { markWrong(ep, st.chain_id); continue; }
          ep.checked = true;
        }
        const result = await ep.client.call(method, params, opts);
        if (method === "status" && chainId) {
          if (result.chain_id !== chainId) { markWrong(ep, result.chain_id); continue; }
          ep.checked = true;
        }
        ep.downUntil = 0;
        return result;
      } catch (e) {
        const transport = TRANSPORT_CODES.has(e?.code);
        if (!transport || (method === "send_tx" && e.code !== "RPC_HTTP")) throw e;
        lastErr = e;
        if (ep.downUntil <= now() && eps.length > 1) log(`NEAR RPC ${host(ep.url)} failed (${e.code}${e?.data?.status ? " " + e.data.status : ""}); trying the next endpoint`);
        ep.downUntil = now() + cooldownMs;
      }
    }
    if (lastErr) throw lastErr;
    throw new NearError("RPC_WRONG_NETWORK", `no NEAR RPC endpoint is on ${chainId}`);
  }

  return { url: list[0], urls: list, call, ...methods(call) };
}
