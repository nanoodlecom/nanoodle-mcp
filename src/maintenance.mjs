// Operator-owned admission state plus process-local work accounting. No wallet,
// RPC, cancellation or signing. A closed gate never cancels accepted work.
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, normalize } from "node:path";
import { readOperatorJson } from "./operator-file.mjs";
import { qualifyStartupPermit } from "./startup-permit.mjs";

export class MaintenanceError extends Error {
  constructor(code, message) {
    super(message); this.name = "MaintenanceError"; this.code = code;
    if (code === "SERVICE_DRAINING") this.executionNotStarted = true;
  }
}

const KINDS = ["request", "wallet", "background"];
const absent = () => ({ accepting: true, token: null, operation: null, revision: null, code: null });
const unavailable = () => ({ accepting: false, token: null, operation: null, revision: null, code: "maintenance-state-unavailable" });

export function createMaintenanceBarrier({ file = null, ownerUid = 0, now = Date.now, startupFile = null, releaseRoot } = {}) {
  if ((file !== null && (typeof file !== "string" || !isAbsolute(file) || normalize(file) !== file))
    || (startupFile !== null && (file === null || typeof startupFile !== "string" || !isAbsolute(startupFile)
      || normalize(startupFile) !== startupFile || dirname(startupFile) !== dirname(file) || startupFile === file))
    || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || typeof now !== "function") {
    throw new TypeError("Maintenance needs an absolute operator-owned path and a clock");
  }
  const context = new AsyncLocalStorage(), active = new Set(), idleWaiters = new Set();
  let stopping = false, startupCalled = false;

  function control() {
    if (file === null) return absent();
    const read = readOperatorJson(file, ownerUid);
    if (read.status === "absent") return absent();
    if (read.status !== "valid") return unavailable();
    const value = read.value;
    if (Object.keys(value).sort().join(",") !== "operation,revision,token,v"
      || value.v !== 1 || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)
      || !["deploy", "backup"].includes(value.operation)
      || (value.operation === "deploy" ? typeof value.revision !== "string" || !/^[a-f0-9]{40}$/.test(value.revision) : value.revision !== null)) return unavailable();
    return { accepting: false, token: value.token, operation: value.operation, revision: value.revision, code: "maintenance-active" };
  }

  function admission() {
    const state = control();
    return stopping ? { ...state, accepting: false, code: "service-stopping" } : state;
  }

  // Synchronous ledger writes finish in the same event-loop turn. They need
  // an admission check, without turning a synchronous intent API into a promise.
  function assertAdmitted(kind = null) {
    const parent = context.getStore(), accepted = parent && active.has(parent) && !parent.closed;
    const startupEntry = accepted && parent.startup && (kind === "request" || (kind === "background" && !parent.recovery));
    if ((!accepted || startupEntry) && !admission().accepting) {
      throw new MaintenanceError("SERVICE_DRAINING", "New work is paused for maintenance; no work was started");
    }
  }

  function capture(execute, kind = "request") {
    if (typeof execute !== "function" || !KINDS.includes(kind)) throw new TypeError("Invalid service operation");
    assertAdmitted(kind);
    const parent = context.getStore(), nested = parent && active.has(parent) && !parent.closed;
    const startup = nested && parent.startup && (kind === "wallet" || (kind === "background" && parent.recovery));
    return register(execute, kind, !!startup, !!(startup && parent.recovery));
  }

  function register(execute, kind, startup = false, recovery = false) {
    // Register synchronously, before returning a callback or yielding. A wallet
    // task waiting in a queue is already in flight for drain purposes.
    const scope = { kind, startup, recovery, startedAt: now(), started: false, closed: false };
    active.add(scope);
    const close = () => {
      scope.closed = true; active.delete(scope);
      if (!active.size) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); }
    };
    const scheduled = async () => {
      if (scope.closed || scope.started) throw new MaintenanceError("SERVICE_OPERATION_CLOSED", "Service operation cannot start again");
      scope.started = true;
      try { return await context.run(scope, execute); }
      finally { close(); }
    };
    scheduled.cancel = () => {
      if (scope.started && !scope.closed) throw new MaintenanceError("SERVICE_OPERATION_ACTIVE", "Active work must reach its terminal state before releasing its scope");
      close();
    };
    return scheduled;
  }

  return {
    accepting: () => admission().accepting,
    initializing: () => { const parent = context.getStore(); return !!parent?.startup && active.has(parent) && !parent.closed; },
    async start(execute, { pollMs = 250, timeoutMs = 120_000, onWait = () => {} } = {}) {
      if (startupCalled || typeof execute !== "function" || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < pollMs || timeoutMs > 300_000 || typeof onWait !== "function") throw TypeError("Invalid startup handoff");
      startupCalled = true;
      const initial = admission();
      let nanoCheckpoint = null;
      if (initial.accepting) {
        if (startupFile !== null && readOperatorJson(startupFile, ownerUid).status !== "absent") throw new MaintenanceError("MAINTENANCE_STARTUP_UNAVAILABLE", "Startup needs operator reconciliation");
      } else {
        if (startupFile === null || initial.code !== "maintenance-active" || stopping) assertAdmitted();
        const request = { v: 1, token: initial.token, operation: initial.operation, revision: initial.revision };
        const originalFlag = readOperatorJson(file, ownerUid).fingerprint;
        const deadline = performance.now() + timeoutMs;
        let waiting = false;
        while (true) {
          const current = admission();
          if (!originalFlag || readOperatorJson(file, ownerUid).fingerprint !== originalFlag || stopping
            || current.code !== "maintenance-active" || ["token", "operation", "revision"].some(key => current[key] !== initial[key])) throw new MaintenanceError("MAINTENANCE_STARTUP_UNAVAILABLE", "Startup authorization changed; operator reconciliation is required");
          const grant = qualifyStartupPermit({ file: startupFile, ownerUid, request, releaseRoot });
          if (grant.status === "valid") {
            const after = admission();
            if (readOperatorJson(file, ownerUid).fingerprint !== originalFlag
              || readOperatorJson(startupFile, ownerUid).fingerprint !== grant.fingerprint
              || after.code !== current.code || ["token", "operation", "revision"].some(key => after[key] !== current[key])) throw new MaintenanceError("MAINTENANCE_STARTUP_UNAVAILABLE", "Startup authorization changed; operator reconciliation is required");
            nanoCheckpoint = grant.nanoCheckpoint ?? null;
            break;
          }
          if (grant.status !== "absent" || performance.now() >= deadline) throw new MaintenanceError("MAINTENANCE_STARTUP_UNAVAILABLE", "Startup needs a valid process-bound operator permit");
          if (!waiting) { waiting = true; onWait(); }
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      }
      // Initialization is accepted work, while callbacks created by it still
      // need separate admission for requests and routine background passes.
      return register(() => execute(nanoCheckpoint), "background", true)();
    },
    async recover(execute) {
      const parent = context.getStore();
      if (typeof execute !== "function" || !parent?.startup || !active.has(parent) || parent.closed) throw new MaintenanceError("MAINTENANCE_RECOVERY_UNAVAILABLE", "Recovery is restricted to accepted initialization");
      return register(execute, "background", true, true)();
    },
    close() { stopping = true; },
    async waitForIdle() {
      if (admission().accepting) throw new MaintenanceError("SERVICE_NOT_DRAINING", "Close admission before waiting for a drain");
      if (active.has(context.getStore())) throw new MaintenanceError("SERVICE_OPERATION_ACTIVE", "An active operation cannot await its own drain");
      if (active.size) await new Promise(resolve => idleWaiters.add(resolve));
    },
    capture,
    assertAdmitted,
    async run(execute, kind = "request") { return capture(execute, kind)(); },
    snapshot() {
      const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
      for (const scope of active) counts[scope.kind]++;
      return { v: 1, enforced: file !== null, ...admission(), stopping, activeOperations: active.size,
        oldestStartedAt: active.size ? Math.min(...[...active].map(scope => scope.startedAt)) : null, counts };
    },
  };
}

/** Operator environment only; graph/tool arguments cannot configure admission. */
export function maintenanceConfig(env = process.env) {
  const file = env.NANOODLE_MAINTENANCE_FILE, uid = env.NANOODLE_MAINTENANCE_OWNER_UID, startupFile = env.NANOODLE_MAINTENANCE_STARTUP_FILE;
  if (file === undefined) {
    if (uid !== undefined || startupFile !== undefined) throw TypeError("Maintenance startup/owner settings require a control file");
    return { file: null, ownerUid: 0 };
  }
  if (typeof file !== "string" || !isAbsolute(file) || normalize(file) !== file) throw TypeError("Maintenance control file must be an absolute canonical path");
  const text = uid ?? "0";
  if (!/^(0|[1-9][0-9]{0,9})$/.test(text) || Number(text) >= 4_294_967_295) throw TypeError("Maintenance owner UID must be an exact operating-system UID");
  if (startupFile !== undefined && (typeof startupFile !== "string" || !isAbsolute(startupFile) || normalize(startupFile) !== startupFile
    || dirname(startupFile) !== dirname(file) || startupFile === file)) throw TypeError("Startup permit needs a separate canonical path beside the control file");
  return { file, ownerUid: Number(text), ...(startupFile === undefined ? {} : { startupFile }) };
}
