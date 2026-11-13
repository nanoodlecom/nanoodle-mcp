import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/near-setup-browser.mjs", import.meta.url), "utf8");
async function setupPage({ clipboardFails = false } = {}) {
  const config = { merchant: "nanoodle.near", network: "mainnet", publicKey: "ed25519:server-public-key" };
  const nodes = new Map(), copied = [];
  let click, poll, authorized = false, active = false;
  for (const id of ["#near-setup", "#near-copy-key", "#near-setup-status", "#near-setup-error"]) {
    nodes.set(id, { dataset: { setup: JSON.stringify(config) }, addEventListener: (name, fn) => { click = fn; } });
  }
  vm.runInNewContext(source, {
    document: { querySelector: (id) => nodes.get(id) }, setInterval: (fn) => { poll = fn; },
    fetch: async () => ({ ok: true, json: async () => ({ authorized, active }) }),
    navigator: { clipboard: { writeText: async (text) => {
      if (clipboardFails) throw new Error("Clipboard denied");
      copied.push(text);
    } } },
  });
  await new Promise(setImmediate);
  return { nodes, copied, click: () => click(),
    update: async (state) => { ({ authorized, active } = state); poll(); await new Promise(setImmediate); } };
}
test("manual setup copies only the displayed public key without opening or signing through a wallet", async () => {
  const page = await setupPage(); await page.click();
  assert.deepEqual(page.copied, ["ed25519:server-public-key"]);
  assert.match(page.nodes.get("#near-setup-status").textContent, /NEAR payments are inactive/);
});
test("on-chain authorization is distinguished from the service being active", async () => {
  const page = await setupPage();
  await page.update({ authorized: true, active: false });
  assert.match(page.nodes.get("#near-setup-status").textContent, /Authorized on chain.*server can now be activated/);
  await page.update({ authorized: true, active: true });
  assert.match(page.nodes.get("#near-setup-status").textContent, /automatic refunds are active/);
});
test("clipboard denial keeps manual public-key copying available", async () => {
  const page = await setupPage({ clipboardFails: true }); await page.click();
  assert.deepEqual(page.copied, []);
  assert.match(page.nodes.get("#near-setup-error").textContent, /Select and copy the public key/);
});
