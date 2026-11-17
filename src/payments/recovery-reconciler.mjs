/** Observe original signed operations. Never sign, publish, sweep or infer. */
import { performance } from "node:perf_hooks";
export const RECOVERY_RECONCILE_CODES = Object.freeze([
  "ok", "recovery-reconcile-not-started", "recovery-reconcile-timeout",
  "recovery-reconcile-unavailable", "recovery-reconcile-stale", "recovery-reconcile-stopped",
]);

export async function startRecoveryReconciler({ reconcile, intervalMs = 15_000, timeoutMs = 10_000, now = Date.now }) {
  if (typeof reconcile !== "function" || typeof now !== "function"
    || ![intervalMs, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 60_000)) {
    throw TypeError("Recovery reconciliation needs a callback and bounded intervals");
  }
  let pending = null, stopped = false, checkedAt = null, ok = false, code = "recovery-reconcile-not-started";
  function status() {
    const age = now() - checkedAt;
    const fresh = checkedAt !== null && Number.isFinite(age) && age >= 0 && age < 60_000;
    return { enforced: !stopped, ok: !stopped && ok && fresh, checkedAt, pending: pending !== null,
      code: stopped ? "recovery-reconcile-stopped" : ok && !fresh ? "recovery-reconcile-stale" : code };
  }
  function refresh() {
    // Observation timeout does not mean that the queued operation is terminal.
    // Retain the actual task until it settles; never enqueue a duplicate.
    if (pending) return pending.observed;
    if (stopped) return Promise.resolve(false);
    const operation = { controller: new AbortController(), deadlineAt: performance.now() + timeoutMs };
    operation.observed = new Promise(resolve => { operation.resolve = resolve; });
    pending = operation;
    const fail = failure => {
      ok = false; code = failure; checkedAt = now(); operation.outcome = false;
    };
    operation.timer = setTimeout(() => {
      operation.controller.abort(); fail("recovery-reconcile-timeout"); operation.resolve(false);
    }, timeoutMs);
    operation.task = Promise.resolve().then(() => reconcile({ signal: operation.controller.signal, deadlineAt: operation.deadlineAt })).then(result => {
      if (operation.controller.signal.aborted) return;
      if (performance.now() >= operation.deadlineAt) {
        operation.controller.abort(); fail("recovery-reconcile-timeout"); return;
      }
      if (!["idle", "unsigned-released", "confirmed"].includes(result?.state)) throw Error("Invalid recovery result");
      ok = true; code = "ok"; checkedAt = now(); operation.outcome = true;
    }).catch(() => {
      if (!operation.controller.signal.aborted) fail(performance.now() >= operation.deadlineAt
        ? "recovery-reconcile-timeout" : "recovery-reconcile-unavailable");
    }).finally(() => {
      clearTimeout(operation.timer);
      if (pending === operation) pending = null;
      operation.resolve(operation.outcome === true && !operation.controller.signal.aborted);
    });
    return operation.observed;
  }
  await refresh();
  const timer = setInterval(refresh, intervalMs); timer.unref?.();
  return {
    refresh, status,
    stop() {
      stopped = true; clearInterval(timer);
      if (pending) {
        clearTimeout(pending.timer); pending.controller.abort(); pending.resolve(false);
      }
    },
  };
}
