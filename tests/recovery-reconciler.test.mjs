import { test } from "node:test";
import assert from "node:assert/strict";
import { startRecoveryReconciler } from "../src/payments/recovery-reconciler.mjs";

const turn = () => new Promise(resolve => setImmediate(resolve));

test("reconciler reports fresh aggregate status and expires its last success", async t => {
  let clock = 1000, calls = 0;
  const worker = await startRecoveryReconciler({ now: () => clock, intervalMs: 60_000,
    reconcile: async () => { calls++; return { state: "idle", privateValue: "PRIVATE" }; } });
  t.after(worker.stop); await turn();
  assert.deepEqual(worker.status(), { enforced: true, ok: true, code: "ok", pending: false, checkedAt: 1000 });
  clock += 60_000;
  assert.equal(worker.status().ok, false); assert.equal(worker.status().code, "recovery-reconcile-stale");
  await worker.refresh(); await turn();
  assert.equal(worker.status().ok, true); assert.equal(calls, 2);
  worker.stop(); assert.equal(worker.status().enforced, false);
  assert.doesNotMatch(JSON.stringify(worker.status()), /PRIVATE/);
});

test("timeout aborts observation but retains the live task and never duplicates queued reconciliation", async t => {
  let calls = 0, finish, signal;
  const worker = await startRecoveryReconciler({ timeoutMs: 15, intervalMs: 60_000,
    reconcile: async options => {
      calls++; signal = options.signal;
      await new Promise(resolve => { finish = resolve; });
      return { state: "confirmed" };
    } });
  t.after(worker.stop);
  assert.equal(signal.aborted, true);
  assert.equal(worker.status().code, "recovery-reconcile-timeout");
  assert.equal(worker.status().pending, true);
  await worker.refresh(); await worker.refresh();
  assert.equal(calls, 1, "a deadline is not evidence that the actual queued task ended");
  finish(); await turn();
  assert.equal(worker.status().pending, false);
  assert.equal(worker.status().ok, false, "late completion does not revive expired observation authority");
});

test("errors stay private and a genuinely new successful attempt can recover", async t => {
  let fail = true;
  const worker = await startRecoveryReconciler({ intervalMs: 60_000,
    reconcile: async () => { if (fail) throw Error("PRIVATE_RPC_URL"); return { state: "idle" }; } });
  t.after(worker.stop); await turn();
  assert.equal(worker.status().code, "recovery-reconcile-unavailable");
  assert.doesNotMatch(JSON.stringify(worker.status()), /PRIVATE/);
  fail = false; await worker.refresh(); await turn();
  assert.equal(worker.status().ok, true);
});

test("stopping a pending worker aborts it without starting a replacement", async () => {
  let calls = 0, finish, signal;
  const worker = await startRecoveryReconciler({ timeoutMs: 15, intervalMs: 60_000,
    reconcile: async options => { calls++; signal = options.signal; await new Promise(r => { finish = r; }); return { state: "idle" }; } });
  worker.stop();
  assert.equal(signal.aborted, true);
  await worker.refresh(); assert.equal(calls, 1);
  finish(); await turn(); assert.equal(worker.status().ok, false);
});

test("a delayed event loop cannot report an over-deadline reconciliation healthy", async t => {
  const { performance } = await import("node:perf_hooks");
  const worker = await startRecoveryReconciler({ timeoutMs: 10, intervalMs: 60_000,
    reconcile: async ({ deadlineAt }) => {
      assert.equal(Number.isFinite(deadlineAt), true);
      const end = performance.now() + 25;
      while (performance.now() < end) { /* The timer cannot run yet. */ }
      return { state: "idle" };
    } });
  t.after(worker.stop);
  assert.equal(worker.status().ok, false);
  assert.equal(worker.status().code, "recovery-reconcile-timeout");
});
