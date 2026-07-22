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
  assert.match(quote.content[0].text, /send exactly 0\.05\d* XNO/);
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

test("deposit derivation: high-water mark, inexact costs, ceiling, pinned x402.usd", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const quoteUsd = async (text) => argOf(await callTool({ name: "poster", arguments: { Text: text } })).amountUsd;
  // the worst run on record prices the deposit, not the (cheaper) last one
  registry.costs = { poster: { usd: 0.002, hiUsd: 0.012 } };
  assert.equal(await quoteUsd("a"), 0.03); // ceil(0.012 · 2.4) → $0.03
  // a lower-bound cost (exact:false) can't cap a deposit → flat default
  registry.costs = { poster: { usd: 0.001, exact: false } };
  assert.equal(await quoteUsd("b"), 0.05);
  // a cost above the ceiling still quotes the ceiling (startup warning covers this)
  registry.costs = { poster: { usd: 0.2 } };
  assert.equal(await quoteUsd("c"), 0.05);
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

test("qrSvg encodes a nano URI into a QR matrix svg", () => {
  const svg = qrSvg(`nano:${GATE_ADDR}?amount=123`);
  assert.match(svg, /^<svg /);
  assert.match(svg, /path d="M/);
});
