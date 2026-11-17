import { open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fundingRaw } from "./run-funding.mjs";
import { hostedRunTimeout } from "./hosted-run.mjs";

/** Private telemetry, never financial authority. Snapshot only reads chain and
 * live reservation state; this timer signs nothing and runs no models/work. */
export async function startFundingReport({ outDir, snapshot, sources, intervalMs = 5_000, now = Date.now, log = () => {} }) {
  const runTimeoutMs = hostedRunTimeout();
  const file = join(outDir, "funding-health.json"), temporary = file + ".tmp";
  let pending = null;
  function refresh() {
    if (pending) return pending;
    pending = (async () => {
      let report;
      try {
        const value = await snapshot();
        const balance = fundingRaw(value.balanceRaw), liabilities = fundingRaw(value.liabilitiesRaw), reserved = fundingRaw(value.reservedRaw);
        if (!Number.isSafeInteger(value.activeRuns) || value.activeRuns < 0 ||
            !(value.oldestStartedAt === null || (Number.isSafeInteger(value.oldestStartedAt) && value.oldestStartedAt > 0))) throw Error("invalid snapshot");
        // Select aggregate fields explicitly: no future wallet metadata belongs
        // in this file, or in the separate monitor's public report.
        report = { balanceRaw: balance.toString(), liabilitiesRaw: liabilities.toString(), reservedRaw: reserved.toString(),
          activeRuns: value.activeRuns, oldestStartedAt: value.oldestStartedAt,
          enforced: value.enforced === true, protectTransfers: value.protectTransfers === true,
          ok: balance >= liabilities + reserved };
        if (value.nanoRpc) {
          const n = value.nanoRpc;
          if (![n.configuredPeers, n.minimumPeers, n.readablePeers, n.networkPeers, n.lastReadAt].every(x => Number.isSafeInteger(x) && x >= 0)) throw Error("invalid RPC snapshot");
          report.nanoRpc = { enforced: n.enforced === true, configuredPeers: n.configuredPeers, minimumPeers: n.minimumPeers,
            readablePeers: n.readablePeers, networkPeers: n.networkPeers, lastReadAt: n.lastReadAt };
          const age = now() - n.lastReadAt;
          report.ok &&= report.nanoRpc.enforced && n.configuredPeers >= 1 && n.configuredPeers <= 8
            && n.minimumPeers === Math.min(2, n.configuredPeers) && n.readablePeers >= n.minimumPeers && n.networkPeers >= n.minimumPeers
            && n.readablePeers <= n.configuredPeers && n.networkPeers <= n.configuredPeers && age <= 60_000 && age >= -30_000;
        }
      } catch { report = { ok: false, code: "funding-state-unavailable" }; }
      report = { ...report, runTimeoutMs, v: 1, checkedAt: new Date(now()).toISOString() };
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(report) + "\n"); }
        finally { await handle.close(); }
        await rename(temporary, file);
        sources.setStorageReady(true); sources.setReady(report.ok);
      } catch (error) {
        sources.setStorageReady(false); throw error;
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  await refresh();
  const timer = setInterval(() => refresh().catch(() => log("funding health could not be written; new quotes and Nano sends are paused")), intervalMs);
  timer.unref?.();
  return { refresh, stop: () => clearInterval(timer) };
}
