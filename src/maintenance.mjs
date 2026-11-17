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
  const context = new AsyncLocalStorage(), active = new Set();

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
        || value.v !== 1 || !/^[a-f0-9]{32}$/.test(value.token || "")
        || !["deploy", "backup"].includes(value.operation)
        || (value.operation === "deploy" ? !/^[a-f0-9]{40}$/.test(value.revision || "") : value.revision !== null)) return unavailable();
      return { accepting: false, token: value.token, operation: value.operation, revision: value.revision, code: "maintenance-active" };
    } catch { return unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  function capture(execute, kind = "request") {
    if (typeof execute !== "function" || !KINDS.includes(kind)) throw new TypeError("Invalid service operation");
    const parent = context.getStore();
    if (!(parent && active.has(parent) && !parent.closed) && !control().accepting) {
      throw new MaintenanceError("SERVICE_DRAINING", "New work is paused for maintenance; no work was started");
    }
    // Register synchronously, before returning a callback or yielding. A wallet
    // task waiting in a queue is already in flight for drain purposes.
    const scope = { kind, startedAt: now(), started: false, closed: false };
    active.add(scope);
    const close = () => { scope.closed = true; active.delete(scope); };
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
    accepting: () => control().accepting,
    capture,
    async run(execute, kind = "request") { return capture(execute, kind)(); },
    snapshot() {
      const counts = Object.fromEntries(KINDS.map(kind => [kind, 0]));
      for (const scope of active) counts[scope.kind]++;
      return { v: 1, enforced: file !== null, ...control(), activeOperations: active.size,
        oldestStartedAt: active.size ? Math.min(...[...active].map(scope => scope.startedAt)) : null, counts };
    },
  };
}
