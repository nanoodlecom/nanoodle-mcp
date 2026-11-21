/**
 * Offline tests for --serve and the x402 charge gate: an in-process HTTP server
 * with a fake registry, and a gate wired to a scripted Nano RPC. No network,
 * nothing spends money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir, link, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";
import { createChargeGate, hashArgs, parseUsdNano, pickNanoQuoteGrain, probeX402Pair } from "../src/gate.mjs";
import { wrapNanoCustomWorkflow } from "../src/custom-mcp.mjs";
import { serveHttp, qrSvg } from "../src/http.mjs";
import { fetchCatalogs, formatCostUsd, loadTools } from "../src/tools.mjs";
import { rawToXno } from "../src/wallet.mjs";
import { createRunFunding } from "../src/run-funding.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { qrModules } from "nanoodle";
import { qrDecode, svgToMatrix } from "./qr-decode.mjs";
import { nanoGptMock, WORKED_CATALOGS, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";

// Any syntactically valid Nano addresses work — checkAddress validates the checksum.
const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

test("Nano quote tags skip collisions after wrapping and stop when the range is full", () => {
  const base = 875_000n;
  const offset = span => span === 10_000 ? 0 : 999_999;
  assert.equal(pickNanoQuoteGrain(base, new Set([base, base + 999_999n]), offset), base + 1n);
  assert.equal(pickNanoQuoteGrain(base, { size: 1_000_000, has: () => true }, offset), null);
});

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
      async transferOnce(to, amountRaw, { prepared, onPrepared, describe }) {
        if (!prepared) await onPrepared({ hash: "F".repeat(64), block: { account: GATE_ADDR, link_as_account: to } });
        return this.transfer(to, amountRaw, describe);
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

function makeGate(chain, { usd = 0.05, registry, now, monotonicNow, waitMs = 300, pollMs = 10, usage,
  xnoUsd = 1.0, fetch, stateFile, fundRun, canQuote, canFundQuote, verifyPaymentReads, maintenance } = {}) {
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
    now, monotonicNow,
    fetch,
    stateFile,
    fundRun, canQuote, canFundQuote, verifyPaymentReads, maintenance,
  });
  return gate;
}

const GRAIN = 10n ** 22n; // 1e-8 XNO, the wallet-typeable resolution — mirrors the gate's constant

const argOf = (result) => result.structuredContent.x402;

test("private Nano workflows bind a quote to their profile and settle only once", async () => {
  const chain = fakeChain();
  const provider = nanoGptMock();
  const baseUrl = "https://custom-nano.provider.invalid";
  let starts = 0;
  const registry = {
    prepareRunNoodle: async (_args, { read }) => assert.equal(read.source, "graph"),
    async callTool(params) {
      assert.equal(params.name, "run_noodle");
      assert.equal(params.arguments.graph.nodes.find(n => n.type === "llm").fields.maxTokens, 2000);
      starts++;
      return { content: [{ type: "text", text: "Private synthetic output" }], costUsd: 0.00941, costExact: true, textOutput: true };
    },
  };
  const gate = makeGate(chain);
  const call = wrapNanoCustomWorkflow({ gate, registry, baseUrl, fetch: provider.fetch });
  const scope = { paymentScope: "private-profile", paymentAlias: "poster-ideas" };
  const args = { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } };
  const payment = argOf(await call(args, scope));
  assert.equal(starts, 0);
  assert.equal(gate.hasOpenProfileQuotes(scope.paymentScope), true);
  assert.equal((await call({ ...args, _payment_id: payment.paymentId }, { ...scope, paymentScope: "another-profile" })).isError, true);
  assert.equal((await call({ ...args, _payment_id: payment.paymentId }, { ...scope, paymentAlias: "different-alias" })).isError, true);
  chain.state.receivable["E".repeat(64)] = { amount: payment.amountRaw, source: PAYER };
  const resume = { ...args, _payment_id: payment.paymentId };
  const results = await Promise.all([call(resume, scope), call(resume, scope)]);
  for (const result of results) {
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(result.content[0].text, /Private synthetic output/);
  }
  assert.equal(starts, 1);
  assert.equal(gate.hasOpenProfileQuotes(scope.paymentScope), false);
});

test("private Nano workflow quotes refuse unpriced models and refund repricing before provider execution", async t => {
  const chain = fakeChain();
  const catalogs = structuredClone(WORKED_CATALOGS);
  const provider = nanoGptMock({ catalogs });
  const baseUrl = "https://custom-nano-repricing.provider.invalid";
  const registry = {
    prepareRunNoodle: async (_args, { read }) => assert.equal(read.source, "graph"),
    async callTool() { assert.fail("Repricing must stop before model execution"); },
  };
  const gate = makeGate(chain);
  t.after(() => gate.stop());
  const call = wrapNanoCustomWorkflow({ gate, registry, baseUrl, fetch: provider.fetch });
  const scope = { paymentScope: "private-repricing-profile", paymentAlias: "poster-ideas" };
  const args = { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } };
  const unpriced = structuredClone(args);
  unpriced.graph.nodes.find(n => n.type === "image").fields.model = "synthetic-uncatalogued-model";
  await assert.rejects(call(unpriced, scope), /price|catalog/i);
  assert.equal(gate.hasOpenProfileQuotes(scope.paymentScope), false);

  const quote = argOf(await call(args, scope));
  assert.ok(quote.amountUsd < 0.12);
  catalogs.image[0].pricing.per_image["1024x1024"] = 0.12;
  await fetchCatalogs(["image"], { baseUrl, fetch: provider.fetch, maxAgeMs: 0 });
  chain.state.receivable["E".repeat(64)] = { amount: quote.amountRaw, source: PAYER };

  const resumed = await call({ ...args, _payment_id: quote.paymentId }, scope);
  assert.equal(resumed.isError, true);
  assert.match(resumed.content[0].text, /no longer fits the quoted budget/);
  assert.equal(provider.runs(), 0);
  assert.equal(chain.state.transfers.length, 1);
  assert.deepEqual(chain.state.transfers[0], { to: PAYER, amountRaw: quote.amountRaw, describe: "refunded" });
});

test("live liabilities retain change while a settlement transfer is still in flight", async () => {
  const chain = fakeChain(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const original = chain.ops.transfer;
  chain.ops.transfer = async (...args) => { await waiting; return original(...args); };
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "done" }], costUsd: 0.01 }) });
  const gate = makeGate(chain, { registry }), { callTool } = gate.wrapRegistry(registry);
  const p = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["E".repeat(64)] = { amount: p.amountRaw, source: PAYER };
  await callTool({ name: "poster", arguments: { Text: "a", _payment_id: p.paymentId } });
  assert.equal(gate.fundingLiabilitiesRaw(), BigInt(p.amountRaw) - 12n * 10n ** 27n);
  release();
  await until("the change transfer to settle", () => gate.fundingLiabilitiesRaw() === 0n);
});

test("an exhausted Nano refund remains held across restart and is not retried or erased", async () => {
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-held-debt-")), "state.json");
  await writeFile(stateFile, JSON.stringify({ v: 2, quotes: [], owed: [{ to: PAYER, amountRaw: "100", describe: "refunded",
    event: "refund", fields: { paymentId: "old-payment" }, tries: 99, journaled: true, prepared: null, nextAttemptAt: 1_030_000 }] }));
  let t = 1_000_000, attempts = 0;
  const chain = fakeChain(), registry = fakeRegistry();
  chain.ops.transfer = async () => { attempts++; throw Error("RPC unavailable"); };
  const gate = makeGate(chain, { registry, stateFile, now: () => t, pollMs: 5 });
  const wrapped = gate.wrapRegistry(registry);
  const p = argOf(await wrapped.callTool({ name: "poster", arguments: { Text: "wake" } }));
  t += 60_000; await gate.waitForPayment(p.paymentId, 20);
  const held = await untilState(stateFile, "the exhausted debt to be retained", s => s.owed[0]?.held === true);
  assert.equal(held.owed[0].tries, 100);
  assert.equal(gate.fundingLiabilitiesRaw(), 100n);
  await gate.stop();
  const restarted = makeGate(chain, { registry, stateFile, now: () => t, pollMs: 5 });
  const next = argOf(await restarted.wrapRegistry(registry).callTool({ name: "poster", arguments: { Text: "another" } }));
  t += 100_000; await restarted.waitForPayment(next.paymentId, 20);
  assert.equal(restarted.fundingLiabilitiesRaw(), 100n);
  assert.equal(attempts, 1);
  await restarted.stop();
});

test("failed Nano settlement retries persist the debt age and attempt count across restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "gate-debt-watch-"));
  const stateFile = join(dir, "state.json"), chain = fakeChain();
  const restoredAt = 1_000_000;
  let now = restoredAt;
  let gate;
  t.after(async () => {
    await gate?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(stateFile, JSON.stringify({ v: 2, quotes: [], owed: [{ to: PAYER, amountRaw: "100", describe: "refunded",
    event: "refund", fields: { paymentId: "retained-debt" }, tries: 0,
    journaled: true, prepared: null, nextAttemptAt: restoredAt + 30_000 }] }));
  chain.ops.transfer = async () => { throw Error("RPC unavailable"); };
  const start = () => makeGate(chain, { stateFile, now: () => now, pollMs: 5 });
  gate = start();
  now += 31_000;
  const first = await untilState(stateFile, "the failed retry to reach disk", s => s.owed[0]?.tries === 1);
  assert.equal(first.owed[0].createdAt, restoredAt);
  await gate.stop();
  now += 180_000;
  gate = start();
  now += 31_000;
  const second = await untilState(stateFile, "the next retry to reach disk", s => s.owed[0]?.tries === 2);
  assert.equal(second.owed[0].createdAt, restoredAt);
  assert.equal(gate.fundingLiabilitiesRaw(), 100n);
  assert.equal(chain.state.transfers.length, 0);
});

test("a Nano refund at the retry limit remains queued after a standby quota deferral", async t => {
  const dir = await mkdtemp(join(tmpdir(), "gate-standby-debt-")), file = join(dir, "gate-state.json");
  const chain = fakeChain(), gates = [];
  t.after(async () => { for (const gate of gates) await gate.stop(); await rm(dir, { recursive: true }); });
  let now = 1_000_000, quotaAvailable = false, attempts = 0;
  const signed = { hash: "A".repeat(64), block: { account: GATE_ADDR, link_as_account: PAYER } };
  await writeFile(file, JSON.stringify({ v: 2, quotes: [], owed: [{ event: "refund", to: PAYER, amountRaw: "100",
    fields: { paymentId: "awaiting-quota" }, journaled: true, prepared: signed, tries: 99,
    createdAt: now - 900_001, nextAttemptAt: now }] }));
  chain.ops.transferOnce = async (_to, _raw, { prepared }) => {
    attempts++;
    assert.deepEqual(prepared, signed);
    if (!quotaAvailable) throw Object.assign(Error("fixture standby budget exhausted"), { code: "NANO_RPC_STANDBY_BUDGET" });
    return prepared.hash;
  };
  const start = () => {
    const gate = makeGate(chain, { stateFile: file, now: () => now, pollMs: 5 });
    gates.push(gate);
    return gate;
  };
  const gate = start();
  const deferred = await untilState(file, "the deferred refund to reach disk", state => state.owed[0]?.nextAttemptAt === now + 60_000);
  assert.equal(deferred.owed[0].tries, 99);
  assert.notEqual(deferred.owed[0].held, true);
  assert.equal(gate.fundingLiabilitiesRaw(), 100n);
  await gate.stop();
  now += 60_000;
  quotaAvailable = true;
  start();
  await untilState(file, "the original refund to settle", state => state.owed.length === 0);
  assert.equal(attempts, 2);
});

test("Nano refuses a quote when its required funding does not fit the shared pool", async t => {
  const chain = fakeChain(), registry = fakeRegistry(), events = [];
  const expected = 5n * 10n ** 28n;
  let funds = expected - 1n;
  const gate = makeGate(chain, { registry,
    canFundQuote: required => { assert.equal(required, expected); return required <= funds; },
    fundRun: () => assert.fail("A quote must not reserve or run"),
    usage: event => events.push(event),
  });
  t.after(() => gate.stop());
  const { callTool } = gate.wrapRegistry(registry);
  const request = { name: "poster", arguments: { Text: "test" } };
  const refused = await callTool(request);
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent?.x402, undefined);
  assert.deepEqual(events, []);
  funds++;
  assert.ok(argOf(await callTool(request)).paymentId);
  assert.deepEqual(events, ["quote"]);
  assert.equal(registry.callCount(), 0);
  assert.deepEqual(chain.state.transfers, []);
});

test("Nano funding handoff uses the paid quote's locked pair and refuses before inference", async () => {
  for (const allowed of [true, false]) {
    const chain = fakeChain(), policies = [];
    const pool = createRunFunding({ serial: fn => fn(), balance: async () => allowed ? 10n ** 30n : 0n });
    const registry = fakeRegistry({ onCall: async () => {
      assert.equal(pool.snapshot().activeRuns, 1);
      return { content: [{ type: "text", text: "done" }], costUsd: 0.01 };
    } });
    const gate = makeGate(chain, { registry, fundRun: (terms, execute) => { policies.push(terms); return pool.run(terms, execute); } });
    const { callTool } = gate.wrapRegistry(registry);
    const p = argOf(await callTool({ name: "poster", arguments: { Text: "funded" } }));
    chain.state.receivable["C".repeat(64)] = { amount: p.amountRaw, source: PAYER };
    const result = await callTool({ name: "poster", arguments: { Text: "funded", _payment_id: p.paymentId } });
    assert.equal(policies[0].id, `nano:${p.paymentId}`);
    assert.equal(policies[0].maxRaw, 5n * 10n ** 28n, "the $0.05/$1 pair excludes identifying dust");
    assert.equal(registry.callCount(), allowed ? 1 : 0);
    assert.equal(pool.snapshot().activeRuns, 0);
    if (!allowed) {
      assert.equal(result.isError, true);
      assert.equal(chain.state.transfers[0].amountRaw, p.amountRaw);
    }
  }
});

test("Nano refunds an underfunded saved workflow before its first provider call", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nano-saved-budget-"));
  const catalogs = structuredClone(WORKED_CATALOGS);
  const models = nanoGptMock({ catalogs });
  await models.listen();
  t.after(async () => {
    await models.close();
    await rm(dir, { recursive: true, force: true });
  });
  // The first deposit covers chat but would fail at the following image invoice.
  // The second covers the estimate only before reserving the creator's share.
  await writeFile(join(dir, "poster.json"), JSON.stringify({ ...WORKED_GRAPH, x402: { usd: 0.005 } }));
  await writeFile(join(dir, "authored.json"), JSON.stringify({ ...WORKED_GRAPH, x402: { usd: 0.01, author: PAYER } }));
  await writeFile(join(dir, "drifted.json"), JSON.stringify({ ...WORKED_GRAPH, x402: { usd: 0.5 } }));
  await writeFile(join(dir, "offline.json"), JSON.stringify({ ...WORKED_GRAPH, x402: { usd: 0.5 } }));
  await writeFile(join(dir, "live-price.json"), JSON.stringify({ ...WORKED_GRAPH, x402: { usd: 0.005 } }));
  const registry = await loadTools({ dirs: [dir], apiKey: "fixture-key", baseUrl: models.url, outDir: dir });
  const chain = fakeChain();
  const gate = makeGate(chain, { registry, fundRun: (_terms, run) => run() });
  t.after(() => gate.stop());
  const { callTool } = gate.wrapRegistry(registry);
  const args = { Idea: "a lighthouse at dawn" };
  for (const [name, hash] of [["poster", "C"], ["authored", "D"], ["drifted", "E"], ["live-price", "7"], ["offline", "F"]]) {
    const quote = argOf(await callTool({ name, arguments: args }));
    if (name === "drifted") catalogs.image[0].pricing.per_image["1024x1024"] = 1;
    if (name === "live-price") {
      catalogs.image[0].pricing.per_image["1024x1024"] = 0.001;
      catalogs.image[0].pricing.note = "Exact price set by live quote";
    }
    if (name === "offline") catalogs.image = [];
    chain.state.receivable[hash.repeat(64)] = { amount: quote.amountRaw, source: PAYER };
    const result = await callTool({ name, arguments: { ...args, _payment_id: quote.paymentId } });
    assert.equal(models.runs(), 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, ["live-price", "offline"].includes(name)
      ? /current model catalogs could not verify this quote's budget/
      : /current model estimate exceeds this quote's budget/);
    assert.equal(chain.state.transfers.at(-1).amountRaw, quote.amountRaw);
  }
});

/**
 * Wait for a CONDITION, never for the clock.
 *
 * The gate persists on a debounced promise chain (mkdir → write → rename) and its
 * owed-queue watchers run on timers. "Sleep 50ms, then look" is therefore a race,
 * and it is a race this suite loses on a busy machine: 9 of 40 full-suite runs
 * failed here with every core loaded, always on a persist or a watcher tick.
 * .github/workflows/test.yml now runs this suite on a shared CI runner, where busy
 * is the normal condition, so an intermittent red would land on whoever pushed
 * next. Polling costs a passing run nothing and makes a slow machine wait instead
 * of fail.
 *
 * Only POSITIVE waits move here. A negative assertion ("no change was sent") can
 * never be established by waiting longer, so those keep their fixed pause.
 */
async function until(what, fn, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait until the gate's state file parses and satisfies `pred`. Returns the parsed state. */
async function untilState(stateFile, what, pred) {
  const { readFile } = await import("node:fs/promises");
  return until(what, async () => {
    const data = JSON.parse(await readFile(stateFile, "utf8"));
    return pred(data) ? data : false;
  });
}

/** The quote `id` as the state file currently holds it, or false. */
const quoteIn = (id) => (data) => (data.quotes || []).find((q) => q.id === id) || false;

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
  // three sequential phases — never hold tools/call through payment
  assert.equal(x.blocking, false, "results tools/call must not block on payment — watch does that");
  assert.deepEqual(x.phases, ["pay", "watch", "results"]);
  assert.equal(x.watchUrl, `http://pay.test/x402/watch/${x.paymentId}`, "agent gets watchUrl for phase 2");
  assert.match(x.next, /IMMEDIATELY open/i, "next tells the agent to open the watch URL on the payment link");
  assert.match(x.next, new RegExp(x.watchUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "next carries the concrete watch URL");
  assert.match(x.next, /_payment_id/, "phase 3 is tools/call + _payment_id");
  assert.match(x.next, new RegExp(x.paymentId), "the next imperative carries this payment id");
  // human-facing text names the watch URL with an agent-only / never-show guard
  assert.match(quoteRes.content[0].text, /IMMEDIATELY open and watch/i);
  assert.match(quoteRes.content[0].text, new RegExp(x.watchUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(quoteRes.content[0].text, /NEVER show this URL to the user/i);
  // $0.05 at $1/XNO ≈ 0.05 XNO plus a sub-cent tag, in whole 1e-8 XNO steps
  assert.ok(BigInt(x.amountRaw) >= 5n * 10n ** 28n && BigInt(x.amountRaw) < 5n * 10n ** 28n + 10n ** 26n);
  assert.equal(BigInt(x.amountRaw) % GRAIN, 0n, "amount must be exactly typeable at 8 decimals");

  // unpaid re-call with the id: hang up with watch instructions — do not hold the results stream
  const pending = await callTool({ name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId } });
  assert.ok(pending.isError);
  assert.match(pending.content[0].text, /hasn't arrived/);
  assert.match(pending.content[0].text, /x402\/watch/, "points the agent at the watch SSE");
  assert.match(pending.content[0].text, /RESULTS stream/i);
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

/**
 * A caller awaiting payment must always get an answer.
 *
 * waitForPayment() used to unref() the bounded timeout it resolves on, so the
 * returned promise only ever settled if some UNRELATED handle happened to keep
 * the event loop alive. Take that handle away and node drains the loop with the
 * call still inside `await`: no timeout, no poll, no answer, ever.
 *
 * The bug hid behind whatever else was running. It never showed in-process here,
 * because the suite around it always had a handle open — but on node 20 it took
 * this whole file down (every test after the first: "Promise resolution is still
 * pending but the event loop has already resolved"). So the guard has to be a
 * child process that owns nothing else: no server, no listener, no other timer.
 * If the money path can only answer when something else is holding the loop, this
 * child hangs and exits non-zero.
 */
test("a call awaiting payment answers even when nothing else keeps the loop alive", async () => {
  const gateUrl = new URL("../src/gate.mjs", import.meta.url).href;
  const child = `
import { createChargeGate } from ${JSON.stringify(gateUrl)};
const chain = { receivable: {}, transfers: [] };
const ops = {
  rpc: async (b) => b.action === "receivable"
    ? { blocks: { ...chain.receivable } }
    : { history: [] },
  transfer: async (to, amountRaw, describe) => { chain.transfers.push(describe); return "F".repeat(64); },
};
let calls = 0;
const registry = {
  tools: [{ name: "poster", x402: null, description: "Make a poster." }],
  listTools: () => [{ name: "poster", description: "d", inputSchema: { type: "object", properties: { Text: { type: "string" } } } }],
  prepareCall: async () => ({}),
  callTool: async () => { calls++; return { content: [{ type: "text", text: "ran" }] }; },
};
const gate = createChargeGate({
  address: ${JSON.stringify(GATE_ADDR)}, ops, usd: 0.05, xnoUsd: 1,
  validate: (p) => registry.prepareCall(p),
  publicBase: "http://pay.test", pollMs: 10, waitMs: 200,
});
const { callTool } = gate.wrapRegistry(registry);
const args = { Text: "a lighthouse" };
const x = (await callTool({ name: "poster", arguments: args })).structuredContent.x402;

// 1. Unpaid. The wait must time out and ANSWER — this is where it used to hang.
const pending = await callTool({ name: "poster", arguments: { ...args, _payment_id: x.paymentId } });
if (!pending.isError) throw new Error("unpaid call should be an error");
console.log("UNPAID_ANSWERED");

// 2. The money lands. The poll must still find it with nothing else ref'd.
chain.receivable["A".repeat(64)] = { amount: x.amountRaw, source: ${JSON.stringify(PAYER)} };
const paid = await callTool({ name: "poster", arguments: { ...args, _payment_id: x.paymentId } });
if (paid.isError) throw new Error("paid call failed: " + JSON.stringify(paid.content));
if (calls !== 1) throw new Error("expected exactly one run, got " + calls);
console.log("PAID_AND_RAN");
`;
  const dir = await mkdtemp(join(tmpdir(), "gate-liveness-"));
  const file = join(dir, "liveness.mjs");
  await writeFile(file, child, "utf8");

  let out = "", err = "", code;
  try {
    const proc = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    code = await new Promise((res, rej) => {
      // Generous: the child's own waits total well under a second. A timeout here
      // means it wedged, which is the very failure this test exists to catch.
      const kill = setTimeout(() => { proc.kill("SIGKILL"); }, 30_000);
      proc.on("error", (e) => { clearTimeout(kill); rej(e); });
      proc.on("close", (c) => { clearTimeout(kill); res(c); });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  assert.match(out, /UNPAID_ANSWERED/,
    `a tools/call awaiting payment never answered — it hung until the event loop drained.\nstdout: ${out}\nstderr: ${err}`);
  assert.match(out, /PAID_AND_RAN/,
    `payment on chain was never detected while the caller waited.\nstdout: ${out}\nstderr: ${err}`);
  assert.equal(code, 0, `child exited ${code}\nstdout: ${out}\nstderr: ${err}`);
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

test("a graph pin of 1e-3 or .001 is the quote, and a failed run refunds that amount", async () => {
  for (const usd of ["1e-3", ".001", "0.001", 0.001]) {
    const chain = fakeChain();
    const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
    registry.tools[0].x402 = { usd };
    const { listTools, callTool } = makeGate(chain, { registry, usd: 0.05 }).wrapRegistry(registry);
    assert.match(listTools()[0].description, /\$0\.001 deposit per call/, `${JSON.stringify(usd)} fell through to the opening deposit`);
    const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
    assert.equal(x.amountUsd, 0.001);
    chain.state.receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /refunded to/);
    await until("the refund send to reach the chain", () => chain.state.transfers.length);
    assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
  }
});

test("settlement reads a string cost of 1e-7 or .001 and returns only the remainder", async () => {
  for (const costUsd of ["1e-7", ".001"]) {
    const chain = fakeChain();
    const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd }) });
    const { callTool } = makeGate(chain, { registry, usd: 0.05 }).wrapRegistry(registry);
    const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
    chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    await until("change to be sent", () => chain.state.transfers.some((t) => t.describe === "change:"));
    const change = chain.state.transfers.find((t) => t.describe === "change:");
    const deposit = BigInt(x.amountRaw);
    const costRaw = costUsd === "1e-7" ? 10n ** 23n : 10n ** 27n;
    const markup = costRaw / 5n;
    assert.equal(BigInt(change.amountRaw), deposit - costRaw - markup, `${costUsd} was not settled as that cost`);
    assert.notEqual(BigInt(change.amountRaw), deposit, `${costUsd} was treated as an unknown cost and the whole deposit came back`);
    assert.match(res.content.at(-1).text, /settled at actual cost/);
  }
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

test("unknown tool on the paid server lists only tools that can be called", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  // The real prepareCall always appends run_noodle. Charge mode must not repeat it:
  // tools/list hides it, and calling it is refused.
  registry.prepareCall = async (params) => {
    if (params.name !== "poster") {
      const e = new Error(`unknown tool "${params.name}" — available: poster, run_noodle`);
      e.mcpCode = -32602;
      throw e;
    }
  };
  const { callTool, listTools } = makeGate(chain, { registry }).wrapRegistry(registry);
  assert.deepEqual(listTools().map((t) => t.name), ["poster"]);
  await assert.rejects(
    () => callTool({ name: "nope", arguments: {} }),
    (err) => {
      assert.equal(err.mcpCode, -32602);
      assert.match(err.message, /^unknown tool "nope" — available: poster$/);
      assert.doesNotMatch(err.message, /run_noodle/);
      return true;
    },
  );
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
  await until("the refund send to reach the chain", () => chain.state.transfers.length);
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
  assert.match(res.content[0].text, /refund is pending/);
  assert.match(res.content[0].text, /Provider costs already incurred by the service remain separate/);
  assert.doesNotMatch(res.content[0].text, /you were not charged|you won't be charged/);
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

test("settle: a lower-bound cost (costExact false) is labelled an estimate and lower bound, never the actual cost", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.02, costExact: false }) });
  const { callTool } = makeGate(chain, { registry }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["F".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError);
  assert.ok(!("costUsd" in res) && !("costExact" in res), "sidecars stripped");
  assert.match(res.content.at(-1).text, /settled at estimated cost \$0\.0200 \(a lower bound: some calls did not report a price\) \+ 20%/);
  assert.doesNotMatch(res.content.at(-1).text, /actual cost/);
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
  assert.match(res.content.at(-1).text, /settled at actual cost \$0\.0200 \+ 20%/);
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

test("receipt settled cost uses the cost line's precision, not cent rounding", async () => {
  // Live mismatch: cost line $0.0201 / $0.0656, receipt $0.02 / $0.07.
  assert.equal(formatCostUsd(0.0201), "0.0201");
  assert.equal(formatCostUsd(0.0656), "0.0656");
  assert.equal(formatCostUsd(0.02), "0.0200");
  assert.equal(formatCostUsd(0.000002), "0.000002");
  assert.equal(formatCostUsd("1e-7"), "0.0000001");
  assert.equal(formatCostUsd(".001"), "0.0010");
  for (const cost of [0.0201, 0.0656]) {
    const chain = fakeChain();
    const figure = formatCostUsd(cost);
    const registry = fakeRegistry({
      onCall: async () => ({
        content: [{ type: "text", text: "ran" }, { type: "text", text: `cost: $${figure}` }],
        costUsd: cost,
      }),
    });
    const { callTool } = makeGate(chain, { registry, usd: 0.2 }).wrapRegistry(registry);
    const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
    chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
    assert.ok(!res.isError, JSON.stringify(res.content));
    assert.equal(res.content.find((c) => c.text.startsWith("cost:")).text, `cost: $${figure}`);
    assert.match(res.content.at(-1).text, new RegExp(`settled at actual cost \\$${figure.replace(".", "\\.")} \\+ 20%`));
  }
});

test("rawToXno at 8 decimals truncates; 30 decimals is the exact raw", () => {
  // 0.0747258679 XNO — the live receipt showed 0.07472586.
  const raw = 747258679n * 10n ** 20n;
  assert.equal(rawToXno(raw), "0.07472586");
  assert.equal(rawToXno(raw, 30), "0.0747258679");
});

test("receipt change is the exact on-chain raw, not an 8-decimal truncation", async () => {
  const chain = fakeChain();
  // $1/XNO keeps change on the 8-decimal grid. A non-integer rate does not.
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.0201 }) });
  const { callTool } = makeGate(chain, { registry, xnoUsd: 0.87 }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  await new Promise((r) => setTimeout(r, 50));
  const change = chain.state.transfers.find((tr) => tr.describe === "change:");
  assert.ok(change, "expected a change send");
  const exact = rawToXno(change.amountRaw, 30);
  const truncated = rawToXno(change.amountRaw);
  assert.notEqual(exact, truncated, "fixture must carry digits past 8 decimals");
  const text = res.content.at(-1).text;
  assert.match(text, new RegExp(`; ${exact.replace(/\./g, "\\.")} XNO change returned`));
  assert.doesNotMatch(text, new RegExp(`; ${truncated.replace(/\./g, "\\.")} XNO change returned`));
});

test("parseUsdNano is string-exact, handles exponents, truncates below 1e-9 USD", () => {
  assert.equal(parseUsdNano("0.092933082"), 92933082n);
  assert.equal(parseUsdNano("0.05"), 50000000n);
  assert.equal(parseUsdNano(0.05), 50000000n);
  assert.equal(parseUsdNano("12"), 12000000000n);
  assert.equal(parseUsdNano(1e-7), 100n);
  assert.equal(parseUsdNano("2.5e-3"), 2500000n);
  assert.equal(parseUsdNano("1e-3"), 1000000n);
  assert.equal(parseUsdNano(".001"), parseUsdNano("0.001"));
  assert.equal(parseUsdNano(".001"), 1000000n);
  assert.equal(parseUsdNano("+.5"), 500000000n);
  assert.equal(parseUsdNano("1."), parseUsdNano(1));
  assert.throws(() => parseUsdNano("-.5"));
  assert.equal(parseUsdNano("0.0000000001"), 0n); // 1e-10 USD truncates
  // A negative slice end used to wrap back through the significand and turn
  // a sub-nanodollar scientific price into a material customer charge.
  assert.equal(parseUsdNano("1234567890e-20"), 0n);
  assert.equal(parseUsdNano(1.23456789e-11), 0n);
  assert.equal(parseUsdNano("1.234567890123456789e-20"), 0n);
  assert.equal(parseUsdNano("0.0000000001", { roundUp: true }), 1n);
  assert.equal(parseUsdNano("0", { roundUp: true }), 0n);
  assert.equal(parseUsdNano("1.0000000001", { roundUp: true }), 1_000_000_001n);
  assert.throws(() => parseUsdNano("-1"));
  assert.throws(() => parseUsdNano("abc"));
  assert.throws(() => parseUsdNano(""));
  assert.throws(() => parseUsdNano("   "));
  assert.throws(() => parseUsdNano(false));
  assert.throws(() => parseUsdNano([]));
  assert.throws(() => parseUsdNano(null));
  assert.equal(parseUsdNano(0), 0n);
  assert.equal(parseUsdNano("0"), 0n);
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

test("guarded Nano quotes share a read-only proof and stay unpublished until both reads recover", async t => {
  const chain = fakeChain(), registry = fakeRegistry();
  const dir = await mkdtemp(join(tmpdir(), "nano-quote-readiness-")), file = join(dir, "gate-state.json");
  const head = "A".repeat(64), attempts = [], usage = [];
  let monotonic = 0, historyReady = false, fundingReady = true, pauseFunding = false;
  chain.ops.checkpoint = () => ({ confirmed: { hash: head, blockCount: "1" } });
  chain.ops.rpc = async body => {
    attempts.push(body.action);
    assert.equal(body.account, GATE_ADDR);
    if (body.action === "receivable") {
      assert.equal(body.include_only_confirmed, "true");
      return { blocks: "" };
    }
    assert.equal(body.action, "account_history");
    assert.equal(body.head, head);
    assert.equal(body.raw, "true");
    if (!historyReady) return { account: GATE_ADDR, history: [] };
    if (pauseFunding) fundingReady = false;
    return { account: GATE_ADDR, history: [{ hash: head, type: "open", height: "1", confirmed: true, account: PAYER, amount: "1" }] };
  };
  const gate = makeGate(chain, { registry, stateFile: file, pollMs: 60_000, verifyPaymentReads: true, canQuote: () => fundingReady,
    monotonicNow: () => monotonic, usage: event => usage.push(event) });
  t.after(async () => { await gate.stop(); await rm(dir, { recursive: true }); });
  const { callTool } = gate.wrapRegistry(registry);
  const request = () => callTool({ name: "poster", arguments: { Text: "payment reads" } });
  for (const result of await Promise.all([request(), request(), request()])) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /payment detection is temporarily unavailable/i);
    assert.equal(result.structuredContent?.x402, undefined);
  }
  assert.deepEqual(attempts, ["receivable", "account_history"]);
  assert.equal((await request()).isError, true);
  assert.equal(attempts.length, 2, "rapid retries do not repeat failed RPC reads");
  assert.deepEqual(usage, []);
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  assert.equal(registry.callCount(), 0);
  assert.equal(chain.state.transfers.length, 0);

  monotonic += 5_000;
  historyReady = true;
  pauseFunding = true;
  const fundingRefusal = await request();
  assert.equal(fundingRefusal.isError, true);
  assert.match(fundingRefusal.content[0].text, /funding is temporarily unavailable/i);
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  pauseFunding = false;
  fundingReady = true;
  const quote = argOf(await request());
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.quotes.find(row => row.id === quote.paymentId)?.historyAfter, "1");
  assert.equal(usage[0], "quote");
});

test("a failed Nano watcher read invalidates quote readiness while issued payments still resolve", async t => {
  const chain = fakeChain(), registry = fakeRegistry();
  const head = "A".repeat(64);
  const existingPaymentReads = [];
  let historyReady = true, failed = false, fallbackReads = 0;
  chain.ops.checkpoint = () => ({ confirmed: { hash: head, blockCount: "1" } });
  const rpc = chain.ops.rpc;
  chain.ops.readPaymentWindow = async ({ existingPayments }) => {
    existingPaymentReads.push(existingPayments);
    if (!historyReady) throw Object.assign(new Error("test combined budget exhausted"), { code: "NANO_RPC_STANDBY_BUDGET" });
    return { receivable: await rpc({ action: "receivable", count: "500" }), history: {
      account: GATE_ADDR, previous: null, history: [{ hash: head, type: "open", height: "1", confirmed: true, account: PAYER, amount: "1" }],
    } };
  };
  chain.ops.rpc = body => {
    assert.equal(historyReady, false, "a verified combined window needs no further RPC");
    if (body.action === "receivable") {
      fallbackReads++;
      return rpc(body);
    }
    assert.equal(body.action, "account_history");
    throw new Error("test history unavailable");
  };
  const gate = createChargeGate({ address: GATE_ADDR, ops: chain.ops, usd: 0.05, xnoUsd: 1, publicBase: "http://pay.test",
    pollMs: 5, verifyPaymentReads: true, log: line => { if (line.includes("payment scan failed")) failed = true; } });
  t.after(() => gate.stop());
  const { callTool } = gate.wrapRegistry(registry);
  const request = text => callTool({ name: "poster", arguments: { Text: text } });
  const original = argOf(await request("issued before the outage"));
  assert.equal(existingPaymentReads[0], false);
  historyReady = false;
  await until("the watcher to report its broken history RPC", () => failed);
  assert.equal((await request("new customer")).isError, true, "a watcher failure supersedes a fresh positive quote probe");
  assert.equal(gate.quote(original.paymentId).status, "pending");

  chain.state.receivable["D".repeat(64)] = { amount: original.amountRaw, source: PAYER };
  assert.equal(await gate.waitForPayment(original.paymentId, 1_000), "paid");
  assert.ok(existingPaymentReads.includes(true), "only the watcher requests priority");
  assert.ok(fallbackReads > 0, "the watcher still looks for receivables for existing quotes");
});

test("anchored history does not advance past a truncated page and then finds the pocketed payment", async t => {
  const chain = fakeChain(), registry = fakeRegistry();
  const dir = await mkdtemp(join(tmpdir(), "nano-anchored-history-")), file = join(dir, "gate-state.json");
  const open = { hash: "A".repeat(64), type: "open", height: "1", confirmed: "true", account: PAYER, amount: "1" };
  const change = { hash: "C".repeat(64), type: "state", subtype: "change", height: "3", confirmed: "true", previous: "D".repeat(64) };
  let anchor = open, paid = null, truncate = true, malformedReads = 0;
  chain.ops.checkpoint = () => ({ confirmed: { hash: anchor.hash, blockCount: anchor.height } });
  const rpc = chain.ops.rpc;
  chain.ops.rpc = body => {
    if (body.action !== "account_history") return rpc(body);
    assert.equal(body.raw, "true");
    const start = { account: body.account };
    if (body.head === open.hash) return { ...start, history: [open] };
    assert.equal(body.head, change.hash);
    if (truncate) { malformedReads++; return { ...start, history: [change, paid] }; }
    return { ...start, history: [change, paid, open] };
  };
  const gate = makeGate(chain, { registry, stateFile: file, pollMs: 5, now: () => 8_000_000 });
  t.after(async () => { await gate.stop(); await rm(dir, { recursive: true }); });
  const { callTool } = gate.wrapRegistry(registry);
  const quote = argOf(await callTool({ name: "poster", arguments: { Text: "raw history" } }));
  const first = await untilState(file, "opening checkpoint", state => state.historyScan?.through === open.hash);
  paid = { hash: change.previous, type: "state", subtype: "receive", height: "2", confirmed: "true",
    previous: open.hash, account: PAYER, amount: quote.amountRaw, local_timestamp: "8000" };
  anchor = change;
  await until("truncated history attempts", () => malformedReads >= 2);
  const waiting = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(waiting.historyScan, first.historyScan);
  assert.equal(gate.quote(quote.paymentId).status, "pending");
  truncate = false;
  assert.equal(await gate.waitForPayment(quote.paymentId, 2000), "paid");
  const saved = await untilState(file, "rollback-compatible history checkpoint", state => state.historyScan?.through === paid.hash);
  assert.equal(saved.quotes.find(value => value.id === quote.paymentId).payHash, paid.hash);
});

/*
 * Burst regression: pre-fix, `receivable` was polled with count 50 and history
 * with a fixed 25-entry window every 5th tick, so a burst of simultaneous
 * payments hard-capped at ~70 settled — everything past that was pocketed by
 * housekeeping, scrolled out of the history window, and silently stranded
 * (paid, never run, never refunded). These tests run against a fake node that
 * honors the RPC count params, which is what exposed the caps.
 */
const testHash = (i) => (i + 1).toString(16).padStart(64, "0").toUpperCase();

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

test("Nano history resumes beyond the page cap after a restart and still discovers new deposits", { timeout: 8_000 }, async t => {
  const chain = fakeChain(), registry = fakeRegistry(), dir = await mkdtemp(join(tmpdir(), "nano-history-cursor-"));
  const file = join(dir, "gate-state.json"), instances = [];
  const start = () => {
    const gate = makeGate(chain, { registry, stateFile: file, now: () => 8_000_000, pollMs: 700 });
    instances.push(gate);
    return gate;
  };
  t.after(async () => { for (const gate of instances) await gate.stop(); await rm(dir, { recursive: true, force: true }); });
  const original = start(), { callTool } = original.wrapRegistry(registry);
  const quoted = async Text => argOf(await callTool({ name: "poster", arguments: { Text } }));
  const old = await quoted("older pocketed transfer"), recent = await quoted("a later pocketed transfer");
  await original.stop();
  const deepHash = testHash(1), freshHash = testHash(1500);
  const fillers = Array.from({ length: 1200 }, (_, i) => ({ type: "send", account: PAYER, amount: "1", hash: testHash(1300 - i) }));
  chain.state.history.push(...fillers, { type: "receive", account: PAYER, amount: old.amountRaw, hash: deepHash });
  const heads = [], rpc = chain.ops.rpc;
  chain.ops.rpc = params => { if (params.action === "account_history") heads.push(params.head ?? null); return rpc(params); };
  const firstRecovery = start();
  const saved = await untilState(file, "the bounded history continuation", s => s.historyScan?.backfill?.next);
  assert.equal(saved.historyScan.through, null);
  assert.equal(saved.historyScan.backfill.next, fillers[1000].hash);
  assert.equal(heads.length, 10);
  assert.equal(firstRecovery.quote(old.paymentId).status, "pending");
  await firstRecovery.stop();

  chain.state.history.unshift({ type: "receive", account: PAYER, amount: recent.amountRaw, hash: freshHash, confirmed: "true" });
  heads.length = 0;
  const recovered = start();
  const statuses = await Promise.all([recent, old].map(q => recovered.waitForPayment(q.paymentId, 2_000)));
  assert.deepEqual(statuses, ["paid", "paid"]);
  const through = await untilState(file, "the completed history checkpoint", s => s.historyScan?.through === fillers[0].hash);
  assert.equal(through.historyScan.backfill, null);
  assert.deepEqual(heads.slice(0, 2), [null, saved.historyScan.backfill.next]);
  assert.equal(quoteIn(old.paymentId)(through).payHash, deepHash);
  assert.equal(quoteIn(recent.paymentId)(through).payHash, freshHash);
  assert.equal(registry.callCount(), 0);
});

test("Nano standby quota saves the next history page and resumes it across restarts", { timeout: 8_000 }, async t => {
  const chain = fakeChain(), registry = fakeRegistry(), gates = [];
  const dir = await mkdtemp(join(tmpdir(), "nano-quota-cursor-")), file = join(dir, "gate-state.json");
  t.after(async () => { for (const gate of gates) await gate.stop(); await rm(dir, { recursive: true }); });
  const firstAt = 8_000_000;
  let now = firstAt, latest, mode = "opening";
  const block = (height, type, terms = {}) => ({ hash: testHash(height), height: String(height), type,
    confirmed: "true", previous: height === 1 ? "0".repeat(64) : testHash(height - 1), ...terms });
  const open = block(1, "open", { account: PAYER, amount: "1" });
  const page = (...history) => ({ account: GATE_ADDR,
    previous: history.at(-1).height === "1" ? null : history.at(-1).previous, history });
  const [middle, head] = [block(3, "send"), block(4, "send")];
  const lookups = [], refused = [], savedPages = new Map();
  latest = page(open);
  chain.ops.checkpoint = () => ({ confirmed: { hash: latest.history[0].hash, blockCount: latest.history[0].height } });
  const budgetError = () => Object.assign(Error("fixture standby window exhausted"), { code: "NANO_RPC_STANDBY_BUDGET" });
  chain.ops.readPaymentWindow = async ({ existingPayments, historyHead, historyHeight }) => {
    if (existingPayments) lookups.push(historyHead);
    if (mode === "refusing") throw budgetError();
    const history = historyHead === null ? latest : savedPages.get(historyHead);
    assert.ok(history, "the combined scan must request the saved continuation");
    assert.equal(historyHeight, historyHead === null ? null : history.history[0].height);
    return { receivable: { blocks: chain.state.receivable }, history };
  };
  chain.ops.rpc = async (body, _base, options) => {
    if (body.action === "receivable") return { blocks: chain.state.receivable };
    assert.equal(body.action, "account_history");
    assert.equal(options?.existingPaymentHistory, true);
    assert.ok(["limited", "refusing"].includes(mode));
    refused.push(body.head);
    throw budgetError();
  };
  const start = () => {
    const gate = makeGate(chain, { registry, stateFile: file, now: () => now, pollMs: 1_000, verifyPaymentReads: true });
    gates.push(gate);
    return gate;
  };
  const original = start(), { callTool } = original.wrapRegistry(registry);
  const quote = async Text => argOf(await callTool({ name: "poster", arguments: { Text } }));
  const old = await quote("pocketed before failover");
  const incoming = await quote("receivable during replay");
  const recent = await quote("pocketed during replay");
  const initial = await untilState(file, "the first completed history checkpoint", s => s.historyScan?.through === open.hash);
  await original.stop();

  now += 1_000;
  latest = page(head);
  mode = "limited";
  lookups.length = 0;
  const firstRecovery = start();
  const waiting = await untilState(file, "a quota-deferred continuation", s => s.historyScan?.backfill?.quotaDeferred);
  await firstRecovery.stop();
  assert.deepEqual(lookups, [null]);
  assert.equal(refused[0], middle.hash);
  assert.equal(waiting.historyScan.through, open.hash);
  assert.equal(waiting.historyScan.coveredAt, initial.historyScan.coveredAt);
  assert.deepEqual(waiting.historyScan.backfill, { newest: head.hash, next: middle.hash, startedAt: now,
    fullReceivableWindow: false, quotaDeferred: true, nextHeight: middle.height, advancedAt: now });

  now += 1_000;
  mode = "refusing";
  const noQuota = start();
  await until("another standby refusal on the same page", () => refused.length === 2);
  await noQuota.stop();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).historyScan, waiting.historyScan, "a refusal cannot renew progress");

  const paid = block(2, "receive", { account: PAYER, amount: old.amountRaw });
  const fresh = block(5, "receive", { account: PAYER, amount: recent.amountRaw });
  now += 60_000;
  latest = page(fresh, head);
  mode = "limited";
  savedPages.set(middle.hash, page(middle));
  savedPages.set(paid.hash, page(paid, open));
  const incomingHash = testHash(20);
  chain.state.receivable[incomingHash] = { source: PAYER, amount: incoming.amountRaw };
  lookups.length = 0;
  const secondRecovery = start();
  const advanced = await untilState(file, "the next saved page after another quota refusal", s => s.historyScan?.backfill?.next === paid.hash);
  await secondRecovery.stop();
  assert.deepEqual(lookups, [middle.hash]);
  assert.equal(refused[2], paid.hash);
  assert.equal(advanced.historyScan.backfill.nextHeight, paid.height);
  assert.equal(advanced.historyScan.backfill.advancedAt, now);
  assert.equal(advanced.historyScan.coveredAt, initial.historyScan.coveredAt);
  assert.equal(quoteIn(incoming.paymentId)(advanced).payHash, incomingHash);
  assert.equal(secondRecovery.quote(recent.paymentId).status, "pending");

  now += 60_000;
  lookups.length = 0;
  const lastRecovery = start();
  const completed = await untilState(file, "the resumed batch to reach the old checkpoint", s => s.historyScan?.through === head.hash);
  assert.equal(completed.historyScan.backfill, null);
  assert.equal(completed.historyScan.coveredAt, waiting.historyScan.backfill.startedAt);
  assert.equal(quoteIn(old.paymentId)(completed).payHash, paid.hash);
  assert.equal(await lastRecovery.waitForPayment(recent.paymentId, 2_500), "paid");
  assert.deepEqual(lookups.slice(0, 2), [paid.hash, null], "the normal latest scan resumes after the backfill");
  assert.equal(registry.callCount(), 0);
});

test("Nano history screens unconfirmed and pre-quote deposits before matching a confirmed receipt", async t => {
  const chain = fakeChain(), registry = fakeRegistry();
  let highest = { blockCount: "7", hash: testHash(7) };
  chain.ops.checkpoint = () => ({ confirmed: highest });
  const rpc = chain.ops.rpc;
  chain.ops.rpc = async body => {
    const result = await rpc(body);
    if (body.action !== "account_history") return result;
    return { ...result, account: body.account, previous: result.history.at(-1)?.previous };
  };
  const gate = makeGate(chain, { registry, now: () => 8_000_000, pollMs: 5 });
  t.after(() => gate.stop());
  const { callTool } = gate.wrapRegistry(registry);
  const p = argOf(await callTool({ name: "poster", arguments: { Text: "confirmed only" } }));
  const old = { type: "receive", account: PAYER, amount: p.amountRaw, hash: highest.hash, height: "7", previous: testHash(6), confirmed: "true" };
  const next = { ...old, hash: testHash(8), height: "8", previous: old.hash, confirmed: "false" };
  chain.state.history.push(next, old);
  highest = { blockCount: "8", hash: next.hash };
  assert.equal(await gate.waitForPayment(p.paymentId, 35), "pending");
  next.confirmed = "true";
  assert.equal(await gate.waitForPayment(p.paymentId, 1000), "paid");
});

test("an old unscanned Nano quote survives a long outage and refunds its discovered deposit", { timeout: 5_000 }, async t => {
  const chain = fakeChain(), registry = fakeRegistry(), dir = await mkdtemp(join(tmpdir(), "nano-history-expired-"));
  const file = join(dir, "gate-state.json"), instances = [];
  let now = 8_000_000;
  const start = () => {
    const gate = makeGate(chain, { registry, stateFile: file, now: () => now, pollMs: 5 });
    instances.push(gate);
    return gate;
  };
  t.after(async () => { for (const gate of instances) await gate.stop(); await rm(dir, { recursive: true, force: true }); });
  const first = start();
  const p = argOf(await first.wrapRegistry(registry).callTool({ name: "poster", arguments: { Text: "before the outage" } }));
  await first.stop();
  now += 25 * 60 * 60_000;
  chain.state.history.push({ type: "receive", account: PAYER, amount: p.amountRaw, hash: testHash(57),
    local_timestamp: String(Math.floor(now / 1000)), confirmed: "true" });
  const startAfterDisruption = start();
  await until("the restarted watcher to refund an expired pocketed deposit", () => startAfterDisruption.quote(p.paymentId)?.status === "refunded", 2_000);
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: p.amountRaw, describe: "refunded" }]);
  assert.equal(registry.callCount(), 0);
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
  assert.match(quote.content[0].text, /typically ~15s/);
  // $0.03 observed → deposit ceil(0.03 × 1.2 × 2) = $0.08 (tracks cost, no longer capped at the opening deposit)
  assert.match(quote.content[0].text, /send exactly 0\.08\d* XNO/);
});

test("gate state survives a restart: pending quote pays and settles under the reloaded gate", async t => {
  const dir = await mkdtemp(join(tmpdir(), "gate-state-"));
  const stateFile = join(dir, "gate-state.json");
  let original, restored, server;
  t.after(async () => {
    if (server) {
      server.close();
      server.closeAllConnections();
    }
    await restored?.stop();
    await original?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const chain1 = fakeChain();
  const registry1 = fakeRegistry();
  original = makeGate(chain1, { registry: registry1, stateFile });
  const gate1 = original.wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  await untilState(stateFile, "the quote to reach the state file", quoteIn(x.paymentId));
  await original.stop();

  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "ran" }], costUsd: 0.02 }) });
  restored = makeGate(chain2, { registry: registry2, stateFile });
  const { callTool, listTools } = restored.wrapRegistry(registry2);
  server = await serveHttp({ host: "127.0.0.1", port: 0, name: "t", version: "0", listTools, callTool,
    gate: restored, publicBase: "http://pay.test", log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const watch = await fetch(`${base}/x402/watch/${x.paymentId}`, {
    headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(watch.status, 200);
  assert.match(watch.headers.get("content-type"), /^text\/event-stream/);
  const frames = [], paymentHash = "A".repeat(64);
  await readSse(watch, ({ event, data }) => {
    if (event !== "status") return;
    frames.push(data);
    if (frames.length === 1) {
      assert.equal(data.status, "pending");
      assert.equal(data.done, undefined);
      chain2.state.receivable[paymentHash] = { amount: x.amountRaw, source: PAYER };
    }
  });
  const paid = frames.at(-1);
  assert.equal(paid?.status, "paid");
  assert.equal(paid.done, true);
  assert.ok(paid.next.includes(x.paymentId));
  const committed = quoteIn(x.paymentId)(JSON.parse(await readFile(stateFile, "utf8")));
  assert.equal(committed.status, "paid");
  assert.equal(committed.payHash, paymentHash);
  assert.equal(registry2.callCount(), 0);

  const run = async () => {
    const reply = await fetch(`${base}/mcp`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } } }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(reply.status, 200);
    return (await reply.json()).result;
  };
  const result = await run();
  assert.ok(!result.isError, JSON.stringify(result.content));
  const replay = await run();
  assert.ok(!replay.isError);
  assert.equal(replay.content[0].text, result.content[0].text);
  assert.equal(registry2.callCount(), 1);
  const saved = await untilState(stateFile, "the settled run and its recorded change",
    state => { const q = quoteIn(x.paymentId)(state); return q?.settled && q.transferReceipts?.change; });
  assert.equal(chain2.state.transfers.length, 1);
  const [change] = chain2.state.transfers;
  assert.equal(change.describe, "change:");
  assert.equal(BigInt(x.amountRaw) - 24n * 10n ** 27n, BigInt(change.amountRaw));
  const receipt = quoteIn(x.paymentId)(saved).transferReceipts.change;
  assert.equal(receipt.amountRaw, change.amountRaw);
  assert.equal(receipt.to, PAYER);
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
  await untilState(stateFile, "the completed run's result to reach the state file",
    (d) => { const q = quoteIn(x.paymentId)(d); return q && q.result; });

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
  const original = makeGate(chain1, { registry: registry1, stateFile, now: () => t, pollMs: 5 });
  const gate1 = original.wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain1.state.failTransfer = true; // refund bounces → owed queue
  const res = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);
  await untilState(stateFile, "the bounced refund to reach the owed queue on disk",
    d => d.owed.some(refund => refund.prepared && refund.nextAttemptAt > t));
  await original.stop();

  const chain2 = fakeChain();
  const gate2 = makeGate(chain2, { registry: fakeRegistry(), stateFile, now: () => t, pollMs: 5 });
  gate2.wrapRegistry(fakeRegistry());
  t += 31_000; // past the first retry backoff
  await until("the restored watcher to send the owed refund", () => chain2.state.transfers.length);
  assert.deepEqual(chain2.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }],
    "the customer's refund must land even though the process that owed it died");
  await gate2.stop();
});

test("a pre-journal refund is held and reserved, with its legacy error redacted", async t => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-legacy-")), "gate-state.json");
  let time = 6_000_000;

  // A state file written by a PRE-policy build: the queued refund's reason is
  // the old free-text form that can quote user content.
  const SENTINEL = "run failed: PROMPT LEAK abc123 SECRET";
  const priorArgs = { Text: "prior charged workflow" };
  await writeFile(stateFile, JSON.stringify({
    v: 1,
    quotes: [{ id: "pay_legacy", tool: "poster", argsHash: hashArgs("poster", priorArgs),
      amountRaw: "50000000000000000000000000000", usd: 0.05, source: PAYER,
      pair: { usdNano: "1000000000", raw: String(10n ** 30n) }, createdAt: time, expiresAt: time + 900_000, status: "paid" }],
    owed: [{
      to: PAYER, amountRaw: "50000000000000000000000000000", describe: "refunded",
      event: "refund", fields: { paymentId: "pay_legacy", tool: "poster", reason: SENTINEL }, tries: 0,
    }],
  }));

  const chain = fakeChain();
  const events = [];
  const registry = fakeRegistry();
  const gate = makeGate(chain, { registry, stateFile, now: () => time, pollMs: 5, usage: (e, f) => events.push([e, f]) });
  const args = { Text: "start watcher" };
  const { callTool } = gate.wrapRegistry(registry);
  const replay = await callTool({ name: "poster", arguments: { ...priorArgs, _payment_id: "pay_legacy" } });
  assert.match(replay.content[0].text, /needs reconciliation/);
  assert.equal(registry.callCount(), 0);
  const payment = argOf(await callTool({ name: "poster", arguments: args }));
  time += 61_000;
  await gate.waitForPayment(payment.paymentId, 25);
  await gate.stop();
  const current = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(current.owed[0].held, true);
  assert.equal(current.owed[0].fields.reason, "run_failed");
  assert.equal(gate.fundingLiabilitiesRaw(), 50000000000000000000000000000n);
  assert.deepEqual(chain.state.transfers, []);
  assert.doesNotMatch(JSON.stringify({ current, events }), /PROMPT LEAK|abc123|SECRET/);
  t.after(() => rm(dirname(stateFile), { recursive: true, force: true }));
});

test("a text output never touches disk and a settled payment cannot rerun inference after restart", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-textout-")), "gate-state.json");

  // The tool output is the customer's paid content — tagged textOutput by emitResult.
  const SECRET = "THE-CROWN-JEWELS-summary-42";
  const textOut = { content: [{ type: "text", text: SECRET }], costUsd: 0.02, textOutput: true };

  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => textOut });
  const original = makeGate(chain1, { registry: registry1, stateFile });
  const gate1 = original.wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(!first.isError && first.content.some((c) => c.text === SECRET), "the caller still gets their output in-process");
  await until("the first run to settle", () => chain1.state.transfers.some((t) => t.describe === "change:"));
  await untilState(stateFile, "the settled quote to persist",
    (d) => { const q = quoteIn(x.paymentId)(d); return q && q.settled; });

  // settle DID run on the first (successful) run: change went back to the payer
  assert.ok(chain1.state.transfers.some((t) => t.describe === "change:"), "the first run settles as normal");

  // The persisted bytes must not contain the customer's output text.
  const bytes = await readFile(stateFile, "utf8");
  assert.doesNotMatch(bytes, /CROWN-JEWELS/, "no tool output text may be written to disk");
  await original.stop();

  // A restart retains the financial outcome, not authority for fresh inference.
  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => textOut });
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /result text was not retained/);
  assert.doesNotMatch(replay.content[0].text, /CROWN-JEWELS/);
  assert.equal(registry2.callCount(), 0, "settled history is never permission to buy another model call");
  await new Promise((r) => setTimeout(r, 60));
  // Not charged twice: no fresh payment was demanded, and change/author are NOT paid a second time.
  assert.ok(!replay.structuredContent, "no new payment-required response — the original deposit still counts");
  assert.equal(chain2.state.transfers.filter((t) => t.describe === "change:").length, 0,
    "the lost result must not pay change a second time");
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
  await untilState(stateFile, "the media result to persist",
    (d) => { const q = quoteIn(x.paymentId)(d); return q && q.result; });

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
  await untilState(stateFile, "the failed quote's redacted error to persist",
    (d) => { const q = quoteIn(x.paymentId)(d); return q && q.error; });

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
  // The rewrite prunes the finished legacy quotes, so the fresh pending one is the marker.
  await untilState(stateFile, "the file to be rewritten in v2 with the fresh quote",
    (d) => d.v === 2 && d.quotes.some((q) => q.status === "pending"));
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
  await untilState(stateFile, "the failed quote's redacted error to persist",
    (d) => { const q = quoteIn(x.paymentId)(d); return q && q.error; });

  // First restart: restore, then force a re-persist (a new quote) so the error round-trips.
  const chain2 = fakeChain();
  chain2.state.failTransfer = true;
  const gate2 = makeGate(chain2, { registry: fakeRegistry({ onCall: async () => { throw new Error(SECRET); } }), stateFile }).wrapRegistry(fakeRegistry());
  await gate2.callTool({ name: "poster", arguments: { Text: "z" } }); // triggers persist
  await untilState(stateFile, "the second persist to hold both quotes",
    (d) => d.quotes.length > 1 && d.quotes.some((q) => q.id === x.paymentId && q.error));

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

test("a lost text result reports the original settled cost and change without running again", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stateFile = join(await mkdtemp(join(tmpdir(), "gate-receipt-")), "gate-state.json");

  const SECRET = "RECEIPT-OUTPUT-text";
  // First run: a known cost of $0.02 → partial change is sent, receipt says "$0.0200".
  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: SECRET }], costUsd: 0.02, textOutput: true }) });
  const original = makeGate(chain1, { registry: registry1, stateFile });
  const gate1 = original.wrapRegistry(registry1);
  const x = argOf(await gate1.callTool({ name: "poster", arguments: { Text: "a" } }));
  chain1.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const first = await gate1.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.match(first.content.at(-1).text, /actual cost \$0\.02/);
  assert.match(first.content.at(-1).text, /change due back to your wallet/);
  await untilState(stateFile, "the first run's confirmed change to persist",
    (d) => quoteIn(x.paymentId)(d)?.transferReceipts?.change);
  await original.stop();

  // The attempted replacement would report no cost; it must never execute.
  const chain2 = fakeChain();
  const registry2 = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: SECRET }], textOutput: true }) }); // no costUsd
  const gate2 = makeGate(chain2, { registry: registry2, stateFile }).wrapRegistry(registry2);
  const replay = await gate2.callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.equal(registry2.callCount(), 0, "completed text work is not regenerated");
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
    assert.match(url, /^https:\/\/api\.nano-gpt\.com\/api\/v1\/chat\/completions$/);
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

test("rate oracle: cached prices expire during an outage and recover with a fresh probe", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  let t = 1_000_000, probeOk = true, probes = 0;
  const signals = [];
  const fetch = async (url, { signal }) => {
    signals.push(signal);
    if (new URL(url).hostname !== "api.nano-gpt.com") return new Response("{}", { status: 503 });
    probes++;
    if (!probeOk) return { status: 500, json: async () => ({}) };
    return {
      status: 402,
      json: async () => ({ payment: { paymentId: "p", accepted: [
        { scheme: "nano", payTo: GATE_ADDR, amount: "100000000000000000000000000000", amountUsd: "0.05" }] } }),
    };
  };
  const gate = makeGate(chain, { registry, xnoUsd: null, fetch, now: () => t, monotonicNow: () => t });
  const { callTool } = gate.wrapRegistry(registry);
  const a = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  t += 61_000; // cache expired, oracle down → stale rate keeps quoting
  probeOk = false;
  const b = argOf(await callTool({ name: "poster", arguments: { Text: "b" } }));
  assert.equal(BigInt(a.amountRaw) / 10n ** 26n, BigInt(b.amountRaw) / 10n ** 26n); // same rate, different tag
  assert.equal(probes, 2);
  t += 239_000;
  await assert.rejects(gate.fundingPair(), /rate probe failed/);
  await assert.rejects(() => callTool({ name: "poster", arguments: { Text: "c" } }), /rate probe failed/);
  assert.equal(registry.callCount(), 0);
  probeOk = true;
  t += 5_000;
  assert.deepEqual(await gate.fundingPair(), { usdNano: 50_000_000n, raw: 10n ** 29n });

  // a gate that never got a rate refuses to quote, readably
  probeOk = false;
  const cold = makeGate(fakeChain(), { registry, xnoUsd: null, fetch }).wrapRegistry(fakeRegistry());
  await assert.rejects(() => cold.callTool({ name: "poster", arguments: { Text: "a" } }), /rate probe failed/);
  assert.ok(signals.every(signal => signal instanceof AbortSignal), "the quote oracle has a request deadline");
});

test("rate oracle accepts a valid Nano invoice after an unusable invoice and ignores other rails", async () => {
  const body = { payment: { accepted: [
    { scheme: "nano", amount: "1", amountUsd: "0" },
    { scheme: "lightning-l402", amount: "2", amountUsd: "0.2" },
    { scheme: "nano-exact", network: "nano:mainnet", asset: "XNO", amount: "3", amountUsd: "0.3" },
  ] } };
  const fetch = async () => Response.json(body, { status: 402 });
  assert.deepEqual(await probeX402Pair({ fetch, url: "https://api.nano-gpt.com" }), { usdNano: 300_000_000n, raw: 3n });
  body.payment.accepted.pop();
  await assert.rejects(probeX402Pair({ fetch, url: "https://api.nano-gpt.com" }), /no usable XNO\/USD pair/);
});

test("rate oracle keeps using NanoGPT when its primary probe model is retired", async () => {
  const calls = [];
  const signal = AbortSignal.timeout(1_000);
  const fetch = async (_url, options) => {
    const { model, max_tokens } = JSON.parse(options.body);
    calls.push(model);
    assert.equal(max_tokens, 256);
    assert.equal(options.signal, signal);
    if (model === "glm-5.2") return Response.json({ error: "model retired" }, { status: 410 });
    return Response.json({ accepts: [
      { scheme: "nano", maxAmountRequired: "1000000000000000000000000000", maxAmountRequiredUSD: "0.0003" },
    ] }, { status: 402 });
  };
  assert.deepEqual(await probeX402Pair({ fetch, url: "https://api.nano-gpt.com", signal }),
    { usdNano: 300_000n, raw: 10n ** 27n });
  assert.deepEqual(calls, ["glm-5.2", "glm-5.3"]);
});

test("Nano checkout uses fresh independent rates on cold start and prefers NanoGPT when it recovers", async (t) => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  let now = 1_795_196_000_000, coinGeckoFresh = false, oracleReady = false;
  let probes = 0;
  const fetchRate = async (url) => {
    const host = new URL(url).hostname;
    if (host === "api.coingecko.com") return Response.json({ nano: { usd: 0.4,
      last_updated_at: now / 1000 - (coinGeckoFresh ? 5 : 301) } });
    if (host === "api.kraken.com") return Response.json({ error: [], result: { NANOUSD: [["0.5", "10", now / 1000 - 1]] } });
    assert.equal(host, "api.nano-gpt.com");
    probes++;
    return Response.json({ accepts: oracleReady
      ? [{ scheme: "nano", maxAmountRequired: "100000000000000000000000000000", maxAmountRequiredUSD: "0.025" }]
      : [{ scheme: "lightning-l402", maxAmountRequired: "1", maxAmountRequiredUSD: "0.025" }] }, { status: 402 });
  };
  const gate = makeGate(chain, { registry, fetch: fetchRate, xnoUsd: null, now: () => now, monotonicNow: () => now });
  const { callTool, listTools } = gate.wrapRegistry(registry);
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "nanoodle-mcp", version: "0.7.0",
    listTools, callTool, gate, publicBase: "http://pay.test", log: () => {} });
  t.after(() => server.close());
  const { port } = server.address();
  const rateRequest = () => fetch(`http://127.0.0.1:${port}/rates/nano`).then(res => res.json());
  const [health, first] = await Promise.all([rateRequest(), callTool({ name: "poster", arguments: { Text: "a" } })]);
  assert.equal(health.source, "kraken");
  assert.equal(health.xnoUsd, 0.5);
  assert.equal(BigInt(argOf(first).amountRaw) / 10n ** 26n, 1_000n);
  assert.equal(probes, 1);
  assert.equal(registry.callCount(), 0);
  now += 60_000;
  coinGeckoFresh = true;
  assert.equal((await rateRequest()).source, "coingecko");
  now += 60_000;
  oracleReady = true;
  assert.equal((await rateRequest()).source, "nanogpt-x402");
});

test("hashArgs is order-insensitive and value-sensitive", () => {
  assert.equal(hashArgs("t", { a: 1, b: "x" }), hashArgs("t", { b: "x", a: 1 }));
  assert.notEqual(hashArgs("t", { a: 1 }), hashArgs("t", { a: 2 }));
  assert.notEqual(hashArgs("t", { a: 1 }), hashArgs("u", { a: 1 }));
});

/* ---- HTTP surface with a live gate ---- */

test("initialize and /version report the git short sha of this checkout", async () => {
  const sha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(sha, /^[0-9a-f]{7,40}$/);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "nanoodle-mcp", version: "0.6.0",
    listTools: () => [], callTool: async () => ({ content: [] }),
    publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const init = await (await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    })).json();
    assert.equal(init.result.serverInfo.name, "nanoodle-mcp");
    assert.equal(init.result.serverInfo.version, "0.6.0");
    assert.equal(init.result.serverInfo.commit, sha);

    const ver = await (await fetch(`${base}/version`)).json();
    assert.deepEqual(ver, { name: "nanoodle-mcp", version: "0.6.0", commit: sha });
  } finally {
    server.close();
  }
});

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
    // the money story: deposit → cost + 20%, markup is the author's — and this
    // server's single workflow really does name an address, so it may say so
    assert.match(html, /20% is the <strong>workflow author's<\/strong> cut/);
    assert.match(html, /capped by whatever the\s+deposit has left after the model's cost/);
    assert.match(html, /Every workflow here names one\./);
    assert.match(html, /Claim the 20% on your own workflow/);
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

/*
 * The production state, and the one the old copy lied about.
 *
 * settle() in src/gate.mjs routes the 20% markup to the graph's x402.author, and
 * KEEPS it when there is no such field. Every graph in awesome-noodles is in that
 * second case, so on mcp.nanoodle.com the markup goes to the wallet running the
 * server. The landing page and /llms.txt both said, flat out, that the 20% goes to
 * the workflow author and not the platform. This test holds the copy to the graphs
 * actually being served.
 */
test("no graph names an author: the page says the markup stays with the server, and never claims otherwise", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();                 // x402: null → no author anywhere
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const toolInfo = [{ name: "poster", x402: null, rawText: "{}", editorUrl: "https://nanoodle.com/#g=abc" }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    const txt = await (await fetch(`${base}/llms.txt`)).text();

    // Says where the money actually goes today.
    assert.match(html, /None of the workflows here name one yet, so for now the markup stays with this server\./);
    assert.match(html, /No workflow here claims it yet/);
    assert.match(txt, /otherwise the operator keeps the markup/);

    // Never the unconditional claim, in either place.
    for (const [where, body] of [["landing page", html], ["/llms.txt", txt]]) {
      assert.doesNotMatch(body, /20% goes to the (<strong>)?workflow author/,
        `${where} claims the author gets the 20% while no served graph names one`);
      assert.doesNotMatch(body, /not the platform/,
        `${where} claims the platform keeps none of the 20% while it keeps all of it`);
      assert.doesNotMatch(body, /authors earn the 20%/i,
        `${where} states as fact something no served graph does`);
    }

    // The genuine feature survives: a graph CAN claim it, and the page says how.
    assert.match(html, /"x402": \{"author": "nano_…"\}/);
    assert.match(txt, /A graph can assign the available markup to its author/);
  } finally {
    server.close();
  }
});

/*
 * The markup is a CEILING, not a guarantee: settle() takes
 * min(markup, deposit − cost), so a deposit that cannot cover cost + 20% pays the
 * author only what is left. Copy that promises "the whole 20%" replaces one
 * overclaim with another.
 */
test("author copy states the deposit ceiling, in both the page and llms.txt", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry({ author: PAYER });
  const gate = makeGate(chain, { registry });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const toolInfo = [{ name: "poster", x402: registry.tools[0].x402, rawText: "{}", editorUrl: "https://nanoodle.com/#g=abc" }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, toolInfo, publicBase: "http://pay.test", log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    const txt = await (await fetch(`${base}/llms.txt`)).text();
    assert.match(html, /capped by whatever the\s+deposit has left after the model's cost/);
    assert.match(html, /as much of it as the\s+deposit leaves after the model's cost/);
    assert.match(txt, /capped by what the deposit has left after cost/);
    assert.doesNotMatch(html, /the full 20% markup of every paid run/,
      "the markup is min(markup, deposit − cost) — never promise the whole of it");
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
    assert.match(html, /settles at the model(?:&#39;|')s actual cost \+ 20%, and returns the change/);
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
    assert.match(html, /<li class="tool" id="poster"><code>poster<\/code>/);
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
    // default command is Claude; Grok rides the same endpoint behind a client toggle
    assert.match(html, /claude mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(html, /grok mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(html, /data-client="claude"/);
    assert.match(html, /data-client="grok"/);
    assert.match(html, /selectClient/);
    assert.match(html, /402 payment quote/);
    assert.match(html, /You can connect without an account or an API key\./);
    assert.match(html, /href="\/llms\.txt"/);
    assert.match(html, /Claude Code, Grok, Cursor/);
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
    assert.match(html, /href="\/brand\/nanoodle-v1\.0\.0\/tokens\/tokens\.css"/);
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

    for (const [path, type] of [
      ["tokens/tokens.css", "text/css"],
      ["fonts/manrope-latin-variable.woff2", "font/woff2"],
      ["assets/wordmark-gradient.svg", "image/svg+xml"],
    ]) {
      const r = await fetch(`${base}/brand/nanoodle-v1.0.0/${path}`);
      assert.equal(r.status, 200, path);
      assert.ok(r.headers.get("content-type").startsWith(type), path);
      assert.ok((await r.arrayBuffer()).byteLength > 500, path);
    }

    // pay pages get the favicon links too
    const arg = argOf(await callTool({ name: "poster", arguments: { Text: "x" } }));
    const pay = await (await fetch(`${base}/pay/${arg.paymentId}`)).text();
    assert.match(pay, /<span>Nano payment<\/span>/);
    assert.match(pay, /href="\/brand\/nanoodle-v1\.0\.0\/fonts\/fonts\.css"/);
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
    assert.match(txt, /MCP endpoint: http:\/\/pay\.test\/mcp/);
    assert.match(txt, /claude mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(txt, /grok mcp add --transport http noodles http:\/\/pay\.test\/mcp/);
    assert.match(txt, /Nano \(XNO\) is the default/);
    assert.match(txt, /settle at metered model cost plus a 20% markup/);
    assert.match(txt, /- `poster`: /);
    assert.match(txt, /\[graph JSON\]\(http:\/\/pay\.test\/graph\/poster\.json\)/);
    assert.match(txt, /nanoodle-mcp --graphs/);
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
    assert.doesNotMatch(txt, /quote is not permission|payment guide/);
    assert.match(txt, /operator’s balance/);
    assert.match(txt, /- `poster`: /);
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
    assert.doesNotMatch(html, /Claim the 20%/);
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
    assert.match(html, /payments ledger, for money events already public on the Nano ledger/);
    // the honest NanoGPT caveat + verify-in-source link
    assert.match(html, /falls under <a href="https:\/\/nano-gpt\.com\/privacy">their privacy policy/);
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
    assert.match(txt, /## Costs and data/);
    assert.match(txt, /do not require a Nanoodle login or a NanoGPT API key/);
    assert.match(txt, /ordinary invocations the server does not persist prompts or input media/);
    assert.match(txt, /quote is not permission to spend/); // charge-only
    assert.match(txt, /retention is 24 hours by default/);
    assert.match(txt, /payment and receipt records/);
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
    assert.match(txt, /## Costs and data/);
    assert.doesNotMatch(txt, /quote is not permission to spend/);
    assert.doesNotMatch(txt, /Nano payment guide/);
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

/* ---- three-phase x402: quote hang-up → watch SSE → results stream ---- */

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

test("three phases: quote hangs up, unpaid results call hangs up, paid results stream runs", async () => {
  const chain = fakeChain();
  const registry = fakeRegistry();
  // short waitMs so an unpaid results call hangs up promptly (not quote TTL)
  const gate = makeGate(chain, { registry, pollMs: 5, waitMs: 40 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", progressMs: 40, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Phase 1: streaming first call ALWAYS returns the quote as RESULT and hangs up
    // (regression: progress-only pay link hung clients that don't render progress).
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
    assert.match(final.result.content[0].text, /hang up/i);
    assert.equal(x.watchUrl, `http://pay.test/x402/watch/${x.paymentId}`, "agent gets watchUrl for phase 2");
    assert.equal(x.blocking, false);
    assert.deepEqual(x.phases, ["pay", "watch", "results"]);
    // payment link text instructs the agent to open the watch URL immediately
    assert.match(final.result.content[0].text, /IMMEDIATELY open and watch/i);
    assert.match(final.result.content[0].text, new RegExp(x.watchUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(final.result.content[0].text, /NEVER show this URL to the user/i);
    assert.match(x.next, /IMMEDIATELY open/i);
    assert.equal(registry.callCount(), 0, "nothing runs on the first call");

    // Phase 3 too early: unpaid results call must hang up with watch instructions —
    // never hold the tools/call SSE open through payment (that raced watch in parallel).
    const t0 = Date.now();
    const early = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId }, _meta: { progressToken: "p2" } },
      }),
    });
    let earlyMsg = null;
    await readSse(early, ({ data }) => { if (data.id === 100) { earlyMsg = data; return "stop"; } });
    assert.ok(Date.now() - t0 < 5_000, "unpaid results call must hang up quickly, not wait the quote TTL");
    assert.ok(earlyMsg.result.isError, "unpaid results call is an error, not a hang");
    assert.match(earlyMsg.result.content[0].text, /hasn't arrived/);
    assert.match(earlyMsg.result.content[0].text, /x402\/watch/);
    assert.equal(registry.callCount(), 0, "still nothing ran");

    // Phase 2 → paid, then phase 3 results stream
    chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    await gate.waitForPayment(x.paymentId, 500);
    const run = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "poster", arguments: { Text: "a lighthouse", _payment_id: x.paymentId }, _meta: { progressToken: "p3" } },
      }),
    });
    let ran = null;
    await readSse(run, ({ data }) => { if (data.id === 101) { ran = data; return "stop"; } });
    assert.ok(!ran.result.isError, JSON.stringify(ran.result));
    assert.match(ran.result.content[0].text, /^ran /, "after payment, the results stream runs");
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
    let terminal = null;
    await readSse(res, ({ event, data }) => {
      if (event !== "status") return;
      seen.push(data.status);
      if (data.status === "pending") {
        assert.equal(data.done, undefined, "pending frames are lean — no done/next yet");
        // pay after the first pending frame; the shared watcher pushes the next frame
        chain.state.receivable["A".repeat(64)] = { amount: x.amountRaw, source: PAYER };
      } else {
        terminal = data;
        return "stop"; // paid/consumed → the stream closes
      }
    });
    assert.equal(seen[0], "pending");
    assert.ok(seen.some((s) => s === "paid" || s === "consumed"), `expected a paid frame, got ${JSON.stringify(seen)}`);
    // Terminal frame must close the gap: agent gets done + next instructions for
    // the result stream (tools/call with _payment_id), not a bare "paid".
    assert.equal(terminal.done, true, "terminal frame marks done so the agent knows the watch is over");
    assert.match(terminal.next, /_payment_id/, "next tells the agent how to open the result stream");
    assert.match(terminal.next, new RegExp(x.paymentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(terminal.next, /result stream|tools\/call|call the SAME tool/i);
  } finally {
    server.close();
  }
});

test("GET /x402/status/:id carries done+next once the payment lands", async () => {
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
    const pending = await (await fetch(`${base}/x402/status/${x.paymentId}`)).json();
    assert.equal(pending.status, "pending");
    assert.equal(pending.done, undefined);

    chain.state.receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    // ?wait=1 long-polls until paid
    const paid = await (await fetch(`${base}/x402/status/${x.paymentId}?wait=1`)).json();
    assert.ok(paid.status === "paid" || paid.status === "consumed", JSON.stringify(paid));
    assert.equal(paid.done, true);
    assert.match(paid.next, /_payment_id/);
    assert.match(paid.next, new RegExp(x.paymentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    server.close();
  }
});

test("results stream announces payment received when already paid (not silent load)", async () => {
  const chain = fakeChain();
  // Slow the run so we can observe the progress event before the final result
  const registry = fakeRegistry({
    onCall: async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { content: [{ type: "text", text: "ran poster" }], costUsd: 0.01, textOutput: true };
    },
  });
  const gate = makeGate(chain, { registry, pollMs: 5 });
  const { listTools, callTool } = gate.wrapRegistry(registry);
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "t", version: "0",
    listTools, callTool, gate, publicBase: "http://pay.test", progressMs: 200, log: () => {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
    // Pay first (phase 2 done), then open the results stream (phase 3)
    chain.state.receivable["C".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    await gate.waitForPayment(x.paymentId, 500);

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call",
        params: {
          name: "poster",
          arguments: { Text: "a", _payment_id: x.paymentId },
          _meta: { progressToken: "pay-ack" },
        },
      }),
    });
    const progressMsgs = [];
    let final = null;
    await readSse(res, ({ data }) => {
      if (data.method === "notifications/progress") {
        progressMsgs.push(data.params && data.params.message);
      }
      if (data.id === 7) { final = data; return "stop"; }
    });
    assert.ok(final && final.result && !final.result.isError, JSON.stringify(final));
    const joined = progressMsgs.join(" | ");
    assert.match(joined, /payment received/i, `expected payment-received announce on results stream, got: ${joined}`);
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

/*
 * Regression: 2026-07-23/25 production incident. A refund that could not send
 * (RPC 429) sat in the owed queue, which kept anyWatchable() true forever, which
 * kept scan() calling `receivable` every 5s — against the very endpoint that was
 * throttling. It ran 34 hours and logged 5,158 failures. The queued send must
 * keep retrying WITHOUT dragging the receivable poll along with it.
 */
test("a queued owed send does not keep polling receivable", async () => {
  let t = 3_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  let receivableCalls = 0;
  const innerRpc = chain.ops.rpc;
  chain.ops.rpc = async (body) => {
    if (body.action === "receivable") receivableCalls++;
    return innerRpc(body);
  };

  const { callTool } = makeGate(chain, { registry, now: () => t, pollMs: 5 }).wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain.state.failTransfer = true; // refund bounces → owed queue, and stays there
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } });
  assert.ok(res.isError);

  // Past LATE_WATCH_MS: no quote is payment-watchable any more, only `owed` is left.
  t += 2 * 60 * 60 * 1000;
  await new Promise((r) => setTimeout(r, 40)); // let a tick land in the new state
  const before = receivableCalls;
  await new Promise((r) => setTimeout(r, 120)); // at pollMs=5 the old code got ~24 more
  assert.equal(receivableCalls, before,
    "owed-only ticks must not touch the node — that poll fed the rate limit blocking the refund");

  // …and the retry itself still works the moment the transfer can go through.
  chain.state.failTransfer = false;
  t += 61_000; // past OWED_BACKOFF_MS[1], where the retry during the idle stretch left o.at
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
});

test("a failing scan backs off instead of hammering at the poll rate", async () => {
  let t = 4_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry();
  let receivableCalls = 0;
  const innerRpc = chain.ops.rpc;
  chain.ops.rpc = async (body) => {
    if (body.action === "receivable") { receivableCalls++; throw new Error("Nano RPC receivable: 429"); }
    return innerRpc(body);
  };
  const { callTool } = makeGate(chain, { registry, now: () => t, pollMs: 5 }).wrapRegistry(registry);
  await callTool({ name: "poster", arguments: { Text: "a" } }); // pending quote → fast poll

  await new Promise((r) => setTimeout(r, 300));
  // Ungated at pollMs=5 this is ~60 calls; doubling 5→10→20→40… caps it well under that.
  assert.ok(receivableCalls > 0, "it must still try");
  assert.ok(receivableCalls <= 12, `expected backoff to bound the retries, got ${receivableCalls}`);
});

/*
 * Regression on the fix above: the backoff reset used to live in
 * ensureWatching(), which looks like "a new caller arrived" but is re-entered by
 * waitForPayment() — and each open /x402/watch stream re-enters that on a 25s
 * ceiling for the whole life of the quote. That zeroed scanFails continuously,
 * so the backoff never engaged for any quote anyone was actually watching, which
 * is all of them. Measured at the time: 8 watchers made MORE receivable calls
 * than the unfixed code.
 */
test("an open payment watcher does not reset the scan backoff", async () => {
  let t = 5_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry();
  let receivableCalls = 0;
  const innerRpc = chain.ops.rpc;
  chain.ops.rpc = async (body) => {
    if (body.action === "receivable") { receivableCalls++; throw new Error("Nano RPC receivable: 429"); }
    return innerRpc(body);
  };
  const gate = makeGate(chain, { registry, now: () => t, pollMs: 5 });
  const { callTool } = gate.wrapRegistry(registry);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));

  // Four watchers re-polling the way the SSE loop does, well inside the backoff.
  let watching = true;
  const watcher = async () => { while (watching) await gate.waitForPayment(x.paymentId, 15); };
  const streams = [watcher(), watcher(), watcher(), watcher()];
  await new Promise((r) => setTimeout(r, 300));
  watching = false;
  await Promise.all(streams);

  // Ungated at pollMs=5 this is ~60; with the reset in ensureWatching it was worse.
  assert.ok(receivableCalls <= 12,
    `watchers must not defeat the backoff, got ${receivableCalls} receivable calls`);
});

test("a genuinely new quote does reset the scan backoff", async () => {
  let t = 6_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry();
  let failing = true;
  let receivableCalls = 0;
  const innerRpc = chain.ops.rpc;
  chain.ops.rpc = async (body) => {
    if (body.action === "receivable") {
      receivableCalls++;
      if (failing) throw new Error("Nano RPC receivable: 429");
    }
    return innerRpc(body);
  };
  const { callTool } = makeGate(chain, { registry, now: () => t, pollMs: 5 }).wrapRegistry(registry);
  await callTool({ name: "poster", arguments: { Text: "a" } });
  await new Promise((r) => setTimeout(r, 200)); // ramp the backoff up

  failing = false;
  const before = receivableCalls;
  const y = argOf(await callTool({ name: "poster", arguments: { Text: "b" } }));
  chain.state.receivable["E".repeat(64)] = { amount: y.amountRaw, source: PAYER };
  await new Promise((r) => setTimeout(r, 60)); // must scan promptly, not wait out the backoff
  assert.ok(receivableCalls > before,
    "a fresh quote must get an immediate scan rather than inherit an earlier caller's backoff");

});

/*
 * Regression: 2026-07-24 triple payout. An owed entry is spliced out of the
 * queue only AFTER its send resolves, so a second retryOwed() running during
 * that await re-sent it. Reachable because tick() nulls `timer` before awaiting
 * scan(), and every ensureWatching() during the send re-enters tick(). Observed
 * in production as three identical 0.31294478 XNO sends inside one second, same
 * PID, no restart; a local repro with four watchers reached 45.
 */
test("a slow owed send is never sent twice", async () => {
  let t = 7_000_000;
  const chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  const slowTransfer = chain.ops.transfer;
  chain.ops.transfer = async (to, amountRaw, describe) => {
    if (chain.state.failTransfer) throw new Error("transfer refused");
    await new Promise((r) => setTimeout(r, 60)); // a real send waits on work generation
    return slowTransfer(to, amountRaw, describe);
  };
  const gate = makeGate(chain, { registry, now: () => t, pollMs: 5 });
  const { callTool } = gate.wrapRegistry(registry);

  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));
  chain.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  chain.state.failTransfer = true; // refund bounces onto the owed queue
  assert.ok((await callTool({ name: "poster", arguments: { Text: "a", _payment_id: x.paymentId } })).isError);

  // A second, still-pending quote keeps watchers calling ensureWatching() —
  // waitForPayment() returns early for a settled quote, so this is what makes
  // the re-entrancy reachable, and it is ordinary concurrent traffic.
  const y = argOf(await callTool({ name: "poster", arguments: { Text: "b" } }));
  chain.state.failTransfer = false;
  t += 61_000;
  let watching = true;
  const watcher = async () => { while (watching) await gate.waitForPayment(y.paymentId, 5); };
  const streams = [watcher(), watcher(), watcher(), watcher()];
  await new Promise((r) => setTimeout(r, 400));
  watching = false;
  await Promise.all(streams);

  const refunds = chain.state.transfers.filter((s) => s.describe === "refunded");
  assert.equal(refunds.length, 1, `the refund must be sent exactly once, got ${refunds.length}`);
});

test("a restored owed refund blocks a second refund of the same late payment", async t => {
  const dir = await mkdtemp(join(tmpdir(), "gate-dupe-"));
  const stateFile = join(dir, "gate-state.json");
  let now = 8_000_000, restarted = null;
  const chain1 = fakeChain();
  const registry1 = fakeRegistry({ onCall: async () => { throw new Error("model exploded"); } });
  const gate1 = makeGate(chain1, { registry: registry1, stateFile, now: () => now, pollMs: 5 });
  t.after(async () => {
    await gate1.stop();
    await restarted?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const { callTool } = gate1.wrapRegistry(registry1);
  const x = argOf(await callTool({ name: "poster", arguments: { Text: "a" } }));

  // #23 is specifically the LATE-payment path: the quote must EXPIRE unpaid,
  // and only then does the payer's block show up.
  now += 16 * 60 * 1000; // past QUOTE_TTL_MS
  chain1.state.failTransfer = true; // the late-payment refund bounces → persisted owed entry
  chain1.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const pending = await untilState(stateFile, "the late refund and retry time to reach disk", data =>
    data.owed.some(refund => refund.event === "refund" && refund.fields?.paymentId === x.paymentId && refund.nextAttemptAt > now));
  assert.equal(quoteIn(x.paymentId)(pending).status, "expired");
  assert.equal(pending.owed.length, 1);
  await gate1.stop();

  // Restart: same state file, and the payer's block is STILL visible on chain
  // (never pocketed), so the fresh watcher re-scans it.
  const chain2 = fakeChain();
  chain2.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: PAYER };
  const rpc = chain2.ops.rpc;
  let rescanned = false;
  chain2.ops.rpc = body => {
    // The history read follows matching the still-visible receivable above.
    if (body.action === "account_history") rescanned = true;
    return rpc(body);
  };
  restarted = makeGate(chain2, { stateFile, now: () => now, pollMs: 5 });
  await restarted.wrapRegistry(fakeRegistry()).callTool({ name: "poster", arguments: { Text: "start another quote" } });
  await until("the restarted watcher to re-scan the late payment", () => rescanned);
  assert.equal(chain2.state.transfers.length, 0, "re-scanning must not send a second refund outside the owed queue");
  now += 61_000;
  await untilState(stateFile, "the restored refund to settle", data =>
    data.owed.length === 0 && quoteIn(x.paymentId)(data).status === "refunded");
  await restarted.stop();

  const refunds = chain2.state.transfers.filter((s) => s.describe === "refunded");
  assert.deepEqual(refunds, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
});

for (const outcome of ["failed", "late", "successful"]) {
  test(`a restart reconciles signed Nano transfers for a ${outcome} payment without sending twice`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "gate-transfer-journal-"));
    const stateFile = join(dir, "gate-state.json"), chain = fakeChain();
    let time = 10_000_000, gate;
    const accepted = new Map(), attempts = [];
    const events = outcome === "successful" ? ["author_payout", "change"] : ["refund"];
    const author = GATE_ADDR;
    const registry = fakeRegistry({ author, onCall: async () => {
      if (outcome === "failed") throw Error("provider failure");
      return { content: [{ type: "text", text: "done" }], costUsd: 0.02, textOutput: true };
    } });
    t.after(async () => {
      await gate?.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const start = () => makeGate(chain, { registry, stateFile, now: () => time, pollMs: 5 });
    gate = start();
    const args = { Text: outcome }, wrapped = gate.wrapRegistry(registry);
    const p = argOf(await wrapped.callTool({ name: "poster", arguments: args }));
    chain.ops.transfer = async () => { assert.fail("durable checkout used the non-journaled wallet operation"); };
    chain.ops.transferOnce = async (to, amountRaw, { prepared, onPrepared, describe }) => {
      const event = describe === "refunded" ? "refund" : describe === "change:" ? "change" : "author_payout";
      const hash = testHash(events.indexOf(event));
      if (!prepared) {
        assert.equal(accepted.has(hash), false, "a known transfer cannot be signed again");
        prepared = { hash, block: { account: GATE_ADDR, link_as_account: to } };
        await onPrepared(prepared);
      }
      const saved = JSON.parse(await readFile(stateFile, "utf8")), q = quoteIn(p.paymentId)(saved);
      assert.deepEqual(saved.owed.find(o => o.event === event).prepared, prepared,
        "the exact signed block is on disk before publish");
      assert.equal(q.settled, outcome === "successful");
      if (outcome === "successful" && accepted.size === 0) assert.deepEqual(saved.owed.map(o => o.event), events);
      if (outcome === "failed") assert.match(q.error, /refund is pending/);
      if (outcome === "late") assert.equal(q.status, "expired");
      attempts.push(prepared.hash);
      if (accepted.has(hash)) return hash;
      accepted.set(hash, { to, amountRaw });
      throw Error("block accepted, confirmation response unavailable");
    };

    if (outcome === "late") time += 16 * 60_000;
    chain.state.receivable[testHash(900)] = { amount: p.amountRaw, source: PAYER };
    const call = { name: "poster", arguments: { ...args, _payment_id: p.paymentId } };
    if (outcome !== "late") await wrapped.callTool(call);
    const pending = await untilState(stateFile, "all accepted sends to remain journaled", s =>
      s.owed.length === events.length && s.owed.every(o => o.prepared && o.nextAttemptAt > time));
    assert.equal(gate.fundingLiabilitiesRaw(), pending.owed.reduce((sum, o) => sum + BigInt(o.amountRaw), 0n));
    await gate.stop();

    time += 31_000;
    gate = start();
    const completed = await untilState(stateFile, "recovery to record all confirmed transfers together with queue removal", s =>
      s.owed.length === 0 && events.every(event => quoteIn(p.paymentId)(s)?.transferReceipts?.[event]));
    for (const event of events) {
      const hash = testHash(events.indexOf(event));
      assert.equal(quoteIn(p.paymentId)(completed).transferReceipts[event].hash, hash);
      assert.equal(attempts.filter(h => h === hash).length, 2);
    }
    assert.equal(accepted.size, events.length);
    await until("the committed receipt to release the in-memory liability", () => gate.fundingLiabilitiesRaw() === 0n);
    assert.equal(quoteIn(p.paymentId)(completed).status, outcome === "successful" ? "paid" : "refunded");
    await gate.wrapRegistry(registry).callTool(call);
    assert.equal(registry.callCount(), outcome === "late" ? 0 : 1);
  });
}

test("Nano payment recovery retains a signed send if the completion write fails", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nano-sent-write-failed-"));
  const stateFile = join(dir, "gate-state.json"), chain = fakeChain(), hash = testHash(122);
  let time = 1_000_000, gate, broadcast = 0;
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "fixture" }], costUsd: 0.02, textOutput: true }) });
  t.after(async () => {
    await gate?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const start = () => makeGate(chain, { registry, stateFile, now: () => time, pollMs: 5 });
  gate = start();
  const { callTool } = gate.wrapRegistry(registry);
  const params = { name: "poster", arguments: { Text: "fixture" } };
  const payment = argOf(await callTool(params));
  chain.state.receivable[testHash(123)] = { amount: payment.amountRaw, source: PAYER };
  chain.ops.transferOnce = async (to, _amount, { prepared, onPrepared }) => {
    if (prepared) {
      assert.equal(prepared.hash, hash);
    } else {
      await onPrepared({ hash, block: { account: GATE_ADDR, link_as_account: to } });
      broadcast++;
      await mkdir(stateFile + ".tmp");
    }
    return hash;
  };
  const result = await callTool({ ...params, arguments: { ...params.arguments, _payment_id: payment.paymentId } });
  assert.equal(result.isError, undefined);
  await until("the failed completion snapshot", () => !gate.persistenceStatus().ok && gate.persistenceStatus().pendingWrites === 0);
  const durable = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(durable.owed.length, 1);
  assert.equal(durable.owed[0].prepared.hash, hash);
  assert.equal(gate.fundingLiabilitiesRaw(), BigInt(durable.owed[0].amountRaw));
  await gate.stop();
  await rm(stateFile + ".tmp", { recursive: true });

  time += 31_000;
  gate = start();
  const recovered = await untilState(stateFile, "the original confirmation to be recorded", s =>
    s.owed.length === 0 && quoteIn(payment.paymentId)(s)?.transferReceipts?.change);
  assert.equal(quoteIn(payment.paymentId)(recovered).transferReceipts.change.hash, hash);
  assert.equal(broadcast, 1);
});

test("a Nano workflow killed after provider dispatch refunds the original payment without rerunning", { timeout: 8_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nano-execution-restart-"));
  const stateFile = join(dir, "gate-state.json"), chain = fakeChain();
  const args = { Text: "PRIVATE-EXECUTION-FIXTURE" }, initial = fakeRegistry();
  let gate = makeGate(chain, { stateFile, registry: initial, pollMs: 5 }), child;
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await gate?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const payment = argOf(await gate.wrapRegistry(initial).callTool({ name: "poster", arguments: args }));
  chain.state.receivable[testHash(124)] = { amount: payment.amountRaw, source: PAYER };
  assert.equal(await gate.waitForPayment(payment.paymentId, 1_000), "paid");
  await gate.stop();

  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { createChargeGate } from ${JSON.stringify(new URL("../src/gate.mjs", import.meta.url).href)};
    const [address, stateFile, id, rawArgs] = process.argv.slice(1);
    const registry = {
      tools: [{ name: "poster" }], listTools: () => [],
      callTool() {
        process.send("provider accepted the fixture request");
        return new Promise(() => {});
      },
    };
    const gate = createChargeGate({ address, usd: 0.05, xnoUsd: 1, stateFile, publicBase: "http://pay.test",
      ops: { rpc: async () => ({ history: [], blocks: {} }) },
      fundRun(_terms, execute) {
        const q = JSON.parse(readFileSync(stateFile, "utf8")).quotes.find(q => q.id === id);
        assert.equal(q.status, "consumed");
        assert.ok(Number.isSafeInteger(q.runDeadlineAt));
        return execute();
      },
    });
    setInterval(() => {}, 1000);
    const result = await gate.wrapRegistry(registry).callTool({ name: "poster", arguments: { ...JSON.parse(rawArgs), _payment_id: id } });
    process.send({ unexpected: result?.content?.[0]?.text ?? "fixture workflow returned early" });
  `;
  child = spawn(process.execPath, ["--input-type=module", "-e", script, GATE_ADDR, stateFile, payment.paymentId, JSON.stringify(args)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const dispatched = new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  });
  assert.equal(await Promise.race([dispatched, exited.then(() => { throw Error(`fixture writer exited early: ${stderr}`); })]),
    "provider accepted the fixture request");
  assert.equal(child.kill("SIGKILL"), true);
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });

  // Start a fresh writer without a caller and verify it durably records the
  // refund once, even if the paying agent reconnects during recovery.
  const registry = fakeRegistry();
  let funding = 0;
  const start = () => makeGate(chain, { stateFile, registry, pollMs: 5, fundRun: (_terms, run) => { funding++; return run(); } });
  gate = start();
  const call = { name: "poster", arguments: { ...args, _payment_id: payment.paymentId } };
  assert.equal((await gate.wrapRegistry(registry).callTool(call)).isError, true);
  await until("the interrupted workflow's refund to publish", () => gate.quote(payment.paymentId)?.status === "refunded");
  const saved = await untilState(stateFile, "the interrupted refund to reach disk", s => quoteIn(payment.paymentId)(s)?.transferReceipts?.refund);
  assert.match(quoteIn(payment.paymentId)(saved).error, /server restarted before recording/);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE-EXECUTION-FIXTURE/);
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw: payment.amountRaw, describe: "refunded" }]);
  assert.equal(gate.fundingLiabilitiesRaw(), 0n);
  await gate.stop();

  gate = start();
  const replay = await gate.wrapRegistry(registry).callTool(call);
  assert.match(replay.content[0].text, /was refunded/);
  assert.equal(registry.callCount(), 0);
  assert.equal(funding, 0);
  assert.equal(chain.state.transfers.length, 1);
});

test("a failed Nano execution-claim write buys no inference and leaves the deposit usable", { timeout: 5_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "nano-execution-claim-failed-"));
  const stateFile = join(dir, "gate-state.json"), chain = fakeChain();
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "fixture" }], costUsd: 0.05 }) });
  let funded = 0;
  const gate = makeGate(chain, { stateFile, registry, pollMs: 5, fundRun: (_terms, run) => { funded++; return run(); } });
  t.after(async () => {
    await gate.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const wrapped = gate.wrapRegistry(registry), args = { Text: "fixture" };
  const quote = argOf(await wrapped.callTool({ name: "poster", arguments: args }));
  chain.state.receivable[testHash(125)] = { amount: quote.amountRaw, source: PAYER };
  assert.equal(await gate.waitForPayment(quote.paymentId, 1_000), "paid");
  await until("the original receipt to settle on disk", () => gate.persistenceStatus().pendingWrites === 0);
  const call = { name: "poster", arguments: { ...args, _payment_id: quote.paymentId } };
  await mkdir(stateFile + ".tmp");
  const unavailable = await Promise.all([wrapped.callTool(call), wrapped.callTool(call)]);
  for (const result of unavailable) assert.match(result.content[0].text, /could not record the workflow start/);
  assert.equal(funded, 0);
  assert.equal(registry.callCount(), 0);
  assert.equal(chain.state.transfers.length, 0);
  assert.equal(gate.quote(quote.paymentId).status, "paid");
  assert.equal(gate.fundingLiabilitiesRaw(), BigInt(quote.amountRaw));
  await rm(stateFile + ".tmp", { recursive: true });
  const retry = await Promise.all([wrapped.callTool(call), wrapped.callTool(call)]);
  for (const result of retry) assert.equal(result.isError, undefined);
  assert.equal(funded, 1);
  assert.equal(registry.callCount(), 1);
});

test("Nano restore retains aged settlement gaps and holds a send with the wrong recipient", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nano-settlement-evidence-"));
  const stateFile = join(dir, "gate-state.json"), chain = fakeChain(), registry = fakeRegistry();
  let gate;
  t.after(async () => {
    await gate?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const args = { Text: "completed workflow" };
  const past = Date.now() - 25 * 60 * 60_000;
  const result = { content: [{ type: "text", text: "recorded result" }] };
  const settled = { tool: "poster", argsHash: hashArgs("poster", args), usd: 0.05,
    pair: { usdNano: "1000000000", raw: String(10n ** 30n) }, amountRaw: "100", createdAt: past,
    expiresAt: past + 900_000, completedAt: past + 30_000, status: "consumed", source: PAYER,
    runDeadlineAt: past + 1_800_000, settled: true, result,
    settleReceipt: { author: true, authorAddress: GATE_ADDR, change: "30", take: "20" } };
  const wrong = { to: GATE_ADDR, amountRaw: "30", event: "change", fields: { paymentId: "pay_wrong" },
    createdAt: past, journaled: true, prepared: null, nextAttemptAt: past };
  await writeFile(stateFile, JSON.stringify({ v: 2, quotes: [
    { ...settled, id: "pay_missing" }, { ...settled, id: "pay_wrong" },
    { ...settled, id: "pay_refund_claim", status: "refunded", settled: false, refundExpected: true, result: null, settleReceipt: null },
  ], owed: [wrong] }));
  gate = makeGate(chain, { stateFile, registry, pollMs: 5 });
  await gate.resume();
  assert.equal(gate.quote("pay_missing")?.status, "consumed", "retention must preserve the missing obligations");
  const replay = await gate.wrapRegistry(registry).callTool({ name: "poster", arguments: { ...args, _payment_id: "pay_missing" } });
  assert.deepEqual(replay, result);
  assert.match(gate.quote("pay_refund_claim").next, /refund needs reconciliation/);
  const refund = await gate.wrapRegistry(registry).callTool({ name: "poster", arguments: { ...args, _payment_id: "pay_refund_claim" } });
  assert.match(refund.content[0].text, /refund needs reconciliation/);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.owed[0].held, true);
  assert.equal(gate.fundingLiabilitiesRaw(), 230n, "reserve incomplete settlements, the mismatched intent and the unproven refund");
  assert.equal(registry.callCount(), 0);
  assert.deepEqual(chain.state.transfers, []);
});

async function gateMaintenance(t) {
  const dir = await mkdtemp(join(tmpdir(), "nano-gate-maintenance-")), file = join(dir, "flag.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maintenance = createMaintenanceBarrier({ file, ownerUid: process.getuid() });
  return { maintenance,
    pause: () => writeFile(file, JSON.stringify({ v: 1, token: "e".repeat(32), operation: "backup", revision: null }), { mode: 0o600 }),
    unpause: () => rm(file) };
}

test("Nano startup records an interrupted refund while admission is paused", async t => {
  const w = await gateMaintenance(t), chain = fakeChain(), registry = fakeRegistry();
  const dir = await mkdtemp(join(tmpdir(), "nano-paused-execution-recovery-"));
  const stateFile = join(dir, "gate-state.json"), id = "pay_interrupted_fixture", now = Date.now();
  const amountRaw = (5n * 10n ** 28n).toString();
  let gate;
  t.after(async () => {
    await gate?.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const args = { Text: "interrupted" };
  await writeFile(stateFile, JSON.stringify({ v: 2, owed: [], quotes: [{ id, tool: "poster", argsHash: hashArgs("poster", args),
    amountRaw, usd: 0.05, pair: { usdNano: "1000000000", raw: String(10n ** 30n) }, source: PAYER,
    createdAt: now - 60_000, paidAt: now - 30_000, expiresAt: now + 900_000,
    payHash: testHash(126), status: "consumed", runDeadlineAt: now + 1_800_000 }] }));
  await w.maintenance.start(async () => {
    await w.pause();
    gate = makeGate(chain, { stateFile, maintenance: w.maintenance, registry, pollMs: 5 });
    await w.maintenance.recover(() => gate.resume());
    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    assert.match(saved.quotes[0].error, /server restarted before recording/);
    assert.deepEqual(saved.owed.map(o => [o.event, o.fields.reason, o.prepared]), [["refund", "interrupted", null]]);
    assert.equal(gate.fundingLiabilitiesRaw(), BigInt(amountRaw));
    assert.deepEqual(chain.state.transfers, []);
    await assert.rejects(gate.wrapRegistry(registry).callTool({ name: "poster", arguments: { ...args, _payment_id: id } }),
      { code: "SERVICE_DRAINING" });
  });
  await w.unpause();
  await until("the original refund to complete after admission reopens", () => gate.quote(id)?.status === "refunded");
  assert.equal(registry.callCount(), 0);
  assert.deepEqual(chain.state.transfers, [{ to: PAYER, amountRaw, describe: "refunded" }]);
});

test("a paused Nano tool preserves a paid quote and retries it exactly once after reopening", async t => {
  const w = await gateMaintenance(t), chain = fakeChain(), registry = fakeRegistry();
  const gate = makeGate(chain, { registry, maintenance: w.maintenance });
  t.after(() => gate.stop());
  const wrapped = gate.wrapRegistry(registry), args = { Text: "one paid idea" };
  const quote = await wrapped.callTool({ name: "poster", arguments: args });
  const payment = quote.structuredContent.x402;
  chain.state.receivable["A".repeat(64)] = { amount: payment.amountRaw, source: PAYER };
  assert.equal(await gate.waitForPayment(payment.paymentId, 1000), "paid");
  await w.pause();
  await assert.rejects(wrapped.callTool({ name: "poster", arguments: { ...args, _payment_id: payment.paymentId } }), { code: "SERVICE_DRAINING", executionNotStarted: true });
  assert.equal(registry.callCount(), 0);
  assert.equal(gate.quote(payment.paymentId).status, "paid");
  assert.equal(chain.state.transfers.length, 0);
  await w.unpause();
  await wrapped.callTool({ name: "poster", arguments: { ...args, _payment_id: payment.paymentId } });
  await wrapped.callTool({ name: "poster", arguments: { ...args, _payment_id: payment.paymentId } });
  assert.equal(registry.callCount(), 1);
  w.maintenance.close(); await gate.stop(); await w.maintenance.waitForIdle();
});

test("Nano result completion cannot hide an unfinished change send or its durable owed fallback", { timeout: 5000 }, async t => {
  const w = await gateMaintenance(t), chain = fakeChain(); let entered, release;
  const reached = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  t.after(() => release());
  const original = chain.ops.transfer;
  chain.ops.transfer = async (...args) => { entered(); await hold; return original(...args); };
  const registry = fakeRegistry({ onCall: async () => ({ content: [{ type: "text", text: "result" }], costUsd: 0.001 }) });
  const stateFile = join(await mkdtemp(join(tmpdir(), "nano-drain-owed-")), "state.json");
  t.after(() => rm(dirname(stateFile), { recursive: true, force: true }));
  const gate = makeGate(chain, { registry, stateFile, maintenance: w.maintenance }); t.after(() => gate.stop());
  const wrapped = gate.wrapRegistry(registry), args = { Text: "with change" };
  const quote = await wrapped.callTool({ name: "poster", arguments: args }), payment = quote.structuredContent.x402;
  chain.state.receivable["B".repeat(64)] = { amount: payment.amountRaw, source: PAYER };
  await gate.waitForPayment(payment.paymentId, 1000);
  const result = await wrapped.callTool({ name: "poster", arguments: { ...args, _payment_id: payment.paymentId } });
  assert.equal(result.isError, undefined); await reached;
  w.maintenance.close(); await gate.stop();
  let drained = false; const idle = w.maintenance.waitForIdle().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.equal(w.maintenance.snapshot().counts.wallet, 1);
  chain.state.failTransfer = true; release(); await idle;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.owed.length, 1, "the retry debt must exist before the drain acknowledgement");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal(state.owed[0].fields.paymentId, payment.paymentId);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});

test("a failed Nano state flush remains unhealthy after drain until a later snapshot succeeds", { timeout: 5000 }, async t => {
  const w = await gateMaintenance(t), chain = fakeChain(), registry = fakeRegistry();
  const dir = await mkdtemp(join(tmpdir(), "nano-drain-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, "state.json");
  const gate = makeGate(chain, { registry, stateFile, maintenance: w.maintenance });
  await mkdir(stateFile + ".tmp");
  t.after(() => gate.stop());
  const wrapped = gate.wrapRegistry(registry);
  const failed = await wrapped.callTool({ name: "poster", arguments: { Text: "first quote" } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent?.x402, undefined);
  assert.equal(registry.callCount(), 0);
  await w.pause(); await w.maintenance.waitForIdle();
  assert.deepEqual(gate.persistenceStatus(), { enabled: true, ok: false, pendingWrites: 0 });
  await rm(stateFile + ".tmp", { recursive: true }); await w.unpause();
  const repaired = argOf(await wrapped.callTool({ name: "poster", arguments: { Text: "new quote after storage repair" } }));
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(saved.quotes.map(q => q.id), [repaired.paymentId], "a checkout returns only after its quote is durable");
  await w.pause(); await w.maintenance.waitForIdle();
  assert.deepEqual(gate.persistenceStatus(), { enabled: true, ok: true, pendingWrites: 0 });
});

test("a Nano payment stays pending until its original transfer is durable, even after it leaves the RPC window", { timeout: 5000 }, async t => {
  const { maintenance } = await gateMaintenance(t);
  const chain = fakeChain(), registry = fakeRegistry(), dir = await mkdtemp(join(tmpdir(), "nano-pending-deposit-"));
  const gates = [];
  t.after(async () => {
    maintenance.close();
    for (const gate of gates) await gate.stop();
    // Successful replay can return while the wallet is durably recording change.
    await maintenance.waitForIdle();
    await rm(dir, { recursive: true, force: true });
  });
  const stateFile = join(dir, "state.json"), temporary = stateFile + ".tmp";
  const gate = makeGate(chain, { registry, stateFile, maintenance, waitMs: 25, pollMs: 5 });
  gates.push(gate);
  const wrapped = gate.wrapRegistry(registry), args = { Text: "original payment" };
  const quote = async args => {
    const payment = argOf(await wrapped.callTool({ name: "poster", arguments: args }));
    const snapshot = JSON.parse(await readFile(stateFile, "utf8"));
    assert.ok(snapshot.quotes.some(q => q.id === payment.paymentId && q.status === "pending"));
    return payment;
  };
  const [payment, another] = await Promise.all([quote(args), quote({ Text: "simultaneous quote" })]);
  assert.notEqual(payment.amountRaw, another.amountRaw);
  await untilState(stateFile, "the initial history checkpoint", s => s.historyScan?.coveredAt != null);
  await until("the history checkpoint sync", () => gate.persistenceStatus().pendingWrites === 0);
  await mkdir(temporary);
  const hash = "A".repeat(64);
  const callPaid = wrapped => wrapped.callTool({ name: "poster", arguments: { ...args, _payment_id: payment.paymentId } });
  chain.state.receivable[hash] = { amount: payment.amountRaw, source: PAYER };
  await until("a failed write of the payment", () => gate.persistenceStatus().ok === false, 1000);
  const view = gate.quote(payment.paymentId);
  assert.equal(view.status, "pending");
  assert.equal(view.checkingPayment, true);
  assert.equal(view.done, undefined);
  assert.equal(await gate.waitForPayment(payment.paymentId, 25), "pending");
  assert.equal((await callPaid(wrapped)).isError, true);
  assert.equal(registry.callCount(), 0);
  assert.equal(chain.state.transfers.length, 0);

  delete chain.state.receivable[hash];
  await rm(temporary, { recursive: true });
  assert.equal(await gate.waitForPayment(payment.paymentId, 2000), "paid");
  const written = JSON.parse(await readFile(stateFile, "utf8")).quotes.find(q => q.id === payment.paymentId);
  assert.equal(written.payHash, hash);
  assert.equal(written.status, "paid");
  await gate.stop();

  const reopened = makeGate(chain, { registry, stateFile, maintenance });
  gates.push(reopened);
  const running = reopened.wrapRegistry(registry);
  assert.equal((await callPaid(running)).isError, undefined);
  assert.equal((await callPaid(running)).isError, undefined);
  assert.equal(registry.callCount(), 1);
  await reopened.stop();
});

for (const [kind, makeLink] of [["symlink", symlink], ["hardlink", link]]) test(`Nano state snapshots reject a ${kind} staging file without modifying its target`, async t => {
  const w = await gateMaintenance(t), chain = fakeChain(), registry = fakeRegistry();
  const dir = await mkdtemp(join(tmpdir(), "nano-staging-link-")), file = join(dir, "state.json"), target = join(dir, "private-target");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(target, "KEEP PRIVATE STATE"); await makeLink(target, file + ".tmp");
  const gate = makeGate(chain, { registry, stateFile: file, maintenance: w.maintenance }); t.after(() => gate.stop());
  await gate.wrapRegistry(registry).callTool({ name: "poster", arguments: { Text: "refuse unsafe storage" } });
  await w.pause(); await w.maintenance.waitForIdle();
  assert.equal(await readFile(target, "utf8"), "KEEP PRIVATE STATE");
  assert.deepEqual(gate.persistenceStatus(), { enabled: true, ok: false, pendingWrites: 0 });
});
