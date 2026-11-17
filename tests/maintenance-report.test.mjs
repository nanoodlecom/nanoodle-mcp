import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";
import { startMaintenanceReport, maintenanceProcessIdentity } from "../src/maintenance-report.mjs";

async function world(t) {
  const dir = await mkdtemp(join(tmpdir(), "maintenance-proof-")), control = join(dir, "flag.json");
  const maintenance = createMaintenanceBarrier({ file: control, ownerUid: process.getuid() });
  let storage = { ok: true, pendingWrites: 0, secret: "PRIVATE_KEY" }, writer = { enforced: true, requiredState: true, scopes: 4, secret: "PRIVATE_PATH" };
  const report = await startMaintenanceReport({ outDir: dir, maintenance, moneyState: () => storage, writerProtection: () => writer, intervalMs: 60_000 });
  t.after(async () => { await report.stop(); await rm(dir, { recursive: true, force: true }); });
  return { dir, control, maintenance, report, setStorage: state => { storage = state; }, setWriter: state => { writer = state; },
    pause: () => writeFile(control, JSON.stringify({ v: 1, token: "a".repeat(32), operation: "deploy", revision: "b".repeat(40) }), { mode: 0o600 }) };
}

test("private proof binds Linux process identity and a valid operator token to fully idle healthy state", async t => {
  const w = await world(t);
  const open = await w.report.refresh(); assert.equal(open.readyToStop, false); assert.equal(open.ok, true);
  await w.pause(); const closed = await w.report.refresh();
  assert.equal(closed.readyToStop, true); assert.equal(closed.control.token, "a".repeat(32));
  assert.deepEqual(closed.process, maintenanceProcessIdentity());
  assert.equal(closed.process.pid, process.pid);
  assert.equal((await stat(w.report.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(w.report.file, "utf8"), /PRIVATE|secret/);
  await rm(w.control); assert.equal((await w.report.refresh()).readyToStop, false);
});

test("accepted asynchronous work and pending or failed writes cannot produce a ready-to-stop proof", async t => {
  const w = await world(t); let release;
  const hold = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const work = w.maintenance.run(() => hold); await w.pause();
  assert.equal((await w.report.refresh()).readyToStop, false);
  release(); await work;
  for (const storage of [{ ok: true, pendingWrites: 1 }, { ok: false, pendingWrites: 0 }, { ok: true, pendingWrites: "unknown" }]) {
    w.setStorage(storage); assert.equal((await w.report.refresh()).readyToStop, false);
  }
  w.setStorage({ ok: true, pendingWrites: 0 }); assert.equal((await w.report.refresh()).readyToStop, true);
});

test("unsafe control state, local shutdown and unqualified writer policy fail closed without publishing raw input", async t => {
  const w = await world(t); await w.pause();
  for (const writer of [{ enforced: false, requiredState: true, scopes: 4 }, { enforced: true, requiredState: false, scopes: 4 }, { enforced: true, requiredState: true, scopes: 0 }]) {
    w.setWriter(writer); assert.equal((await w.report.refresh()).readyToStop, false);
  }
  w.setWriter({ enforced: true, requiredState: true, scopes: 4 });
  await writeFile(w.control, "PRIVATE_UNPARSEABLE_VALUE");
  const invalid = await w.report.refresh(); assert.equal(invalid.readyToStop, false); assert.equal(invalid.control.token, null);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/);
  await w.pause(); w.maintenance.close(); assert.equal((await w.report.refresh()).readyToStop, false);
});

test("a proof staging symlink cannot overwrite another file", async t => {
  const w = await world(t), target = join(w.dir, "private");
  await writeFile(target, "KEEP"); await symlink(target, w.report.file + ".tmp");
  await assert.rejects(w.report.refresh()); assert.equal(await readFile(target, "utf8"), "KEEP");
});
