/**
 * Offline tests for --serve and the x402 charge gate: an in-process HTTP server
 * with a fake registry, and a gate wired to a scripted Nano RPC. No network,
 * nothing spends money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChargeGate, hashArgs, parseUsdNano } from "../src/gate.mjs";
import { serveHttp, qrSvg } from "../src/http.mjs";
import { rawToXno } from "../src/wallet.mjs";
import { qrModules } from "nanoodle";
import { qrDecode, svgToMatrix } from "./qr-decode.mjs";

// Any syntactically valid Nano addresses work — checkAddress validates the checksum.
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

/**
 * Scripted chain: receivable/history state the gate polls, transfers it makes.
 * Behaves like a REAL node where it matters for burst detection: `receivable`
 * honors its count (stable hash order), `account_history` honors count and
 * pages via head/previous (history[0] is newest), and `pocket` moves
 * receivables into history the way wallet housekeeping does.
 */
function fakeChain() {
  const state = { receivable: {}, history: [], transfers: [], failTransfer: false };
  return {
    state,
    ops: {
      rpc: async (body) => {
        if (body.action === "receivable") {
          const count = parseInt(body.count || "50", 10);
          const entries = Object.entries(state.receivable).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, count);
          return { blocks: Object.fromEntries(entries) };
        }
        if (body.action === "account_history") {
          const count = parseInt(body.count || "25", 10);
          let start = 0;
          if (body.head) {
            const i = state.history.findIndex((e) => e.hash === body.head);
            start = i === -1 ? state.history.length : i;
          }
          const res = { history: state.history.slice(start, start + count) };
          if (start + count < state.history.length) res.previous = state.history[start + count].hash;
          return res;
        }
        throw new Error("unexpected rpc action " + body.action);
      },
      transfer: async (to, amountRaw, describe) => {
        if (state.failTransfer) throw new Error("transfer refused");
        state.transfers.push({ to, amountRaw, describe });
        return "F".repeat(64);
      },
      pocket: async () => {
        for (const [hash, v] of Object.entries(state.receivable)) {
          delete state.receivable[hash];
          state.history.unshift({ type: "receive", account: v.source ?? null, amount: v.amount ?? v, hash });
        }
      },
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

function makeGate(chain, { usd = 0.05, registry, now, waitMs = 300, pollMs = 10, usage, xnoUsd = 1.0, fetch, stateFile } = {}) {
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: chain.ops,
    usd,
    validate: registry ? (p) => registry.prepareCall(p) : null,
    xnoUsd, // tests default to a static $1/XNO rate: amounts easy to reason about, no network
    publicBase: "http://pay.test",
    pollMs,
    waitMs,
    usage,
    now,
    fetch,
    stateFile,
  });
  return gate;
}

const GRAIN = 10n ** 22n; // 1e-8 XNO, the wallet-typeable resolution — mirrors the gate's constant

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
  assert.match(tools[0].description, /\$0\.05 deposit per call, paid in Nano \(XNO\)/);
  assert.ok(tools[0].inputSchema.properties._payment_id);

  const quoteRes = await callTool({ name: "poster", arguments: { Text: "a lighthouse" } });
  assert.ok(!quoteRes.isError);
  const x = argOf(quoteRes);
  assert.match(quoteRes.content[0].text, /PAYMENT REQUIRED/);
  assert.match(quoteRes.content[0].text, /expires in about 15 minutes \(\d{4}-\d{2}-\d{2}T/);
  assert.match(quoteRes.content[0].text, new RegExp(x.paymentId));
  assert.equal(x.payUrl, `http://pay.test/pay/${x.paymentId}`);
  assert.equal(x.address, GATE_ADDR);
  // $0.05 at $1/XNO ≈ 0.05 XNO plus a sub-cent tag, in whole 1e-8 XNO steps
  assert.ok(BigInt(x.amountRaw) >= 5n * 10n ** 28n && BigInt(x.amountRaw) < 5n * 10n ** 28n + 10n ** 26n);
  assert.equal(BigInt(x.amountRaw) % GRAIN, 0n, "amount must be exactly typeable at 8 decimals");

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
  assert.match(paidRes.content.at(-1).text, /paid 0\.05\d* XNO deposit/);
  // the fake run reports no cost → settles at $0, whole deposit goes back as change
  assert.match(paidRes.content.at(-1).text, /whole deposit is being returned/);
  assert.equal(registry.callCount(), 1);

  // replay: same id returns the cached result without running again
  const replay = await callTool({ name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId } });
  assert.deepEqual(replay, paidRes);
  assert.equal(registry.callCount(), 1);

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "change:" }]);
  // usage.jsonl is a payments ledger: money events only, never a "run" event.
  assert.deepEqual(events.map(([e]) => e).filter((e) => e !== "change"), ["quote", "paid"]);
  assert.ok(!events.some(([e]) => e === "run"), "no run telemetry in the payments ledger");
  const paidEvent = events[1][1];
  assert.equal(paidEvent.source, PAYER);
  assert.equal(typeof paidEvent.settleMs, "number");
});

test("quote tracks the up-front cost forecast, not a flat deposit — and covers the real cost", async () => {
  const chain = fakeChain();
  // A pricey graph forecast at $0.20/run (inexact — e.g. a video). Deposit = ceil(0.20 × 1.2 × 2) = $0.48.
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.20 }) });
  registry.estimates = { poster: { usd: 0.20, exact: false, priced: 1, unpriced: 0 } };
  const { listTools, callTool } = makeGate(chain, { registry }).wrapRegistry(registry);

  assert.match(listTools()[0].description, /\$0\.48 deposit per call/);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  assert.equal(x.amountUsd, 0.48);   // NOT the flat $0.05

  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError);
  await new Promise((r) => setTimeout(r, 50));
  // the real $0.20 cost is fully covered by the deposit → operator keeps cost+markup, payer gets change.
  // (At flat $0.05 this run would have overrun the deposit and the operator would eat $0.15.)
  const deposit = BigInt(x.amountRaw), costRaw = 20n * 10n ** 28n; // $0.20 at $1/XNO
  const change = chain.state.transfers.find((t) => t.describe === "change:");
  assert.ok(change, "change is returned — deposit exceeded the cost");
  assert.equal(BigInt(change.amountRaw), deposit - costRaw - costRaw / 5n);
});

test("exact (all-image) forecast quotes a tight deposit; observed cost overrides a low estimate", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  // deterministic image forecast $0.04 → ceil(0.04 × 1.2 × 1.25) = $0.06 (tighter than the variance multiplier)
  registry.estimates = { poster: { usd: 0.04, exact: true, priced: 1, unpriced: 0 } };
  let g = makeGate(chain, { registry }).wrapRegistry(registry);
  assert.match(g.listTools()[0].description, /\$0\.06 deposit per call/);

  // reality beats the forecast: a metered $0.10 high-water mark pushes the deposit up (variance multiplier applies)
  registry.costs = { poster: { usd: 0.10, exact: true } };
  g = makeGate(chain, { registry }).wrapRegistry(registry);
  assert.match(g.listTools()[0].description, /\$0\.24 deposit per call/);  // ceil(0.10 × 1.2 × 2)
});

test("a forecast with unpriceable nodes never quotes below the opening deposit", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  // only $0.01 could be priced but a node is uncatalogued → lower bound; floor to the $0.05 opening deposit
  registry.estimates = { poster: { usd: 0.01, exact: false, priced: 1, unpriced: 1 } };
  const { listTools } = makeGate(chain, { registry, usd: 0.05 }).wrapRegistry(registry);
  assert.match(listTools()[0].description, /\$0\.05 deposit per call/);
});

test("no forecast and never run → the flat opening deposit (unchanged behavior)", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { listTools } = makeGate(chain, { registry, usd: 0.05 }).wrapRegistry(registry);
  assert.match(listTools()[0].description, /\$0\.05 deposit per call/);
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
  const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded: PROMPT LEAK abc123"); } });
  const events = [];
  const { callTool } = makeGate(chain, { registry, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  // the FULL upstream error still reaches the caller…
  assert.match(res.content[0].text, /model exploded: PROMPT LEAK abc123/);
  assert.match(res.content[0].text, /refunded to/);
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);

  // …but the payments ledger records only a categorical refund — no run event,
  // and not one byte of the upstream error text lands in the serialized line.
  assert.ok(!events.some(([e]) => e === "run"), "no run telemetry in the ledger");
  const refund = events.find(([e]) => e === "refund");
  assert.ok(refund, "a failed paid run writes a refund event");
  assert.equal(refund[1].reason, "run_failed");
  const line = JSON.stringify({ ts: new Date().toISOString(), event: refund[0], ...refund[1] });
  assert.doesNotMatch(line, /model exploded|PROMPT LEAK|abc123/,
    "the ledger line must not carry upstream error text (it can quote user content)");
});

test("a bounced refund is retried until it lands — the customer's money is never stranded", async () => {
  let t = 1_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  const events = [];
  const { callTool } = makeGate(chain, { registry, now: () => t, pollMs: 5, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: PAYER };

  chain.state.failTransfer = true; // the refund send bounces (rate limit, RPC blip…)
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /refunded to .* automatically/, "caller must be told the refund retries, not to chase the operator");
  assert.deepEqual(chain.state.transfers, []);

  chain.state.failTransfer = false;
  t += 31_000; // past the first retry backoff
  await new Promise((r) => setTimeout(r, 80)); // let the watcher tick
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
  const retried = events.filter(([e, f]) => e === "refund" && f.ok);
  assert.equal(retried.length, 1);
  assert.equal(retried[0][1].retries, 1);
});

test("a bounced change send is retried too", async () => {
  let t = 2_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.02 }) });
  const events = [];
  const { callTool } = makeGate(chain, { registry, now: () => t, pollMs: 5, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["E".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain.state.failTransfer = true;
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError, "the run itself succeeded — only the change send bounced");
  await new Promise((r) => setTimeout(r, 30));
  chain.state.failTransfer = false;
  t += 31_000;
  await new Promise((r) => setTimeout(r, 80));
  const change = chain.state.transfers.find((tr) => tr.describe === "change:");
  assert.ok(change, "change must land on retry");
  assert.equal(BigInt(x.amountRaw) - 24n * 10n ** 27n, BigInt(change.amountRaw)); // deposit − (cost+markup) at $1/XNO
  assert.ok(events.find(([e, f]) => e === "change" && f.ok && f.retries === 1));
});

test("settle: cost + 20% markup to the author, change back to the payer, exact to the raw", async () => {
  const chain = fakeChain();
  // $0.05 deposit at $1/XNO; the run meters $0.02 → cost 0.02 XNO, markup 0.004 XNO, rest is change
  const registry = fakeRegistry({ author: PAYER, onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.02 }) });
  const events = [];
  const { callTool, listTools } = makeGate(chain, { registry, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  assert.match(listTools()[0].description, /20% markup goes to the graph's author/);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError);
  assert.ok(!("costUsd" in res), "cost sidecar must be stripped from the caller's result");
  assert.match(res.content.at(-1).text, /settled at actual cost \$0\.02 \+ 20%/);
  assert.match(res.content.at(-1).text, /markup goes to this noodle's author/);
  // transfers ride the send queue — give the microtask a beat
  await new Promise((r) => setTimeout(r, 50));
  const deposit = BigInt(x.amountRaw);
  const costRaw = 2n * 10n ** 28n;       // $0.02 at $1/XNO, exact
  const markup = costRaw / 5n;           // 20%, integer
  assert.deepEqual(chain.state.transfers, [
    { to: PAYER, amountRaw: markup.toString(), describe: "author payout:" },
    { to: PAYER, amountRaw: (deposit - costRaw - markup).toString(), describe: "change:" },
  ]);
  // conservation: every raw accounted for — deposit = cost kept + author take + change
  const [a, c] = chain.state.transfers;
  assert.equal(costRaw + BigInt(a.amountRaw) + BigInt(c.amountRaw), deposit);
  assert.ok(events.find(([e]) => e === "author_payout")[1].ok);
  assert.ok(events.find(([e]) => e === "change")[1].ok);
});

test("settle: run costing more than its deposit keeps the deposit, pays nothing out", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ author: PAYER, onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.06 }) });
  const events = [];
  const { callTool } = makeGate(chain, { registry, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chain.state.transfers.length, 0);
  assert.ok(!events.some(([e]) => e === "author_payout" || e === "change"));
});

test("settle: markup is capped by what's left after cost", async () => {
  const chain = fakeChain();
  // deposit $0.05, cost $0.045 → remaining 0.005 XNO < markup 0.009 XNO → author gets the remaining, no change
  const registry = fakeRegistry({ author: PAYER, onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.045 }) });
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  await new Promise((r) => setTimeout(r, 50));
  const remaining = BigInt(x.amountRaw) - 45n * 10n ** 27n;
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: remaining.toString(), describe: "author payout:" }]);
});

test("parseUsdNano is string-exact, handles exponents, truncates below 1e-9 USD", () => {
  assert.equal(parseUsdNano("0.092933082"), 92933082n);
  assert.equal(parseUsdNano("0.05"), 50000000n);
  assert.equal(parseUsdNano(0.05), 50000000n);
  assert.equal(parseUsdNano("12"), 12000000000n);
  assert.equal(parseUsdNano(1e-7), 100n);
  assert.equal(parseUsdNano("2.5e-3"), 2500000n);
  assert.equal(parseUsdNano("0.0000000001"), 0n); // 1e-10 USD truncates
  assert.throws(() => parseUsdNano("-1"));
  assert.throws(() => parseUsdNano("abc"));
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

/*
 * Burst regression: pre-fix, `receivable` was polled with count 50 and history
 * with a fixed 25-entry window every 5th tick, so a burst of simultaneous
 * payments hard-capped at ~70 settled — everything past that was pocketed by
 * housekeeping, scrolled out of the history window, and silently stranded
 * (paid, never run, never refunded). These tests run against a fake node that
 * honors the RPC count params, which is what exposed the caps.
 */
const testHash = (i) => i.toString(16).padStart(64, "0").toUpperCase();

test("burst: 120 payments pocketed by a concurrent wallet all match via the history walk", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { callTool } = gate.wrapRegistry(registry);
  const xs = [];
  for (let i = 0; i < 120; i++) xs.push(argOf(await callTool({ name: "poster", arguments: { Text: "p" + i } })));
  await new Promise((r) => setTimeout(r, 25)); // watcher ticks at least once pre-burst (seeds the history marker)
  // every deposit was pocketed the instant it arrived — never visible in
  // receivable — then buried under 40 later housekeeping sends. 160 entries
  // spans multiple history pages, so this exercises pagination too.
  for (let i = 0; i < 120; i++) chain.state.history.unshift({ type: "receive", account: PAYER, amount: xs[i].amountRaw, hash: testHash(i) });
  for (let i = 0; i < 40; i++) chain.state.history.unshift({ type: "send", account: PAYER, amount: "1", hash: testHash(1000 + i) });
  const statuses = await Promise.all(xs.map((x) => gate.waitForPayment(x.paymentId, 2000)));
  assert.equal(statuses.filter((s) => s === "paid").length, 120, `expected all 120 paid, got: ${JSON.stringify(statuses.filter((s) => s !== "paid"))}`);
});

test("burst: receivables past the poll window recover via pocketing + the history walk", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { callTool } = gate.wrapRegistry(registry);
  const xs = [];
  for (let i = 0; i < 520; i++) xs.push(argOf(await callTool({ name: "poster", arguments: { Text: "p" + i } })));
  await new Promise((r) => setTimeout(r, 25));
  // 520 simultaneous receivables — 20 beyond even the widened 500 window. The
  // scanner must notice the full window, have the wallet pocket, and pick the
  // overflow up from history.
  for (let i = 0; i < 520; i++) chain.state.receivable[testHash(i)] = { amount: xs[i].amountRaw, source: PAYER };
  const statuses = await Promise.all(xs.map((x) => gate.waitForPayment(x.paymentId, 2000)));
  assert.equal(statuses.filter((s) => s === "paid").length, 520, `expected all 520 paid, got ${statuses.filter((s) => s === "paid").length}`);
});

test("burst: concurrent cold-cache quotes share ONE rate-oracle probe", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  let probes = 0;
  const fetch = async () => {
    probes++;
    await new Promise((r) => setTimeout(r, 20)); // all quoters arrive while the probe is in flight
    return {
      status: 402,
      json: async () => ({ payment: { accepted: [
        { scheme: "nano", payTo: GATE_ADDR, amount: "1" + "0".repeat(30), amountUsd: "1" }] } }),
    };
  };
  const { callTool } = makeGate(chain, { registry, xnoUsd: null, fetch }).wrapRegistry(registry);
  const quotes = await Promise.all(Array.from({ length: 10 }, (_, i) => callTool({ name: "poster", arguments: { Text: "t" + i } })));
  assert.equal(probes, 1, "10 concurrent cold quotes must not stampede the oracle");
  assert.equal(new Set(quotes.map((q) => argOf(q).amountRaw)).size, 10);
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

test("the displayed XNO amount IS the payable amount — display round-trips to the exact raw", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  // reconstruct raw from the friendly string exactly as a wallet would send it
  const [whole, frac = ""] = rawToXno(x.amountRaw).split(".");
  const typedRaw = BigInt(whole + frac.padEnd(30, "0"));
  assert.equal(typedRaw.toString(), x.amountRaw,
    "a human typing the displayed XNO amount must send exactly the quoted raw");
});

test("a payment a wallet padded with sub-display dust still matches its quote", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  // an amount inside the same 1e-8 XNO bucket, but not byte-identical
  chain.state.receivable["A".repeat(64)] = { amount: (BigInt(x.amountRaw) + 12345n).toString(), source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError, JSON.stringify(res.content));
});

test("payment-required text carries the tool's typical runtime when known", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  registry.costs = { poster: { usd: 0.03, ms: 15_000, at: "2026-07-22T00:00:00Z" } };
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const quote = await callTool({ name: "poster", arguments: { Text: "a" } });
  assert.match(quote.content[0].text, /typically finishes in ~15s/);
  // $0.03 observed → deposit ceil(0.03 × 1.2 × 2) = $0.08 (tracks cost, no longer capped at the opening deposit)
  assert.match(quote.content[0].text, /send exactly 0\.08\d* XNO/);
});

test("gate state survives a restart: pending quote pays and settles under the reloaded gate", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-state-")), "gate-state.json");

  const chain1 = fakeChain();
  const registry1 = fakeRegistry();
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  await new Promise((r) => setTimeout(r, 50)); // let the debounced persist land

  // "deploy": a brand-new gate + chain, same state file
  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.02 }) });
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  chain2.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  assert.equal(registry2.callCount(), 1);
  // settle math still exact after the pair's BigInts round-tripped through JSON
  await new Promise((r) => setTimeout(r, 50));
  const change = chain2.state.transfers.find((t) => t.describe === "change:");
  assert.equal(BigInt(x.amountRaw) - 24n * 10n ** 27n, BigInt(change.amountRaw));
});

test("gate state survives a restart: completed runs replay, they never run twice", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-replay-")), "gate-state.json");

  const chain1 = fakeChain();
  const registry1 = fakeRegistry();
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!first.isError);
  await new Promise((r) => setTimeout(r, 50));

  const chain2 = fakeChain();
  const registry2 = fakeRegistry();
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!replay.isError);
  assert.equal(replay.content[0].text, first.content[0].text);
  assert.equal(registry2.callCount(), 0, "replay must not re-run (or re-settle) the tool");
});

test("gate state survives a restart: a queued refund retries under the new process", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-owed-")), "gate-state.json");
  let t = 5_000_000;

  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile, now: () => t, pollMs: 5 }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain1.state.failTransfer = true; // refund bounces → owed queue
  const res = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  await new Promise((r) => setTimeout(r, 50));

  const chain2 = fakeChain();
  const gate2 = makeGate(chain2, { registry: fakeRegistry(), stateFile, now: () => t, pollMs: 5 });
  gate2.wrapRegistry(fakeRegistry());
  t += 31_000; // past the first retry backoff
  await new Promise((r) => setTimeout(r, 80)); // restored watcher ticks
  assert.deepEqual(chain2.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }],
    "the customer's refund must land even though the process that owed it died");
});

test("restore scrubs legacy free-text refund reasons: no upstream error text reaches a new ledger line", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-legacy-")), "gate-state.json");
  let t = 6_000_000;

  // A state file written by a PRE-policy build: the queued refund's reason is
  // the old free-text form that can quote user content.
  const SENTINEL = "run failed: PROMPT LEAK abc123 SECRET";
  await writeFile(stateFile, JSON.stringify({
    v: 1,
    quotes: [],
    owed: [{
      to: PAYER, amountRaw: "50000000000000000000000000000", describe: "refunded",
      event: "refund", fields: { paymentId: "pay_legacy", tool: "poster", reason: SENTINEL }, tries: 0,
    }],
  }));

  const chain = fakeChain();
  const events = [];
  // Restore under the new build; the owed send lands on the first retry tick.
  makeGate(chain, { registry: fakeRegistry(), stateFile, now: () => t, pollMs: 5, usage: (e, f) => events.push([e, f]) })
    .wrapRegistry(fakeRegistry());
  t += 31_000; // past the first retry backoff
  await new Promise((r) => setTimeout(r, 80)); // restored watcher ticks and sends

  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: "50000000000000000000000000000", describe: "refunded" }]);
  const refund = events.find(([e, f]) => e === "refund" && f.ok);
  assert.ok(refund, "the restored refund must land and log a money event");
  assert.equal(refund[1].reason, "run_failed", "the legacy reason is coerced to a category");
  const line = JSON.stringify({ ts: new Date().toISOString(), event: refund[0], ...refund[1] });
  assert.doesNotMatch(line, /PROMPT LEAK|abc123|SECRET/,
    "not one byte of the legacy free-text reason may reach the new ledger line");
});

test("a text output never touches disk: state file holds no output text, restart re-runs (charged once)", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-textout-")), "gate-state.json");

  // The tool output is the customer's paid content — tagged textOutput by emitResult.
  const SECRET = "THE-CROWN-JEWELS-summary-42";
  const textOut = { content: [{ type: "text", text: SECRET }], costUsd: 0.02, textOutput: true };

  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => textOut });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!first.isError && first.content.some((c) => c.text === SECRET), "the caller still gets their output in-process");
  await new Promise((r) => setTimeout(r, 60)); // settle + persist land

  // settle DID run on the first (successful) run: change went back to the payer
  assert.ok(chain1.state.transfers.some((t) => t.describe === "change:"), "the first run settles as normal");

  // The persisted bytes must not contain the customer's output text.
  const bytes = await readFile(stateFile, "utf8");
  assert.doesNotMatch(bytes, /CROWN-JEWELS/, "no tool output text may be written to disk");

  // Restart: the quote demotes to paid and RE-RUNS on retry — delivered, not charged twice.
  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => textOut });
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!replay.isError && replay.content.some((c) => c.text === SECRET), "retry after restart re-runs and delivers");
  assert.equal(registry2.callCount(), 1, "the tool re-runs once after a restart (the operator eats the duplicate call)");
  await new Promise((r) => setTimeout(r, 60));
  // Not charged twice: no fresh payment was demanded, and change/author are NOT paid a second time.
  assert.ok(!replay.structuredContent, "no new payment-required response — the original deposit still counts");
  assert.equal(chain2.state.transfers.filter((t) => t.describe === "change:").length, 0,
    "the re-run must not pay change a second time");
});

test("a media-URL result persists and replays after a restart (pointers are safe at rest)", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-media-")), "gate-state.json");

  // Media output: a /out/ URL pointer + cost line, no textOutput flag.
  const URL = "http://pay.test/out/poster-image-123.png";
  const mediaOut = { content: [{ type: "text", text: `image: ${URL}` }], costUsd: 0.02 };

  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => mediaOut });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!first.isError);
  await new Promise((r) => setTimeout(r, 60));

  const bytes = await readFile(stateFile, "utf8");
  assert.match(bytes, /out\/poster-image-123\.png/, "the media pointer persists (the file itself dies by --out-ttl)");

  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => mediaOut });
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!replay.isError);
  assert.equal(replay.content[0].text, first.content[0].text, "the media result replays byte-for-byte");
  assert.equal(registry2.callCount(), 0, "a persisted media result replays — it does not re-run");
});

test("a failed paid run persists refund status but no upstream error text; replay shows the placeholder", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-err-")), "gate-state.json");

  const SECRET = "upstream said PROMPT-LEAK-xyz in the body";
  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => { throw new Error(SECRET); } });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  // The refund bounces so the quote stays "consumed" carrying its (redacted) error,
  // which is the state that replays a placeholder after a restart. (A refund that
  // lands flips the quote to "refunded" and replays the gate's "call again" note —
  // also content-free, but it doesn't exercise the error redaction on disk.)
  chain1.state.failTransfer = true;
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(first.isError && first.content[0].text.includes(SECRET), "the caller sees the full error in-process");
  await new Promise((r) => setTimeout(r, 60));

  const bytes = await readFile(stateFile, "utf8");
  assert.doesNotMatch(bytes, /PROMPT-LEAK/, "the upstream error text must not be written to disk");
  assert.match(bytes, /error details not retained across restarts/, "the redacted placeholder is persisted");
  assert.match(bytes, /refunded to/, "the gate-authored refund status IS kept");

  const chain2 = fakeChain();
  chain2.state.failTransfer = true; // keep the refund pending so the quote replays its error, not "refunded"
  const registry2 = fakeRegistry({ onCall: async () => { throw new Error(SECRET); } });
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(replay.isError);
  assert.doesNotMatch(replay.content[0].text, /PROMPT-LEAK/, "the replayed error carries no upstream text");
  assert.match(replay.content[0].text, /error details not retained across restarts/);
  assert.match(replay.content[0].text, /refunded to/, "the replayed error keeps the refund status");
  assert.equal(registry2.callCount(), 0, "a failed quote replays its redacted error — it does not re-run or re-refund");
});

test("a legacy state file with a text result + free-text error never re-persists its content", async () => {
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-legacy2-")), "gate-state.json");

  const RESULT_SECRET = "LEGACY-OUTPUT-abc";
  const ERROR_SECRET = "LEGACY-ERROR-def";
  const pair = { usdNano: "1000000000", raw: "1000000000000000000000000000000" };
  const base = { tool: "poster", argsHash: hashArgs("poster", {}), usd: 0.05, pair,
    amountRaw: "50000000000000000000000000000", createdAt: 1000, expiresAt: 9_000_000_000_000,
    source: PAYER, payHash: "P".repeat(64), paidAt: 2000 };
  // A pre-v2 file: one consumed quote with a text result, one with a free-text error.
  await writeFile(stateFile, JSON.stringify({
    v: 1,
    quotes: [
      { ...base, id: "pay_legacy_result", status: "consumed",
        result: { content: [{ type: "text", text: RESULT_SECRET }] }, error: null },
      { ...base, id: "pay_legacy_error", argsHash: hashArgs("poster", { Text: "z" }), status: "consumed",
        result: null, error: `run failed: ${ERROR_SECRET} — your payment was refunded to ${PAYER}.` },
    ],
    owed: [],
  }));

  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, stateFile }).wrapRegistry(registry);

  // The legacy errored quote replays a redacted placeholder — no re-run, no re-refund.
  const errReplay = await gate.callTool({ name: "poster", arguments: { Text: "z", _payment_id: "pay_legacy_error" } });
  assert.ok(errReplay.isError);
  assert.doesNotMatch(errReplay.content[0].text, /LEGACY-ERROR/, "the legacy error text is gone from the replay");
  assert.match(errReplay.content[0].text, /error details not retained across restarts/);

  // Force a fresh persist (a new quote), then inspect the rewritten v2 file.
  await gate.callTool({ name: "poster", arguments: { Text: "new" } });
  await new Promise((r) => setTimeout(r, 60));
  const bytes = await readFile(stateFile, "utf8");
  assert.doesNotMatch(bytes, /LEGACY-OUTPUT|LEGACY-ERROR/, "no legacy content may leak into the rewritten state file");
  assert.match(bytes, /"v":2/, "the file is rewritten in the content-stripping era format");
  assert.equal(registry.callCount(), 0, "restoring a legacy file must not re-run any paid call on its own");
});

test("a redacted error survives a SECOND restart: the refund-status sentence is never lost", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-err2-")), "gate-state.json");

  const SECRET = "PROMPT-LEAK-2nd-restart";
  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => { throw new Error(SECRET); } });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain1.state.failTransfer = true; // refund bounces → quote stays consumed with its redacted error
  await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  await new Promise((r) => setTimeout(r, 60));

  // First restart: restore, then force a re-persist (a new quote) so the error round-trips.
  const chain2 = fakeChain();
  chain2.state.failTransfer = true;
  const gate2 = makeGate(chain2, { registry: fakeRegistry({ onCall: async () => { throw new Error(SECRET); } }), stateFile }).wrapRegistry(fakeRegistry());
  await gate2.callTool({ name: "poster", arguments: { Text: "z" } }); // triggers persist
  await new Promise((r) => setTimeout(r, 60));

  const bytes = await readFile(stateFile, "utf8");
  assert.doesNotMatch(bytes, /PROMPT-LEAK/, "no upstream text after the second persist");
  assert.match(bytes, /error details not retained across restarts/, "the placeholder survives");
  assert.match(bytes, /refunded to/, "the refund-status sentence is NOT collapsed to the bare fallback");

  // Second restart: the replayed error still carries the refund status.
  const chain3 = fakeChain();
  chain3.state.failTransfer = true;
  const gate3 = makeGate(chain3, { registry: fakeRegistry(), stateFile }).wrapRegistry(fakeRegistry());
  const replay = await gate3.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(replay.isError);
  assert.match(replay.content[0].text, /refunded to/, "refund status still present after two restarts");
  assert.doesNotMatch(replay.content[0].text, /PROMPT-LEAK/);
});

test("a re-run after restart reports the FIRST run's settled cost and change, not the second run's", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-receipt-")), "gate-state.json");

  const SECRET = "RECEIPT-OUTPUT-text";
  // First run: a known cost of $0.02 → partial change is sent, receipt says "$0.0200".
  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: SECRET }], costUsd: 0.02, textOutput: true }) });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile }).wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.match(first.content.at(-1).text, /actual cost \$0\.02/);
  assert.match(first.content.at(-1).text, /change returned to your wallet/);
  await new Promise((r) => setTimeout(r, 60));

  // Restart: the SECOND run reports NO cost. Money doesn't move again, and the
  // receipt must still describe the first run's settlement — not claim "whole
  // deposit returned" off the second run's missing cost.
  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: SECRET }], textOutput: true }) }); // no costUsd
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.equal(registry2.callCount(), 1, "the text quote re-runs after restart");
  const receipt = replay.content.at(-1).text;
  assert.match(receipt, /actual cost \$0\.02/, "receipt reports the FIRST run's cost");
  assert.match(receipt, /change returned to your wallet/, "receipt reports the FIRST run's change");
  assert.doesNotMatch(receipt, /whole deposit is being returned/, "must NOT claim a full refund off the second run's missing cost");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(chain2.state.transfers.filter((t) => t.describe === "change:").length, 0, "no money moves on the re-run");
});

test("rate oracle: NanoGPT's own 402 invoice implies the XNO/USD rate", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const probes = [];
  // 0.2 XNO priced at $0.05 → $0.25/XNO → a $0.05 quote should be ~0.2 XNO
  const fetch = async (url, opts) => {
    probes.push(url);
    assert.match(url, /nano-gpt\.com\/api\/v1\/chat\/completions/);
    assert.equal(opts.headers["x-x402"], "true");
    return {
      status: 402,
      json: async () => ({
        payment: {
          paymentId: "probe",
          accepted: [{ scheme: "nano", payTo: GATE_ADDR, amount: "200000000000000000000000000000", amountUsd: "0.05" }],
        },
      }),
    };
  };
  const events = [];
  const { callTool } = makeGate(chain, { registry, xnoUsd: null, fetch, usage: (e, f) => events.push([e, f]) }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  assert.ok(BigInt(x.amountRaw) >= 2n * 10n ** 29n && BigInt(x.amountRaw) < 2n * 10n ** 29n + 10n ** 26n,
    `expected ~0.2 XNO, got ${x.amountXno}`);
  // second quote inside the cache window: no second probe
  await callTool({ name: "poster", arguments: { Text: "b" } });
  assert.equal(probes.length, 1);
  assert.equal(events[0][1].rateSource, "nanogpt-x402");
  assert.ok(Math.abs(events[0][1].xnoUsd - 0.25) < 1e-9);
});

test("rate oracle: stale cache survives a probe outage; no cache at all is a clean error", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  let t = 1_000_000, probeOk = true, probes = 0;
  const fetch = async () => {
    probes++;
    if (!probeOk) return { status: 500, json: async () => ({}) };
    return {
      status: 402,
      json: async () => ({ payment: { paymentId: "p", accepted: [
        { scheme: "nano", payTo: GATE_ADDR, amount: "100000000000000000000000000000", amountUsd: "0.05" }] } }),
    };
  };
  const { callTool } = makeGate(chain, { registry, xnoUsd: null, fetch, now: () => t }).wrapRegistry(registry);
  const a = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  t += 61_000; // cache expired, oracle down → stale rate keeps quoting
  probeOk = false;
  const b = argOf(await callTool({ name: "poster", arguments: { Text: "b" } }));
  assert.equal(BigInt(a.amountRaw) / 10n ** 26n, BigInt(b.amountRaw) / 10n ** 26n); // same rate, different tag
  assert.equal(probes, 2);

  // a gate that never got a rate refuses to quote, readably
  const cold = makeGate(fakeChain(), { registry, xnoUsd: null, fetch }).wrapRegistry(fakeRegistry());
  await assert.rejects(() => cold.callTool({ name: "poster", arguments: { Text: "a" } }), /rate probe failed/);
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
    // The QR a phone would actually scan off this page must decode to the exact
    // nano: URI (address + amount), not just "contain an <svg>".
    const svg = html.match(/<svg[\s\S]*?<\/svg>/)[0];
    assert.equal(qrDecode(svgToMatrix(svg)), `nano:${GATE_ADDR}?amount=${x.amountRaw}`);

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

test("an SSE-capable tools/call streams progress heartbeats, then the final response", async () => {
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools: () => [],
    callTool: async (params, ctx) => {
      if (ctx && ctx.report) ctx.report("making the thing");
      await new Promise((r) => setTimeout(r, 120));
      return { content: [{ type: "text", text: "done" }] };
    },
    publicBase: "http://pay.test", progressMs: 25, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: { name: "x", arguments: {}, _meta: { progressToken: 42 } },
      }),
    });
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const body = await r.text();
    assert.match(body, /notifications\/progress/, "heartbeats must flow while the tool runs");
    assert.match(body, /making the thing \(\d+s elapsed\)/, "heartbeats carry the tool's reported status");
    assert.match(body, /"progressToken":42/);
    const finalEvent = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 7);
    assert.equal(finalEvent.result.content[0].text, "done");

    // a client that doesn't accept SSE still gets the plain JSON response
    const plain = await fetch(`${base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "x", arguments: {} } }),
    });
    assert.match(plain.headers.get("content-type"), /application\/json/);
    assert.equal((await plain.json()).result.content[0].text, "done");
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
  assert.match(t.description, /\$0\.10 deposit per call/);
  assert.match(t.description, /20% markup goes to the graph's author/);

  // the minted editor link is the exact file, gzip+base64url — the editor's own wire format
  const { gunzipSync } = await import("node:zlib");
  const tool = registry.tools[0];
  assert.equal(tool.rawText, JSON.stringify(g));
  assert.match(tool.editorUrl, /^https:\/\/nanoodle\.com\/#g=[A-Za-z0-9_-]+$/);
  const decoded = gunzipSync(Buffer.from(tool.editorUrl.split("#g=")[1], "base64url")).toString("utf8");
  assert.equal(decoded, tool.rawText);
});

test("editor-saved filenames make clean tool names, and legacy cost keys migrate", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { loadTools } = await import("../src/tools.mjs");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "clean-names-"));
  const g = await readFile(join(here, "fixtures", "hello-noodle.json"), "utf8");
  await writeFile(join(dir, "poster.noodle-graph.json"), g);
  await writeFile(join(dir, "costs.json"), JSON.stringify({ "poster-noodle-graph": { usd: 0.04, at: "2026-07-22T00:00:00Z" } }));
  const registry = await loadTools({ dirs: [dir], apiKey: "k", outDir: dir });
  assert.equal(registry.tools[0].name, "poster", "the .noodle-graph save suffix is not part of the name");
  assert.equal(registry.costs.poster.usd, 0.04, "pre-rename cost record still prices the deposit");
  assert.equal(registry.costs["poster-noodle-graph"], undefined);
  assert.match(registry.tools[0].description, /\$0\.04/);
});

test("deposits track observed cost: cheap tools quote small deposits, live", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  registry.costs = { poster: { usd: 0.004, at: "2026-07-21T00:00:00Z" } };
  const { listTools, callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  // $0.004 observed → 2× (cost + 20%) = $0.0096 → 1¢ floor, not the flat $0.05
  assert.match(listTools()[0].description, /\$0\.01 deposit per call/);
  assert.equal(argOf(await callTool({ name: "poster", arguments: { Text: "a" } })).amountUsd, 0.01);
  // the cost record is live — the very next quote follows a fresh recording
  registry.costs.poster = { usd: 0.015, at: "2026-07-21T00:01:00Z" };
  assert.equal(argOf(await callTool({ name: "poster", arguments: { Text: "b" } })).amountUsd, 0.04); // ceil($0.036)
});

test("deposit derivation: high-water mark, inexact costs, tracks-not-caps, pinned x402.usd", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const quoteUsd = async (text) => argOf(await callTool({ name: "poster", arguments: { Text: text } })).amountUsd;
  // the worst run on record prices the deposit, not the (cheaper) last one
  registry.costs = { poster: { usd: 0.002, hiUsd: 0.012 } };
  assert.equal(await quoteUsd("a"), 0.03); // ceil(0.012 · 2.4) → $0.03
  // a lower-bound cost (exact:false) can't be trusted as a basis → flat opening deposit
  registry.costs = { poster: { usd: 0.001, exact: false } };
  assert.equal(await quoteUsd("b"), 0.05);
  // a cost ABOVE the opening deposit now quotes what it actually costs — the deposit is no longer capped
  registry.costs = { poster: { usd: 0.2 } };
  assert.equal(await quoteUsd("c"), 0.48); // ceil(0.2 · 2.4)
  // a pinned per-graph price ignores observed costs entirely
  const pinnedReg = fakeRegistry();
  pinnedReg.tools[0].x402 = { usd: 0.10 };
  pinnedReg.costs = { poster: { usd: 0.004 } };
  const pinnedGate = makeGate(fakeChain(), { registry: pinnedReg }).wrapRegistry(pinnedReg);
  assert.equal(argOf(await pinnedGate.callTool({ name: "poster", arguments: { Text: "d" } })).amountUsd, 0.10);
});

test("landing page links each workflow, states the author cut, and shows self-hosting; /graph serves the JSON", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ author: PAYER });
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const rawText = JSON.stringify({ nodes: [], links: [] });
  const toolInfo = [{
    name: "poster", x402: registry.tools[0].x402, rawText,
    editorUrl: "https://nanoodle.com/#g=H4sIAAAAtest",
  }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    // each workflow: a load-in-editor link + its raw graph JSON
    assert.match(html, /href="https:\/\/nanoodle\.com\/#g=H4sIAAAAtest">open in editor</);
    assert.match(html, /href="\/graph\/poster\.json">graph JSON</);
    // the money story: deposit → cost + 20%, markup is the author's
    assert.match(html, /workflow author&#39;s cut|workflow author's cut/);
    assert.match(html, /authors earn the 20%/);
    assert.match(html, new RegExp(PAYER)); // per-tool author payout address
    // open source + host your own
    assert.match(html, /Open source — host your own/);
    assert.match(html, /MIT-licensed/);
    assert.match(html, /npx nanoodle-mcp --graphs/);
    assert.match(html, /github\.com\/nanoodlecom\/nanoodle-mcp/);

    const graph = await fetch(`${base}/graph/poster.json`);
    assert.equal(graph.status, 200);
    assert.match(graph.headers.get("content-type"), /application\/json/);
    assert.equal(await graph.text(), rawText);
    assert.equal((await fetch(`${base}/graph/nope.json`)).status, 404);
  } finally {
    server.close();
  }
});

test("landing workflow card: title + id, intent, tinted pipeline chips, last-run cost — boilerplate stated once, not per card", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const toolInfo = [{
    name: "poster", x402: null, rawText: "{}",
    editorUrl: "https://nanoodle.com/#g=H4sIAAAAtest",
    card: {
      intent: "Turns one line into a printable poster.",
      steps: [
        { label: "text", kind: "text", n: 1 },
        { label: "llm", kind: "llm", n: 2 },
        { label: "image", kind: "image", n: 1 },
      ],
    },
  }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo,
    costs: { poster: { usd: 0.04, ms: 15_000 } },
    publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    // layered card: human title beside the exact tool id, then the author's intent
    assert.match(html, /<span class="tname">Poster<\/span><code class="tid">poster<\/code>/);
    assert.match(html, /<p class="intent">Turns one line into a printable poster\.<\/p>/);
    // pipeline chips carry their media-class tints; ×N collapse survives
    assert.match(html, /<span class="chip k-text">text<\/span>/);
    assert.match(html, /<span class="chip k-llm">llm×2<\/span>/);
    assert.match(html, /<span class="chip k-image">image<\/span>/);
    // real price signal on the card, links intact
    assert.match(html, /last run \$0\.04, ~15s/);
    assert.match(html, /open in editor/);
    // the payment contract is told once above the grid, not inside every card
    assert.match(html, /settles at the model(?:&#39;|')s actual cost \+ 20%, change returned/);
    assert.doesNotMatch(html, /deposit per call, paid in Nano/);
  } finally {
    server.close();
  }
});

test("landing workflow card without structured pieces falls back to the one-line description", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const toolInfo = [{ name: "poster", x402: null, rawText: "{}", editorUrl: "https://nanoodle.com/#g=H4sIAAAAtest" }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<li class="tool"><code>poster<\/code>/);
    assert.match(html, /deposit per call, paid in Nano/); // the gated description carries the contract here
    assert.match(html, /open in editor/);
  } finally {
    server.close();
  }
});

test("landing hero: connect command, payment flow strip, llms.txt pointer", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /claude mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(html, /402 payment quote/);
    assert.match(html, /No tab, no tip, no signup\./);
    assert.match(html, /href="\/llms\.txt"/);
  } finally {
    server.close();
  }
});

test("landing carries OG/social meta and the favicon; brand assets are served", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    // social card meta, absolute against publicBase
    assert.match(html, /property="og:image" content="http:\/\/pay\.test\/og\.jpg"/);
    assert.match(html, /property="og:title"/);
    assert.match(html, /property="og:description"/);
    assert.match(html, /property="og:url" content="http:\/\/pay\.test\/"/);
    assert.match(html, /property="og:image:alt"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    // favicon links + the icon sits next to the brand name
    assert.match(html, /rel="icon" href="\/favicon\.ico"/);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /<a class="brand" href="\/"><img src="\/favicon\.png"/);

    // the assets themselves are served with real bytes and the right type
    for (const [path, type] of [
      ["/favicon.ico", "image/x-icon"], ["/favicon.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"], ["/icon-512.png", "image/png"], ["/og.jpg", "image/jpeg"],
    ]) {
      const r = await fetch(`${base}${path}`);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("content-type"), type, path);
      assert.ok((await r.arrayBuffer()).byteLength > 500, `${path} should have real image bytes`);
    }

    // pay pages get the favicon links too
    const arg = argOf(await callTool({ name: "poster", arguments: { Text: "x" } }));
    const pay = await (await fetch(`${base}/pay/${arg.paymentId}`)).text();
    assert.match(pay, /rel="icon" href="\/favicon\.ico"/);
  } finally {
    server.close();
  }
});

test("llms.txt: plain-text endpoint, payment contract, and tool list; free mode drops payment", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const toolInfo = [{ name: "poster", x402: null, rawText: "{}", editorUrl: "https://nanoodle.com/#g=abc" }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/llms.txt`);
    assert.match(res.headers.get("content-type"), /text\/plain/);
    const txt = await res.text();
    assert.match(txt, /endpoint: http:\/\/pay\.test\/mcp/);
    assert.match(txt, /claude mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(txt, /## Payment \(x402, Nano\/XNO\)/);
    assert.match(txt, /settles at metered model cost \+ 20%/);
    assert.match(txt, /- poster: /);
    assert.match(txt, /graph: http:\/\/pay\.test\/graph\/poster\.json/);
    assert.match(txt, /npx nanoodle-mcp --graphs/);
  } finally {
    server.close();
  }

  const freeReg = fakeRegistry();
  const freeServer = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools: freeReg.listTools, callTool: freeReg.callTool,
    publicBase: "http://pay.test", log: () => {},
  });
  const freeBase = `http://127.0.0.1:${freeServer.address().port}`;
  try {
    const txt = await (await fetch(`${freeBase}/llms.txt`)).text();
    assert.doesNotMatch(txt, /Payment/);
    assert.match(txt, /- poster: /);
  } finally {
    freeServer.close();
  }
});

test("free-mode landing page skips the payment story but still shows self-hosting", async () => {
  const registry = fakeRegistry();
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools: registry.listTools, callTool: registry.callTool,
    toolInfo: [{ name: "poster", x402: null, rawText: "{}", editorUrl: "https://nanoodle.com/#g=abc" }],
    publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /authors earn the 20%/);
    assert.doesNotMatch(html, /deposit/i);
    assert.match(html, /open in editor/);
    assert.match(html, /Open source — host your own/);
  } finally {
    server.close();
  }
});

test("landing page states the privacy contract; charged mode adds the ledger line", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Private by design/);
    assert.match(html, /No accounts, no API keys, no sign-ins/);
    assert.match(html, /never written to disk or logs/);
    assert.match(html, /auto-deletes after 24 hours/);
    assert.match(html, /held in memory for delivery, not stored/);
    assert.match(html, /the server keeps no request logs/);
    // charge-mode-only ledger claim
    assert.match(html, /payments ledger: money events that mirror what is already public/);
    // the honest NanoGPT caveat + verify-in-source link
    assert.match(html, /governed by <a href="https:\/\/nano-gpt\.com\/privacy">their privacy policy/);
    assert.match(html, /Verify every line in the source/);
  } finally {
    server.close();
  }
});

test("free-mode landing keeps the privacy card but drops the payments-ledger line", async () => {
  const registry = fakeRegistry();
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools: registry.listTools, callTool: registry.callTool,
    publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Private by design/);
    assert.match(html, /auto-deletes after 24 hours/);
    assert.doesNotMatch(html, /payments ledger: money events/);
  } finally {
    server.close();
  }
});

test("llms.txt carries a Privacy section; free mode drops the charge-specific lines", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const txt = await (await fetch(`${base}/llms.txt`)).text();
    assert.match(txt, /## Privacy/);
    assert.match(txt, /No accounts, no API keys, no sign-ins/);
    assert.match(txt, /Prompts and inputs are never written to disk or logs/);
    assert.match(txt, /short hash binding a payment to its call/); // charge-only
    assert.match(txt, /auto-deletes after 24h/);
    assert.match(txt, /payments ledger \(usage\.jsonl\)/); // charge-only
    assert.match(txt, /nano-gpt\.com\/privacy/);
  } finally {
    server.close();
  }

  const freeReg = fakeRegistry();
  const freeServer = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools: freeReg.listTools, callTool: freeReg.callTool,
    publicBase: "http://pay.test", log: () => {},
  });
  const freeBase = `http://127.0.0.1:${freeServer.address().port}`;
  try {
    const txt = await (await fetch(`${freeBase}/llms.txt`)).text();
    assert.match(txt, /## Privacy/);
    assert.doesNotMatch(txt, /short hash binding a payment/);
    assert.doesNotMatch(txt, /payments ledger \(usage\.jsonl\)/);
  } finally {
    freeServer.close();
  }
});

test("qrSvg encodes a nano URI into a QR matrix svg", () => {
  const svg = qrSvg(`nano:${GATE_ADDR}?amount=123`);
  assert.match(svg, /^<svg /);
  assert.match(svg, /path d="M/);
});

// The QR is only worth showing if a camera reads it back byte-for-byte. These
// decode the matrix with an independent decoder (tests/qr-decode.mjs) — the true
// "does it scan" check, not just "an <svg> came out".
test("qrModules round-trips: the encoded matrix decodes back to the input", () => {
  // Lengths span QR versions 1 → ~large, exercising different masks and the
  // 8-bit vs 16-bit char-count boundary at version 10.
  for (const s of [
    "x",
    `nano:${GATE_ADDR}?amount=123`,
    `nano:${GATE_ADDR}?amount=136472560000000000000000000000`,
    "https://mcp.nanoodle.com/pay/abc123",
    "café ☕ 日本語 — unicode survives the round-trip",
    "A".repeat(400),
  ]) {
    assert.equal(qrDecode(qrModules(s)), s, `round-trip failed for length ${s.length}`);
  }
});

test("qrSvg output parses back into the same matrix qrModules produced", () => {
  const uri = `nano:${GATE_ADDR}?amount=136472560000000000000000000000`;
  assert.deepEqual(svgToMatrix(qrSvg(uri)), qrModules(uri), "SVG path lost/added modules");
  assert.equal(qrDecode(svgToMatrix(qrSvg(uri))), uri, "served SVG does not scan to the URI");
});

// A wallet pre-fills the amount only when the URI carries it in the Nano URI
// scheme: nano:<address>?amount=<raw>, raw being integer 1e-30 XNO units.
test("the payment quote's QR is a spec-correct nano: URI carrying the exact amount", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);

  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a lighthouse" } }));

  // The URI the pay page turns into a QR (http.mjs payPageHtml → qrSvg(q.uri)).
  assert.equal(x.uri, `nano:${GATE_ADDR}?amount=${x.amountRaw}`);
  const u = new URL(x.uri);
  assert.equal(u.protocol, "nano:");
  assert.equal(u.pathname, GATE_ADDR, "address is the URI body, no double slashes");
  const amount = u.searchParams.get("amount");
  assert.match(amount, /^[1-9]\d*$/, "amount must be a bare integer in raw (no decimals, no scale suffix)");
  assert.equal(amount, x.amountRaw, "QR amount must equal the quoted amountRaw");
  // raw → XNO agrees with the human-facing figure shown next to the QR.
  assert.equal(rawToXno(amount), x.amountXno);

  // And it scans: the served SVG decodes byte-for-byte back to that URI.
  assert.equal(qrDecode(svgToMatrix(qrSvg(x.uri))), x.uri);
});

/* ---- streaming hold-open + SSE payment watch (no re-invoke after paying) ---- */

/** Read an SSE response frame by frame, calling onEvent({event,data}) until it returns "stop" or the stream ends. */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      if (onEvent({ event: evLine ? evLine.slice(7) : "message", data: JSON.parse(dataLine.slice(6)) }) === "stop") {
        try { await reader.cancel(); } catch {}
        return;
      }
    }
  }
}

test("streaming first call returns the quote as a RESULT (never held open on a progress-only pay link)", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", progressMs: 40, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // REGRESSION: an earlier build held a streaming first call open and pushed the
    // pay link only as a progress notification. Clients that don't render progress
    // messages (observed live on talking-avatar) then saw NOTHING and the call hung
    // to timeout — no link, no result. The first call must ALWAYS return the quote
    // as its tool RESULT, even for a streaming client that sends a progressToken.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 99, method: "tools/call",
        params: { name: "poster", arguments: { Text: "a lighthouse" }, _meta: { progressToken: "p1" } },
      }),
    });
    const body = await res.text(); // MUST terminate promptly — not hang open
    const final = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 99);
    const x = final.result.structuredContent.x402;
    assert.ok(x.paymentId, "the first call returns the payment-required quote as its result");
    assert.match(final.result.content[0].text, /PAYMENT REQUIRED/, "the pay link is in the RESULT content, not only a progress message");
    assert.match(final.result.content[0].text, /\/pay\//);
    // the watch endpoint is agent/pay-page plumbing — it must NOT ride in the
    // per-call result (agents relay this to users; only the payUrl is user-facing)
    assert.equal(x.watchUrl, undefined, "watchUrl must not be in the quote result shown to users");
    assert.doesNotMatch(final.result.content[0].text, /x402\/watch/, "the watch URL is never in the human-facing text");
    assert.equal(registry.callCount(), 0, "nothing runs on the first call");

    // The no-re-invoke-AFTER-paying path: the follow-up _payment_id call on a
    // streaming transport is held open until the payment lands, then runs.
    chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const run = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId }, _meta: { progressToken: "p2" } },
      }),
    });
    let ran = null;
    await readSse(run, ({ data }) => { if (data.id === 100) { ran = data; return "stop"; } });
    assert.ok(!ran.result.isError, JSON.stringify(ran.result));
    assert.match(ran.result.content[0].text, /^ran /, "the held-open payment call runs and returns the result");
    assert.equal(registry.callCount(), 1, "the tool ran exactly once");
  } finally {
    server.close();
  }
});

test("GET /x402/watch/:id streams status: pending, then paid when the payment lands", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", progressMs: 40, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
    // the endpoint is derived from the paymentId (agent-only; not advertised in the result)
    const res = await fetch(`${base}/x402/watch/${x.paymentId}`, { headers: { Accept: "text/event-stream" } });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const seen = [];
    await readSse(res, ({ event, data }) => {
      if (event !== "status") return;
      seen.push(data.status);
      if (data.status === "pending") {
        // pay after the first pending frame; the shared watcher pushes the next frame
        chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
      } else {
        return "stop"; // paid/consumed → the stream closes
      }
    });
    assert.equal(seen[0], "pending");
    assert.ok(seen.some((s) => s === "paid" || s === "consumed"), `expected a paid frame, got ${JSON.stringify(seen)}`);
  } finally {
    server.close();
  }
});

test("the held-connection cap degrades a streaming call to plain JSON instead of refusing it", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", maxStreams: 0, progressMs: 40, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // maxStreams:0 forces the cap. A streaming tools/call must still get a correct
    // (plain JSON) answer — the payment-required quote — not an error or a hang.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "poster", arguments: { Text: "a" }, _meta: { progressToken: "z" } } }),
    });
    assert.match(res.headers.get("content-type"), /application\/json/, "over the cap, the call is answered as plain JSON");
    const j = await res.json();
    assert.ok(j.result.structuredContent.x402.paymentId);
    // and the watch endpoint 503s so the pay page falls back to polling
    const w = await fetch(`${base}/x402/watch/${j.result.structuredContent.x402.paymentId}`);
    assert.equal(w.status, 503);
  } finally {
    server.close();
  }
});
