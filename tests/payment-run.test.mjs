import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorPaymentRun } from "../src/payment-run.mjs";

const id = "nq_test", receipt = status => ({ outcome: "succeeded", refund: { status } });
const result = { content: [{ type: "text", text: "The paid output" }] };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("payment page follows paid and running events, then reads the result without executing any tool", async () => {
  let events; const seen = [], requests = [];
  class Events {
    constructor(url) { this.url = url; this.handlers = {}; events = this; }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    close() { this.closed = true; }
    emit(state) { this.handlers.status({ data: JSON.stringify(state) }); }
  }
  const monitor = monitorPaymentRun({ initial: { paymentId: id, status: "pending" }, EventSource: Events,
    fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(result)); },
    update: (state, output) => seen.push({ state, output }),
  });
  assert.match(events.url, /\?run=1$/);
  events.emit({ status: "paid", done: false }); await flush(); assert.ok(!events.closed);
  events.emit({ status: "running", workflow: { nodes: [{ id: "anything", status: "running" }] }, done: false }); await flush();
  assert.equal(seen.at(-1).state.workflow.nodes[0].status, "running"); assert.equal(requests.length, 0);
  events.emit({ status: "settled", receipt: receipt("pending"), done: false }); await flush();
  assert.deepEqual(seen.at(-1).output, result); assert.ok(!events.closed, "refund still monitored after the result appears");
  events.emit({ status: "settled", receipt: receipt("sent"), done: true }); await flush();
  assert.equal(events.closed, true); assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/near\/result\//); assert.equal(requests[0].options.cache, "no-store");
  monitor.stop();
});

test("reopening a finished payment fetches its result immediately", async () => {
  const seen = [];
  const monitor = monitorPaymentRun({ initial: { paymentId: id, status: "settled", receipt: receipt("sent") }, EventSource: null,
    fetch: async () => new Response(JSON.stringify(result)), update: (state, output) => seen.push(output) });
  await flush(); assert.deepEqual(seen.at(-1), result); monitor.stop();
});

test("a dropped event stream keeps polling beyond payment and retries the same result after a temporary failure", async () => {
  let events, resultReads = 0, statusReads = 0; const urls = [], outputs = [];
  class Events { constructor() { events = this; } addEventListener() {} close() {} }
  const monitor = monitorPaymentRun({ initial: { paymentId: id, status: "paid" }, EventSource: Events, pause: async () => {},
    update: (state, output) => outputs.push(output),
    fetch: async url => {
      urls.push(url);
      if (url.includes("/result/")) return ++resultReads === 1 ? new Response("down", { status: 503 }) : new Response(JSON.stringify(result));
      statusReads++; return new Response(JSON.stringify(statusReads === 1 ? { status: "running" } : { status: "settled", receipt: receipt("sent") }));
    } });
  events.onerror();
  for (let i = 0; i < 30 && !outputs.at(-1); i++) await flush();
  assert.deepEqual(outputs.at(-1), result); assert.equal(resultReads, 2); assert.equal(statusReads, 3);
  assert.ok(urls.every(url => url.includes(id) && !url.includes("/mcp"))); monitor.stop();
});

test("expired payments never request a paid result", async () => {
  let requests = 0;
  const monitor = monitorPaymentRun({ initial: { paymentId: id, status: "expired" }, EventSource: null,
    fetch: async () => { requests++; }, update() {} });
  await flush(); assert.equal(requests, 0); monitor.stop();
});
