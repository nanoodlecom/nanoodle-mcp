/**
 * Cancel checks on the nanoodle client's 402 path. Mocks only — the payment
 * callback is a counter, and no request leaves the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NanoClient, parseNanoInvoice, strictUsd } from "nanoodle";
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

function invoiceBody(id, usd) {
  const accepted = {
    scheme: "nano",
    payTo: "nano_1stub",
    maxAmountRequired: "1" + "0".repeat(30),
    completeUrl: "http://x/api/x402/complete/" + id,
  };
  if (usd !== undefined) accepted.maxAmountRequiredUSD = usd;
  return { payment: { paymentId: id, accepted: [accepted] } };
}

const BAD_USD = [
  ["''", ""],
  ["whitespace", "   "],
  ["false", false],
  ["[]", []],
  ["null", null],
  ["missing", undefined],
];

test("a malformed USD price stays unknown, and an explicit 0 stays 0", () => {
  for (const [label, usd] of BAD_USD) {
    assert.equal(parseNanoInvoice(invoiceBody("bad-" + label, usd), "http://x").amountUsd, null, label);
    assert.equal(strictUsd(usd), null, label);
  }
  assert.equal(parseNanoInvoice(invoiceBody("z", 0), "http://x").amountUsd, 0);
  assert.equal(parseNanoInvoice(invoiceBody("z0", "0"), "http://x").amountUsd, 0);
  assert.equal(parseNanoInvoice(invoiceBody("z00", "0.00"), "http://x").amountUsd, 0);
  assert.equal(parseNanoInvoice(invoiceBody("ok", "  0.48  "), "http://x").amountUsd, 0.48);
  for (const [text, n] of [["1e-3", 0.001], [".001", 0.001], ["0.001", 0.001], ["1e-7", 1e-7], ["2.5e-3", 0.0025], ["  1E-7 ", 1e-7]]) {
    assert.equal(strictUsd(text), n, text);
    assert.equal(parseNanoInvoice(invoiceBody("exp", text), "http://x").amountUsd, n, text);
  }
  assert.equal(strictUsd(0.001), 0.001);
  for (const bad of [NaN, Infinity, -Infinity, -1, "-1", "-1e-3", "1abc", "abc", "0x10", "1e", ".", "Infinity", "NaN", true, {}]) {
    assert.equal(strictUsd(bad), null, JSON.stringify(bad));
  }
});

test("NanoClient does not pay a 1 XNO invoice whose USD price is malformed", async () => {
  for (const [label, usd] of BAD_USD) {
    let paid = 0;
    const client = new NanoClient({
      baseUrl: "http://x",
      payment: () => { paid += 1; },
      fetch: async () => new Response(JSON.stringify(invoiceBody("pay-" + label, usd)), {
        status: 402, headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(client._paidFetch("http://x/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-x402": "true" },
      body: "{\"model\":\"m\"}",
    }), (e) => e && e.unknownPrice === true && e.paymentNotSent === true && e.costUnknown !== true);
    assert.equal(paid, 0, label);
    assert.equal(client._paidIds.size, 0, label);
  }
});

test("NanoClient pays an explicit USD 0", async () => {
  let paid = 0;
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: async () => { paid += 1; },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(invoiceBody("pay0", 0)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const r = await client._paidFetch("http://x/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true" },
    body: "{\"model\":\"m\"}",
  });
  assert.equal(r.status, 200);
  assert.equal(paid, 1);
});

test("NanoClient resends the exact billed body on a paid retry", async () => {
  const billed = "{\"model\":\"m\",\"note\":\"billed bytes\"}";
  const seen = [];
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: async () => {},
    fetch: async (url, init) => {
      const paidId = init && init.headers && init.headers["x-x402-payment-id"];
      seen.push({ url: String(url), body: init.body, paidId });
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (paidId) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(invoiceBody("payM", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const r = await client._paidFetch("http://x/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true" },
    body: billed,
  });
  assert.equal((await r.json()).choices[0].message.content, "ok");
  const replay = seen.find((s) => s.paidId === "payM");
  assert.ok(replay, "replay was sent");
  assert.equal(replay.body, billed);
  seen.length = 0;
  await client._paidFetch("http://x/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true", "x-x402-payment-id": "payM" },
    body: "{\"model\":\"m\",\"note\":\"CHANGED\"}",
  });
  assert.equal(seen[0].body, billed);
  assert.equal(client._billedBodies.get("payM"), billed);
});

test("NanoClient reserves one paymentId inside the payment callback and keeps the first body", async () => {
  let paid = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const firstBody = "{\"model\":\"m\",\"note\":\"first\"}";
  const secondBody = "{\"model\":\"m\",\"note\":\"second\"}";
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: () => { paid += 1; return gate; },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(invoiceBody("payOnce", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const headers = { "content-type": "application/json", "x-x402": "true" };
  const first = client._paidFetch("http://x/api/v1/chat/completions", { method: "POST", headers, body: firstBody });
  const second = client._paidFetch("http://x/api/v1/chat/completions", { method: "POST", headers, body: secondBody });
  const settledP = Promise.allSettled([first, second]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(paid, 1);
  const stored = client._billedBodies.get("payOnce");
  assert.ok(stored === firstBody || stored === secondBody);
  release();
  const settled = await settledP;
  const rejected = settled.filter((s) => s.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already paid/);
  assert.equal(client._billedBodies.get("payOnce"), stored);
  assert.equal(paid, 1);
});

test("NanoClient releases a paymentId when payment throws immediately with paymentNotSent", async () => {
  let paid = 0;
  const client = new NanoClient({
    baseUrl: "http://x",
    payment() {
      paid += 1;
      if (paid === 1) {
        const e = new Error("wallet refused");
        e.paymentNotSent = true;
        throw e;
      }
    },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(invoiceBody("paySync", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const headers = { "content-type": "application/json", "x-x402": "true" };
  const body = "{\"model\":\"m\"}";
  await assert.rejects(client._paidFetch("http://x/api/v1/chat/completions", { method: "POST", headers, body }), (e) => {
    assert.equal(e.paymentNotSent, true);
    assert.notEqual(e.costUnknown, true);
    return /wallet refused/.test(e.message);
  });
  assert.equal(paid, 1);
  assert.equal(client._paidIds.size, 0);
  const r = await client._paidFetch("http://x/api/v1/chat/completions", { method: "POST", headers, body });
  assert.equal(r.status, 200);
  assert.equal(paid, 2);
  assert.equal(client._paidIds.has("paySync"), true);
});

test("a complete error after payment keeps the NanoClient reservation even with paymentNotSent", async () => {
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: () => {},
    fetch: async () => {
      const e = new Error("complete failed");
      e.paymentNotSent = true;
      throw e;
    },
  });
  const response = new Response(JSON.stringify(invoiceBody("payKeep", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
  await assert.rejects(client._settle402(response, undefined, "{\"model\":\"m\"}"), (e) => {
    assert.equal(e.paymentNotSent, true);
    assert.equal(e.costUnknown, true);
    assert.equal(e.reconcile.paymentId, "payKeep");
    return /complete failed/.test(e.message);
  });
  assert.equal(client._paidIds.has("payKeep"), true);
});

test("NanoClient records costUnknown and the invoice before a payment error rejects", async () => {
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: () => { throw new Error("rpc down"); },
    fetch: () => { throw new Error("no network"); },
  });
  const response = new Response(JSON.stringify(invoiceBody("payE", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
  await assert.rejects(client._settle402(response, undefined, "{\"model\":\"m\"}"), (e) => {
    assert.equal(e.costUnknown, true);
    assert.equal(e.reconcile.paymentId, "payE");
    assert.equal(e.reconcile.amountUsd, 0.01);
    assert.equal(e.reconcile.ambiguous, true);
    assert.equal(e.reconcile.status, "payment outcome uncertain");
    return /rpc down/.test(e.message);
  });
  assert.equal(client._paidIds.has("payE"), true);
});

test("NanoClient records the invoice when a cancel lands after the wallet runs", async () => {
  const ac = new AbortController();
  const client = new NanoClient({
    baseUrl: "http://x",
    payment: async () => { ac.abort(new Error("cancelled")); },
    pollIntervals: { x402: 5 },
    fetch: async () => new Response("{}", { status: 402, headers: { "content-type": "application/json" } }),
  });
  const response = new Response(JSON.stringify(invoiceBody("payC", 0.01)), { status: 402, headers: { "content-type": "application/json" } });
  await assert.rejects(client._settle402(response, ac.signal, "{\"model\":\"m\"}"), (e) => {
    assert.equal(e.costUnknown, true);
    assert.equal(e.reconcile.paymentId, "payC");
    assert.equal(e.reconcile.amountUsd, 0.01);
    assert.equal(e.reconcile.status, "aborted after payment");
    return true;
  });
  assert.equal(client._paidIds.has("payC"), true);
});
