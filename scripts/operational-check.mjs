#!/usr/bin/env node
// Read-only production readiness. No Workflow.run, payment, work generation,
// signing, receive sweep, assignment start, bid, submission or price mutation.
import { readFileSync, mkdirSync, mkdtempSync, chmodSync, statfsSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PrivateStateDurabilityError, syncPrivateStateParentSync, writePrivateStateSync } from "../src/private-state.mjs";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { deriveAddress, derivePublicKey, checkAddress, hashBlock } from "nanocurrency";
import { createProbeFetch } from "../src/probe-http.mjs";
import { waitForRecentAppStart } from "../src/probe-startup.mjs";
import { paymentLiabilities, nearLiquidityChecks, nanoLiquidityCheck } from "../src/operational-state.mjs";
import { findUnrecordedNanoPayments, nanoWatchDemand, NANO_SCAN_GRACE_MS } from "../src/operational-nano-watch.mjs";
import { base58Encode, createNearRpc, loadNearSigner, checkUsdcMerchant, parseNearToYocto, USDC_CONTRACTS } from "../src/near/index.mjs";
import { assertFreshBlock, nearBlockIdentity } from "../src/near/freshness.mjs";
import { DUST_STEP_YOCTO, QUOTE_DUST_SLOTS, usdToYocto } from "../src/near/amount.mjs";
import { USDC_RATE } from "../src/near/ft.mjs";
import {
  countOpenNearQuotes, heldNearQuoteAmounts, nearPaymentWatchCoverage, MAX_OPEN_NEAR_QUOTES, PAYMENT_WATCH_META, RETAIN_NEAR_QUOTE_MS,
} from "../src/near/quote-capacity.mjs";
import { resolveWalletKey, isThrottleError } from "../src/wallet.mjs";
import { rpcPeerSetId, selectRpcCooldowns } from "../src/rpc-backoff.mjs";
import { parseUsdNano } from "../src/gate.mjs";
import { readCatalog, fetchListingPrice, budgetFromPrice, marketEscrowTerms } from "../src/market/catalog.mjs";
import { createMarketClient, MarketApiError } from "../src/market/client.mjs";
import { MARKET_PLATFORM_FEE_BPS } from "../src/market/fee-guard.mjs";
import { marketNeedUsd } from "../src/market/runner.mjs";
import { computePrice } from "../src/tools.mjs";
import { DEFAULT_HOSTED_RUN_MS } from "../src/hosted-run.mjs";
import { NANO_GENESIS, checkNanoGenesis, matchesNanoConfirmedBlock, nanoAccountView, nanoStandbyConfig,
  qualifyNanoAccountViews } from "../src/nano-read-pool.mjs";
import { selectNanoCheckpoint } from "../src/nano-checkpoint.mjs";
import { fundingReportFailure, selectFundingPause } from "../src/funding-report.mjs";
import { nearFundingNeed, nearRefundClaims, nearRefundFinalHeight, readNearFunding, readNearTransferFunding } from "../src/near/funding.mjs";
import { RAW_PER_XNO } from "../src/near/rates.mjs";
import { atomicJson, checkGraph, DEFAULT_CHECK_MAX_NEAR } from "./near-check.mjs";

const ALL = ["nano", "near", "usdc", "market"];
const NEAR_BACKFILL_ALERT_MS = 5 * 60_000;
const MARKET_PICKUP_GRACE_MS = 5 * 60_000;
const MARKET_MAX_PAGES = 5;
const SHARED_SAVED_WORKFLOWS = ["image-model-arena", "mix-the-references", "neon-shrine-duel", "photo-to-video", "sing"];
const NEAR_WORKFLOW_TEMPLATE = "idea-to-3d-model";
const CAPACITY_WARNING = 0.8;
const BACKUP_EXPORT_AGE_MS = 2 * 3600_000;
const BACKUP_CAPTURE_AGE_MS = 26 * 3600_000;
const REFUND_FUNDING_CODES = new Map([
  ["NEAR_FUNDING_INSUFFICIENT", "near-refund-funding-insufficient"],
  ["NEAR_FUNDING_UNAVAILABLE", "near-refund-funding-unavailable"],
  ["NEAR_FUNDING_STALE", "near-refund-funding-stale"],
]);
class CheckError extends Error {}
const need = (condition, code) => { if (!condition) throw new CheckError(code); };
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const safeCode = e => e instanceof CheckError ? e.message : /^[A-Z_]{2,60}$/.test(e?.code || "") ? e.code : /Timeout|Abort/.test(e?.name || "") ? "request-timeout" : "probe-failed";
const positiveDecimal = value => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
  && Number.isFinite(Number(value)) && Number(value) > 0;

function backupExportProof(file, read, now) {
  let record;
  try { record = read(file); }
  catch { throw new CheckError("backup-export-proof-unavailable"); }
  const parse = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
    ? Date.parse(value) : NaN;
  const verified = parse(record?.verifiedAt), captured = parse(record?.capturedAt);
  need(record?.v === 1 && Number.isFinite(verified) && Number.isFinite(captured)
    && captured <= verified + 30_000 && verified <= now + 30_000 && captured <= now + 30_000, "backup-export-proof-invalid");
  return { verificationAgeMs: now - verified, captureAgeMs: now - captured };
}

function savedPricingContent(result) {
  const content = result?.structuredContent, pricing = content?.pricing;
  need(!result?.isError && pricing?.currency === "USD" && pricing.safety?.ok === true
    && Array.isArray(pricing.unpriced) && pricing.unpriced.length === 0, "saved-workflow-not-priceable");
  need(!content.payment && !content.quote && !content.x402, "saved-workflow-preview-invalid");
  const amounts = [pricing.estimatedCost?.usd, pricing.likelyCharge?.usd, pricing.deposit?.usd];
  need(amounts.every(positiveDecimal) && Number(amounts[0]) <= Number(amounts[1])
    && Number(amounts[1]) <= Number(amounts[2]), "saved-workflow-preview-invalid");
  return content;
}

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

export function finishOperationalReport(stateDir, checks, now = Date.now(), { fundingPause = null, nearBackfilling = null, invocationId = null } = {}) {
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
  const admission = Object.fromEntries(ALL.map(asset => [asset, !failed.some(c => c.domains?.includes(asset))]));
  const fingerprint = createHash("sha256").update(JSON.stringify([failed.map(c => [c.stage, c.code]).sort(), admission])).digest("hex");
  const firstSeenAt = previous?.fingerprint === fingerprint && previous.ok === false ? previous.firstSeenAt : now;
  const reminder = Math.floor((now - firstSeenAt) / (6 * 3_600_000));
  const incidentId = createHash("sha256").update(`${fingerprint}:${firstSeenAt}:${reminder}`).digest("hex").slice(0, 32);
  const report = { v: 1, ok: failed.length === 0, checkedAt: new Date(now).toISOString(), stage: failed[0]?.stage || "complete",
    admission, checks, ...(/^[a-f0-9]{32}$/.test(invocationId || "") && { invocationId }),
    ...(failed.length ? { fingerprint, firstSeenAt, incidentId } : {}), ...(fundingPause && { fundingPause }),
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
  if (config.backupExportReport) {
    const backup = await check("backup-export-proof", () => backupExportProof(config.backupExportReport, read, now()), []);
    if (backup) {
      await check("backup-export-freshness", () => need(backup.verificationAgeMs <= BACKUP_EXPORT_AGE_MS, "backup-export-overdue"), []);
      await check("backup-capture-freshness", () => need(backup.captureAgeMs <= BACKUP_CAPTURE_AGE_MS, "backup-capture-overdue"), []);
    }
  }
  const http = async (url, init = {}) => {
    const response = await request(url, init); need(response.ok, `http-${response.status}`); return response.json();
  };
  const nanoRpc = async (url, body) => {
    need(["account_info", "account_history", "receivable", "block_count", "version", "block_info"].includes(body.action), "probe-action-forbidden");
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
  async function checkSavedWorkflows(site, tools, assets, heldAmounts = null) {
    const names = assets.includes("nano") ? SHARED_SAVED_WORKFLOWS : [...SHARED_SAVED_WORKFLOWS, NEAR_WORKFLOW_TEMPLATE];
    for (const name of names) {
      const template = name === NEAR_WORKFLOW_TEMPLATE;
      // Share the published graph within this site. Run the next graph's price
      // requests after these finish so a cold catalog isn't fetched in a burst.
      const tool = tools.find(t => t?.name === name);
      const graph = (async () => {
        need(template || tool, "saved-workflow-tool-missing");
        const value = await http(site + (template ? "/examples/" : "/graph/") + name + ".json");
        need(Array.isArray(value?.nodes) && value.nodes.length > 0 && Array.isArray(value.links), "saved-workflow-graph-invalid");
        return value;
      })();
      await Promise.all(assets.map(asset => check(`saved-workflow-${asset}-${name}`, async () => {
        const published = await graph;
        const result = await mcp("tools/call", { name: "price_noodle", arguments: { graph: published, _pay_with: asset === "nano" ? "near" : asset } }, site);
        const content = savedPricingContent(result);
        if (asset === "nano") {
          // Fixed-deposit tools on the live Nano API publish the cold deposit
          // in their generated MCP description, including the payment rail.
          const amount = typeof tool.description === "string"
            && tool.description.match(/Runs on NanoGPT — \$(\d+(?:\.\d+)?) deposit per call, paid in Nano \(XNO\) —/)?.[1];
          need(!tool.pricedPerRequest && positiveDecimal(amount), "saved-nano-deposit-unavailable");
          need(Number(amount) >= Number(content.pricing.likelyCharge.usd), "saved-nano-deposit-too-low");
        } else {
          const currency = content[asset];
          need(currency?.network === config.network, "saved-workflow-denomination-invalid");
          if (asset === "usdc") {
            need(currency.tokenContract === USDC_CONTRACTS[config.network] && currency.decimals === 6
              && currency.usdcUsd === "1", "saved-workflow-denomination-invalid");
          } else {
            need(positiveDecimal(currency.rate?.nearUsd) && positiveDecimal(currency.depositNear)
              && positiveDecimal(currency.likelyChargeNear) && Number(currency.depositNear) >= Number(currency.likelyChargeNear),
            "saved-workflow-denomination-invalid");
          }
          const held = heldAmounts?.[asset];
          if (held?.size >= Math.ceil(QUOTE_DUST_SLOTS * CAPACITY_WARNING)) {
            // The native preview gives the dust-rounded base, before a unique
            // payment amount is assigned. USDC uses whole micro-USDC units.
            const base = asset === "near" ? parseNearToYocto(currency.depositNear)
              : usdToYocto(content.pricing.deposit.usd, USDC_RATE, "ceil");
            const step = asset === "near" ? DUST_STEP_YOCTO : 1n;
            let occupied = 0;
            for (let dust = 1; dust <= QUOTE_DUST_SLOTS; dust++) {
              if (held.has((base + BigInt(dust) * step).toString())) occupied++;
            }
            need(occupied < QUOTE_DUST_SLOTS, "saved-workflow-quote-amounts-exhausted");
            need(occupied < Math.ceil(QUOTE_DUST_SLOTS * CAPACITY_WARNING), "saved-workflow-quote-amounts-low");
          }
        }
      }, [])));
    }
  }
  const readNearLedger = () => {
    const ledger = read(join(config.outDir, "near-state.json"));
    need(ledger?.v === 1 && ledger.network === config.network && ledger.merchant === config.merchant, "ledger-account-mismatch");
    return ledger;
  };
  const readNanoLedger = () => read(join(config.outDir, "gate-state.json"));
  const state = await check("payment-state", async () => {
    const nano = readNanoLedger(), near = readNearLedger();
    const market = config.agents.map(a => read(join(config.marketStateDir, a.handle, "market-state.json")));
    const liabilities = paymentLiabilities({ nano, near, market }, { now: now() });
    for (const code of liabilities.issues) checks.push({ stage: code, ok: false, code, domains: [] });
    return { liabilities, near };
  });
  const heldNearAmounts = state && await check("near-open-quote-capacity", () => {
    const quotes = Object.values(state.near.quotes), checkedAt = now();
    const open = countOpenNearQuotes(quotes, checkedAt);
    need(open < MAX_OPEN_NEAR_QUOTES, "near-open-quote-capacity-exhausted");
    if (open >= Math.ceil(MAX_OPEN_NEAR_QUOTES * CAPACITY_WARNING)) {
      checks.push({ stage: "near-open-quote-headroom", ok: false, code: "near-open-quote-capacity-low", domains: [] });
    }
    const coveredThroughMs = nearPaymentWatchCoverage(state.near.meta?.[PAYMENT_WATCH_META]);
    return Object.fromEntries(["near", "usdc"].map(asset => [asset, heldNearQuoteAmounts(quotes, asset, checkedAt, RETAIN_NEAR_QUOTE_MS, { coveredThroughMs })]));
  }, ["near", "usdc"]);
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
    return { availableRaw, checkpoint, fundingPause: pause?.recoveredAt != null ? pause : null };
  });
  await check("state-disk-space", async () => {
    const fs = (deps.statfs || statfsSync)(config.outDir);
    need(fs.bavail * fs.bsize >= 512 * 1024 * 1024 && fs.bavail / fs.blocks >= 0.05, "state-disk-low");
    need(fs.ffree > 1000, "state-inodes-low");
  });
  await check("state-writable", async () => {
    if (deps.probeStateWrite) return deps.probeStateWrite(config.outDir);
    let dir;
    try {
      dir = mkdtempSync(join(config.outDir, ".operational-check-"));
      const path = join(dir, "probe.json"), data = '{"probe":true}\n';
      writePrivateStateSync(path, data);
      need(readFileSync(path, "utf8") === data, "state-disk-readback-mismatch");
      syncPrivateStateParentSync(dir); // also verify the production state directory itself
    } catch (error) {
      if (error instanceof CheckError) throw error;
      throw new CheckError(error instanceof PrivateStateDurabilityError ? "state-disk-commit-uncertain" : "state-disk-write-failed");
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
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
  const nanoAnchor = runtimeFunding?.checkpoint.confirmed;
  const nanoAnchorHeight = nanoAnchor ? BigInt(nanoAnchor.blockCount) : null;
  const nanoNodes = (await Promise.all(config.nanoRpcUrls.map(async (url, index) => {
    let observation;
    await check(`nano-node-${index}`, async () => {
      need(!nanoCooldowns.some(item => item.peer === index), "nano-rpc-rate-limited");
      checkNanoGenesis(await nanoRpc(url, { action: "block_info", hash: NANO_GENESIS, json_block: "true" }));
      const info = await nanoRpc(url, { action: "account_info", account: config.nanoAddress, representative: "true", include_confirmed: "true", receivable: "true" });
      const view = nanoAccountView(info, checkAddress);
      // Keep a valid account observation for detecting a conflicting view
      // even if this peer cannot prove the earlier block.
      observation = { info, peer: index, view, witnessed: false };
      if (nanoAnchor && view.confirmedHeight > nanoAnchorHeight) {
        const block = await nanoRpc(url, { action: "block_info", hash: nanoAnchor.hash, json_block: "true" });
        need(matchesNanoConfirmedBlock(block, { account: config.nanoAddress, anchor: nanoAnchor, hashBlock }),
          "nano-confirmed-checkpoint-unverified");
      }
      observation.witnessed = !nanoAnchor || view.confirmedHeight > nanoAnchorHeight
        || (view.confirmedHeight === nanoAnchorHeight && view.confirmedFrontier === nanoAnchor.hash);
    }, []);
    return observation;
  }))).filter(Boolean);
  const nano = await check("nano-frontier-agreement", () => {
    const { current, lagging, latestConfirmed } = qualifyNanoAccountViews(nanoNodes);
    const behind = current.filter(({ view }) => nanoAnchor && view.confirmedHeight < nanoAnchorHeight);
    for (const { peer } of [...lagging, ...behind]) {
      checks.push({ stage: `nano-node-${peer}-lag`, ok: false, code: "nano-rpc-peer-lagging", domains: [] });
    }
    const minimum = Math.min(2, config.nanoRpcUrls.length);
    const standbyMatches = standbyCheckpoint && latestConfirmed?.confirmedHeight === BigInt(standbyCheckpoint.blockCount)
      && latestConfirmed.confirmedFrontier === standbyCheckpoint.hash;
    if (current.length < minimum) {
      need(current.length === 1 && standbyCheckpoint, lagging.length ? "nano-rpc-lagging-peers" : "nano-read-quorum-unavailable");
      need(standbyMatches, "nano-standby-checkpoint-disagrees");
    }
    if (nanoAnchor) {
      need(latestConfirmed.confirmedHeight >= nanoAnchorHeight, "nano-confirmed-checkpoint-regressed");
      need(nanoNodes.every(({ view }) => view.confirmedHeight !== nanoAnchorHeight || view.confirmedFrontier === nanoAnchor.hash),
        "nano-confirmed-checkpoint-disagrees");
    }
    const witnesses = current.filter(row => row.witnessed);
    const currentWitnesses = witnesses.filter(({ view }) => view.confirmedHeight === latestConfirmed.confirmedHeight);
    const [newest] = currentWitnesses;
    need(newest && witnesses.length + Number(Boolean(standbyMatches)) >= minimum, "nano-confirmed-checkpoint-unverified");
    return { ...newest, peers: currentWitnesses.map(row => row.peer) };
  });
  if (standbyCheckpoint) checks.push({ stage: "nano-standby", ok: false, code: "nano-standby-covering-quorum", domains: [] });
  if (state) await check("nano-payment-scan-progress", async () => {
    const at = now(), ledger = readNanoLedger();
    const { history, waiting } = nanoWatchDemand(ledger, at);
    if (!waiting.length) return;
    if (ledger.historyScan !== undefined) {
      need(history.coveredAt === null || history.coveredAt <= at + 30_000, "nano-payment-coverage-invalid");
      need(history.coveredAt !== null && at - history.coveredAt <= NANO_SCAN_GRACE_MS, "nano-payment-coverage-stale");
      return;
    }
    need(nano, "nano-payment-observation-unavailable");
    const observed = await check("nano-legacy-payment-observation", async () => {
      let failure;
      for (const index of nano.peers) {
        try {
          return await findUnrecordedNanoPayments({ rpc: body => nanoRpc(config.nanoRpcUrls[index], body),
            account: config.nanoAddress, head: nano.view.confirmedFrontier, ledger, waiting, now: at });
        } catch (error) {
          if (error.code === "NANO_PAYMENT_OBSERVATION_LIMIT") throw error;
          failure = error;
        }
      }
      throw failure;
    }, []);
    if (!observed?.length) return;
    // A normal scan may have recorded the payment while the probe was reading.
    const latest = readNanoLedger();
    const unpaid = new Set(nanoWatchDemand(latest, now()).waiting.map(q => q.id));
    const recorded = new Set(latest.quotes.filter(q => typeof q.payHash === "string").map(q => q.payHash.toUpperCase()));
    need(!observed.some(({ id, hash, receipt }) => unpaid.has(id) && !recorded.has(hash) && !recorded.has(receipt)),
      "nano-confirmed-payment-unrecorded");
  }, ["nano"]);
  const nearNodes = (await Promise.all(config.nearRpcUrls.map((url, index) => check(`near-node-${index}`, async () => {
    const rpc = createNearRpc({ url, fetch: request, timeoutMs: config.timeoutMs || 12_000 });
    const status = await rpc.status();
    need(status.chain_id === config.network, "near-wrong-network");
    need(status.sync_info?.syncing === false, "near-node-syncing");
    const block = await rpc.block({ finality: "final" });
    try { assertFreshBlock(block, { now: now() }); }
    catch (error) { throw new CheckError(error.code === "RPC_STALE" ? "near-finalized-head-stale" : "near-block-invalid"); }
    return { index, rpc, block, identity: nearBlockIdentity(block) };
  }, [])))).filter(Boolean);
  const near = await check("near-rpc-ready", async () => {
    need(nearNodes.length >= 1, "near-no-fresh-node");
    const highest = nearNodes.reduce((a, b) => a.identity.height >= b.identity.height ? a : b);
    const top = highest.identity;
    need(nearNodes.every(({ identity }) => top.height - identity.height <= 60), "near-finalized-nodes-disagree");
    const canonical = new Map([[top.height, top.hash]]);
    const heights = [...new Set(nearNodes.map(({ identity }) => identity.height))].filter(height => height !== top.height);
    await Promise.all(heights.map(async height => {
      try {
        const overlap = nearBlockIdentity(await highest.rpc.block({ blockId: height }));
        if (overlap.height === height) canonical.set(height, overlap.hash);
      } catch { /* Compare every available proof before reporting a missing one. */ }
    }));
    need(new Set(canonical.values()).size === canonical.size
      && nearNodes.every(({ identity }) => !canonical.has(identity.height) || canonical.get(identity.height) === identity.hash),
    "near-finalized-nodes-disagree");
    need(canonical.size === heights.length + 1, "near-finalized-overlap-unverified");
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
  // Real checkout IDs use 12 characters after their prefix. These GETs
  // exercise public routing and stream termination without accessing a quote.
  const missingNearQuote = "nq_operational_probe_unissued";
  const unknownTerminal = value => value?.status === "unknown" && value.done === true
    && typeof value.next === "string" && value.next.trim().length > 0;
  const checkCheckout = ({ rail, site, prefix, id, statusCode, watchQuery = "", domains }) => Promise.all([
    check(`${rail}-payment-page`, async () => {
      const response = await request(`${site}/pay/${id}`);
      need(response.status === 404 && /^text\/html\b/.test(response.headers.get("content-type") || "")
        && /Unknown or expired payment/.test(await response.text()), `${rail}-payment-page-response-invalid`);
    }, domains),
    check(`${rail}-payment-status-route`, async () => {
      const response = await request(`${site}${prefix}/status/${id}?wait=1`);
      need(response.status === statusCode && /^application\/json\b/.test(response.headers.get("content-type") || "")
        && unknownTerminal(await response.json()), `${rail}-payment-status-response-invalid`);
    }, domains),
    check(`${rail}-payment-event-stream`, async () => {
      const response = await request(`${site}${prefix}/watch/${id}${watchQuery}`, { headers: { accept: "text/event-stream" } });
      need(response.status === 200 && /^text\/event-stream\b/.test(response.headers.get("content-type") || ""),
        `${rail}-payment-stream-response-invalid`);
      const frame = /^event: status\r?\ndata: (.+)\r?\n\r?\n/m.exec(await response.text());
      need(frame && unknownTerminal(JSON.parse(frame[1])), `${rail}-payment-stream-response-invalid`);
    }, domains),
  ]);
  await Promise.all([
    checkCheckout({ rail: "near", site: config.site, prefix: "/near", id: missingNearQuote, statusCode: 404,
      watchQuery: "?run=1", domains: ["near", "usdc"] }),
    checkCheckout({ rail: "nano", site: config.nanoSite, prefix: "/x402", id: "pay_operational_probe_unissued",
      statusCode: 200, domains: ["nano"] }),
    check("near-payment-result-route", async () => {
      const response = await request(`${config.site}/near/result/${missingNearQuote}`);
      need(response.status === 404 && (await response.json())?.error === "Unknown or expired payment", "near-payment-result-response-invalid");
    }, ["near", "usdc"]),
  ]);
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
      const code = asset === "usdc" && fundingHealth.usdcCode === "USDC_FUNDING_UNAVAILABLE"
        ? "usdc-refund-funding-unavailable" : "near-refund-capacity-exhausted";
      need(fundingHealth[key] === true, code);
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
    const result = nanoLiquidityCheck({ liabilities: state.liabilities, nanoBalanceRaw: nano.info.confirmed_balance,
      xnoUsd: rates.xnoUsd, providerReserveUsd });
    need(result.ok, result.code);
  });
  if (runtimeFunding && rates) await check("nano-unreserved-liquidity", () => {
    // The runtime already accounts for live reservations and liabilities. The
    // on-disk accounting above remains independent so neither counts them twice.
    const minimumUsd = parseUsdNano(providerReserveUsd), rateUsd = parseUsdNano(rates.xnoUsd);
    need(runtimeFunding.availableRaw * rateUsd >= minimumUsd * RAW_PER_XNO, "nano-pool-insufficient-after-reservations");
  }, []);
  const nearTools = await check("mcp-discovery", async () => {
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nanoodle-operational-check", version: "1" } });
    const result = await mcp("tools/list", {});
    need(["price_noodle", "run_noodle", "noodle_guide"].every(name => result.tools?.some(t => t.name === name)), "mcp-tools-missing");
    return result.tools;
  });
  const nanoTools = await check("nano-mcp-discovery", async () => {
    const target = config.nanoSite;
    need(typeof target === "string" && target.length > 0, "nano-site-not-configured");
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nanoodle-operational-check", version: "1" } }, target);
    const result = await mcp("tools/list", {}, target);
    need((config.nanoExpectedTools || ["sing"]).every(name => result.tools?.some(t => t.name === name)), "mcp-tools-missing");
    return result.tools;
  }, ["nano"]);
  await Promise.all([
    nearTools && checkSavedWorkflows(config.site, nearTools, ["near", "usdc"], heldNearAmounts),
    nanoTools && checkSavedWorkflows(config.nanoSite, nanoTools, ["nano"]),
  ]);
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
    const tokenContract = USDC_CONTRACTS[config.network];
    await check("usdc-receive-registration", () => checkUsdcMerchant({ rpc: near.rpc, network: config.network, merchantId: config.merchant }), ["usdc"]);
    const readFunding = (node, finalizedBlock) => readNearFunding({
      rpc: node.rpc, network: config.network, accountId: config.merchant, publicKey: config.nearPublicKey,
      tokenContract, optionalTokenBalance: true, finalizedBlock, now,
    });
    let floor = 0;
    const qualify = (proof) => {
      // A refund can finalize while the account and fee RPCs are in flight.
      const ledger = readNearLedger();
      floor = Math.max(floor, nearRefundFinalHeight(ledger.meta?.refundFinalHeight));
      need(proof.frame.blockHeight >= floor, "near-refund-balance-before-checkpoint");
      assertFreshBlock(proof.finalizedBlock, { now: now() });
      return nearRefundClaims(ledger, { now: now() });
    };
    const fundingProof = await check("near-fee-and-balance-reads", async () => {
      floor = nearRefundFinalHeight((state?.near ?? readNearLedger()).meta?.refundFinalHeight);
      let last, nativeProof;
      for (const node of [near, ...nearNodes.filter(n => n !== near)]) {
        try {
          const finalizedBlock = await node.rpc.block({ finality: "final" });
          const frame = await readFunding(node, finalizedBlock);
          const proof = { frame, node, finalizedBlock };
          qualify(proof);
          if (!tokenContract || frame.usdcAtomic != null && frame.usdcRegistered) return proof;
          if (!nativeProof || frame.blockHeight > nativeProof.frame.blockHeight) nativeProof = proof;
        } catch (e) { last = e; }
      }
      if (nativeProof) {
        qualify(nativeProof);
        return nativeProof;
      }
      throw last;
    }, ["near", "usdc"]);
    if (fundingProof) await check("refund-liquidity-accounting", async () => {
      const { frame, node, finalizedBlock } = fundingProof;
      const peerFrames = await Promise.all(nearNodes.filter(peer => peer !== node).map(async peer => {
        // A lagging peer can still corroborate the earlier finalized overlap.
        // Keep the newer frame for deciding how much can be refunded now.
        const overlap = peer.identity.height < node.identity.height ? peer.block : node.block;
        const reference = peer.identity.height < frame.blockHeight ? overlap : finalizedBlock;
        const [source, corroborator] = await Promise.all([
          reference.header.hash === finalizedBlock.header.hash ? frame : readFunding(node, reference).catch(() => null),
          readFunding(peer, reference).catch(() => null),
        ]);
        return { peer, source, corroborator };
      }));
      const claims = qualify(fundingProof);
      for (const { peer, source, corroborator } of peerFrames) {
        const nativeStage = `near-funding-peer-${peer.index}`;
        if (!source || !corroborator) {
          checks.push({ stage: nativeStage, ok: false, code: "near-funding-peer-proof-unavailable", domains: [] });
          continue;
        }
        await check(nativeStage, () => {
          need(source.balanceYocto === corroborator.balanceYocto && source.storageUsage === corroborator.storageUsage
            && BigInt(source.accessKey.nonce) === BigInt(corroborator.accessKey.nonce)
            && Object.keys(source.costs).every(key => source.costs[key] === corroborator.costs[key]), "near-funding-peers-disagree");
        }, ["near", "usdc"]);
        if (tokenContract) {
          const stage = `usdc-funding-peer-${peer.index}`;
          const hasBalance = source.usdcAtomic != null && corroborator.usdcAtomic != null;
          const hasRegistration = source.usdcRegistrationVerified && corroborator.usdcRegistrationVerified;
          const balanceDisagrees = hasBalance && source.usdcAtomic !== corroborator.usdcAtomic;
          const registrationDisagrees = hasRegistration && source.usdcRegistered !== corroborator.usdcRegistered;
          if (balanceDisagrees || registrationDisagrees) {
            checks.push({ stage, ok: false, code: "usdc-funding-peers-disagree",
              domains: balanceDisagrees && claims.usdcAtomic > 0n ? ["near", "usdc"] : ["usdc"] });
          } else if (!hasBalance || !hasRegistration) {
            checks.push({ stage, ok: false, code: "usdc-funding-peer-proof-unavailable", domains: [] });
          } else {
            checks.push({ stage, ok: true });
          }
        }
      }
      if (tokenContract) {
        const sharedDebtUnverified = frame.usdcAtomic == null && claims.usdcAtomic > 0n;
        await check("usdc-funding-reads", () => {
          need(frame.usdcAtomic != null && frame.usdcRegistered, "usdc-refund-funding-unavailable");
        }, sharedDebtUnverified ? ["near", "usdc"] : ["usdc"]);
      }
      const results = nearLiquidityChecks({ nearBalanceYocto: frame.balanceYocto.toString(), storageUsage: frame.storageUsage,
        costs: frame.costs, usdcBalanceAtomic: frame.usdcAtomic?.toString() ?? "0", liabilities: claims });
      for (const result of results.filter(r => r.stage === "near-liquidity" || frame.usdcAtomic != null)) {
        checks.push({ ...result, ...(result.ok ? {} : { domains: result.stage === "usdc-liquidity" ? ["usdc"] : ["near", "usdc"] }) });
      }
      await check("near-open-quote-refund-fees", () => {
        // Both currencies spend native NEAR on refund gas. Pending deposits
        // would bring their own principal, so only their fees are additional.
        // Keep this advisory so unpaid quotes cannot block admission.
        if (claims.pendingNativeRefunds || claims.pendingTokenRefunds) {
          need(frame.balanceYocto >= nearFundingNeed({ claims, costs: frame.costs, storageUsage: frame.storageUsage, pending: true }),
            "near-open-quote-refund-fees-underfunded");
        }
      }, []);
      const coversTokenDebt = claims.usdcAtomic === 0n || frame.usdcAtomic != null && frame.usdcAtomic >= claims.usdcAtomic;
      for (const asset of ["near", "usdc"]) {
        if (asset === "usdc" && (frame.usdcAtomic == null || !frame.usdcRegistered)) continue;
        await check(`${asset}-independent-refund-headroom`, () => {
          need(coversTokenDebt, "independent-usdc-refund-debt-uncovered");
          need(frame.balanceYocto >= nearFundingNeed({ claims, costs: frame.costs, storageUsage: frame.storageUsage, extraAsset: asset }),
            "independent-refund-headroom-insufficient");
        }, [asset]);
      }
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
        } else {
          const record = state.assignments[a.assignmentId];
          const needUsd = record?.pricing?.depositUsd;
          if ((record?.phase === "starting" || record?.phase === "started") && Number.isFinite(needUsd)) {
            const { budgetUsd } = marketEscrowTerms(a);
            if (budgetUsd !== undefined) need(needUsd <= budgetUsd, "market-intake-escrow-below-priced-need");
          }
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
    { fundingPause: runtimeFunding?.fundingPause, nearBackfilling: watcherHealth?.backfilling, invocationId: config.invocationId });
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
  return { stateDir: env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check", invocationId: env.INVOCATION_ID,
    backupExportReport: env.OPERATIONAL_BACKUP_EXPORT_REPORT,
    outDir: "/srv/nanoodle-mcp/out",
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
  catch {
    report = finishOperationalReport(process.env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check",
      [{ stage: "preflight", ok: false, code: "check-could-not-finish", domains: ALL }], Date.now(),
      { invocationId: process.env.INVOCATION_ID });
  }
  console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
}
