import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/near-pay-browser.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "");

function page({ outcome = { transaction: { hash: "transfer-hash" } }, stored = null, asset = {}, finalStatus = "paid" } = {}) {
  const payment = { paymentId: "nq_test", status: "pending", network: "testnet", payTo: "merchant.testnet", amountYocto: "12345678901234567890123", ...asset };
  const state = { ...payment };
  const events = new Map();
  const elements = new Map();
  for (const id of ["#near-payment", "#near-pay", "#near-status", "#near-error", "#near-confirm", "#near-title", "#near-deposit", "#near-manual", "#near-note"]) {
    elements.set(id, { dataset: { payment: JSON.stringify(payment) }, textContent: "", elements: { senderId: { value: "" }, txHash: { value: "" } },
      addEventListener: (name, fn) => events.set(`${id}:${name}`, fn) });
  }
  let sent = [], confirmed = [], options;
  const storage = new Map(stored ? [["nanoodle-near:nq_test", JSON.stringify(stored)]] : []);
  const context = {
    document: { querySelector: (id) => elements.get(id) },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    NearConnector: class {
      constructor(o) { options = o; }
      async connect() {
        return { getAccounts: async () => [{ accountId: "payer.testnet" }],
          signAndSendTransaction: async (params) => { sent.push(params); return outcome; } };
      }
    },
    EventSource: class { addEventListener() {} close() {} },
    createRunView: () => ({ render() {}, elapsed() {} }),
    monitorPaymentRun: ({ initial, update }) => update(initial, null),
    setInterval() {},
    fetch: async (url, args) => {
      if (args?.method === "POST") {
        confirmed.push(JSON.parse(args.body)); state.status = finalStatus;
      }
      return { ok: true, json: async () => ({ ...state }) };
    },
    setTimeout,
  };
  vm.runInNewContext(source, context);
  return { elements, sent, confirmed, storage, options: () => options, click: () => events.get("#near-pay:click")() };
}

test("wallet page requests exactly one native transfer, then confirms it without another payment", async () => {
  const p = page();
  await p.click();
  assert.equal(p.options().network, "testnet");
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent)), [{ network: "testnet", signerId: "payer.testnet", receiverId: "merchant.testnet",
    actions: [{ type: "Transfer", params: { deposit: "12345678901234567890123" } }] }]);
  assert.deepEqual(p.confirmed, [{ senderId: "payer.testnet", txHash: "transfer-hash" }]);
  assert.match(p.elements.get("#near-status").textContent, /Payment confirmed/);
  await p.click();
  assert.equal(p.sent.length, 1);
});

test("uncertain wallet outcome is retained so a refresh cannot request a second transfer", async () => {
  // A result with no transaction hash represents a wallet that lost its result.
  const missing = page({ outcome: {} });
  await missing.click();
  assert.equal(missing.sent.length, 1);
  assert.equal(missing.confirmed.length, 0);
  assert.match(missing.elements.get("#near-error").textContent, /Check your wallet history/);
  const retained = JSON.parse(missing.storage.get("nanoodle-near:nq_test"));
  const reloaded = page({ stored: retained });
  await reloaded.click();
  assert.equal(reloaded.sent.length, 0);
});

test("USDC wallet payment signs one ft_transfer to the quoted token contract, with one yoctoNEAR attached", async () => {
  const p = page({ asset: { asset: "USDC", tokenContract: "circle-usdc.testnet", amountAtomic: "10347" }, finalStatus: "settled" });
  await p.click();
  assert.deepEqual(JSON.parse(JSON.stringify(p.sent)), [{ network: "testnet", signerId: "payer.testnet", receiverId: "circle-usdc.testnet",
    actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: "merchant.testnet", amount: "10347" }, gas: "30000000000000", deposit: "1" } }] }]);
  assert.deepEqual(p.confirmed, [{ senderId: "payer.testnet", txHash: "transfer-hash" }]);
  assert.match(p.elements.get("#near-status").textContent, /Unused USDC is returned/);
  await p.click(); assert.equal(p.sent.length, 1);
});
