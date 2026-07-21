/**
 * Offline tests for --serve and the x402 charge gate: an in-process HTTP server
 * with a fake registry, and a gate wired to a scripted Nano RPC. No network,
 * nothing spends money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChargeGate, hashArgs } from "../src/gate.mjs";
import { serveHttp, qrSvg } from "../src/http.mjs";

// Any syntactically valid Nano addresses work — checkAddress validates the checksum.
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

/** Scripted chain: receivable/history state the gate polls, transfers it makes. */
function fakeChain() {
  const state = { receivable: {}, history: [], transfers: [], failTransfer: false };
  return {
    state,
    ops: {
      rpc: async (body) => {
        if (body.action === "receivable") return { blocks: state.receivable };
        if (body.action === "account_history") return { history: state.history };
        throw new Error("unexpected rpc action " + body.action);
      },
      transfer: async (to, amountRaw, describe) => {
        if (state.failTransfer) throw new Error("transfer refused");
        state.transfers.push({ to, amountRaw, describe });
        return "F".repeat(64);
      },
      pocket: async () => {},
    },
  };
}

function fakeRegistry({ author = null, onCall } = {}) {
  let calls = 0;
  const registry = {
    tools: [{ name: "poster", x402: author ? { author } : null, description:
      "Make a poster. text -> image; returns image. Runs on NanoGPT — every call spends real credit from your API key's balance." }],
    listTools: () => [
      { name: "poster", description: registry.tools[0].description, inputSchema: { type: "object", properties: { Text: { type: "string" } } } },
      { name: "run_noodle", description: "runs any share link", inputSchema: { type: "object", properties: {} } },
    ],
    prepareCall: async (params) => {
      if (params.name !== "poster") throw new Error("unknown tool " + params.name);
      if (params.arguments && params.arguments.bad) { const e = new Error("bad input"); e.mcpCode = -32602; throw e; }
      return {};
    },
    callTool: async (params) => {
      calls++;
      if (onCall) return onCall(params, calls);
      return { content: [{ type: "text", text: "ran " + JSON.stringify(params.arguments) }] };
    },
    callCount: () => calls,
  };
  return registry;
}

function makeGate(chain, { usd = 0.05, registry, now, waitMs = 300, pollMs = 10, usage } = {}) {
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: chain.ops,
    usd,
    validate: registry ? (p) => registry.prepareCall(p) : null,
    xnoUsd: 1.0, // static rate: $1/XNO keeps amounts easy to reason about, no CoinGecko
    publicBase: "http://pay.test",
    pollMs,
    waitMs,
    usage,
    now,
  });
  return gate;
}

const argOf = (result) => result.structuredContent.x402;

test("quote → pay (receivable poll) → run once → replay, with receipt", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const events = [];
  const gate = makeGate(chain, { registry, usage: (e, f) => events.push([e, f]) });
  const { listTools, callTool } = gate.wrapRegistry(registry);

  // descriptions carry the price, schemas carry _payment_id, run_noodle is gone
  const tools = listTools();
  assert.equal(tools.length, 1);
  assert.match(tools[0].description, /\$0\.05 per call, paid in Nano \(XNO\)/);
  assert.ok(tools[0].inputSchema.properties._payment_id);

  const quoteRes = await callTool({ name: "poster", arguments: { Text: "a lighthouse" } });
  assert.ok(!quoteRes.isError);
  const x = argOf(quoteRes);
  assert.match(quoteRes.content[0].text, /PAYMENT REQUIRED/);
  assert.match(quoteRes.content[0].text, new RegExp(x.paymentId));
  assert.equal(x.payUrl, `http://pay.test/pay/${x.paymentId}`);
  assert.equal(x.address, GATE_ADDR);
  // $0.05 at $1/XNO ≈ 0.05 XNO plus sub-cent dust
  assert.ok(BigInt(x.amountRaw) >= 5n * 10n ** 28n && BigInt(x.amountRaw) < 5n * 10n ** 28n + 10n ** 20n);

  // unpaid re-call with the id: reports pending, runs nothing
  const pending = await callTool({ name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId } });
  assert.ok(pending.isError);
  assert.match(pending.content[0].text, /hasn't arrived/);
  assert.equal(registry.callCount(), 0);

  // the exact tagged amount lands on-chain
  chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const paidRes = await callTool({ name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId } });
  assert.ok(!paidRes.isError);
  assert.match(paidRes.content[0].text, /^ran /);
  assert.match(paidRes.content.at(-1).text, /paid 0\.05\d* XNO/);
  assert.equal(registry.callCount(), 1);

  // replay: same id returns the cached result without running again
  const replay = await callTool({ name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId } });
  assert.deepEqual(replay, paidRes);
  assert.equal(registry.callCount(), 1);

  assert.deepEqual(events.map(([e]) => e), ["quote", "paid", "run"]);
  const paidEvent = events[1][1];
  assert.equal(paidEvent.source, PAYER);
  assert.equal(typeof paidEvent.settleMs, "number");
});

test("payment id is bound to the exact arguments", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  const res = await callTool({ name: "poster", arguments: { Text: "b", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /different call/);
  assert.equal(registry.callCount(), 0);
});

test("bad arguments are rejected before a quote is ever issued", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  await assert.rejects(() => callTool({ name: "poster", arguments: { bad: "1" } }), /bad input/);
  await assert.rejects(() => callTool({ name: "nope", arguments: {} }), /unknown tool/);
});

test("run_noodle is withdrawn in charge mode", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const res = await callTool({ name: "run_noodle", arguments: { url: "https://nanoodle.com/#g=x" } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /not available on this paid server/);
});

test("failed run refunds the payer in full", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /model exploded/);
  assert.match(res.content[0].text, /refunded to/);
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
});

test("author payout: 20% off the top, uncut; no field → no transfer", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ author: PAYER });
  const events = [];
  const { callTool, listTools } = makeGate(chain, { registry, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  assert.match(listTools()[0].description, /author earns 20% of every call/);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError);
  assert.match(res.content.at(-1).text, /20% goes to this noodle's author/);
  // the payout rides the send queue — give the microtask a beat
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chain.state.transfers.length, 1);
  assert.equal(chain.state.transfers[0].to, PAYER);
  assert.equal(chain.state.transfers[0].amountRaw, ((BigInt(x.amountRaw) * 20n) / 100n).toString());
  assert.ok(events.some(([e, f]) => e === "author_payout" && f.ok));
});

test("already-pocketed payments are found via account_history", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry, pollMs: 5 }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  // never appears in receivable — a concurrent wallet already received it
  chain.state.history.push({ type: "receive", account: PAYER, amount: x.amountRaw, hash: "D".repeat(64) });
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError, JSON.stringify(res.content));
});

test("expired quotes reject; a late payment is auto-refunded", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  let t = 1_000_000;
  const gate = makeGate(chain, { registry, now: () => t, pollMs: 5, waitMs: 50 });
  const { callTool } = gate.wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  t += 16 * 60 * 1000; // past the 15-minute TTL
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /expired/);
  // the payment arrives anyway → bounced back to the payer
  chain.state.receivable["E".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  await gate.waitForPayment(x.paymentId, 100); // drives the watcher
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
});

test("two live quotes never share an amount", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const a = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  const b = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  assert.notEqual(a.amountRaw, b.amountRaw);
  assert.notEqual(a.paymentId, b.paymentId);
});

test("hashArgs is order-insensitive and value-sensitive", () => {
  assert.equal(hashArgs("t", { a: 1, b: "x" }), hashArgs("t", { b: "x", a: 1 }));
  assert.notEqual(hashArgs("t", { a: 1 }), hashArgs("t", { a: 2 }));
  assert.notEqual(hashArgs("t", { a: 1 }), hashArgs("u", { a: 1 }));
});

/* ---- HTTP surface with a live gate ---- */

test("pay page + status endpoint over HTTP", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mcp = async (method, params, id = 1) => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      });
      return r.json();
    };
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.match(init.result.instructions ?? "", /.*/); // instructions optional here (none passed)
    const list = await mcp("tools/list");
    assert.deepEqual(list.result.tools.map((t) => t.name), ["poster"]);

    const quote = await mcp("tools/call", { name: "poster", arguments: { Text: "hi" } });
    const x = quote.result.structuredContent.x402;

    const payPage = await fetch(`${base}/pay/${x.paymentId}`);
    assert.equal(payPage.status, 200);
    const html = await payPage.text();
    assert.match(html, /<svg/);
    assert.match(html, new RegExp(x.amountRaw));

    let st = await (await fetch(`${base}/x402/status/${x.paymentId}`)).json();
    assert.equal(st.status, "pending");

    chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    st = await (await fetch(`${base}/x402/status/${x.paymentId}?wait=1`)).json();
    assert.equal(st.status, "paid");

    const run = await mcp("tools/call", { name: "poster", arguments: { Text: "hi", _payment_id: x.paymentId } });
    assert.ok(!run.result.isError);

    assert.equal((await fetch(`${base}/pay/unknown-id`)).status, 404);
    // content-type guard: a no-CORS-able POST is refused
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(r.status, 415);
  } finally {
    server.close();
  }
});

test("a hand-added x402 block on a graph file reaches the gate (price + author)", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { loadTools } = await import("../src/tools.mjs");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "x402-graph-"));
  const g = JSON.parse(await readFile(join(here, "fixtures", "hello-noodle.json"), "utf8"));
  g.x402 = { usd: 0.10, author: PAYER };
  await writeFile(join(dir, "hello-noodle.json"), JSON.stringify(g));
  const registry = await loadTools({ dirs: [dir], apiKey: "k", outDir: dir });
  assert.deepEqual(registry.tools[0].x402, { usd: 0.10, author: PAYER });
  const { listTools } = makeGate(fakeChain(), {}).wrapRegistry(registry);
  const t = listTools().find((t) => t.name === "hello-noodle");
  assert.match(t.description, /\$0\.10 per call/);
  assert.match(t.description, /author earns 20%/);
});

test("qrSvg encodes a nano URI into a QR matrix svg", () => {
  const svg = qrSvg(`nano:${GATE_ADDR}?amount=123`);
  assert.match(svg, /^<svg /);
  assert.match(svg, /path d="M/);
});
