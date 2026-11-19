import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";
import { createNearWatcher, createNearRpc, createNearRpcPool, openNearLedger, NearError } from "../src/near/index.mjs";
import { createFakeChain } from "./fixtures/near-fake-chain.mjs";

async function world() {
  let time = Date.now() - 60_000;
  const chain = createFakeChain({ now: () => time });
  chain.addAccount("merchant.testnet", 10n ** 24n);
  chain.addAccount("payer.testnet", 10n ** 24n);
  const file = join(await mkdtemp(join(tmpdir(), "near-watch-")), "state.json");
  const ledger = openNearLedger({ file, network: "testnet", merchant: "merchant.testnet" });
  const rpc = createNearRpc({ url: "http://chain.fake", fetch: chain.fetch });
  const observed = [];
  let pending = [];
  const opts = { rpc, ledger, merchantId: "merchant.testnet", pendingQuotes: () => pending,
    observeTransfer: async (hash, sender) => { observed.push({ hash, sender }); }, schedule: () => null };
  return { chain, ledger, rpc, observed, opts,
    quote: () => { time += 1000; pending = [{ createdAt: time }]; },
    pay: () => { time += 1000; return chain.transfer("payer.testnet", "merchant.testnet", 123n, { blockTimeMs: time }); },
  };
}

test("native RPC watcher discovers transfers without a caller tx hash and checkpoints across restart", async () => {
  const w = await world();
  const watcher = createNearWatcher(w.opts); await watcher.start();
  w.quote(); const tx = w.pay(); await watcher.tick();
  assert.deepEqual(w.observed, [{ hash: tx, sender: "payer.testnet" }]);
  assert.equal(watcher.status().listening, true);
  watcher.stop();
  const restarted = createNearWatcher(w.opts); await restarted.start();
  assert.equal(w.observed.length, 1, "a persisted cursor does not redeliver a block");
  const next = w.pay(); await restarted.tick();
  assert.equal(w.observed.at(-1).hash, next); restarted.stop();
});

test("a failed receipt lookup or gate confirmation retries the same block, without losing a payment", async () => {
  const w = await world(); let reject = true;
  const watcher = createNearWatcher({ ...w.opts, observeTransfer: async (hash, sender) => {
    if (reject) throw new NearError("RPC_UNAVAILABLE", "temporary failure");
    w.observed.push({ hash, sender });
  } });
  await watcher.start(); const before = w.ledger.getMeta("paymentWatch");
  w.quote(); const tx = w.pay(); await watcher.tick();
  assert.deepEqual(w.ledger.getMeta("paymentWatch"), before);
  assert.equal(watcher.status().listening, false);
  reject = false; await watcher.tick();
  assert.equal(watcher.status().listening, true);
  assert.ok(w.ledger.getMeta("paymentWatch").coveredThroughMs > before.coveredThroughMs);
  assert.equal(w.observed[0].hash, tx); watcher.stop();
});

test("receipt discovery fails over before the watcher checkpoints the block", async t => {
  for (const scenario of ["wrong-block", "missing-receipt", "bad-lookup", "unavailable-lookup"]) {
    const w = await world();
    const method = ["wrong-block", "missing-receipt"].includes(scenario) ? "EXPERIMENTAL_changes" : "EXPERIMENTAL_receipt_to_tx";
    const attempted = [];
    let fallbackUnavailable = scenario === "unavailable-lookup";
    const fetch = async (url, init) => {
      const endpoint = new URL(url).hostname, request = JSON.parse(init.body);
      if (request.method !== method) return w.chain.fetch(url, init);
      attempted.push(endpoint);
      if (endpoint === "fallback.test" && !fallbackUnavailable) return w.chain.fetch(url, init);
      const result = scenario === "wrong-block" ? { block_hash: "different-block", changes: [] }
        : scenario === "missing-receipt" ? { block_hash: request.params.block_id, changes: [
          { cause: { type: "receipt_processing" }, change: { account_id: "merchant.testnet" } },
        ] } : { transaction_hash: "not-a-transaction-hash", sender_account_id: "payer.testnet" };
      const answer = scenario === "unavailable-lookup"
        ? { error: { code: -32000, cause: { name: "UNKNOWN_RECEIPT" } } } : { result };
      return Response.json({ jsonrpc: "2.0", id: request.id, ...answer });
    };
    const rpc = createNearRpcPool({ urls: ["https://primary.test", "https://fallback.test"],
      chainId: "testnet", maxHeadAgeMs: 90_000, fetch });
    const watcher = createNearWatcher({ ...w.opts, rpc });
    t.after(() => watcher.stop());
    await watcher.start();
    const previous = w.ledger.getMeta("paymentWatch");
    w.quote(); const tx = w.pay(); await watcher.tick();
    assert.deepEqual(attempted, ["primary.test", "fallback.test"], scenario);
    if (fallbackUnavailable) {
      assert.equal(watcher.status().listening, false);
      assert.deepEqual(w.ledger.getMeta("paymentWatch"), previous);
      assert.deepEqual(w.observed, []);
      fallbackUnavailable = false; await watcher.tick();
    }
    assert.equal(watcher.status().listening, true, scenario);
    assert.ok(w.ledger.getMeta("paymentWatch").height > previous.height, scenario);
    assert.deepEqual(w.observed, [{ hash: tx, sender: "payer.testnet" }], scenario);
    await watcher.tick();
    assert.equal(w.observed.length, 1);
    await watcher.stop();
  }
});

test("a first startup with old quotes backfills final receipts instead of missing a transfer", async () => {
  const w = await world(); w.quote(); const tx = w.pay();
  const watcher = createNearWatcher(w.opts); await watcher.start();
  assert.deepEqual(w.observed, [{ hash: tx, sender: "payer.testnet" }]);
  assert.equal(watcher.status().backfilling, false); watcher.stop();
});

test("unquoted top-ups are not interpreted as jobs", async () => {
  const w = await world(); const watcher = createNearWatcher(w.opts); await watcher.start();
  w.pay(); await watcher.tick();
  assert.equal(w.observed.length, 0); watcher.stop();
});

test("malformed durable cursor fails closed", async () => {
  const w = await world(); w.ledger.setMeta("paymentWatch", { height: "not a height" });
  assert.throws(() => createNearWatcher(w.opts), (e) => e.code === "STATE_UNREADABLE");
});

test("a long outage keeps new payments live while old payments backfill within one shared budget", async () => {
  const w = await world();
  let inspected = 0;
  const rpc = { ...w.rpc, call: async (method, ...args) => {
    if (method === "EXPERIMENTAL_changes") inspected++;
    return w.rpc.call(method, ...args);
  } };
  const opts = { ...w.opts, rpc, maxBlocksPerTick: 3 };
  const watcher = createNearWatcher(opts); await watcher.start(); w.quote();
  const old = Array.from({ length: 12 }, () => w.pay());
  await watcher.tick();
  assert.equal(w.observed[0].hash, old.at(-1), "the newest finalized payment is checked first");
  assert.equal(watcher.status().backfilling, true);
  assert.ok(inspected <= 3, "live and recovery scans share the request budget");
  const fresh = w.pay(); inspected = 0; await watcher.tick();
  assert.ok(w.observed.some(o => o.hash === fresh), "a new payment does not wait behind the outage backlog");
  assert.ok(inspected <= 3);
  watcher.stop();
  const restarted = createNearWatcher(opts); await restarted.start();
  for (let i = 0; i < 20 && restarted.status().backfilling; i++) await restarted.tick();
  assert.equal(restarted.status().backfilling, false);
  for (const hash of [...old, fresh]) assert.ok(w.observed.some(o => o.hash === hash), "no payment is lost during recovery or restart");
  restarted.stop();
});

test("accepting the last pending quote at the live tip leaves a readable recovery cursor", async () => {
  const w = await world(); let accepted = false;
  const watcher = createNearWatcher({ ...w.opts, maxBlocksPerTick: 1,
    pendingQuotes: () => accepted ? [] : w.opts.pendingQuotes(),
    observeTransfer: async () => { accepted = true; } });
  await watcher.start(); w.quote(); w.pay(); w.pay(); await watcher.tick();
  assert.equal(accepted, true);
  assert.ok(Number.isFinite(w.ledger.getMeta("paymentWatch").backfill.cutoffMs));
  watcher.stop();
  const restarted = createNearWatcher(w.opts); await restarted.start(); restarted.stop();
});

test("a frozen head stops listening without advancing or refreshing the durable cursor", async () => {
  const w = await world(); let at = Date.now();
  const watcher = createNearWatcher({ ...w.opts, now: () => at });
  await watcher.start();
  const before = w.ledger.getMeta("paymentWatch"), scan = watcher.status().lastScanAt;
  at += 90_001;
  assert.equal(watcher.status().listening, false, "even a stalled loop's cached status expires");
  await watcher.tick();
  assert.equal(watcher.status().error, "RPC_STALE");
  assert.equal(watcher.status().lastScanAt, scan);
  assert.deepEqual(w.ledger.getMeta("paymentWatch"), before);
  at = Date.now(); w.pay(); await watcher.tick();
  assert.equal(watcher.status().listening, true, "fresh-head recovery resumes the existing cursor");
  watcher.stop();
});

test("a malformed or future finalized head is rejected before writing initial state", async () => {
  const w = await world(), at = Date.now();
  for (const timestamp of [undefined, "not-a-number", String(BigInt(at + 30_001) * 1_000_000n)]) {
    const block = await w.rpc.block({ finality: "final" });
    block.header.timestamp_nanosec = timestamp;
    const watcher = createNearWatcher({ ...w.opts, now: () => at, rpc: { block: async () => block } });
    await watcher.start();
    assert.equal(watcher.status().listening, false);
    assert.equal(w.ledger.getMeta("paymentWatch"), undefined);
    watcher.stop();
  }
});

test("stop waits for the watcher to durably finish an in-flight payment observation", async () => {
  const w = await world(); let entered, release, completed = false;
  const reached = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  const watcher = createNearWatcher({ ...w.opts, observeTransfer: async (hash, sender) => {
    entered(); await hold; w.observed.push({ hash, sender });
  } });
  await watcher.start(); w.quote(); const tx = w.pay();
  const scan = watcher.tick(); await reached;
  const stopped = watcher.stop().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  assert.equal(w.observed.length, 0);
  release(); await Promise.all([scan, stopped]);
  assert.equal(completed, true); assert.equal(w.observed[0].hash, tx);
  const cursor = w.ledger.getMeta("paymentWatch");
  w.pay(); await watcher.tick();
  assert.deepEqual(w.ledger.getMeta("paymentWatch"), cursor, "explicit ticks cannot restart a stopped watcher");
  assert.equal(watcher.status().listening, false);
});

test("maintenance pauses new NEAR scans without losing finalized payments or hiding an active scan", async t => {
  const w = await world(), dir = await mkdtemp(join(tmpdir(), "watch-maintenance-")), file = join(dir, "flag.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maintenance = createMaintenanceBarrier({ file, ownerUid: process.getuid() });
  let entered, release;
  const reached = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  const watcher = createNearWatcher({ ...w.opts, maintenance, observeTransfer: async (hash, sender) => {
    entered(); await hold; w.observed.push({ hash, sender });
  } });
  await watcher.start(); w.quote(); const first = w.pay();
  const scan = watcher.tick(); await reached;
  await writeFile(file, JSON.stringify({ v: 1, token: "a".repeat(32), operation: "backup", revision: null }), { mode: 0o600 });
  assert.equal(maintenance.snapshot().counts.background, 1);
  assert.equal(watcher.status().listening, false);
  release(); await scan;
  assert.equal(w.observed[0].hash, first);
  assert.equal(maintenance.snapshot().activeOperations, 0);
  const before = w.ledger.getMeta("paymentWatch"), scanAt = watcher.status().lastScanAt;
  const second = w.pay(); await watcher.tick();
  assert.deepEqual(w.ledger.getMeta("paymentWatch"), before);
  assert.equal(watcher.status().lastScanAt, scanAt);
  assert.equal(watcher.status().error, "SERVICE_DRAINING");
  await rm(file); await watcher.tick();
  assert.ok(w.observed.some(o => o.hash === second));
  assert.equal(watcher.status().listening, true);
  assert.equal(maintenance.snapshot().activeOperations, 0);
  await watcher.stop();
});
