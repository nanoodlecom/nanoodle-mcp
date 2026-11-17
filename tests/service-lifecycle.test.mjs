import { test } from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";
import { createServiceLifecycle, moneyStateStatus } from "../src/service-lifecycle.mjs";
import { createMoneyLog } from "../src/money-log.mjs";
import { mkdtemp, readFile, stat, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("shutdown includes startup, accepted settlement and listeners registered late; repeated signals wait", async () => {
  const maintenance = createMaintenanceBarrier(), startup = deferred(), finish = deferred();
  const work = maintenance.run(() => finish.promise), listeners = [];
  let marketStopped = false, paymentsStopped = false, socketsClosed = false, listenerClosed;
  const lifecycle = createServiceLifecycle({ maintenance, startup: startup.promise, servers: () => listeners,
    stopPayments: async () => { paymentsStopped = true; }, market: () => ({ stop() { marketStopped = true; }, done: Promise.resolve(0) }) });
  const first = lifecycle.stop("SIGTERM"); assert.equal(lifecycle.stop("SIGINT"), first);
  assert.equal(maintenance.accepting(), false); assert.equal(paymentsStopped, false);
  listeners.push({ close(resolve) { listenerClosed = resolve; }, closeReadOnlyStreams() { socketsClosed = true; listenerClosed(); } });
  startup.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(marketStopped, true); assert.equal(paymentsStopped, true); assert.equal(socketsClosed, false);
  finish.resolve(); await work; assert.deepEqual(await first, { exitCode: 0 });
  assert.equal(socketsClosed, true);
});

test("shutdown reports failed persistence and component failures after draining", async () => {
  for (const storageHealthy of [() => true, () => false]) {
    const maintenance = createMaintenanceBarrier();
    const lifecycle = createServiceLifecycle({ maintenance, servers: () => [], market: () => null,
      stopPayments: async () => { if (storageHealthy()) throw Error("component failed"); }, storageHealthy });
    assert.deepEqual(await lifecycle.stop("SIGTERM"), { exitCode: 1 });
    assert.equal(maintenance.snapshot().activeOperations, 0);
  }
});

test("queued money events remain registered until private, synchronized appends finish", async t => {
  const dir = await mkdtemp(join(tmpdir(), "money-log-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "usage.jsonl"), maintenance = createMaintenanceBarrier();
  const writer = createMoneyLog({ file, maintenance, now: () => 1_000 });
  writer.write("paid", { paymentId: "one", amountRaw: "123" });
  writer.write("change", { paymentId: "one", amountRaw: "100" });
  assert.equal(maintenance.snapshot().counts.background, 2);
  maintenance.close(); await maintenance.waitForIdle();
  assert.deepEqual(writer.status(), { ok: true, pendingWrites: 0 });
  assert.deepEqual((await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line).event), ["paid", "change"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("unsafe or failed money appends are visible and cannot be hidden by later successful appends", async t => {
  const dir = await mkdtemp(join(tmpdir(), "money-log-failed-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "usage.jsonl"), target = join(dir, "elsewhere");
  await mkdir(target); await symlink(target, file);
  const writer = createMoneyLog({ file }); writer.write("paid", { paymentId: "lost" }); await writer.flush();
  assert.deepEqual(writer.status(), { ok: false, pendingWrites: 0 });
  await rm(file); writer.write("paid", { paymentId: "later" }); await writer.flush();
  assert.equal(writer.status().ok, false);
  assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).paymentId, "later");
});

test("money write health selects only aggregate status and treats malformed counters as unknown", () => {
  assert.deepEqual(moneyStateStatus([null, { ok: true, pendingWrites: 2, key: "PRIVATE" }, { ok: false, pendingWrites: 1 }]), { ok: false, pendingWrites: 3 });
  for (const pendingWrites of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(moneyStateStatus([{ ok: true, pendingWrites }]), { ok: false, pendingWrites: null });
});
