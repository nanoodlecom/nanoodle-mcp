import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isExpiredPayment } from "../src/near/payment-view.mjs";

const source = (await readFile(new URL("../src/near-pay-browser.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "");

function page({ outcome = { transaction: { hash: "transfer-hash" } }, stored = null, asset = {}, finalStatus = "paid", initial = {} } = {}) {
  const payment = { paymentId: "nq_test", status: "pending", network: "testnet", payTo: "merchant.testnet", amountYocto: "12345678901234567890123", ...asset, ...initial };
  const state = { ...payment };
  const events = new Map();
  const elements = new Map();
  for (const id of ["#near-payment", "#near-pay", "#near-status", "#near-error", "#near-confirm", "#near-title", "#near-deposit", "#near-manual", "#near-note", "#near-transfer-instructions"]) {
    elements.set(id, { dataset: { payment: JSON.stringify(payment) }, textContent: "", elements: { senderId: { value: "" }, txHash: { value: "" } },
      addEventListener: (name, fn) => events.set(`${id}:${name}`, fn) });
  }
  const sent = [], confirmed = [], subscriptions = [];
  let options;
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
    isExpiredPayment,
    monitorPaymentRun: ({ initial: starting, update }) => {
      subscriptions.push(starting.status);
      update(starting, null);
      return { stop() {} };
    },
    setInterval() {},
    fetch: async (url, args) => {
      if (args?.method === "POST") {
        const confirmation = JSON.parse(args.body);
        confirmed.push(confirmation);
        Object.assign(state, { status: finalStatus, txHash: confirmation.txHash });
        delete state.checkingPayment;
      }
      return { ok: true, json: async () => ({ ...state }) };
    },
    setTimeout,
  };
  vm.runInNewContext(source, context);
  return { elements, sent, confirmed, subscriptions, storage, options: () => options,
    render: status => context.render({ status }), click: () => events.get("#near-pay:click")() };
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

test("an expired checkout hides new payment controls and reconnects after confirming the original saved transfer", async () => {
  const checking = page({ initial: { status: "expired", checkingPayment: true } });
  assert.equal(checking.elements.get("#near-title").textContent, "Checking payment");
  assert.equal(checking.elements.get("#near-pay").hidden, true);
  assert.equal(checking.elements.get("#near-transfer-instructions").hidden, true);
  assert.equal(checking.elements.get("#near-manual").hidden, false);
  await checking.click();
  assert.deepEqual(checking.sent, []);

  const original = { senderId: "payer.testnet", txHash: "original-transfer" };
  const reopened = page({ initial: { status: "expired" }, stored: original });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reopened.confirmed, [original]);
  assert.deepEqual(reopened.sent, []);
  assert.deepEqual(reopened.subscriptions, ["expired", "paid"]);
  assert.match(reopened.elements.get("#near-status").textContent, /Payment confirmed/);
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

test("wallet pending, error and refund copy names only the quoted asset", () => {
  for (const [asset, forbidden, options] of [["NEAR", /\b(?:USDC|XNO|Nano)\b/i, {}], ["USDC", /\b(?:NEAR|XNO|Nano)\b/i, { asset: { asset: "USDC" } }]]) {
    const p = page(options);
    for (const state of ["pending", "settled", "rejected", "expired", "unknown"]) {
      p.render(state);
      const status = p.elements.get("#near-status").textContent;
      assert.match(status, new RegExp(`\\b${asset}\\b`));
      assert.doesNotMatch(status, forbidden);
    }
  }
});
