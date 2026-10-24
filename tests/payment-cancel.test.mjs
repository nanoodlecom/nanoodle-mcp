/**
 * Cancel checks on the nanoodle client's 402 path. Mocks only — the payment
 * callback is a counter, and no request leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "nanoodle";
import { beginPayment } from "../src/pay-guard.mjs";

const INVOICE = {
  payment: {
    paymentId: "payC",
    accepted: [{
      scheme: "nano",
      payTo: "nano_1stub",
      maxAmountRequired: "1000",
      maxAmountRequiredUSD: 0.01,
      completeUrl: "http://x/api/x402/complete/payC",
    }],
  },
};

function abortOnNthRead(n) {
  const ac = new AbortController();
  const reason = new Error("cancelled");
  let reads = 0;
  return new Proxy(ac.signal, {
    get(target, prop, receiver) {
      if (prop === "aborted") { reads += 1; return reads >= n; }
      if (prop === "reason") return reason;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("beginPayment does not pay when cancelled inside the queued callback", async () => {
  const ac = new AbortController();
  let paid = 0;
  const pending = beginPayment(ac.signal, () => { paid += 1; });
  ac.abort(new Error("cancelled"));
  await assert.rejects(pending, (e) => e && e.paymentNotSent === true);
  assert.equal(paid, 0);
});

test("NanoClient does not pay when cancelled after the invoice read", async () => {
  const ac = new AbortController();
  const reason = new Error("cancelled");
  let paid = 0;
  const payload = JSON.stringify(INVOICE);
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: () => { paid += 1; },
    fetch: () => { throw new Error("no network"); },
  });
  const response = new Response(new ReadableStream({
    pull(controller) {
      ac.abort(reason);
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { status: 402, headers: { "content-type": "application/json" } });
  await assert.rejects(client._settle402(response, ac.signal), (e) => e === reason || /cancelled/.test(String(e && e.message)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(paid, 0);
});

test("NanoClient does not pay when cancelled inside the queued payment callback", async () => {
  let paid = 0;
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: () => { paid += 1; },
    fetch: () => { throw new Error("no network"); },
  });
  const response = new Response(JSON.stringify(INVOICE), { status: 402, headers: { "content-type": "application/json" } });
  // Read 1 is the sync check after r.json(); read 2 is inside the callback.
  await assert.rejects(client._settle402(response, abortOnNthRead(2)), (e) => e && e.paymentNotSent === true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(paid, 0);
});

test("NanoClient still pays a live invoice exactly once", async () => {
  let paid = 0;
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: async () => { paid += 1; },
    pollIntervals: { x402: 5 },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(INVOICE), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const r = await client._paidFetch("http://x/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true" },
    body: "{}",
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "ok");
  assert.equal(paid, 1);
});
