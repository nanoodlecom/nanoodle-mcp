import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNearWatcher, createNearRpc, openNearLedger, NearError } from "../src/near/index.mjs";
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
  await watcher.start(); const before = w.ledger.getMeta("paymentWatch").height;
  w.quote(); const tx = w.pay(); await watcher.tick();
  assert.equal(w.ledger.getMeta("paymentWatch").height, before);
  assert.equal(watcher.status().listening, false);
  reject = false; await watcher.tick();
  assert.equal(watcher.status().listening, true);
  assert.equal(w.observed[0].hash, tx); watcher.stop();
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
