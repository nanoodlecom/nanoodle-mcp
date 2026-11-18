#!/usr/bin/env node
// Read-only production readiness. No Workflow.run, payment, work generation,
// signing, receive sweep, assignment start, bid, submission or price mutation.
import { readFileSync, mkdirSync, chmodSync, statfsSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { deriveAddress, derivePublicKey, checkAddress } from "nanocurrency";
import { createProbeFetch } from "../src/probe-http.mjs";
import { waitForRecentAppStart } from "../src/probe-startup.mjs";
import { paymentLiabilities, liquidityChecks, nanoLiquidityCheck } from "../src/operational-state.mjs";
import { base58Encode, createNearRpc, loadNearSigner, checkUsdcMerchant, parseNearToYocto } from "../src/near/index.mjs";
import { resolveWalletKey, isThrottleError } from "../src/wallet.mjs";
import { rpcPeerSetId, selectRpcCooldowns } from "../src/rpc-backoff.mjs";
import { parseUsdNano } from "../src/gate.mjs";
import { readCatalog, fetchListingPrice, budgetFromPrice, marketEscrowTerms } from "../src/market/catalog.mjs";
import { createMarketClient, MarketApiError } from "../src/market/client.mjs";
import { MARKET_PLATFORM_FEE_BPS } from "../src/market/fee-guard.mjs";
import { marketNeedUsd } from "../src/market/runner.mjs";
import { computePrice } from "../src/tools.mjs";
import { DEFAULT_HOSTED_RUN_MS } from "../src/hosted-run.mjs";
import { NANO_GENESIS, checkNanoGenesis, nanoAccountView, nanoStandbyConfig, qualifyNanoAccountViews } from "../src/nano-read-pool.mjs";
import { selectNanoCheckpoint } from "../src/nano-checkpoint.mjs";
import { fundingReportFailure, selectFundingPause } from "../src/funding-report.mjs";
import { readNearFunding, readNearTransferFunding } from "../src/near/funding.mjs";
import { RAW_PER_XNO } from "../src/near/rates.mjs";
import { atomicJson, checkGraph, DEFAULT_CHECK_MAX_NEAR } from "./near-check.mjs";

const ALL = ["nano", "near", "usdc", "market"];
const NEAR_BACKFILL_ALERT_MS = 5 * 60_000;
const MARKET_PICKUP_GRACE_MS = 5 * 60_000;
const MARKET_MAX_PAGES = 5;
const REFUND_FUNDING_CODES = new Map([
  ["NEAR_FUNDING_INSUFFICIENT", "near-refund-funding-insufficient"],
  ["NEAR_FUNDING_UNAVAILABLE", "near-refund-funding-unavailable"],
  ["NEAR_FUNDING_STALE", "near-refund-funding-stale"],
]);
class CheckError extends Error {}
const need = (condition, code) => { if (!condition) throw new CheckError(code); };
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const safeCode = e => e instanceof CheckError ? e.message : /^[A-Z_]{2,60}$/.test(e?.code || "") ? e.code : /Timeout|Abort/.test(e?.name || "") ? "request-timeout" : "probe-failed";

export function isMarketWorkerAlive(lock, appDirectory = fileURLToPath(new URL("../", import.meta.url))) {
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return false;
  need(lock.host === hostname() && lock.boot === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "market-worker-lock-is-foreign");
  const processDir = `/proc/${lock.pid}`, releaseDir = realpathSync(appDirectory);
  try {
    const [, entrypoint] = readFileSync(join(processDir, "cmdline"), "utf8").split("\0");
    // A former worker can still have "/current" in argv after that symlink
    // moves. Its kernel working directory stays in the release it started in.
    return isAbsolute(entrypoint || "") && realpathSync(join(processDir, "cwd")) === releaseDir
      && realpathSync(entrypoint) === join(releaseDir, "bin/nanoodle-mcp.mjs");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

export function finishOperationalReport(stateDir, checks, now = Date.now(), { fundingPause = null, nearBackfilling = null } = {}) {
  const latest = join(stateDir, "latest.json");
  let previous; try { previous = readJson(latest); } catch { /* first probe */ }
  const priorBackfill = previous?.nearBackfillSince;
  let nearBackfillSince = Number.isSafeInteger(priorBackfill) && priorBackfill > 0 && priorBackfill <= now ? priorBackfill : null;
  if (nearBackfilling === false) nearBackfillSince = null;
  if (nearBackfilling === true) {
    nearBackfillSince ??= now;
    if (now - nearBackfillSince >= NEAR_BACKFILL_ALERT_MS) {
      checks = [...checks, { stage: "near-watcher-backfill", ok: false, code: "near-watcher-backfill-delayed", domains: [] }];
    }
  }
  const failed = checks.filter(c => !c.ok);
  const fingerprint = createHash("sha256").update(JSON.stringify(failed.map(c => [c.stage, c.code]).sort())).digest("hex");
  const firstSeenAt = previous?.fingerprint === fingerprint && previous.ok === false ? previous.firstSeenAt : now;
  const reminder = Math.floor((now - firstSeenAt) / (6 * 3_600_000));
  const incidentId = createHash("sha256").update(`${fingerprint}:${firstSeenAt}:${reminder}`).digest("hex").slice(0, 32);
  const admission = Object.fromEntries(ALL.map(asset => [asset, !failed.some(c => c.domains?.includes(asset))]));
  const report = { v: 1, ok: failed.length === 0, checkedAt: new Date(now).toISOString(), stage: failed[0]?.stage || "complete",
    admission, checks, ...(failed.length ? { fingerprint, firstSeenAt, incidentId } : {}), ...(fundingPause && { fundingPause }),
    ...(nearBackfillSince !== null && { nearBackfillSince }) };
  mkdirSync(stateDir, { recursive: true, mode: 0o755 }); atomicJson(latest, report);
  // This file contains ONLY fixed probe names/codes and aggregate observations.
  // The separate alert user needs to read it, without access to app secrets.
  chmodSync(latest, 0o644);
  return report;
}

export async function runOperationalCheck(config, deps = {}) {
  const now = deps.now || Date.now, read = deps.readJson || readJson;
  const request = createProbeFetch({ fetch: deps.fetch || globalThis.fetch, timeoutMs: config.timeoutMs || 12_000 });
  const priceWorkflow = deps.computePrice || computePrice;
  const providerReserveUsd = config.providerReserveUsd || "2";
  const checks = [];
  const peerUrls = config.nanoStandby ? [...config.nanoRpcUrls, config.nanoStandby.url] : config.nanoRpcUrls;
  let nanoCooldowns = [];
  let standbyCheckpoint = null;
  const check = async (stage, fn, domains = ALL) => {
    try { const value = await fn(); checks.push({ stage, ok: true }); return value; }
    catch (e) { checks.push({ stage, ok: false, code: safeCode(e), domains }); return null; }
  };
  const http = async (url, init = {}) => {
    const response = await request(url, init); need(response.ok, `http-${response.status}`); return response.json();
  };
  const nanoRpc = async (url, body) => {
    need(["account_info", "block_count", "version", "block_info"].includes(body.action), "probe-action-forbidden");
    const response = await request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    need(response.status !== 429, "nano-rpc-rate-limited");
    need(response.ok, `http-${response.status}`);
    const result = await response.json();
    need(!result.error || !isThrottleError(result.error), "nano-rpc-rate-limited");
    need(!result.error, "nano-rpc-error"); return result;
  };
  const mcp = async (method, params, site = config.site) => {
    need(["initialize", "tools/list"].includes(method) || (method === "tools/call" && params.name === "price_noodle"), "probe-action-forbidden");
    const result = await http(site + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    need(!result.error && result.result, "mcp-error"); return result.result;
  };
  const state = await check("payment-state", async () => {
    const nano = read(join(config.outDir, "gate-state.json")), near = read(join(config.outDir, "near-state.json"));
    need(near.network === config.network && near.merchant === config.merchant, "ledger-account-mismatch");
    const market = config.agents.map(a => read(join(config.marketStateDir, a.handle, "market-state.json")));
    const liabilities = paymentLiabilities({ nano, near, market }, { now: now() });
    for (const code of liabilities.issues) checks.push({ stage: code, ok: false, code, domains: [] });
    return { liabilities, near };
  });
  const runtimeFunding = await check("runtime-funding", async () => {
    const value = read(join(config.outDir, "funding-health.json"));
    need(value?.v === 1, "funding-report-missing");
    const checkedAt = Date.parse(value.checkedAt), age = now() - checkedAt;
    need(Number.isFinite(age) && age <= 60_000 && age >= -30_000, "funding-report-stale");
    if (value.ok === false && Object.hasOwn(value, "code")) throw new CheckError(fundingReportFailure(value.code));
    need(value.enforced === true && value.protectTransfers === true, "funding-not-enforced");
    need(value.writerProtection?.enforced === true, "writer-protection-not-enforced");
    need(value.writerProtection.requiredState === true, "required-state-policy-not-enforced");
    need([value.balanceRaw, value.liabilitiesRaw, value.reservedRaw].every(v => typeof v === "string" && /^\d{1,39}$/.test(v)), "funding-report-invalid");
    const availableRaw = BigInt(value.balanceRaw) - BigInt(value.liabilitiesRaw) - BigInt(value.reservedRaw);
    need(value.ok === true && availableRaw >= 0n, "funding-underfunded");
    need(Number.isSafeInteger(value.activeRuns) && value.activeRuns >= 0, "funding-report-invalid");
    const limit = Object.hasOwn(value, "runTimeoutMs") ? value.runTimeoutMs : DEFAULT_HOSTED_RUN_MS;
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= 24 * 3_600_000, "funding-report-invalid");
    need(value.activeRuns === 0 ? value.oldestStartedAt === null : Number.isSafeInteger(value.oldestStartedAt)
      && value.oldestStartedAt <= now() + 30_000 && now() - value.oldestStartedAt <= limit + 15 * 60_000, "funding-run-stuck");
    const rpc = value.nanoRpc;
    need(rpc?.enforced === true && rpc.configuredPeers === peerUrls.length, "nano-read-guard-not-enforced");
    const minimum = Math.min(2, config.nanoRpcUrls.length);
    need([rpc.networkPeers, rpc.readablePeers].every(n => Number.isSafeInteger(n) && n >= minimum && n <= peerUrls.length)
      && rpc.minimumPeers === minimum, "nano-read-guard-no-quorum");
    need(Number.isSafeInteger(rpc.lastReadAt) && now() - rpc.lastReadAt <= 60_000 && now() - rpc.lastReadAt >= -30_000, "nano-read-guard-stale");
    let checkpoint;
    try { checkpoint = selectNanoCheckpoint(rpc.checkpoint, config.nanoAddress); }
    catch { need(false, "nano-checkpoint-unavailable"); }
    if (config.nanoStandby || rpc.cooldowns !== undefined || rpc.configuration !== undefined) {
      need(rpc.configuration === rpcPeerSetId(peerUrls), "nano-peer-configuration-mismatch");
      try { nanoCooldowns = selectRpcCooldowns(rpc.cooldowns, peerUrls.length, now()); }
      catch { need(false, "nano-cooldown-observation-invalid"); }
    }
    if (config.nanoStandby) {
      const { inUse, requestsPerMinute } = rpc.standby ?? {};
      need(typeof inUse === "boolean" && requestsPerMinute === config.nanoStandby.requestsPerMinute
        && (!inUse || (rpc.readablePeers === 2 && !nanoCooldowns.some(item => item.peer === peerUrls.length - 1))), "nano-standby-observation-invalid");
      if (inUse) standbyCheckpoint = checkpoint.confirmed;
    }
    const pause = selectFundingPause(value.pause, Math.min(now(), checkedAt));
    return { availableRaw, fundingPause: pause?.recoveredAt != null ? pause : null };
  });
  await check("state-disk-space", async () => {
    const fs = (deps.statfs || statfsSync)(config.outDir);
    need(fs.bavail * fs.bsize >= 512 * 1024 * 1024 && fs.bavail / fs.blocks >= 0.05, "state-disk-low");
    need(fs.ffree > 1000, "state-inodes-low");
  });
  await check("state-writable", async () => {
    if (deps.probeStateWrite) return deps.probeStateWrite(config.outDir);
    const path = join(config.outDir, `.operational-check-${process.pid}-${randomBytes(6).toString("hex")}`);
    let fd, created = false;
    try {
      fd = openSync(path, "wx", 0o600); created = true;
      writeSync(fd, "operational-check\n"); fsyncSync(fd);
    } finally {
      try { if (fd != null) closeSync(fd); } finally { if (created) unlinkSync(path); }
    }
  });
  for (const [name, maxAgeMs] of [["nanoodle-market-check", 20 * 60_000], ["nanoodle-near-check", 26 * 3_600_000], ["nanoodle-near-alert-retry", 10 * 60_000]]) {
    await check(`timer-${name}`, async () => {
      const unitState = deps.unitState || (unit => Object.fromEntries(execFileSync("/usr/bin/systemctl", ["show", "--timestamp=unix", unit,
        "--property=LastTriggerUSec", "--property=ActiveEnterTimestamp", "--property=ActiveState", "--property=UnitFileState", "--property=Result"],
      { encoding: "utf8", timeout: 5_000, env: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" } }).trim().split("\n").map(line => { const p = line.indexOf("="); return [line.slice(0, p), line.slice(p + 1)]; })));
      const timer = unitState(name + ".timer"), service = unitState(name === "nanoodle-near-alert-retry" ? "nanoodle-near-alert@retry.service" : name + ".service");
      need(timer.ActiveState === "active" && ["enabled", "enabled-runtime"].includes(timer.UnitFileState), "check-timer-not-enabled");
      const stamp = timer.LastTriggerUSec && timer.LastTriggerUSec !== "n/a" ? timer.LastTriggerUSec : timer.ActiveEnterTimestamp;
      const utc = /^(?:[A-Za-z]{3} )?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? UTC$/.exec(stamp || "");
      const at = /^@\d+(?:\.\d+)?$/.test(stamp || "") ? Number(stamp.slice(1)) * 1000 : utc ? Date.parse(`${utc[1]}T${utc[2]}Z`) : NaN;
      need(Number.isFinite(at), "check-timer-time-unreadable");
      const age = now() - at;
      need(age <= maxAgeMs && age >= -30_000, "check-timer-missed");
      need(service.ActiveState !== "failed" && (!service.Result || service.Result === "success" || service.ActiveState === "activating"), "scheduled-check-failed");
    }, []);
  }
  const nanoNodes = (await Promise.all(config.nanoRpcUrls.map((url, index) => check(`nano-node-${index}`, async () => {
    need(!nanoCooldowns.some(item => item.peer === index), "nano-rpc-rate-limited");
    checkNanoGenesis(await nanoRpc(url, { action: "block_info", hash: NANO_GENESIS, json_block: "true" }));
    const info = await nanoRpc(url, { action: "account_info", account: config.nanoAddress, representative: "true", include_confirmed: "true", receivable: "true" });
    return { info, peer: index, view: nanoAccountView(info, checkAddress) };
  }, [])))).filter(Boolean);
  const nano = await check("nano-frontier-agreement", async () => {
    const { current, lagging, latestConfirmed } = qualifyNanoAccountViews(nanoNodes);
    for (const { peer } of lagging) checks.push({ stage: `nano-node-${peer}-lag`, ok: false, code: "nano-rpc-peer-lagging", domains: [] });
    if (current.length < Math.min(2, config.nanoRpcUrls.length)) {
      need(current.length === 1 && standbyCheckpoint, lagging.length ? "nano-rpc-lagging-peers" : "nano-read-quorum-unavailable");
      need(latestConfirmed.confirmedHeight === BigInt(standbyCheckpoint.blockCount)
        && latestConfirmed.confirmedFrontier === standbyCheckpoint.hash, "nano-standby-checkpoint-disagrees");
    }
    return current.find(row => row.view === latestConfirmed).info;
  });
  if (standbyCheckpoint) checks.push({ stage: "nano-standby", ok: false, code: "nano-standby-covering-quorum", domains: [] });
  const nearNodes = (await Promise.all(config.nearRpcUrls.map((url, index) => check(`near-node-${index}`, async () => {
    const rpc = createNearRpc({ url, fetch: request, timeoutMs: config.timeoutMs || 12_000 });
    const status = await rpc.status();
    need(status.chain_id === config.network, "near-wrong-network");
    need(status.sync_info?.syncing === false, "near-node-syncing");
    const block = await rpc.block({ finality: "final" });
    need(Number.isSafeInteger(Number(block.header.height)) && typeof block.header.hash === "string", "near-block-invalid");
    const age = now() - Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
    need(age <= 90_000 && age >= -30_000, "near-finalized-head-stale");
    return { rpc, block };
  }, [])))).filter(Boolean);
  const near = await check("near-rpc-ready", async () => {
    need(nearNodes.length >= 1, "near-no-fresh-node");
    const highest = nearNodes.reduce((a, b) => Number(a.block.header.height) >= Number(b.block.header.height) ? a : b);
    need(nearNodes.every(n => Number(highest.block.header.height) - Number(n.block.header.height) <= 60
      && (Number(n.block.header.height) !== Number(highest.block.header.height) || n.block.header.hash === highest.block.header.hash)), "near-finalized-nodes-disagree");
    return highest;
  }, ["near", "usdc"]);
  let refundHealth = null;
  const watcherHealth = await check("near-payment-watcher", async () => {
    const health = await http(config.site + "/near/health");
    need(health.active && health.merchant === config.merchant && health.network === config.network, "near-listener-not-active");
    refundHealth = health;
    const age = now() - Date.parse(health.watcher?.lastScanAt);
    need(health.watcher?.listening && Number.isFinite(age) && age < 120_000 && age >= -30_000, "near-watcher-stale");
    need(Number.isSafeInteger(health.watcher.height) && health.watcher.height >= 0
      && typeof health.watcher.backfilling === "boolean", "near-watcher-observation-invalid");
    if (near) {
      const lag = Number(near.block.header.height) - health.watcher.height;
      need(lag <= 120, "near-watcher-behind");
      need(lag >= -120, "near-watcher-ahead");
    }
    return health.watcher;
  }, ["near", "usdc"]);
  const fundingHealth = refundHealth && await check("near-refund-funding", async () => {
    const funding = refundHealth.funding;
    need(funding?.enforced === true, "near-refund-funding-not-enforced");
    const age = now() - funding.checkedAt;
    need(Number.isSafeInteger(funding.checkedAt) && age <= 60_000 && age >= -30_000, "near-refund-funding-stale");
    need(funding.ok === true, REFUND_FUNDING_CODES.get(funding.code) || "near-refund-funding-unhealthy");
    return funding;
  }, ["near", "usdc"]);
  if (fundingHealth) for (const [asset, key] of [["near", "canQuoteNear"], ["usdc", "canQuoteUsdc"]]) {
    await check(`${asset}-refund-admission`, async () => {
      need(fundingHealth[key] === true, "near-refund-capacity-exhausted");
    }, [asset]);
  }
  const rates = await check("exchange-rates", async () => {
    const result = await http(config.site + "/rates");
    need(result.quoting && parseUsdNano(result.nearUsd) > 0n && parseUsdNano(result.xnoUsd) > 0n, "exchange-rate-not-usable");
    for (const name of ["nearUsd", "xnoUsd"]) {
      const source = result.sources?.[name];
      need(source?.usable === true, "exchange-rate-not-usable");
      if (source.live) {
        const age = now() - Date.parse(source.at);
        need(Number.isFinite(age) && age <= 300_000 && age >= -30_000, "exchange-rate-stale");
      } else checks.push({ stage: `static-rate-${name}`, ok: false, code: "static-rate-needs-operator-review", domains: [] });
    }
    return result;
  });
  if (state && nano && rates) await check("nano-liquidity", async () => {
    const result = nanoLiquidityCheck({ liabilities: state.liabilities, nanoBalanceRaw: nano.confirmed_balance,
      xnoUsd: rates.xnoUsd, providerReserveUsd });
    need(result.ok, result.code);
  });
  if (runtimeFunding && rates) await check("nano-unreserved-liquidity", () => {
    // The runtime already accounts for live reservations and liabilities. The
    // on-disk accounting above remains independent so neither counts them twice.
    const minimumUsd = parseUsdNano(providerReserveUsd), rateUsd = parseUsdNano(rates.xnoUsd);
    need(runtimeFunding.availableRaw * rateUsd >= minimumUsd * RAW_PER_XNO, "nano-pool-insufficient-after-reservations");
  }, []);
  await check("mcp-discovery", async () => {
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nanoodle-operational-check", version: "1" } });
    const result = await mcp("tools/list", {});
    need(["price_noodle", "run_noodle", "noodle_guide"].every(name => result.tools?.some(t => t.name === name)), "mcp-tools-missing");
  });
  await check("nano-mcp-discovery", async () => {
    const target = config.nanoSite;
    need(typeof target === "string" && target.length > 0, "nano-site-not-configured");
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nanoodle-operational-check", version: "1" } }, target);
    const result = await mcp("tools/list", {}, target);
    need((config.nanoExpectedTools || ["sing"]).every(name => result.tools?.some(t => t.name === name)), "mcp-tools-missing");
  }, ["nano"]);
  await check("custom-workflow-pricing", async () => {
    const sample = checkGraph("readonly-operational-probe", true);
    for (const asset of ["near", "usdc"]) {
      const result = await mcp("tools/call", { name: "price_noodle", arguments: { graph: sample.graph, inputs: sample.inputs, _pay_with: asset } });
      need(!result.isError && result.structuredContent?.pricing?.safety?.ok, "custom-workflow-not-priceable");
    }
  }, ["near", "usdc", "market"]);
  if (near) {
    if (config.canaryPayer) await check("near-canary-payer-funding", async () => {
      const { accountId, publicKey, maxNear } = config.canaryPayer;
      need(accountId !== config.merchant && publicKey, "near-canary-payer-proof-unconfigured");
      const amountYocto = parseNearToYocto(maxNear);
      need(amountYocto > 0n, "near-canary-payer-proof-unconfigured");
      const funding = await readNearTransferFunding({ rpc: near.rpc, network: config.network, accountId, publicKey, amountYocto, now });
      need(funding.sufficient, "near-canary-payer-insufficient");
    }, []);
    await check("near-refund-authority", async () => {
      const key = await near.rpc.viewAccessKey({ accountId: config.merchant, publicKey: config.nearPublicKey });
      need(key.permission === "FullAccess", "near-refund-key-not-authorized");
    }, ["near", "usdc"]);
    const token = await check("usdc-receive-registration", () => checkUsdcMerchant({ rpc: near.rpc, network: config.network, merchantId: config.merchant }), ["usdc"]);
    const funding = await check("near-fee-and-balance-reads", async () => {
      let last;
      for (const node of [near, ...nearNodes.filter(n => n !== near)]) {
        try {
          const frame = await readNearFunding({ rpc: node.rpc, network: config.network, accountId: config.merchant,
            publicKey: config.nearPublicKey, tokenContract: token?.tokenContract, now });
          return { nearBalanceYocto: frame.balanceYocto.toString(), storageUsage: frame.storageUsage, costs: frame.costs,
            usdcBalanceAtomic: frame.usdcAtomic?.toString() ?? null };
        } catch (e) { last = e; }
      }
      throw last;
    }, ["near", "usdc"]);
    if (funding && state && rates) await check("refund-liquidity-accounting", async () => {
      const results = liquidityChecks({ ...funding, usdcBalanceAtomic: funding.usdcBalanceAtomic ?? "0", liabilities: state.liabilities, nanoBalanceRaw: nano?.confirmed_balance || "0",
        xnoUsd: rates.xnoUsd, providerReserveUsd });
      for (const result of results.filter(r => r.stage !== "nano-liquidity")) checks.push({ ...result, ...(result.ok ? {} : { domains: result.stage === "usdc-liquidity" ? ["usdc"] : ["near", "usdc"] }) });
    }, ["near", "usdc"]);
  }
  const platform = await check("market-platform-fee", async () => {
    const result = await http(config.marketUrl + "/v1/platform/config");
    need(result.platform_fee_bps === MARKET_PLATFORM_FEE_BPS, "market-fee-assumption-changed"); return result;
  }, ["market"]);
  await Promise.all(config.agents.map(async agent => {
    await check(`market-process-${agent.handle}`, async () => {
      const lock = read(join(config.marketStateDir, agent.handle, "worker.lock"));
      const alive = deps.isWorkerAlive || isMarketWorkerAlive;
      need(Number.isSafeInteger(lock?.pid) && lock.pid > 0 && alive(lock), "market-worker-process-missing");
    }, ["market"]);
    const assignments = await check(`market-auth-${agent.handle}`, async () => {
      const token = (deps.readText || (file => readFileSync(file, "utf8")))(agent.tokenFile).trim();
      const client = createMarketClient({ baseUrl: config.marketUrl, token, fetch: request });
      try { return await client.listActionable({ maxPages: MARKET_MAX_PAGES }); }
      catch (error) {
        if (error instanceof MarketApiError && error.status !== null) {
          throw new CheckError(error.status === 200 ? "market-auth-response-invalid" : `http-${error.status}`);
        }
        throw error;
      }
    }, ["market"]);
    if (assignments) await check(`market-escrow-${agent.handle}`, () => {
      for (const row of assignments) {
        if (row?.job?.jobKind === "competition") continue;
        const { code } = marketEscrowTerms(row?.assignment);
        need(!code, code?.toLowerCase().replaceAll("_", "-"));
      }
    }, ["market"]);
    if (assignments) await check(`market-intake-${agent.handle}`, () => {
      need(assignments.length < MARKET_MAX_PAGES * 100, "market-intake-scan-incomplete");
      const active = assignments.filter(row => row?.job?.jobKind !== "competition");
      if (!active.length) return;
      // Read after the remote poll. The worker persists its record before starting a hire.
      const state = read(join(config.marketStateDir, agent.handle, "market-state.json"));
      need(state?.v === 1 && state.assignments && typeof state.assignments === "object" && !Array.isArray(state.assignments),
        "market-intake-state-invalid");
      const checkedAt = now(), seen = new Set();
      for (const row of active) {
        const a = row?.assignment;
        need(typeof a?.assignmentId === "string" && a.assignmentId && a.status === "in_progress" && !seen.has(a.assignmentId),
          "market-intake-response-invalid");
        seen.add(a.assignmentId);
        const hiredAt = Date.parse(a.createdAt), deadline = Date.parse(a.slaDeadlineAt);
        need(Number.isFinite(hiredAt) && Number.isFinite(deadline) && deadline >= hiredAt && hiredAt <= checkedAt + 30_000,
          "market-intake-timing-invalid");
        need(deadline > checkedAt, "market-intake-sla-expired");
        if (!Object.hasOwn(state.assignments, a.assignmentId)) {
          need(!a.startedAt && !a.submittedAt && !a.deliverableUrl && row.latestMessage?.senderSide !== "worker",
            "market-intake-start-without-record");
          need(checkedAt - hiredAt <= MARKET_PICKUP_GRACE_MS, "market-intake-untracked");
        }
      }
    }, ["market"]);
    if (!agent.defaultWorkflow) return;
    await check(`workflow-price-${agent.handle}`, async () => {
      const priced = await priceWorkflow({ graph: agent.defaultWorkflow.graph, inputs: { [agent.defaultWorkflow.inputName]: "A lighthouse at dawn" } },
        { fetch: request, baseUrl: config.nanoGptBase, allowShortLinks: false, limits: { maxDepositUsd: 1_000_000 } });
      need(priced.safety.ok && priced.pricing, "workflow-not-priceable");
      const listing = await fetchListingPrice({ baseUrl: config.marketUrl, handle: agent.handle, fetch: request });
      need(listing.ok && listing.listingStatus === "live", "market-price-unavailable");
      const needUsd = marketNeedUsd(priced.pricing.estimatedCostUsd);
      need(platform && budgetFromPrice(listing.priceUsd) >= needUsd, "market-workflow-underpriced");
      const remote = await mcp("tools/call", { name: "price_noodle", arguments: { graph: agent.defaultWorkflow.graph, inputs: { [agent.defaultWorkflow.inputName]: "A lighthouse at dawn" } } });
      need(!remote.isError && remote.structuredContent?.pricing?.safety?.ok, "mcp-pricing-unavailable");
    }, ["market"]);
  }));
  return finishOperationalReport(config.stateDir, checks.sort((a, b) => a.stage.localeCompare(b.stage)), now(),
    { fundingPause: runtimeFunding?.fundingPause, nearBackfilling: watcherHealth?.backfilling });
}

async function productionConfig(env = process.env) {
  const secret = resolveWalletKey({ privateKey: env.NANO_PRIVATE_KEY, seed: env.NANO_SEED });
  need(secret, "nano-wallet-not-configured");
  const merchant = env.NEAR_MERCHANT;
  const signer = await loadNearSigner({ accountId: merchant, keyFile: env.NEAR_KEY_FILE || null, env });
  const payer = env.CHECK_PAYER;
  const canaryPayer = payer ? { accountId: payer, maxNear: env.CHECK_MAX_NEAR || DEFAULT_CHECK_MAX_NEAR,
    publicKey: env.CHECK_PAYER_PUBLIC_KEY || (/^[a-f0-9]{64}$/.test(payer) ? "ed25519:" + base58Encode(Buffer.from(payer, "hex")) : null) } : null;
  const nanoRpcUrls = env.NANO_RPC_URL.split(",").map(s => s.trim());
  const nanoStandby = nanoStandbyConfig(nanoRpcUrls, { url: env.NANO_RPC_STANDBY_URL, requestsPerMinute: env.NANO_RPC_STANDBY_REQUESTS_PER_MINUTE });
  return { stateDir: env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check", outDir: "/srv/nanoodle-mcp/out",
    marketStateDir: env.MARKET_STATE_DIR, merchant, network: env.NEAR_NETWORK, canaryPayer,
    nanoAddress: deriveAddress(derivePublicKey(secret), { useNanoPrefix: true }), nearPublicKey: signer.publicKey,
    nanoRpcUrls, nanoStandby, nearRpcUrls: env.NEAR_RPC_URL.split(",").map(s => s.trim()),
    site: env.NEAR_PUBLIC_URL || "https://near.nanoodle.com", nanoSite: env.NANO_PUBLIC_URL || "https://mcp.nanoodle.com", marketUrl: env.MARKET_BASE_URL || "https://market.near.ai",
    nanoGptBase: env.NANOGPT_BASE_URL || "https://nano-gpt.com", agents: readCatalog(env.MARKET_AGENTS_FILE).agents };
}

if (import.meta.main) {
  let report;
  try {
    const config = await productionConfig();
    await waitForRecentAppStart(config);
    report = await runOperationalCheck(config);
  }
  catch { report = finishOperationalReport(process.env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check", [{ stage: "preflight", ok: false, code: "check-could-not-finish", domains: ALL }]); }
  console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
}
