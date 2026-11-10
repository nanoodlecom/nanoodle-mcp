/**
 * NEAR JSON-RPC client against a mock fetch. Response bodies are shapes
 * captured from public testnet RPC (read-only calls), with accounts renamed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearRpc, createNearRpcPool, parseRpcUrls, parseRpcJson } from "../src/near/rpc.mjs";

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
    const keep = setInterval(() => {}, 1_000); /* Node 22 unrefs AbortSignal.timeout; a real fetch holds a socket */ 
    init.signal.addEventListener("abort", () => { clearInterval(keep); reject(init.signal.reason); });
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

/* ------------------------------ failover ------------------------------- */

/** A mock fetch that answers per host: `hosts[host](req)` → {status, body} | {status, text} | throws. */
function hostFetch(hosts) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    const host = new URL(url).host;
    calls.push(`${host} ${req.method}`);
    const a = await hosts[host](req);
    const text = a.text ?? JSON.stringify({ jsonrpc: "2.0", id: req.id, ...a.body });
    return new Response(text, { status: a.status ?? 200 });
  };
  return { fetch, calls };
}
const ok = (chain = "mainnet") => (req) => ({ body: { result: req.method === "status" ? { chain_id: chain } : { from: chain, method: req.method } } });
const limited = () => ({ status: 429, text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -429, message: "Rate limits exceeded" } }) });

test("a rate limit is a transport failure in both shapes public RPCs use", async () => {
  let rpc = createNearRpc({ url: URL_, fetch: async () => new Response("slow down", { status: 429 }) });
  await assert.rejects(rpc.status(), (e) => e.code === "RPC_HTTP" && e.data.status === 429);
  // HTTP 200 with a JSON-RPC error whose code is -429 and whose id matches the request
  const { fetch } = mockFetch(() => ({ body: { error: { code: -429, message: "Rate limits exceeded" } } }));
  rpc = createNearRpc({ url: URL_, fetch });
  await assert.rejects(rpc.status(), (e) => e.code === "RPC_HTTP" && e.data.status === 429);
});

test("parseRpcUrls splits, trims and drops duplicates", () => {
  assert.deepEqual(parseRpcUrls(" https://a.test , https://b.test,,https://a.test "), ["https://a.test", "https://b.test"]);
  assert.deepEqual(parseRpcUrls(["https://a.test"]), ["https://a.test"]);
  assert.deepEqual(parseRpcUrls(null), []);
  assert.throws(() => createNearRpcPool({ urls: "" }), TypeError);
  assert.throws(() => createNearRpcPool({ urls: "https://a.test, ftp://b" }), TypeError);
});

test("pool: a rate-limited or dead endpoint fails over to the next; an answer does not", async () => {
  const logs = [];
  let t = 1_000;
  const { fetch, calls } = hostFetch({ "a.test": limited, "b.test": ok() });
  const rpc = createNearRpcPool({ urls: "https://a.test,https://b.test", chainId: "mainnet", fetch, now: () => t, log: (l) => logs.push(l) });
  assert.equal(rpc.url, "https://a.test");
  assert.deepEqual(rpc.urls, ["https://a.test", "https://b.test"]);
  assert.deepEqual(await rpc.block({ finality: "final" }), { from: "mainnet", method: "block" });
  // a: chain check is rate limited → b: chain check, then the call
  assert.deepEqual(calls, ["a.test status", "b.test status", "b.test block"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /a\.test failed \(RPC_HTTP 429\)/);

  // while a rests, calls go straight to b (already chain-checked)
  calls.length = 0;
  await rpc.txStatus({ txHash: "h", senderId: "s.near" });
  assert.deepEqual(calls, ["b.test tx"]);

  // after the rest, a is tried first again
  t += 31_000;
  calls.length = 0;
  await rpc.status();
  assert.deepEqual(calls, ["a.test status", "b.test status"]);
});

test("pool: a JSON-RPC answer such as UNKNOWN_TRANSACTION is final for the call", async () => {
  const unknown = (req) => req.method === "status" ? ok()(req) : { body: { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, code: -32000, message: "Server error" } } };
  const { fetch, calls } = hostFetch({ "a.test": unknown, "b.test": ok() });
  const rpc = createNearRpcPool({ urls: ["https://a.test", "https://b.test"], chainId: "mainnet", fetch });
  await assert.rejects(rpc.txStatus({ txHash: "h", senderId: "s.near" }), { code: "UNKNOWN_TRANSACTION" });
  assert.deepEqual(calls, ["a.test status", "a.test tx"]);
});

test("pool: an endpoint on another network is never used; all wrong is RPC_WRONG_NETWORK", async () => {
  const logs = [];
  const { fetch, calls } = hostFetch({ "a.test": ok("testnet"), "b.test": ok("mainnet") });
  const rpc = createNearRpcPool({ urls: "https://a.test,https://b.test", chainId: "mainnet", fetch, log: (l) => logs.push(l) });
  assert.deepEqual(await rpc.block({ finality: "final" }), { from: "mainnet", method: "block" });
  await rpc.block({ finality: "final" });
  assert.deepEqual(calls, ["a.test status", "b.test status", "b.test block", "b.test block"]);
  assert.match(logs[0], /a\.test is on "testnet", not mainnet/);

  const wrong = hostFetch({ "a.test": ok("testnet") });
  const only = createNearRpcPool({ urls: "https://a.test", chainId: "mainnet", fetch: wrong.fetch });
  await assert.rejects(only.status(), { code: "RPC_WRONG_NETWORK" });
  await assert.rejects(only.block({ finality: "final" }), { code: "RPC_WRONG_NETWORK" });
  assert.deepEqual(wrong.calls, ["a.test status"]); // never asked again
});

test("pool: send_tx fails over on a refused request but not on a timeout", async () => {
  const dead = (req) => req.method === "status" ? ok()(req) : (() => { throw new TypeError("fetch failed"); })();
  let { fetch, calls } = hostFetch({ "a.test": dead, "b.test": ok() });
  let rpc = createNearRpcPool({ urls: "https://a.test,https://b.test", chainId: "mainnet", fetch });
  assert.deepEqual(await rpc.sendTx("AAAA"), { from: "mainnet", method: "send_tx" });
  assert.deepEqual(calls, ["a.test status", "a.test send_tx", "b.test status", "b.test send_tx"]);

  const hang = (url, init) => new Promise((_, reject) => {
    if (JSON.parse(init.body).method === "status") return reject(new Error("unused"));
    const keep = setInterval(() => {}, 1_000); /* Node 22 unrefs AbortSignal.timeout; a real fetch holds a socket */ 
    init.signal.addEventListener("abort", () => { clearInterval(keep); reject(init.signal.reason); });
  });
  const seen = [];
  rpc = createNearRpcPool({ urls: "https://a.test,https://b.test", fetch: (u, i) => { seen.push(new URL(u).host); return hang(u, i); }, timeoutMs: 20 });
  await assert.rejects(rpc.sendTx("AAAA"), { code: "RPC_TIMEOUT" });
  assert.deepEqual(seen, ["a.test"]); // the caller resolves a timed-out send by hash
});

test("pool: when every endpoint fails, the last transport error surfaces", async () => {
  const { fetch } = hostFetch({ "a.test": limited, "b.test": () => ({ status: 503, text: "down" }) });
  const rpc = createNearRpcPool({ urls: "https://a.test,https://b.test", chainId: "mainnet", fetch });
  await assert.rejects(rpc.status(), (e) => e.code === "RPC_HTTP" && e.data.status === 503);
  // both resting: still tried, in order, rather than refusing outright
  await assert.rejects(rpc.status(), { code: "RPC_HTTP" });
});
