import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync, chmodSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const token = "a".repeat(32), revision = "b".repeat(40);
const flag = { v: 1, token, operation: "deploy", revision };
function world(t) {
  const dir = mkdtempSync(join(tmpdir(), "maintenance-")), file = join(dir, "flag.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const barrier = createMaintenanceBarrier({ file, ownerUid: process.getuid() });
  function put(value = flag) {
    writeFileSync(file + ".next", typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    renameSync(file + ".next", file);
  }
  return { dir, file, barrier, put };
}

test("closing admission preserves accepted work and its nested wallet operations until actually terminal", async t => {
  const w = world(t), entered = deferred(), finish = deferred();
  const run = w.barrier.run(async () => {
    entered.resolve(); await finish.promise;
    assert.equal(await w.barrier.run(async () => "settled", "wallet"), "settled");
  });
  await entered.promise;
  w.put();
  await assert.rejects(w.barrier.run(() => assert.fail("A new run must not start")), { code: "SERVICE_DRAINING", executionNotStarted: true });
  assert.equal(w.barrier.snapshot().activeOperations, 1);
  finish.resolve(); await run;
  assert.equal(w.barrier.snapshot().activeOperations, 0);
  assert.equal(w.barrier.snapshot().token, token);
  assert.equal(w.barrier.accepting(), false, "Completing old work must not clear the operator's pause");
});

test("a queued task remains counted before execution and can run only once", async t => {
  const w = world(t); let calls = 0;
  const queued = w.barrier.capture(async () => { calls++; return 7; }, "wallet");
  assert.equal(w.barrier.snapshot().counts.wallet, 1);
  w.put();
  assert.equal(await queued(), 7);
  await assert.rejects(queued(), { code: "SERVICE_OPERATION_CLOSED" });
  assert.equal(calls, 1);
  assert.equal(w.barrier.snapshot().activeOperations, 0);
});

test("cancellation can release an unstarted queued task but cannot hide active work", async t => {
  const w = world(t), entered = deferred(), finish = deferred();
  const queued = w.barrier.capture(() => assert.fail("Cancelled work must never execute"), "wallet");
  queued.cancel();
  await assert.rejects(queued(), { code: "SERVICE_OPERATION_CLOSED" });
  const active = w.barrier.capture(async () => { entered.resolve(); await finish.promise; });
  const running = active(); await entered.promise;
  assert.throws(() => active.cancel(), { code: "SERVICE_OPERATION_ACTIVE" });
  assert.equal(w.barrier.snapshot().activeOperations, 1);
  finish.resolve(); await running;
  assert.equal(w.barrier.snapshot().activeOperations, 0);
});

test("a detached callback cannot inherit admission from a completed parent", async t => {
  const w = world(t), later = deferred(); let callback;
  await w.barrier.run(async () => {
    callback = later.promise.then(() => w.barrier.run(() => assert.fail("Closed parent must not grant work"), "background"));
  });
  w.put(); later.resolve();
  await assert.rejects(callback, { code: "SERVICE_DRAINING" });
  assert.equal(w.barrier.snapshot().activeOperations, 0);
});

test("missing or unsafe state fails closed without leaking raw values", async t => {
  const w = world(t);
  assert.equal(w.barrier.accepting(), true);
  for (const value of (['{', 'x'.repeat(5000), { ...flag, secret: "PRIVATE_VALUE" }, { ...flag, v: 2 }, { ...flag, token: "PRIVATE_VALUE" }])) {
    w.put(value);
    const snapshot = w.barrier.snapshot();
    assert.equal(snapshot.accepting, false);
    assert.equal(snapshot.token, null);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE_VALUE"), false);
  }
  rmSync(w.file); symlinkSync(join(w.dir, "missing"), w.file);
  assert.equal(w.barrier.accepting(), false);
  rmSync(w.file); w.put(); chmodSync(w.file, 0o666);
  assert.equal(w.barrier.accepting(), false);
  chmodSync(w.file, 0o600); linkSync(w.file, w.file + ".hardlink");
  assert.equal(w.barrier.accepting(), false);
});

test("a non-regular control file cannot block the service event loop", t => {
  const w = world(t);
  execFileSync("mkfifo", [w.file]);
  assert.equal(w.barrier.accepting(), false);
});

test("missing, writable or symlinked parents never grant admission", t => {
  const w = world(t);
  const missing = createMaintenanceBarrier({ file: join(w.dir, "missing", "flag"), ownerUid: process.getuid() });
  assert.equal(missing.accepting(), false);
  chmodSync(w.dir, 0o777); assert.equal(w.barrier.accepting(), false); chmodSync(w.dir, 0o700);
  symlinkSync(w.dir, w.dir + "-link"); t.after(() => rmSync(w.dir + "-link"));
  assert.equal(createMaintenanceBarrier({ file: join(w.dir + "-link", "flag"), ownerUid: process.getuid() }).accepting(), false);
  assert.equal(createMaintenanceBarrier({ file: w.file, ownerUid: process.getuid() + 1 }).accepting(), false);
});

test("a backup flag requires explicit removal; no timer or completion reopens admission", async t => {
  const w = world(t);
  w.put({ v: 1, token, operation: "backup", revision: null });
  assert.equal(w.barrier.snapshot().operation, "backup");
  await assert.rejects(w.barrier.run(async () => 1), { code: "SERVICE_DRAINING" });
  rmSync(w.file);
  assert.equal(await w.barrier.run(async () => 2), 2);
  assert.equal(w.barrier.accepting(), true);
});

// A secure final directory is insufficient if an ancestor is redirected.
test("a symlinked ancestor never grants maintenance admission", t => {
  const w = world(t), link = w.dir + "-ancestor";
  symlinkSync(w.dir, link); t.after(() => rmSync(link));
  const child = join(w.dir, "child");
  execFileSync("mkdir", [child]);
  const redirected = createMaintenanceBarrier({ file: join(link, "child", "flag.json"), ownerUid: process.getuid() });
  assert.equal(redirected.accepting(), false);
  assert.throws(() => createMaintenanceBarrier({ file: w.dir + "/child/../flag.json" }), TypeError);
});

test("synchronous admission checks grant no detached scope and allow an accepted parent's ledger writes", async t => {
  const w = world(t);
  w.barrier.assertAdmitted();
  assert.equal(w.barrier.snapshot().activeOperations, 0);
  await w.barrier.run(async () => { w.put(); w.barrier.assertAdmitted(); });
  assert.throws(() => w.barrier.assertAdmitted(), { code: "SERVICE_DRAINING" });
  assert.equal(w.barrier.snapshot().activeOperations, 0);
});
