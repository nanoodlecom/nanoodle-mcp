import assert from "node:assert/strict";
import { test } from "node:test";
import { NanoClient } from "nanoodle";
import { nanoGptBackupFetch } from "../src/nanogpt-backup.mjs";

const baseUrl = "https://api.nano-gpt.example";
const chat = baseUrl + "/api/v1/chat/completions";
const key = "fixture-backup-key";
const request = { method: "POST", headers: { "x-x402": "true" }, body: '{"model":"test"}' };
const nanoOption = { scheme: "nano", payTo: "nano_fixture", amount: "50" };
const lightning = { scheme: "lightning-l402", amountUsd: "0.09", undiscountedAmountUsd: "0.10" };
const quote = (accepted = [lightning]) => Response.json({
  payment: { paymentId: "quote", amountUsd: "0.09", accepted },
}, { status: 402 });

test("the normal client prefers a Nano invoice even with a backup key", async () => {
  const calls = [], paid = [];
  const fetch = nanoGptBackupFetch({
    baseUrl, key, authorize: () => assert.fail("must pay the offered Nano invoice"),
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return String(url) === chat ? quote([lightning, nanoOption])
        : Response.json({ choices: [{ message: { content: "Nano result" } }] });
    },
  });
  const client = new NanoClient({ baseUrl, fetch, payment: async invoice => paid.push(invoice.paymentId) });
  assert.equal(await client.chat([], "model"), "Nano result");
  assert.deepEqual(paid, ["quote"]);
  assert.deepEqual(calls, [chat, baseUrl + "/api/x402/complete/quote"]);
});

test("Lightning-only quotes authorize one same-body API request and preserve reported cost", async () => {
  const calls = [], costs = [];
  const fetch = nanoGptBackupFetch({
    baseUrl, key, authorize: async invoice => calls.push(invoice),
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      calls.push({ body: init.body, headers, redirect: init.redirect });
      return headers.has("authorization")
        ? Response.json({ choices: [{ message: { content: "Key result" } }], x_nanogpt_pricing: { costUsd: 0.02 } })
        : quote();
    },
  });
  const client = new NanoClient({ baseUrl, fetch, payment: () => assert.fail("must not send Nano") });
  assert.equal(await client.chat([], "model", {}, { onCost: cost => costs.push(cost) }), "Key result");
  assert.equal(calls.length, 3);
  const [initial, debit, backup] = calls;
  assert.equal(initial.headers.get("x-x402"), "true");
  assert.equal(initial.headers.has("authorization"), false);
  assert.equal(initial.headers.has("x-billing-mode"), false);
  assert.deepEqual(debit, { paymentId: "quote", amountUsd: 0.10 });
  assert.equal(backup.body, initial.body);
  assert.equal(backup.headers.has("x-x402"), false);
  assert.equal(backup.headers.get("x-billing-mode"), "paygo");
  assert.equal(backup.headers.get("authorization"), "Bearer " + key);
  assert.equal(backup.redirect, "error");
  assert.deepEqual(costs, [{ usd: 0.02, balance: null }]);
});

test("completion, replay, external URLs and incomplete challenges cannot use a backup key", async () => {
  const fetch = nanoGptBackupFetch({
    baseUrl, key, authorize: () => assert.fail("unexpected authorization"),
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.notEqual(headers.get("x-api-key"), key);
      return headers.has("x-ordinary-402") ? Response.json({ error: "payment required" }, { status: 402 }) : quote();
    },
  });
  for (const [url, init] of [
    [baseUrl + "/api/x402/complete/quote", request],
    ["https://another.example/api/v1/chat/completions", request],
    [chat, { ...request, headers: { ...request.headers, "x-x402-payment-id": "paid" } }],
    [chat, { ...request, headers: { ...request.headers, "PAYMENT-SIGNATURE": "signed" } }],
    [chat, { ...request, headers: { ...request.headers, "x-ordinary-402": "true" } }],
  ]) assert.equal((await fetch(url, init)).status, 402);
});

test("backup failures never make a second model payment and preserve ambiguity", async () => {
  for (const failure of ["budget", "rejected", "lost"]) {
    let calls = 0;
    const fetch = nanoGptBackupFetch({
      baseUrl, key, authorize: async () => {
        if (failure === "budget") throw Object.assign(Error("confidential"), { code: "FUNDING_OVER_BUDGET" });
      },
      fetch: async () => {
        if (++calls === 1) return quote();
        if (failure === "lost") throw Error(key);
        return Response.json({ error: key }, { status: 402 });
      },
    });
    const client = new NanoClient({ baseUrl, fetch, payment: () => assert.fail("must not send Nano") });
    await assert.rejects(client.chat([], "model"), error => error.code === "x402-backup"
      && error.backupChargePossible === (failure === "lost") && !error.message.includes(key));
    assert.equal(calls, failure === "budget" ? 1 : 2);
  }
});
