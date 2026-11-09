/**
 * Payment transaction checks. The fixture is a real FINAL `tx` response for a
 * native transfer on NEAR testnet (public chain data), with the account names
 * replaced by neutral ones. Every rejection is produced by mutating it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearRpc } from "../src/near/rpc.mjs";
import { readPaymentTransfer } from "../src/near/verify.mjs";

const TX_HASH = "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1";
const OUTCOME_BLOCK = "BqMN6q5nwpKqiJ3c7jQ92Y1J8pCZvx7hou7xafiunMcL";
const BLOCK_NS = "1794262320491343383";

// Raw text, so the big JSON numbers go through the client's exact parser.
const TX_RESULT_TEXT = `{"final_execution_status":"FINAL","receipts_outcome":[{"block_hash":"8EKsbfBjR33HPnwt5gzP4qKawGZZEGy5LFhAkmqtYDnT","id":"BW89gq8yaDaFBJqT9dhx3i7FQMsSJ8wuPh5DB5znhekE","outcome":{"executor_id":"merchant.testnet","gas_burnt":223182562500,"logs":[],"metadata":{"contracts":[null],"gas_profile":[],"version":4},"receipt_ids":["B2cyUiXfmzFzw2WpGBwvXXqEM5FfRRgYJpA68ijsgLYv"],"status":{"SuccessValue":""},"tokens_burnt":"22318256250000000000"},"proof":[]},{"block_hash":"4tmkbTaA82x9VFCdTTbsk7gEVpgEqiq9wByV1oEqM8ih","id":"B2cyUiXfmzFzw2WpGBwvXXqEM5FfRRgYJpA68ijsgLYv","outcome":{"executor_id":"payer.testnet","gas_burnt":223182562500,"logs":[],"metadata":{"contracts":[null],"gas_profile":[],"version":4},"receipt_ids":[],"status":{"SuccessValue":""},"tokens_burnt":"0"},"proof":[{"direction":"Left","hash":"4tNduV7UPf1eDkWPchHkredtAVT1H9ZjWiQCB3rr3Gdk"}]}],"status":{"SuccessValue":""},"transaction":{"actions":[{"Transfer":{"deposit":"97000000000000000000000"}}],"hash":"${TX_HASH}","nonce":275735371000005,"priority_fee":0,"public_key":"ed25519:CDo3YDqTKQSzpxct7gcPUxk88P2HKixPKQ6Cbg18yohE","receiver_id":"merchant.testnet","signature":"ed25519:26SNn7XnWKCnnot7Wqttkns9XpCdRGCC48F4ZSLxoPmAXjdnujZU5L7YxsEZbDxvBKDAuwoQX1HbPmwM6pX9JeS9","signer_id":"payer.testnet"},"transaction_outcome":{"block_hash":"${OUTCOME_BLOCK}","id":"${TX_HASH}","outcome":{"executor_id":"payer.testnet","gas_burnt":223182562500,"logs":[],"metadata":{"gas_profile":null,"version":1},"receipt_ids":["BW89gq8yaDaFBJqT9dhx3i7FQMsSJ8wuPh5DB5znhekE"],"status":{"SuccessReceiptId":"BW89gq8yaDaFBJqT9dhx3i7FQMsSJ8wuPh5DB5znhekE"},"tokens_burnt":"22318256250000000000"},"proof":[]}}`;
const BLOCK_RESULT_TEXT = `{"author":"node1","chunks":[],"header":{"hash":"${OUTCOME_BLOCK}","height":276980238,"timestamp":1794262320491343383,"timestamp_nanosec":"${BLOCK_NS}"}}`;

/**
 * Mock RPC. `mutateTx(result)` edits a parsed copy of the tx result; `txError`
 * replaces it with a JSON-RPC error; `txStatus` is the HTTP status for `tx`.
 */
function chain({ mutateTx = null, txError = null, txStatus = 200, blockError = null } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    let text;
    let status = 200;
    if (req.method === "tx") {
      status = txStatus;
      if (txError) text = JSON.stringify({ jsonrpc: "2.0", id: req.id, error: txError });
      else if (status >= 300) text = "upstream unavailable";
      else if (mutateTx) {
        const r = JSON.parse(TX_RESULT_TEXT);
        mutateTx(r);
        text = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: r });
      } else text = `{"jsonrpc":"2.0","result":${TX_RESULT_TEXT},"id":"${req.id}"}`;
    } else if (req.method === "block") {
      if (blockError) text = JSON.stringify({ jsonrpc: "2.0", id: req.id, error: blockError });
      else text = `{"jsonrpc":"2.0","result":${BLOCK_RESULT_TEXT},"id":"${req.id}"}`;
    } else {
      throw new Error(`unexpected method ${req.method}`);
    }
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { rpc: createNearRpc({ url: "https://rpc.example.test", fetch }), calls };
}

const ARGS = { txHash: TX_HASH, senderId: "payer.testnet", merchantId: "merchant.testnet" };

test("happy path on the real FINAL transfer shape", async () => {
  const { rpc, calls } = chain();
  const p = await readPaymentTransfer({ rpc, ...ARGS });
  assert.deepEqual(p, {
    txHash: TX_HASH,
    payer: "payer.testnet",
    receiver: "merchant.testnet",
    amountYocto: 97000000000000000000000n,
    blockHash: OUTCOME_BLOCK,
    blockTimeMs: 1794262320491,
  });
  assert.deepEqual(calls[0].params, { tx_hash: TX_HASH, sender_account_id: "payer.testnet", wait_until: "FINAL" });
  assert.deepEqual(calls[1].params, { block_id: OUTCOME_BLOCK });
});

test("payer comes from signer_id, not the claimed sender", async () => {
  const { rpc } = chain();
  const p = await readPaymentTransfer({ rpc, ...ARGS, senderId: "someone-else.testnet" });
  assert.equal(p.payer, "payer.testnet");
});

test("blockTimeMs comes from timestamp_nanosec, exactly", async () => {
  const { rpc } = chain();
  const p = await readPaymentTransfer({ rpc, ...ARGS });
  assert.equal(p.blockTimeMs, Number(BigInt(BLOCK_NS) / 1_000_000n));
  assert.equal(new Date(p.blockTimeMs).toISOString(), "2026-11-09T22:12:00.491Z");
});

const MUTATIONS = [
  ["not FINAL", (r) => { r.final_execution_status = "EXECUTED_OPTIMISTIC"; }, "TX_NOT_FINAL"],
  ["status Failure", (r) => { r.status = { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "merchant.testnet" } } } } }; }, "TX_FAILED"],
  ["no SuccessValue", (r) => { r.status = {}; }, "TX_FAILED"],
  ["a receipt Failure", (r) => { r.receipts_outcome[1].outcome.status = { Failure: { ActionError: {} } }; }, "TX_FAILED"],
  ["two actions", (r) => { r.transaction.actions.push({ Transfer: { deposit: "1" } }); }, "NOT_A_SINGLE_TRANSFER"],
  ["FunctionCall", (r) => { r.transaction.actions = [{ FunctionCall: { method_name: "ft_transfer", args: "e30=", gas: 30000000000000, deposit: "1" } }]; }, "NOT_A_SINGLE_TRANSFER"],
  ["Delegate", (r) => { r.transaction.actions = [{ Delegate: { delegate_action: {}, signature: "ed25519:x" } }]; }, "NOT_A_SINGLE_TRANSFER"],
  ["no actions", (r) => { r.transaction.actions = []; }, "NOT_A_SINGLE_TRANSFER"],
  ["non-digit deposit", (r) => { r.transaction.actions = [{ Transfer: { deposit: "1e21" } }]; }, "NOT_A_SINGLE_TRANSFER"],
  ["numeric deposit", (r) => { r.transaction.actions = [{ Transfer: { deposit: 5 } }]; }, "NOT_A_SINGLE_TRANSFER"],
  ["extra key beside Transfer", (r) => { r.transaction.actions = [{ Transfer: { deposit: "1" }, Stake: {} }]; }, "NOT_A_SINGLE_TRANSFER"],
  ["wrong receiver", (r) => { r.transaction.receiver_id = "attacker.testnet"; }, "WRONG_RECEIVER"],
  ["different hash", (r) => { r.transaction.hash = "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwoFm"; }, "TX_MISMATCH"],
];

for (const [name, mutateTx, code] of MUTATIONS) {
  test(`rejects: ${name} -> ${code}`, async () => {
    const { rpc } = chain({ mutateTx });
    await assert.rejects(readPaymentTransfer({ rpc, ...ARGS }), { name: "NearError", code });
  });
}

test("UNKNOWN_TRANSACTION -> TX_NOT_FOUND", async () => {
  const { rpc } = chain({ txError: { name: "HANDLER_ERROR", cause: { info: { requested_transaction_hash: TX_HASH }, name: "UNKNOWN_TRANSACTION" }, code: -32000, message: "Server error", data: `Transaction ${TX_HASH} doesn't exist` } });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS }), { code: "TX_NOT_FOUND" });
});

test("the RPC's 408 TIMEOUT_ERROR for an unseen hash -> TX_NOT_FOUND", async () => {
  const { rpc } = chain({ txStatus: 408, txError: { name: "HANDLER_ERROR", cause: { info: { cause: "NOT_OBSERVED" }, name: "TIMEOUT_ERROR" }, code: -32000, message: "Server error", data: "Timeout" } });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS }), { code: "TX_NOT_FOUND" });
});

test("HTTP 503 -> RPC_UNAVAILABLE", async () => {
  const { rpc } = chain({ txStatus: 503 });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS }), { code: "RPC_UNAVAILABLE" });
});

test("client timeout -> RPC_UNAVAILABLE", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const rpc = createNearRpc({ url: "https://rpc.example.test", fetch: hang });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS, txTimeoutMs: 20 }), { code: "RPC_UNAVAILABLE" });
});

test("a block that cannot be read -> RPC_UNAVAILABLE", async () => {
  const { rpc } = chain({ blockError: { name: "HANDLER_ERROR", cause: { info: {}, name: "UNKNOWN_BLOCK" }, data: "DB Not Found Error" } });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS }), { code: "RPC_UNAVAILABLE" });
});

test("bad inputs are rejected before any RPC call", async () => {
  const { rpc, calls } = chain();
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS, txHash: "not-base58!" }), { code: "BAD_BASE58" });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS, txHash: "1111" }), { code: "BAD_BASE58" });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS, senderId: "Bad Sender" }), { code: "BAD_ACCOUNT" });
  await assert.rejects(readPaymentTransfer({ rpc, ...ARGS, merchantId: "" }), { code: "BAD_ACCOUNT" });
  assert.equal(calls.length, 0);
});
