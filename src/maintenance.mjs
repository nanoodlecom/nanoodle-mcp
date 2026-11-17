// Operator-owned admission state plus process-local work accounting. No wallet,
// RPC, cancellation or signing. A closed gate never cancels accepted work.
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export class MaintenanceError extends Error {
  constructor(code, message) {
    super(message); this.name = "MaintenanceError"; this.code = code;
    if (code === "SERVICE_DRAINING") this.executionNotStarted = true;
  }
}

const KINDS = ["request", "wallet", "background"];
const absent = () => ({ accepting: true, token: null, operation: null, revision: null, code: null });
const unavailable = () => ({ accepting: false, token: null, operation: null, revision: null, code: "maintenance-state-unavailable" });

export function createMaintenanceBarrier({ file = null, ownerUid = 0, now = Date.now } = {}) {
  if ((file !== null && (typeof file !== "string" || !isAbsolute(file) || normalize(file) !== file))
    || !Number.isSafeInteger(ownerUid) || ownerUid < 0 || typeof now !== "function") {
    throw new TypeError("Maintenance needs an absolute operator-owned path and a clock");
  }
  const context = new AsyncLocalStorage(), active = new Set(), idleWaiters = new Set();
  let stopping = false;

  function control() {
    if (file === null) return absent();
    let fd;
    try {
      if (realpathSync(dirname(file)) !== dirname(file)) return unavailable();
      const parent = lstatSync(dirname(file));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== ownerUid || (parent.mode & 0o022)) return unavailable();
      const parentUnchanged = () => {
        const current = lstatSync(dirname(file));
        return current.isDirectory() && !current.isSymbolicLink() && current.dev === parent.dev && current.ino === parent.ino
          && current.uid === ownerUid && !(current.mode & 0o022);
      };
      try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (error.code === "ENOENT" && parentUnchanged()) return absent();
        return unavailable();
      }
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ownerUid || (stat.mode & 0o022) || stat.size > 4096) return unavailable();
      const raw = readFileSync(fd);
      if (raw.byteLength > 4096) return unavailable();
      const value = JSON.parse(raw);
      const current = lstatSync(file);
      if (!parentUnchanged() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1
        || current.uid !== ownerUid || (current.mode & 0o022) || current.isSymbolicLink()) return unavailable();
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "operation,revision,token,v"
        || value.v !== 1 || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)
        || !["deploy", "backup"].includes(value.operation)
        || (value.operation === "deploy" ? typeof value.revision !== "string" || !/^[a-f0-9]{40}$/.test(value.revision) : value.revision !== null)) return unavailable();
      return { accepting: false, token: value.token, operation: value.operation, revision: value.revision, code: "maintenance-active" };
    } catch { return unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  function admission() {
    const state = control();
    return stopping ? { ...state, accepting: false, code: "service-stopping" } : state;
  }

  // Synchronous ledger writes finish in the same event-loop turn. They need
  // an admission check, without turning a synchronous intent API into a promise.
  function assertAdmitted() {
    const parent = context.getStore();
    if (!(parent && active.has(parent) && !parent.closed) && !admission().accepting) {
      throw new MaintenanceError("SERVICE_DRAINING", "New work is paused for maintenance; no work was started");
    }
  }

  function capture(execute, kind = "request") {
    if (typeof execute !== "function" || !KINDS.includes(kind)) throw new TypeError("Invalid service operation");
    assertAdmitted();
    // Register synchronously, before returning a callback or yielding. A wallet
    // task waiting in a queue is already in flight for drain purposes.
    const scope = { kind, startedAt: now(), started: false, closed: false };
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
  const file = env.NANOODLE_MAINTENANCE_FILE, uid = env.NANOODLE_MAINTENANCE_OWNER_UID;
  if (file === undefined) {
    if (uid !== undefined) throw TypeError("Maintenance owner UID requires a control file");
    return { file: null, ownerUid: 0 };
  }
  if (typeof file !== "string" || !isAbsolute(file) || normalize(file) !== file) throw TypeError("Maintenance control file must be an absolute canonical path");
  const text = uid ?? "0";
  if (!/^(0|[1-9][0-9]{0,9})$/.test(text) || Number(text) >= 4_294_967_295) throw TypeError("Maintenance owner UID must be an exact operating-system UID");
  return { file, ownerUid: Number(text) };
}
