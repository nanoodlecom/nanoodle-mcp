import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/near-setup-browser.mjs", import.meta.url), "utf8"))
  .replace('import { NearConnector } from "@hot-labs/near-connect";', "");
async function setupPage(accountId = "nanoodle.near") {
  const config = { merchant: "nanoodle.near", network: "mainnet", publicKey: "ed25519:server-public-key" };
  const nodes = new Map(); const events = new Map(); const transactions = []; let authorized = false;
  for (const id of ["#near-setup", "#near-authorize", "#near-setup-status", "#near-setup-error"]) {
    nodes.set(id, { dataset: { setup: JSON.stringify(config) }, addEventListener: (name, fn) => events.set(name, fn) });
  }
  vm.runInNewContext(source, {
    document: { querySelector: (id) => nodes.get(id) }, setInterval: () => null,
    fetch: async () => ({ ok: true, json: async () => ({ authorized, active: false }) }),
    NearConnector: class {
      async connect(options) {
        assert.equal(options.walletId, "meteor-wallet");
        return { getAccounts: async () => [{ accountId }], signAndSendTransaction: async (tx) => {
          transactions.push(JSON.parse(JSON.stringify(tx))); authorized = true; return { status: { SuccessValue: "" } };
        } };
      }
    },
  });
  await new Promise(setImmediate);
  return { nodes, transactions, click: () => events.get("click")() };
}
test("owner approval requests only the displayed refund key, preserving the wallet's existing key", async () => {
  const page = await setupPage(); await page.click();
  assert.deepEqual(page.transactions, [{ network: "mainnet", signerId: "nanoodle.near", receiverId: "nanoodle.near",
    actions: [{ type: "AddKey", params: { publicKey: "ed25519:server-public-key", accessKey: { nonce: 0, permission: "FullAccess" } } }] }]);
  assert.match(page.nodes.get("#near-setup-status").textContent, /Authorized on chain/);
  await page.click(); assert.equal(page.transactions.length, 1);
});
test("a different Meteor account cannot be asked to authorize the merchant refund key", async () => {
  const page = await setupPage("someone-else.near"); await page.click();
  assert.equal(page.transactions.length, 0);
  assert.match(page.nodes.get("#near-setup-error").textContent, /Select nanoodle.near/);
});
