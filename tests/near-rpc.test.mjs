/**
 * NEAR JSON-RPC client against a mock fetch. Response bodies are shapes
 * captured from public testnet RPC (read-only calls), with accounts renamed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearRpc, parseRpcJson } from "../src/near/rpc.mjs";

const URL_ = "https://rpc.example.test";

/** A mock fetch: `answer(req)` returns {status, body} or {status, text}; the request id is echoed. */
function mockFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, init, req });
    const a = await answer(req, init);
    const text = a.text ?? JSON.stringify({ jsonrpc: "2.0", id: req.id, ...a.body });
    return new Response(text, { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

test("parseRpcJson keeps unsafe integers exact and leaves safe ones as numbers", () => {
  const v = parseRpcJson('{"timestamp":1794262084390466800,"timestamp_nanosec":"1794262084390466740","height":276980002,"nonce":275735371000005,"neg":-9007199254740993,"f":1.5,"big_f":1.5e300}');
  assert.equal(v.timestamp, "1794262084390466800");
  assert.equal(v.timestamp_nanosec, "1794262084390466740");
  assert.equal(v.height, 276980002);
  assert.equal(v.nonce, 275735371000005);
  assert.equal(v.neg, "-9007199254740993");
  assert.equal(v.f, 1.5);
  assert.equal(v.big_f, 1.5e300);
  assert.equal(parseRpcJson("9007199254740993"), "9007199254740993");
  assert.equal(parseRpcJson("9007199254740991"), 9007199254740991);
});

test("request shapes for every method", async () => {
  const { fetch, calls } = mockFetch(() => ({ body: { result: { ok: true } } }));
  const rpc = createNearRpc({ url: URL_, fetch });
  assert.equal(rpc.url, URL_);
  await rpc.status();
  await rpc.block({ finality: "final" });
  await rpc.block({ blockId: "BqMN6q5nwpKqiJ3c7jQ92Y1J8pCZvx7hou7xafiunMcL" });
  await rpc.txStatus({ txHash: "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", senderId: "payer.testnet" });
  await rpc.txStatus({ txHash: "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", senderId: "payer.testnet", waitUntil: "NONE" });
  await rpc.viewAccessKey({ accountId: "merchant.testnet", publicKey: "ed25519:CDo3YDqTKQSzpxct7gcPUxk88P2HKixPKQ6Cbg18yohE" });
  await rpc.sendTx("AAAA");
  await rpc.sendTx("BBBB", "FINAL");
  await rpc.call("gas_price", [null]);
  const reqs = calls.map((c) => c.req);
  assert.deepEqual(reqs.map((r) => [r.method, r.params]), [
    ["status", []],
    ["block", { finality: "final" }],
    ["block", { block_id: "BqMN6q5nwpKqiJ3c7jQ92Y1J8pCZvx7hou7xafiunMcL" }],
    ["tx", { tx_hash: "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", sender_account_id: "payer.testnet", wait_until: "FINAL" }],
    ["tx", { tx_hash: "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", sender_account_id: "payer.testnet", wait_until: "NONE" }],
    ["query", { request_type: "view_access_key", finality: "final", account_id: "merchant.testnet", public_key: "ed25519:CDo3YDqTKQSzpxct7gcPUxk88P2HKixPKQ6Cbg18yohE" }],
    ["send_tx", { signed_tx_base64: "AAAA", wait_until: "INCLUDED_FINAL" }],
    ["send_tx", { signed_tx_base64: "BBBB", wait_until: "FINAL" }],
    ["gas_price", [null]],
  ]);
  for (const r of reqs) assert.equal(r.jsonrpc, "2.0");
  assert.equal(new Set(reqs.map((r) => r.id)).size, reqs.length);
  assert.match(reqs[0].id, /^nanoodle-\d+$/);
  for (const c of calls) {
    assert.equal(c.url, URL_);
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers["content-type"], "application/json");
    assert.equal(c.init.redirect, "error");
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  assert.throws(() => rpc.block({}), TypeError);
});

test("block: unsafe timestamp stays exact, timestamp_nanosec is a string", async () => {
  const text = (id) => `{"jsonrpc":"2.0","result":{"author":"node0","header":{"height":276980002,"hash":"NUgay1111111111111111111111111111111111111","timestamp":1794262084390466800,"timestamp_nanosec":"1794262084390466740"}},"id":"${id}"}`;
  const { fetch } = mockFetch((req) => ({ text: text(req.id) }));
  const rpc = createNearRpc({ url: URL_, fetch });
  const b = await rpc.block({ finality: "final" });
  assert.equal(b.header.timestamp, "1794262084390466800");
  assert.equal(b.header.timestamp_nanosec, "1794262084390466740");
  assert.equal(b.header.height, 276980002);
});

test("view_access_key: result, and an unknown key as QUERY_ERROR", async () => {
  let unknown = false;
  const { fetch } = mockFetch(() => unknown
    ? { body: { result: { block_hash: "6YqaHbPh8XNkhsCEcvbNmLKYtRrzxgtycbP1Rzwq6suE", block_height: 276981388, error: "access key ed25519:11111111111111111111111111111111 does not exist while viewing", logs: [] } } }
    : { body: { result: { block_hash: "NUgay1111111111111111111111111111111111111", block_height: 276980002, nonce: 275735371000005, permission: "FullAccess" } } });
  const rpc = createNearRpc({ url: URL_, fetch });
  const k = await rpc.viewAccessKey({ accountId: "merchant.testnet", publicKey: "ed25519:11111111111111111111111111111111" });
  assert.equal(k.nonce, 275735371000005);
  assert.equal(k.permission, "FullAccess");
  unknown = true;
  await assert.rejects(rpc.viewAccessKey({ accountId: "merchant.testnet", publicKey: "ed25519:11111111111111111111111111111111" }), (e) => {
    assert.equal(e.name, "NearError");
    assert.equal(e.code, "QUERY_ERROR");
    assert.match(e.message, /does not exist while viewing/);
    assert.equal(e.data.block_height, 276981388);
    return true;
  });
});

test("JSON-RPC error causes pass through verbatim", async () => {
  const cases = [
    {
      status: 200,
      error: { name: "HANDLER_ERROR", cause: { info: { requested_transaction_hash: "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwoFm" }, name: "UNKNOWN_TRANSACTION" }, code: -32000, message: "Server error", data: "Transaction 6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwoFm doesn't exist" },
      code: "UNKNOWN_TRANSACTION", message: /doesn't exist/,
    },
    {
      // A FINAL wait on a hash the network never saw: public RPC holds it ~30 s, then answers 408.
      status: 408,
      error: { name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" },
      code: "TIMEOUT_ERROR", message: /Timeout/,
    },
    {
      // Bad signed bytes: answered with HTTP 400.
      status: 400,
      error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR", info: { error_message: "Failed parsing args: the value could not decoded from borsh due to: Unexpected length of input" } }, code: -32700, message: "Parse error", data: "Failed parsing args: the value could not decoded from borsh due to: Unexpected length of input" },
      code: "PARSE_ERROR", message: /borsh/,
    },
    {
      status: 200,
      error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: "Expired" } } },
      code: "INVALID_TRANSACTION", message: /Expired/,
    },
    {
      status: 200,
      error: { name: "HANDLER_ERROR", cause: { info: { block_hash: "6MCrxU6EoeRLYCVLWFF27s6s1Nu9maLCTADZvWLi7bFA", block_height: 276981458, requested_account_id: "nobody.testnet" }, name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error", data: "account nobody.testnet does not exist while viewing" },
      code: "UNKNOWN_ACCOUNT", message: /does not exist/,
    },
    {
      status: 200,
      error: { name: "HANDLER_ERROR", cause: { info: {}, name: "UNKNOWN_BLOCK" }, code: -32000, message: "Server error", data: "DB Not Found Error: BLOCK: 11111111111111111111111111111111 \n Cause: Unknown" },
      code: "UNKNOWN_BLOCK", message: /DB Not Found/,
    },
    { status: 200, error: { name: "SOMETHING", code: -1, message: "odd" }, code: "SOMETHING", message: /odd/ },
    { status: 200, error: { code: -1 }, code: "RPC_ERROR", message: /RPC error/ },
  ];
  for (const c of cases) {
    const { fetch } = mockFetch(() => ({ status: c.status, body: { error: c.error } }));
    const rpc = createNearRpc({ url: URL_, fetch });
    await assert.rejects(rpc.call("tx", {}), (e) => {
      assert.equal(e.name, "NearError");
      assert.equal(e.code, c.code);
      assert.match(e.message, c.message);
      assert.deepEqual(e.data, c.error);
      return true;
    }, c.code);
  }
  // INVALID_TRANSACTION keeps the InvalidTxError detail for callers
  const { fetch } = mockFetch(() => ({ body: { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } } } } } } }));
  await assert.rejects(createNearRpc({ url: URL_, fetch }).sendTx("AAAA"), (e) => {
    assert.deepEqual(e.data.data.TxExecutionError.InvalidTxError, { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } });
    return true;
  });
});

test("transport errors", async () => {
  // non-2xx without a JSON-RPC body
  let rpc = createNearRpc({ url: URL_, fetch: async () => new Response("Service Unavailable", { status: 503 }) });
  await assert.rejects(rpc.status(), { code: "RPC_HTTP" });
  // non-2xx whose error body answers a different id
  rpc = createNearRpc({ url: URL_, fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "E" } }), { status: 500 }) });
  await assert.rejects(rpc.status(), { code: "RPC_HTTP" });
  // network failure
  rpc = createNearRpc({ url: URL_, fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(rpc.status(), { code: "RPC_HTTP" });
  // unparsable
  rpc = createNearRpc({ url: URL_, fetch: async () => new Response("<html>", { status: 200 }) });
  await assert.rejects(rpc.status(), { code: "RPC_BAD_RESPONSE" });
  // envelope id mismatch
  rpc = createNearRpc({ url: URL_, fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "other", result: {} })) });
  await assert.rejects(rpc.status(), { code: "RPC_BAD_RESPONSE" });
  // no result
  const { fetch } = mockFetch(() => ({ body: {} }));
  await assert.rejects(createNearRpc({ url: URL_, fetch }).status(), { code: "RPC_BAD_RESPONSE" });
  // array body
  rpc = createNearRpc({ url: URL_, fetch: async () => new Response("[]") });
  await assert.rejects(rpc.status(), { code: "RPC_BAD_RESPONSE" });
});

test("timeout -> RPC_TIMEOUT (client default and per-call)", async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const rpc = createNearRpc({ url: URL_, fetch: hang, timeoutMs: 20 });
  await assert.rejects(rpc.status(), { code: "RPC_TIMEOUT" });
  const slow = createNearRpc({ url: URL_, fetch: hang, timeoutMs: 60_000 });
  const t0 = Date.now();
  await assert.rejects(slow.txStatus({ txHash: "x", senderId: "a.testnet", timeoutMs: 20 }), { code: "RPC_TIMEOUT" });
  assert.ok(Date.now() - t0 < 5_000);
});

test("constructor checks", () => {
  assert.throws(() => createNearRpc({ url: "ftp://x", fetch: async () => {} }), TypeError);
  assert.throws(() => createNearRpc({ url: URL_, fetch: null }), TypeError);
});
