import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFundingReport } from "../src/funding-report.mjs";
import { createHostedFundingSources } from "../src/hosted-funding.mjs";

const value = { balanceRaw: "100", liabilitiesRaw: "20", reservedRaw: "80", activeRuns: 1,
  oldestStartedAt: 1000, enforced: true, protectTransfers: true, privateExtra: "SECRET" };
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "funding-report-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sources = createHostedFundingSources({ nanoFile: join(dir, "nano.json"), nearFile: join(dir, "near.json"), ...options });
  return { dir, sources, file: join(dir, "funding-health.json") };
}

test("funding health is private aggregate telemetry and insufficient funds pause new quotes", async t => {
  const w = await setup(t); let balanceRaw = "100";
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => 2000,
    snapshot: async () => ({ ...value, balanceRaw }) });
  t.after(report.stop);
  assert.equal(w.sources.ready(), true);
  assert.equal((await stat(w.file)).mode & 0o777, 0o600);
  const saved = await readFile(w.file, "utf8");
  assert.doesNotMatch(saved, /SECRET|privateExtra/);
  assert.equal(JSON.parse(saved).checkedAt, new Date(2000).toISOString());
  balanceRaw = "99"; await report.refresh();
  assert.equal(w.sources.ready(), false);
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).ok, false);
});

test("unreadable financial state fails closed and later recovery can resume quote readiness", async t => {
  const w = await setup(t); let fail = true;
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources,
    snapshot: async () => { if (fail) throw Error("PRIVATE_PROVIDER_ERROR"); return value; } });
  t.after(report.stop);
  assert.equal(w.sources.ready(), false);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(w.file, "utf8"))).sort(), ["checkedAt", "code", "ok", "runTimeoutMs", "v"]);
  fail = false; await report.refresh(); assert.equal(w.sources.ready(), true);
});

test("a write failure pauses sending; read-only recovery does not need to enable sends first", async t => {
  const w = await setup(t);
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources,
    snapshot: async () => ({ ...value, liabilitiesRaw: w.sources.liabilitiesRaw({ readOnly: true }).toString() }) });
  t.after(report.stop);
  await mkdir(w.file + ".tmp");
  await assert.rejects(report.refresh());
  assert.equal(w.sources.ready(), false);
  assert.throws(() => w.sources.liabilitiesRaw(), /funding-state-unwritable/);
  await rm(w.file + ".tmp", { recursive: true });
  await report.refresh();
  assert.equal(w.sources.ready(), true); assert.equal(w.sources.liabilitiesRaw(), 0n);
});

test("the report writer refuses a staging symlink and does not overwrite its target", async t => {
  const w = await setup(t), target = join(w.dir, "private.txt");
  await writeFile(target, "KEEP"); await symlink(target, w.file + ".tmp");
  await assert.rejects(startFundingReport({ outDir: w.dir, sources: w.sources, snapshot: async () => value }));
  assert.equal(await readFile(target, "utf8"), "KEEP");
  assert.equal(w.sources.ready(), false);
});

test("funding telemetry cannot call degraded read coverage healthy", async t => {
  const w = await setup(t);
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => 2000,
    snapshot: async () => ({ ...value, nanoRpc: { enforced: true, configuredPeers: 4, minimumPeers: 2, networkPeers: 1, readablePeers: 1, lastReadAt: 2000 } }) });
  t.after(report.stop);
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).ok, false);
  assert.equal(w.sources.ready(), false);
});

test("lost writer protection pauses quotes and its private error is not published", async t => {
  const w = await setup(t); let lost = false;
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, snapshot: async () => value,
    writerProtection: () => { if (lost) throw Error("PRIVATE_LOCK_PATH"); return { enforced: true, requiredState: true, privatePath: "PRIVATE_LOCK_PATH" }; } });
  t.after(report.stop);
  let saved = JSON.parse(await readFile(w.file, "utf8"));
  assert.deepEqual(saved.writerProtection, { enforced: true, requiredState: true });
  assert.equal(w.sources.ready(), true);
  lost = true; await report.refresh(); saved = JSON.parse(await readFile(w.file, "utf8"));
  assert.equal(saved.ok, false); assert.equal(w.sources.ready(), false);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE/);
});

test("a pending refresh cannot keep stale checkout admission alive or discard protected debts", async t => {
  let clock = 1000, finish, snapshots = 0;
  const w = await setup(t, { now: () => clock });
  w.sources.registerNano(() => 20n);
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, intervalMs: 1_000_000,
    snapshot: async () => { snapshots++; if (snapshots > 1) await new Promise(resolve => { finish = resolve; }); return value; } });
  t.after(report.stop);
  assert.equal(w.sources.ready(), true);
  const original = await readFile(w.file, "utf8");
  const pending = report.refresh();
  assert.equal(report.refresh(), pending, "a stalled refresh is not duplicated");
  clock += 60_000;
  assert.equal(w.sources.ready(), false, "no second report is needed to stop issuing new quotes");
  assert.equal(await readFile(w.file, "utf8"), original);
  assert.equal(w.sources.liabilitiesRaw(), 20n, "settlement still sees the existing obligations");
  finish(); await pending;
  assert.equal(w.sources.ready(), true, "a fresh successful observation restores admission");
  assert.equal(snapshots, 2);
});
