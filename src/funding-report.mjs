import { open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fundingRaw } from "./run-funding.mjs";
import { hostedRunTimeout } from "./hosted-run.mjs";
import { selectNanoCheckpoint } from "./nano-checkpoint.mjs";
import { NANO_COLD_STANDBY_SCAN_REQUESTS } from "./nano-read-pool.mjs";
import { selectRpcCooldowns } from "./rpc-backoff.mjs";
import { maintenanceProcessIdentity } from "./maintenance-report.mjs";
import { readOperatorJson } from "./operator-file.mjs";

const readFailureCodes = new Map([
  ["NANO_RPC_NETWORK_QUORUM", "nano-rpc-network-quorum"],
  ["NANO_RPC_READ_QUORUM", "nano-rpc-read-quorum"],
  ["NANO_RPC_LAGGING_PEERS", "nano-rpc-lagging-peers"],
  ["NANO_RPC_CONFLICT", "nano-rpc-frontier-conflict"],
  ["NANO_RPC_REGRESSION", "nano-rpc-frontier-regressed"],
  ["NANO_RPC_UNCONFIRMED_FRONTIER", "nano-rpc-unconfirmed-frontier"],
  ["NANO_RPC_STANDBY_DISAGREES", "nano-rpc-standby-disagrees"],
  ["NANO_RPC_STANDBY_BUDGET", "nano-rpc-standby-budget"],
  ["NANO_RPC_CHECKPOINT_UNPROVEN", "nano-checkpoint-unproven"],
  ["NANO_RPC_CHECKPOINT_CONFLICT", "nano-checkpoint-conflict"],
  ["NANO_CHECKPOINT_INVALID", "nano-checkpoint-invalid"],
  ["NANO_CHECKPOINT_STORAGE", "nano-checkpoint-storage-unavailable"],
]);
const reportFailureCodes = new Set([
  "funding-state-unavailable", "funding-underfunded", "funding-durable-state-unavailable",
  "funding-state-durability-uncertain",
  "funding-storage-unavailable", "funding-report-stale", "nano-read-guard-unhealthy",
  ...readFailureCodes.values(),
]);
export const fundingReportFailure = code => reportFailureCodes.has(code) ? code : "funding-state-unavailable";

export function selectFundingPause(pause, now) {
  const { lastFailedAt, recoveredAt, code } = pause ?? {};
  const end = recoveredAt ?? lastFailedAt;
  if (!Number.isSafeInteger(lastFailedAt) || lastFailedAt <= 0
      || (recoveredAt !== null && !Number.isSafeInteger(recoveredAt))
      || !Number.isFinite(now) || end < lastFailedAt || end > now || now - end > 15 * 60_000) return null;
  return { lastFailedAt, recoveredAt, code: fundingReportFailure(code) };
}

/** Private telemetry, never financial authority. Snapshot only reads chain and
 * live reservation state; this timer signs nothing and runs no models/work. */
export async function startFundingReport({ outDir, snapshot, sources, writerProtection = null, durableState = null, intervalMs = 5_000, now = Date.now, log = () => {} }) {
  const runTimeoutMs = hostedRunTimeout();
  const identity = maintenanceProcessIdentity();
  const file = join(outDir, "funding-health.json"), temporary = file + ".tmp";
  const { value: previous } = readOperatorJson(file, identity.uid, 16_384);
  let pause = previous?.v === 1
    ? selectFundingPause(previous.pause, Math.min(now(), Date.parse(previous.checkedAt))) : null;
  let lastWriteHealthy = false;
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
        // Select aggregate fields and the public-chain handoff checkpoint
        // explicitly. Private wallet/provider fields must never be copied.
        report = { balanceRaw: balance.toString(), liabilitiesRaw: liabilities.toString(), reservedRaw: reserved.toString(),
          activeRuns: value.activeRuns, oldestStartedAt: value.oldestStartedAt,
          enforced: value.enforced === true, protectTransfers: value.protectTransfers === true,
          ok: balance >= liabilities + reserved };
        if (!report.ok) report.code = "funding-underfunded";
        if (value.nanoRpc) {
          const n = value.nanoRpc;
          if (![n.configuredPeers, n.minimumPeers, n.readablePeers, n.networkPeers, n.lastReadAt].every(x => Number.isSafeInteger(x) && x >= 0)) throw Error("invalid RPC snapshot");
          report.nanoRpc = { enforced: n.enforced === true, configuredPeers: n.configuredPeers, minimumPeers: n.minimumPeers,
            readablePeers: n.readablePeers, networkPeers: n.networkPeers, lastReadAt: n.lastReadAt,
            checkpoint: selectNanoCheckpoint(n.checkpoint) };
          if (n.standby !== undefined) {
            const { inUse, requestsPerMinute, coldPaymentScanRequests } = n.standby;
            if (typeof inUse !== "boolean" || !Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 3 || requestsPerMinute > 120
                || (coldPaymentScanRequests !== undefined && coldPaymentScanRequests !== NANO_COLD_STANDBY_SCAN_REQUESTS)
                || n.configuredPeers < 3 || (inUse && (n.minimumPeers !== 2 || n.readablePeers !== 2))) throw Error("invalid standby observation");
            report.nanoRpc.standby = { inUse, requestsPerMinute,
              ...(coldPaymentScanRequests !== undefined && { coldPaymentScanRequests }) };
          }
          if (n.cooldowns !== undefined || n.configuration !== undefined) {
            if (typeof n.configuration !== "string" || !/^[a-f0-9]{64}$/.test(n.configuration)) throw Error("invalid RPC configuration observation");
            report.nanoRpc.configuration = n.configuration;
            report.nanoRpc.cooldowns = selectRpcCooldowns(n.cooldowns, n.configuredPeers, now());
          }
          const age = now() - n.lastReadAt;
          const rpcHealthy = report.nanoRpc.enforced && n.configuredPeers >= 1 && n.configuredPeers <= 8
            && n.minimumPeers === Math.min(2, n.configuredPeers) && n.readablePeers >= n.minimumPeers && n.networkPeers >= n.minimumPeers
            && n.readablePeers <= n.configuredPeers && n.networkPeers <= n.configuredPeers && age <= 60_000 && age >= -30_000;
          if (!rpcHealthy) { report.ok = false; report.code = "nano-read-guard-unhealthy"; }
        }
        if (durableState) {
          const state = durableState();
          if (typeof state?.ok !== "boolean" || !Number.isSafeInteger(state.pendingWrites) || state.pendingWrites < 0) throw Error("durable write health unavailable");
          const durabilityUncertain = state.durabilityUncertain === true;
          report.durableState = { ok: state.ok && !durabilityUncertain, pendingWrites: state.pendingWrites, ...(durabilityUncertain && { durabilityUncertain: true }) };
          // Normal queued writes do not indicate a failed snapshot.
          if (!report.durableState.ok) {
            report.ok = false;
            report.code = durabilityUncertain ? "funding-state-durability-uncertain" : "funding-durable-state-unavailable";
          }
        }
        if (writerProtection) {
          const proof = writerProtection();
          if (proof?.enforced !== true || typeof proof.requiredState !== "boolean") throw Error("writer protection unavailable");
          report.writerProtection = { enforced: true, requiredState: proof.requiredState };
        }
      } catch (error) {
        report = { ok: false, code: fundingReportFailure(readFailureCodes.get(error?.code)) };
      }
      const checkedAt = now();
      pause = selectFundingPause(pause, checkedAt);
      if (!report.ok) pause = { lastFailedAt: checkedAt, recoveredAt: null, code: report.code };
      else if (lastWriteHealthy && !sources.ready()) {
        pause = { lastFailedAt: checkedAt, recoveredAt: checkedAt, code: "funding-report-stale" };
      } else if (pause?.recoveredAt === null) pause = { ...pause, recoveredAt: checkedAt };
      report = { ...report, process: identity, runTimeoutMs, v: 1, checkedAt: new Date(checkedAt).toISOString(), ...(pause && { pause }) };
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(report) + "\n"); }
        finally { await handle.close(); }
        await rename(temporary, file);
        sources.setStorageReady(true); sources.setReady(report.ok);
        lastWriteHealthy = report.ok;
      } catch (error) {
        lastWriteHealthy = false;
        pause = { lastFailedAt: now(), recoveredAt: null, code: "funding-storage-unavailable" };
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
