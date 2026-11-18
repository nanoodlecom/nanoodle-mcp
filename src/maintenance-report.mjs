// Private stop proof. No RPC, keys, prompts or inference; never served over HTTP.
import { constants, readFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";

export function maintenanceProcessIdentity() {
  const stat = readFileSync("/proc/self/stat", "utf8"), end = stat.lastIndexOf(") ");
  const fields = stat.slice(end + 2).trim().split(/\s+/), startTicks = fields[19];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (end < 0 || !/^[1-9][0-9]*$/.test(startTicks || "") || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(bootId)) throw Error("Process identity unavailable");
  return { pid: process.pid, uid: process.getuid(), bootId, startTicks };
}
const count = n => Number.isSafeInteger(n) && n >= 0;

export async function startMaintenanceReport({ outDir, maintenance, moneyState, writerProtection,
  intervalMs = 1000, now = Date.now, log = () => {},
}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) throw TypeError("Invalid maintenance report interval");
  const identity = maintenanceProcessIdentity(), file = join(outDir, "maintenance-health.json"), temporary = file + ".tmp";
  let pending = null, failed = false, stopped = false;
  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      let report;
      try {
        const state = maintenance.snapshot(), storage = moneyState(), writer = writerProtection();
        if (state.v !== 1 || ![state.enforced, state.accepting, state.stopping].every(value => typeof value === "boolean")
          || !(state.token === null || (typeof state.token === "string" && /^[a-f0-9]{32}$/.test(state.token)))
          || ![null, "backup", "deploy"].includes(state.operation)
          || !(state.revision === null || (typeof state.revision === "string" && /^[a-f0-9]{40}$/.test(state.revision)))
          || ![null, "maintenance-active", "maintenance-state-unavailable", "service-stopping"].includes(state.code)
          || !count(state.activeOperations) || !["request", "wallet", "background"].every(key => count(state.counts?.[key]))
          || Object.values(state.counts).reduce((sum, n) => sum + n, 0) !== state.activeOperations
          || !(state.oldestStartedAt === null || (Number.isSafeInteger(state.oldestStartedAt) && state.oldestStartedAt > 0))
          || (state.activeOperations === 0) !== (state.oldestStartedAt === null)
          || typeof storage?.ok !== "boolean" || !count(storage.pendingWrites)
          || typeof writer?.enforced !== "boolean" || typeof writer.requiredState !== "boolean" || !count(writer.scopes)) throw Error("Unknown drain state");
        const ok = storage.ok && writer.enforced && writer.requiredState && writer.scopes > 0 && state.code !== "maintenance-state-unavailable";
        const qualifiedFlag = state.enforced && !state.accepting && !state.stopping && state.code === "maintenance-active"
          && /^[a-f0-9]{32}$/.test(state.token) && ((state.operation === "backup" && state.revision === null)
            || (state.operation === "deploy" && /^[a-f0-9]{40}$/.test(state.revision)));
        report = { ok, readyToStop: ok && qualifiedFlag && state.activeOperations === 0 && storage.pendingWrites === 0,
          control: { enforced: state.enforced, accepting: state.accepting, stopping: state.stopping, token: state.token,
            operation: state.operation, revision: state.revision, code: state.code },
          operations: { active: state.activeOperations, oldestStartedAt: state.oldestStartedAt,
            counts: { request: state.counts.request, wallet: state.counts.wallet, background: state.counts.background } },
          moneyState: { ok: storage.ok, pendingWrites: storage.pendingWrites },
          writerProtection: { enforced: writer.enforced, requiredState: writer.requiredState, scopes: writer.scopes } };
      } catch { report = { ok: false, readyToStop: false, code: "maintenance-proof-unavailable" }; }
      report = { ...report, v: 1, process: identity, checkedAt: new Date(now()).toISOString() };
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw Error("Unsafe stop proof staging file");
        await handle.chmod(0o600); await handle.truncate(0); await handle.writeFile(JSON.stringify(report) + "\n");
      } finally { await handle.close(); }
      await rename(temporary, file);
      if (failed) { failed = false; log("Maintenance telemetry recovered"); }
      return report;
    })().finally(() => { pending = null; });
    return pending;
  }
  await refresh();
  const timer = setInterval(() => {
    if (!stopped) refresh().catch(() => {
      if (!failed) { failed = true; log("Maintenance telemetry could not be written; automatic maintenance remains blocked"); }
    });
  }, intervalMs);
  timer.unref?.();
  return { file, refresh, async stop() { stopped = true; clearInterval(timer); await pending; } };
}
