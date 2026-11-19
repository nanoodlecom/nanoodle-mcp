import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFundingReport } from "../src/funding-report.mjs";
import { createHostedFundingSources } from "../src/hosted-funding.mjs";
import { moneyStateStatus } from "../src/service-lifecycle.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY } from "./fixtures/nano-protocol.mjs";

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
    snapshot: async () => ({ ...value, balanceRaw, process: { pid: -1, secret: "PROVIDER_PRIVATE" } }) });
  t.after(report.stop);
  assert.equal(w.sources.ready(), true);
  assert.equal((await stat(w.file)).mode & 0o777, 0o600);
  const saved = await readFile(w.file, "utf8");
  assert.doesNotMatch(saved, /SECRET|privateExtra/);
  assert.equal(JSON.parse(saved).checkedAt, new Date(2000).toISOString());
  const identity = JSON.parse(saved).process;
  assert.equal(identity.pid, process.pid); assert.equal(identity.uid, process.getuid());
  assert.match(identity.startTicks, /^[1-9][0-9]*$/);
  assert.match(identity.bootId, /^[a-f0-9-]{36}$/);
  assert.doesNotMatch(saved, /PROVIDER_PRIVATE/);
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
  assert.deepEqual(Object.keys(JSON.parse(await readFile(w.file, "utf8"))).sort(), ["checkedAt", "code", "ok", "pause", "process", "runTimeoutMs", "v"]);
  fail = false; await report.refresh(); assert.equal(w.sources.ready(), true);
});

test("runtime funding reports a known read guard refusal without copying RPC diagnostics", async t => {
  const w = await setup(t);
  let cause = "NANO_RPC_READ_QUORUM";
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources,
    snapshot: async () => { throw Object.assign(Error("PRIVATE_RPC_URL"), { code: cause }); } });
  t.after(report.stop);
  const currentCode = async () => { await report.refresh(); return JSON.parse(await readFile(w.file, "utf8")).code; };
  assert.equal(await currentCode(), "nano-rpc-read-quorum");
  cause = "NANO_RPC_UNCONFIRMED_FRONTIER";
  assert.equal(await currentCode(), "nano-rpc-unconfirmed-frontier");
  cause = "PRIVATE_ERROR_CODE";
  assert.equal(await currentCode(), "funding-state-unavailable");
  assert.equal(w.sources.ready(), false);
  assert.doesNotMatch(await readFile(w.file, "utf8"), /PRIVATE/);
});

test("a funding pause keeps the last failed sample and first recovery across a reporter restart", async t => {
  const w = await setup(t);
  let clock = 1000, fail = false;
  const options = { outDir: w.dir, sources: w.sources, now: () => clock, intervalMs: 1_000_000,
    snapshot: async () => {
      if (fail) throw Object.assign(Error("PRIVATE_RPC_URL"), { code: "NANO_RPC_READ_QUORUM" });
      return value;
    } };
  const saved = async () => JSON.parse(await readFile(w.file, "utf8"));
  const before = await startFundingReport(options);
  t.after(before.stop);
  assert.equal((await saved()).pause, undefined);
  fail = true; clock = 6000; await before.refresh();
  clock = 11_000; await before.refresh();
  assert.deepEqual((await saved()).pause, { lastFailedAt: 11_000, recoveredAt: null, code: "nano-rpc-read-quorum" });
  before.stop();
  fail = false; clock = 16_000;
  const after = await startFundingReport(options);
  t.after(after.stop);
  const pause = { lastFailedAt: 11_000, recoveredAt: 16_000, code: "nano-rpc-read-quorum" };
  assert.deepEqual((await saved()).pause, pause);
  assert.equal(w.sources.ready(), true);
  clock += 300_000; await after.refresh();
  assert.deepEqual((await saved()).pause, pause, "the next scheduled probe can still see the failure");
  clock += 15 * 60_000; await after.refresh();
  assert.equal((await saved()).pause, undefined);
});

test("a failed funding snapshot writes only the provider backoff observations", async t => {
  const w = await setup(t);
  const configuration = "a".repeat(64), until = 1000 + 86_400_000;
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => 1000,
    snapshot: async () => { throw Object.assign(Error("PRIVATE_PROVIDER"), { code: "NANO_RPC_READ_QUORUM" }); },
    rpcStatus: () => ({ configuration, configuredPeers: 2, cooldowns: [{ peer: 1, until, url: "PRIVATE_RPC" }],
      readablePeers: 0, checkpoint: { account: "PRIVATE_ACCOUNT" } }),
  });
  t.after(report.stop);
  const saved = await readFile(w.file, "utf8"), value = JSON.parse(saved);
  assert.equal(value.code, "nano-rpc-read-quorum");
  assert.equal(w.sources.ready(), false);
  assert.deepEqual(value.nanoRpc, { configuration, configuredPeers: 2, cooldowns: [{ peer: 1, until }] });
  assert.doesNotMatch(saved, /PRIVATE/);
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
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).pause.code, "funding-storage-unavailable");
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

test("a reused standby proof cannot renew funding admission past its original deadline", async t => {
  let wall = 20_000, elapsed = 0;
  const w = await setup(t, { now: () => elapsed });
  const head = { hash: "A".repeat(64), blockCount: "10" };
  const nanoRpc = { enforced: true, configuredPeers: 3, minimumPeers: 2, networkPeers: 2, readablePeers: 2,
    lastReadAt: 1_000, fundingEvidenceExpiresAt: 31_000,
    standby: { inUse: true, requestsPerMinute: 4, coldPaymentScanRequests: 4 },
    checkpoint: { v: 1, networkGenesis: NANO_GENESIS_HASH, account: NANO_GENESIS_REPLY.contents.account, head, confirmed: head } };
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => wall, intervalMs: 1_000_000,
    snapshot: async () => ({ ...value, nanoRpc }) });
  t.after(report.stop);
  const saved = async () => JSON.parse(await readFile(w.file, "utf8"));
  assert.equal((await saved()).nanoRpc.fundingEvidenceExpiresAt, 31_000);
  elapsed = 5_000;
  assert.equal(w.sources.ready(), true);
  wall = 10_000;
  elapsed = 11_000;
  assert.equal(w.sources.ready(), false, "a wall-clock rewind cannot extend the published lease");
  wall = 31_000;
  await report.refresh();
  assert.equal((await saved()).ok, false);
  assert.equal(w.sources.ready(), false);
});

test("a regular RPC read gives checkout only the remaining lifetime of that read", async t => {
  let elapsed = 0, wall = 60_000;
  const w = await setup(t, { now: () => elapsed });
  const head = { hash: "A".repeat(64), blockCount: "10" };
  const nanoRpc = { enforced: true, configuredPeers: 2, minimumPeers: 2, networkPeers: 2, readablePeers: 2,
    lastReadAt: 5_000, checkpoint: { v: 1, networkGenesis: NANO_GENESIS_HASH,
      account: NANO_GENESIS_REPLY.contents.account, head, confirmed: head } };
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => wall,
    monotonicNow: () => elapsed, intervalMs: 1_000_000, snapshot: async () => ({ ...value, nanoRpc }) });
  t.after(report.stop);
  assert.equal(w.sources.ready(), true);
  elapsed = 4_999;
  assert.equal(w.sources.ready(), true);
  wall = 59_000;
  elapsed = 5_000;
  assert.equal(w.sources.ready(), false, "an old chain read and a clock rewind cannot extend the quote lease");
});

test("a delayed report publication cannot restart an expired quote lease", async t => {
  let elapsed = 0, wall = 60_000, delay = true;
  const w = await setup(t, { now: () => elapsed });
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => wall,
    monotonicNow: () => elapsed, intervalMs: 1_000_000, snapshot: async () => value,
    writerProtection: () => {
      // Run during the asynchronous file publication after the sample has
      // been checked. The wall clock alone cannot expose the elapsed time.
      if (delay) queueMicrotask(() => { elapsed = 60_000; wall = 59_000; });
      return { enforced: true, requiredState: true };
    } });
  t.after(report.stop);
  assert.equal(w.sources.ready(), false);
  delay = false;
  await report.refresh();
  assert.equal(w.sources.ready(), true, "publishing a new, fresh sample restores quoting");
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

test("the private handoff retains only validated public-chain facts and never treats a missing floor as healthy", async t => {
  const w = await setup(t);
  const head = { hash: "A".repeat(64), blockCount: "10" };
  const checkpoint = { v: 1, networkGenesis: NANO_GENESIS_HASH, account: NANO_GENESIS_REPLY.contents.account,
    head, confirmed: head, secret: "PRIVATE_KEY", provider: { token: "PRIVATE_TOKEN" } };
  const rpc = { enforced: true, configuredPeers: 2, minimumPeers: 2, networkPeers: 2, readablePeers: 2,
    lastReadAt: 2000, checkpoint };
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => 2000,
    snapshot: async () => ({ ...value, nanoRpc: rpc }) });
  t.after(report.stop);
  const saved = await readFile(w.file, "utf8"), selected = JSON.parse(saved).nanoRpc.checkpoint;
  assert.equal(w.sources.ready(), true); assert.doesNotMatch(saved, /PRIVATE|secret|provider/);
  assert.deepEqual(selected.head, head); assert.equal(selected.networkGenesis, NANO_GENESIS_HASH);
  assert.equal((await stat(w.file)).mode & 0o777, 0o600);
  for (const bad of [null, { ...checkpoint, account: "invalid" }, { ...checkpoint, networkGenesis: "F".repeat(64) },
    { ...checkpoint, head: { ...head, blockCount: "9" } }, { ...checkpoint, confirmed: { ...head, hash: "B".repeat(64) } }]) {
    rpc.checkpoint = bad; await report.refresh();
    assert.equal(w.sources.ready(), false); assert.equal(JSON.parse(await readFile(w.file, "utf8")).ok, false);
  }
  rpc.checkpoint = checkpoint; await report.refresh(); assert.equal(w.sources.ready(), true);
});

test("private RPC cooldown telemetry selects safe fields and malformed state pauses admission", async t => {
  const w = await setup(t), head = { hash: "A".repeat(64), blockCount: "10" };
  const rpc = { enforced: true, configuredPeers: 3, minimumPeers: 2, networkPeers: 2, readablePeers: 2, lastReadAt: 2000,
    checkpoint: { v: 1, networkGenesis: NANO_GENESIS_HASH, account: NANO_GENESIS_REPLY.contents.account, head, confirmed: head },
    standby: { inUse: false, requestsPerMinute: 4, coldPaymentScanRequests: 4, endpoint: "PRIVATE_STANDBY" },
    configuration: "a".repeat(64), cooldowns: [{ peer: 0, until: 32_000, endpoint: "PRIVATE_CREDENTIAL_URL" }] };
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, now: () => 2000, snapshot: async () => ({ ...value, nanoRpc: rpc }) });
  t.after(report.stop);
  let text = await readFile(w.file, "utf8");
  assert.deepEqual(JSON.parse(text).nanoRpc.cooldowns, [{ peer: 0, until: 32_000 }]);
  assert.deepEqual(JSON.parse(text).nanoRpc.standby, { inUse: false, requestsPerMinute: 4, coldPaymentScanRequests: 4 });
  assert.doesNotMatch(text, /PRIVATE|endpoint/); assert.equal(w.sources.ready(), true);
  rpc.cooldowns = [{ peer: 3, until: 32_000 }]; await report.refresh();
  assert.equal(w.sources.ready(), false);
  text = await readFile(w.file, "utf8"); assert.equal(JSON.parse(text).ok, false);
});

test("a pending refresh cannot keep stale checkout admission alive or discard protected debts", async t => {
  let clock = 1000, finish, snapshots = 0;
  const w = await setup(t, { now: () => clock });
  w.sources.registerNano(() => 20n);
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, intervalMs: 1_000_000,
    now: () => clock,
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
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).pause.code, "funding-report-stale");
  assert.equal(snapshots, 2);
});

test("failed money-state persistence pauses checkout admission without inference and normal queued writes do not", async t => {
  const w = await setup(t); let state = { ok: true, pendingWrites: 2, privateExtra: "PRIVATE_MONEY_EVENT" };
  const report = await startFundingReport({ outDir: w.dir, sources: w.sources, snapshot: async () => value, durableState: () => state });
  t.after(report.stop);
  assert.equal(w.sources.ready(), true);
  assert.deepEqual(JSON.parse(await readFile(w.file, "utf8")).durableState, { ok: true, pendingWrites: 2 });
  state.ok = false; await report.refresh();
  assert.equal(w.sources.ready(), false);
  assert.doesNotMatch(await readFile(w.file, "utf8"), /PRIVATE/);
  state = moneyStateStatus([{ ...state, durabilityUncertain: true }, { ok: true, pendingWrites: 0 }]);
  await report.refresh();
  assert.equal(w.sources.ready(), false);
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).code, "funding-state-durability-uncertain");
  state = { ok: true, pendingWrites: "unknown" }; await report.refresh();
  assert.equal(w.sources.ready(), false);
  assert.equal(JSON.parse(await readFile(w.file, "utf8")).code, "funding-state-unavailable");
  state = { ok: true, pendingWrites: 0 }; await report.refresh();
  assert.equal(w.sources.ready(), true);
});
