/**
 * Minimal NEAR JSON-RPC client. fetch is injected, so tests run offline.
 *
 * Integers are parsed exactly: NEAR returns some values (block
 * `header.timestamp`, nonces on long-lived keys) as JSON numbers above 2^53;
 * those come back as exact decimal strings instead of rounded floats.
 *
 * Errors are NearError with:
 *   RPC_HTTP         non-2xx without a JSON-RPC error body, or a network failure
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

  return {
    url,
    call,
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
