import { RECOVERY_RECONCILE_CODES } from "./recovery-reconciler.mjs";

/** Select aggregates only. Shared by the private reporter and no-effect probe. */
export function selectRecoveryHealth(value, now = Date.now()) {
  const valid = condition => { if (!condition) throw Error("Invalid recovery health"); };
  valid(value && value.schema === 3 && [value.enforced, value.heightProtected, value.ready].every(x => typeof x === "boolean"));
  const { activeOperations, heldRuns, heldPayouts, queuedPayouts } = value;
  valid([activeOperations, heldRuns, heldPayouts, queuedPayouts].every(x => Number.isSafeInteger(x) && x >= 0)
    && activeOperations <= 1 && heldPayouts <= queuedPayouts);
  const worker = value.reconciler;
  valid(worker && [worker.enforced, worker.ok, worker.pending].every(x => typeof x === "boolean")
    && (worker.checkedAt === null || Number.isSafeInteger(worker.checkedAt) && worker.checkedAt > 0)
    && RECOVERY_RECONCILE_CODES.includes(worker.code));
  const reconciler = { enforced: worker.enforced, ok: worker.ok, pending: worker.pending,
    checkedAt: worker.checkedAt, code: worker.code };
  const age = now - worker.checkedAt;
  const ready = value.ready && value.enforced && value.heightProtected && activeOperations + heldRuns + heldPayouts === 0
    && worker.enforced && worker.ok && worker.code === "ok" && worker.checkedAt !== null && age >= 0 && age < 60_000;
  return { enforced: value.enforced, schema: 3, heightProtected: value.heightProtected,
    activeOperations, heldRuns, heldPayouts, queuedPayouts, ready, reconciler };
}
