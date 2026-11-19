#!/usr/bin/env node
// Read-only production readiness. No Workflow.run, payment, work generation,
// signing, receive sweep, assignment start, bid, submission or price mutation.
import { readFileSync, mkdirSync, mkdtempSync, chmodSync, statfsSync, rmSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { PrivateStateDurabilityError, syncPrivateStateParentSync, writePrivateStateSync } from "../src/private-state.mjs";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { deriveAddress, derivePublicKey, checkAddress, hashBlock } from "nanocurrency";
import { createProbeFetch } from "../src/probe-http.mjs";
import { waitForRecentAppStart } from "../src/probe-startup.mjs";
import { paymentLiabilities, nearLiquidityChecks, nanoLiquidityCheck, paidNearRunFundingRaw, paidNanoRunFundingRaw,
  marketRunFunding, recentPaidWorkflowFailures } from "../src/operational-state.mjs";
import { findUnrecordedNanoPayments, nanoWatchDemand, NANO_SCAN_GRACE_MS } from "../src/operational-nano-watch.mjs";
import { checkedAnchoredNanoHistory, NANO_HISTORY_PAGE, NANO_RECEIVABLE_COUNT } from "../src/nano-payment-history.mjs";
import { base58Encode, base58Decode, createNearRpc, loadNearSigner, checkUsdcMerchant, parseNearToYocto, USDC_CONTRACTS } from "../src/near/index.mjs";
import { readNearPaymentReceipts, readNearReceiptTransaction } from "../src/near/watch.mjs";
import { hasUnverifiedNearPaymentClaim, SETTLED_NEAR_QUOTE_RETENTION_MS } from "../src/near/ledger.mjs";
import { assertFreshBlock, nearBlockIdentity } from "../src/near/freshness.mjs";
import { DUST_STEP_YOCTO, QUOTE_DUST_SLOTS, usdToYocto } from "../src/near/amount.mjs";
import { USDC_RATE } from "../src/near/ft.mjs";
import {
  countOpenNearQuotes, heldNearQuoteAmounts, nearPaymentWatchCoverage, MAX_OPEN_NEAR_QUOTES, PAYMENT_WATCH_META, RETAIN_NEAR_QUOTE_MS,
} from "../src/near/quote-capacity.mjs";
import { authorAddress, resolveWalletKey, isThrottleError } from "../src/wallet.mjs";
import { rpcPeerSetId, selectRpcCooldowns } from "../src/rpc-backoff.mjs";
import { LIVE_RATE_MAX_AGE_MS, parseUsdNano } from "../src/gate.mjs";
import { readCatalog, fetchListingPrice, budgetFromPrice, marketEscrowTerms, listingWorkflowPriceSample } from "../src/market/catalog.mjs";
import { resolveJobBrief } from "../src/market/brief.mjs";
import { createMarketClient, MarketApiError } from "../src/market/client.mjs";
import { createMarketFeeGuard } from "../src/market/fee-guard.mjs";
import { marketDeliveryWindow } from "../src/market/deadline.mjs";
import { marketNeedUsd } from "../src/market/runner.mjs";
import { computePrice, priceSavedWorkflow } from "../src/tools.mjs";
import { DEFAULT_HOSTED_RUN_MS } from "../src/hosted-run.mjs";
import { NANO_COLD_STANDBY_SCAN_REQUESTS, NANO_LEGACY_COLD_STANDBY_SCAN_REQUESTS, NANO_FUNDING_EVIDENCE_MS, NANO_GENESIS, checkNanoGenesis, matchesNanoConfirmedBlock, nanoAccountView, nanoStandbyConfig,
  qualifyNanoAccountViews, checkedReceivable } from "../src/nano-read-pool.mjs";
import { selectNanoCheckpoint } from "../src/nano-checkpoint.mjs";
import { FUNDING_REPORT_MAX_AGE_MS, fundingReportFailure, selectFundingPause } from "../src/funding-report.mjs";
import { nearFundingNeed, nearRefundClaims, nearRefundFinalHeight, readNearFunding, readNearTransferFunding } from "../src/near/funding.mjs";
import { RAW_PER_XNO, parseSpreadBps, spreadPair } from "../src/near/rates.mjs";
import { exactUsd } from "../src/custom-workflow.mjs";
import { nearRunFundingBudget } from "../src/funding-liabilities.mjs";
import { runFundingBudget } from "../src/run-funding.mjs";
import { atomicJson, checkGraph, DEFAULT_CHECK_MAX_NEAR } from "./near-check.mjs";

const ALL = ["nano", "near", "usdc", "market"];
const NEAR_BACKFILL_ALERT_MS = 5 * 60_000;
const NEAR_DISCOVERY_MAX_PROOF_AGE_MS = 27 * 3600_000;
const NANO_TELEMETRY_AGE_MS = 90_000;
const NANO_LEDGER_LAG_BLOCKS = 1_000n;
const NANO_CEMENTATION_WINDOW_MS = 10 * 60_000;
const NANO_CEMENTATION_SAMPLE_MAX_AGE_MS = 12 * 60_000;
const NANO_PEER_ADVANCE_BLOCKS = 50n;
const MARKET_PICKUP_GRACE_MS = 5 * 60_000;
const MARKET_MAX_PAGES = 5;
const MARKET_MAX_REPRICES = 20;
const MARKET_SLA_WARNINGS = ["market-sla-execution-overdue", "market-sla-start-window-ended",
  "market-sla-retry-after-cutoff", "market-sla-delivery-due"];
const SHARED_SAVED_WORKFLOWS = ["image-model-arena", "mix-the-references", "neon-shrine-duel", "photo-to-video", "sing"];
const EXTRA_NANO_WORKFLOW_LIMIT = 8;
const NANO_SAVED_DEPOSIT = /Runs on NanoGPT — \$(\d+(?:\.\d+)?) deposit per call, paid in Nano \(XNO\) —/;
const NEAR_WORKFLOW_TEMPLATE = "idea-to-3d-model";
const CAPACITY_WARNING = 0.8;
const BACKUP_VERIFICATION_AGE_MS = 2 * 3600_000;
const BACKUP_CAPTURE_AGE_MS = 26 * 3600_000;
const BACKUP_REPLICATION_GRACE_MS = 15 * 60_000;
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

function nanoLedgerCount(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return null;
  const count = BigInt(value);
  return count < (1n << 64n) ? count : null;
}

function nanoLedgerCounters(count, cemented) {
  const blocks = nanoLedgerCount(count), confirmed = nanoLedgerCount(cemented);
  if (blocks === null || confirmed === null || confirmed > blocks) return null;
  return { blocks, confirmed };
}

function nanoPeerLedgerBaseline(metrics, now) {
  // The local node validates telemetry signatures on receipt. Use its raw
  // cached peer observations: the non-raw RPC can return the local counters.
  const peers = new Map();
  for (const sample of Array.isArray(metrics) ? metrics : []) {
    if (sample?.genesis_block !== NANO_GENESIS || !/^node_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(sample.node_id)
      || !/^[a-f0-9]{128}$/i.test(sample.signature)) continue;
    const at = typeof sample.timestamp === "string" && /^\d{13}$/.test(sample.timestamp) ? Number(sample.timestamp) : NaN;
    if (!Number.isFinite(at) || now - at > NANO_TELEMETRY_AGE_MS || at - now > 30_000) continue;
    const ledger = nanoLedgerCounters(sample.block_count, sample.cemented_count);
    if (ledger && (!peers.has(sample.node_id) || at > peers.get(sample.node_id).at)) {
      peers.set(sample.node_id, { at, confirmed: ledger.confirmed });
    }
  }
  need(peers.size >= 3, "nano-ledger-peer-telemetry-insufficient");
  const counts = Array.from(peers.values(), peer => peer.confirmed).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { median: counts[Math.floor((counts.length - 1) / 2)], peers: counts.length };
}

function nanoCementationProgress(current, previous, now) {
  const prior = previous?.nanoLedgerSync;
  const checkedAt = prior?.observedAt ?? Date.parse(previous?.checkedAt);
  const continuous = Number.isSafeInteger(checkedAt) && checkedAt < now && now - checkedAt <= NANO_CEMENTATION_SAMPLE_MAX_AGE_MS;
  let unchangedSince = now, peerMedianAtStart = current.peerMedianConfirmed;
  if (continuous && prior?.localConfirmed === current.localConfirmed) {
    const since = prior.unchangedSince;
    if (Number.isSafeInteger(since) && since > 0 && since <= checkedAt && nanoLedgerCount(prior.peerMedianAtStart) !== null) {
      unchangedSince = since;
      peerMedianAtStart = prior.peerMedianAtStart;
    } else if (nanoLedgerCount(prior.peerMedianConfirmed) !== null) {
      unchangedSince = checkedAt;
      peerMedianAtStart = prior.peerMedianConfirmed;
    }
  }
  const progress = { unchangedSince, peerMedianAtStart };
  const priorLocal = continuous ? nanoLedgerCount(prior?.localConfirmed) : null;
  const local = BigInt(current.localConfirmed), peer = BigInt(current.peerMedianConfirmed);
  if (priorLocal !== null && local < priorLocal) {
    return { ...progress, code: "nano-ledger-local-confirmations-regressed" };
  }
  const stalled = now - unchangedSince >= NANO_CEMENTATION_WINDOW_MS
    && BigInt(current.peerMedianConfirmed) - BigInt(peerMedianAtStart) >= NANO_PEER_ADVANCE_BLOCKS;
  if (stalled) return { ...progress, code: "nano-ledger-confirmations-stalled" };
  const priorPeer = nanoLedgerCount(prior?.peerMedianConfirmed);
  if (priorLocal === null || priorPeer === null) return progress;

  const priorLead = priorPeer > priorLocal ? priorPeer - priorLocal : 0n;
  const lead = peer - local;
  if (lead < priorLead) return progress;
  // Keep a recent rise through a short plateau. Only another increase can
  // open the trend warning, and a sustained plateau expires the baseline.
  const increased = lead > priorLead;
  const trend = prior.wideningGap;
  const firstLead = trend?.leadAtStart === "0" ? 0n : nanoLedgerCount(trend?.leadAtStart);
  const lastIncrease = trend?.lastIncreaseAt ?? checkedAt;
  const ongoing = Number.isSafeInteger(trend?.since) && trend.since > 0 && trend.since <= checkedAt
    && Number.isSafeInteger(lastIncrease) && lastIncrease >= trend.since && lastIncrease <= checkedAt
    && now - lastIncrease <= NANO_CEMENTATION_SAMPLE_MAX_AGE_MS && firstLead !== null && firstLead < priorLead;
  if (!ongoing && !increased) return progress;
  const since = ongoing ? trend.since : checkedAt;
  const leadAtStart = ongoing ? firstLead : priorLead;
  const growing = ongoing && (increased || trend.alerted === true)
    && now - since >= NANO_CEMENTATION_WINDOW_MS && lead - leadAtStart >= NANO_PEER_ADVANCE_BLOCKS;
  return { ...progress, wideningGap: { since, leadAtStart: leadAtStart.toString(), lastIncreaseAt: increased ? now : lastIncrease,
    ...(growing && { alerted: true }) },
    ...(growing && { code: "nano-ledger-confirmations-falling-behind" }) };
}

function currentNanoPaymentPeers(rows) {
  const { current, latestConfirmed } = qualifyNanoAccountViews(rows);
  return current.filter(row => row.paymentReads && row.view.confirmedHeight === latestConfirmed.confirmedHeight);
}

async function readDiscoveryStep(step, read) {
  try { return await read(); }
  catch (error) {
    if (error?.code === "RPC_TIMEOUT") throw new CheckError(`near-discovery-${step}-timeout`);
    throw error;
  }
}

async function checkoutStreamFrame(response, code) {
  need(response.status === 200 && /^text\/event-stream\b/.test(response.headers.get("content-type") || ""), code);
  const frame = /^event: status\r?\ndata: (.+)\r?\n\r?\n/m.exec(await response.text());
  need(frame, code);
  return JSON.parse(frame[1]);
}

function backupVerificationProof(file, read, now, stage) {
  let record;
  try { record = read(file); }
  catch { throw new CheckError(`${stage}-proof-unavailable`); }
  const parse = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
    ? Date.parse(value) : NaN;
  const verified = parse(record?.verifiedAt), captured = parse(record?.capturedAt);
  const hasGeneration = record?.generation !== undefined;
  const publishedAt = hasGeneration && stage === "backup-export" ? parse(record.publishedAt) : null;
  need(record?.v === 1 && Number.isFinite(verified) && Number.isFinite(captured)
    && captured <= verified + 30_000 && verified <= now + 30_000 && captured <= now + 30_000, `${stage}-proof-invalid`);
  need(!hasGeneration || (typeof record.generation === "string" && /^[0-9a-f]{64}$/.test(record.generation)
    && (publishedAt === null || (publishedAt >= captured - 30_000
      && publishedAt <= verified + 30_000 && publishedAt <= now + 30_000))),
  `${stage}-proof-invalid`);
  return { generation: record.generation, publishedAt, capturedAt: captured,
    verificationAgeMs: now - verified, captureAgeMs: now - captured };
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

function previewDeposit(content, asset, network) {
  const currency = content[asset], depositUsd = content.pricing.deposit.usd;
  need(currency?.network === network, "saved-workflow-denomination-invalid");
  if (asset === "usdc") {
    need(currency.tokenContract === USDC_CONTRACTS[network] && currency.decimals === 6
      && currency.usdcUsd === "1", "saved-workflow-denomination-invalid");
    return { base: usdToYocto(depositUsd, USDC_RATE, "ceil"), rate: USDC_RATE, step: 1n };
  }
  need(positiveDecimal(currency.rate?.nearUsd) && positiveDecimal(currency.depositNear)
    && positiveDecimal(currency.likelyChargeNear), "saved-workflow-denomination-invalid");
  const amount = parseNearToYocto(currency.depositNear);
  need(amount >= parseNearToYocto(currency.likelyChargeNear), "saved-workflow-denomination-invalid");
  const rate = spreadPair(parseUsdNano(currency.rate.nearUsd), parseSpreadBps(currency.rate.spreadBps));
  const yocto = usdToYocto(depositUsd, rate, "ceil");
  const base = ((yocto + DUST_STEP_YOCTO - 1n) / DUST_STEP_YOCTO) * DUST_STEP_YOCTO;
  need(amount === base, "near-deposit-conversion-invalid");
  return { base: amount, rate, step: DUST_STEP_YOCTO };
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

export function finishOperationalReport(stateDir, checks, now = Date.now(), {
  fundingPause = null, nearBackfilling = null, nanoLedgerSync = null, nanoPaymentReadPeers = null, invocationId = null,
} = {}) {
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
  if (nanoLedgerSync) {
    const { code, ...progress } = nanoCementationProgress(nanoLedgerSync, previous, nanoLedgerSync.observedAt ?? now);
    nanoLedgerSync = { ...nanoLedgerSync, ...progress };
    const check = code
      ? { stage: "nano-ledger-confirmation-progress", ok: false, code, domains: [] }
      : { stage: "nano-ledger-confirmation-progress", ok: true };
    checks = [...checks, check].sort((a, b) => a.stage.localeCompare(b.stage));
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
    ...(nearBackfillSince !== null && { nearBackfillSince }), ...(nanoLedgerSync && { nanoLedgerSync }),
    ...(nanoPaymentReadPeers !== null && { nanoPaymentReadPeers }) };
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
  const pricePublishedWorkflow = deps.priceSavedWorkflow || priceSavedWorkflow;
  const providerReserveUsd = config.providerReserveUsd || "2";
  const checks = [];
  const peerUrls = config.nanoStandby ? [...config.nanoRpcUrls, config.nanoStandby.url] : config.nanoRpcUrls;
  let nanoCooldowns = [];
  let standbyCheckpoint = null;
  const check = async (stage, fn, domains = ALL) => {
    try { const value = await fn(); checks.push({ stage, ok: true }); return value; }
    catch (e) { checks.push({ stage, ok: false, code: safeCode(e), domains }); return null; }
  };
  const backup = config.backupExportReport &&
    await check("backup-export-proof", () => backupVerificationProof(config.backupExportReport, read, now(), "backup-export"), []);
  if (backup) {
    await check("backup-export-freshness", () => need(backup.verificationAgeMs <= BACKUP_VERIFICATION_AGE_MS, "backup-export-overdue"), []);
    await check("backup-capture-freshness", () => need(backup.captureAgeMs <= BACKUP_CAPTURE_AGE_MS, "backup-capture-overdue"), []);
  }
  const copy = config.backupCopyReport &&
    await check("backup-copy-proof", () => backupVerificationProof(config.backupCopyReport, read, now(), "backup-copy"), []);
  if (copy) await check("backup-copy-freshness", () => need(copy.verificationAgeMs <= BACKUP_VERIFICATION_AGE_MS, "backup-copy-overdue"), []);
  if (backup && copy) {
    const pending = backup.generation && copy.generation && backup.generation !== copy.generation
      && (now() - backup.publishedAt <= BACKUP_REPLICATION_GRACE_MS
        // The offsite receipt can arrive between export index and health publication.
        || (copy.capturedAt > backup.capturedAt && copy.verificationAgeMs <= 30_000));
    if (pending) checks.push({ stage: "backup-copy-generation-pending", ok: true });
    else await check("backup-copy-generation", () => {
      need(backup.generation && copy.generation, "backup-copy-generation-unavailable");
      need(backup.generation === copy.generation, "backup-copy-generation-overdue");
      need(backup.capturedAt === copy.capturedAt, "backup-copy-generation-inconsistent");
    }, []);
  }
  const http = async (url, init = {}) => {
    const response = await request(url, init); need(response.ok, `http-${response.status}`); return response.json();
  };
  const nanoRpc = async (url, body, signal) => {
    need(["account_info", "account_history", "receivable", "block_count", "version", "block_info", "telemetry"].includes(body.action), "probe-action-forbidden");
    const response = await request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
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
  const freshPriceOptions = {
    fetch: request, baseUrl: config.nanoGptBase, allowShortLinks: false, requireFreshCatalogs: true, limits: { maxDepositUsd: 1_000_000 },
  };
  async function freshCharge(args) {
    const priced = await priceWorkflow(args, freshPriceOptions);
    const charge = priced?.pricing?.likelyChargeUsd;
    need(priced?.safety?.ok === true && Number.isFinite(charge) && charge >= 0, "workflow-provider-pricing-unavailable");
    return parseUsdNano(exactUsd(charge));
  }
  async function checkSavedWorkflows(site, tools, assets, heldAmounts = null) {
    const names = [...SHARED_SAVED_WORKFLOWS];
    let additional = [];
    if (assets.includes("nano")) {
      const discovered = new Set(tools.filter(tool => /^[a-z0-9_-]{1,64}$/.test(tool?.name) && tool.name !== "run_noodle"
        && !tool.pricedPerRequest && (tool.inputSchema?.properties?._payment_id || NANO_SAVED_DEPOSIT.test(tool.description))
        && !names.includes(tool.name)).map(tool => tool.name));
      if (discovered.size > EXTRA_NANO_WORKFLOW_LIMIT) await check("saved-nano-workflow-coverage", () => {
        need(false, "saved-nano-workflow-scan-incomplete");
      }, []);
      additional = [...discovered].sort().slice(0, EXTRA_NANO_WORKFLOW_LIMIT);
    } else {
      names.push(NEAR_WORKFLOW_TEMPLATE);
    }
    for (const name of [...names, ...additional]) {
      const savedOnly = additional.includes(name);
      const template = !savedOnly && name === NEAR_WORKFLOW_TEMPLATE;
      // Share the published graph within this site. Run the next graph's price
      // requests after these finish so a cold catalog isn't fetched in a burst.
      const tool = tools.find(t => t?.name === name);
      const graph = (async () => {
        need(template || tool, "saved-workflow-tool-missing");
        const value = await http(site + (template ? "/examples/" : "/graph/") + name + ".json");
        need(Array.isArray(value?.nodes) && value.nodes.length > 0 && Array.isArray(value.links), "saved-workflow-graph-invalid");
        return value;
      })();
      const fresh = graph.then(async published => {
        if (!savedOnly) return freshCharge({ graph: published });
        // Operator-installed graphs can use nodes outside the custom graph allowlist.
        const { pricing } = await pricePublishedWorkflow(published, { fetch: request, baseUrl: config.nanoGptBase });
        const charge = pricing.likelyChargeUsd;
        need(pricing.unpriced.length === 0 && pricing.refusals.length === 0 && Number.isFinite(charge) && charge >= 0,
          "workflow-provider-pricing-unavailable");
        return parseUsdNano(exactUsd(charge));
      });
      await Promise.all(assets.map(asset => check(`saved-workflow-${asset}-${name}`, async () => {
        const [published, charge] = await Promise.all([graph, fresh]);
        const content = savedOnly ? null : savedPricingContent(await mcp("tools/call", {
          name: "price_noodle", arguments: { graph: published, _pay_with: asset === "nano" ? "near" : asset },
        }, site));
        if (asset === "nano") {
          // Fixed-deposit tools on the live Nano API publish the cold deposit
          // in their generated MCP description, including the payment rail.
          const amount = typeof tool.description === "string" && tool.description.match(NANO_SAVED_DEPOSIT)?.[1];
          need(!tool.pricedPerRequest && positiveDecimal(amount), "saved-nano-deposit-unavailable");
          const deposit = parseUsdNano(amount);
          need(deposit >= charge && (!content || deposit >= parseUsdNano(content.pricing.likelyCharge.usd)), "saved-nano-deposit-too-low");
          await checkUsdRunCapital(`workflow-nano-capital-nano-${name}`, amount, Boolean(authorAddress(published.x402)));
        } else {
          need(parseUsdNano(content.pricing.deposit.usd) >= charge, "saved-workflow-deposit-too-low");
          const denomination = previewDeposit(content, asset, config.network);
          const { base, step } = denomination;
          const held = heldAmounts?.[asset];
          if (held?.size >= Math.ceil(QUOTE_DUST_SLOTS * CAPACITY_WARNING)) {
            // The native preview gives the dust-rounded base, before a unique
            // payment amount is assigned. USDC uses whole micro-USDC units.
            let occupied = 0;
            for (let dust = 1; dust <= QUOTE_DUST_SLOTS; dust++) {
              if (held.has((base + BigInt(dust) * step).toString())) occupied++;
            }
            need(occupied < QUOTE_DUST_SLOTS, "saved-workflow-quote-amounts-exhausted");
            need(occupied < Math.ceil(QUOTE_DUST_SLOTS * CAPACITY_WARNING), "saved-workflow-quote-amounts-low");
          }
          await checkNearPreviewCapital(`workflow-nano-capital-${asset}-${name}`, published, content, denomination);
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
  const readMarketLedgers = () => config.agents.map(a => read(join(config.marketStateDir, a.handle, "market-state.json")));
  const state = await check("payment-state", async () => {
    const nano = readNanoLedger(), near = readNearLedger(), market = readMarketLedgers();
    const checkedAt = now();
    const liabilities = paymentLiabilities({ nano, near, market }, { now: checkedAt });
    for (const code of liabilities.issues) checks.push({ stage: code, ok: false, code, domains: [] });
    const failures = recentPaidWorkflowFailures({ nano, near }, checkedAt);
    const ok = failures.nano + failures.near + failures.usdc < 2;
    checks.push({ stage: "paid-workflow-execution", ok, failures,
      ...(ok ? {} : { code: "paid-workflow-failures-repeated", domains: [] }) });
    return { liabilities, near };
  });
  if (state) await check("near-payment-replay-coverage", () => {
    need(!hasUnverifiedNearPaymentClaim(state.near.quotes, state.near.consumedTx ?? {}), "near-payment-replay-unverified");
  }, ["near", "usdc"]);
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
    const observedAt = now(), checkedAt = Date.parse(value.checkedAt), age = observedAt - checkedAt;
    need(Number.isFinite(age) && age < FUNDING_REPORT_MAX_AGE_MS && age >= -30_000, "funding-report-stale");
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
    const readAge = observedAt - rpc.lastReadAt;
    need(Number.isSafeInteger(rpc.lastReadAt) && readAge < FUNDING_REPORT_MAX_AGE_MS && readAge >= -30_000, "nano-read-guard-stale");
    if (rpc.fundingEvidenceExpiresAt !== undefined) {
      const expiresAt = rpc.fundingEvidenceExpiresAt;
      need(config.nanoStandby && rpc.standby?.inUse === true && Number.isSafeInteger(expiresAt)
        && expiresAt > observedAt && expiresAt > rpc.lastReadAt && expiresAt - rpc.lastReadAt <= NANO_FUNDING_EVIDENCE_MS,
      "nano-read-guard-stale");
    }
    let checkpoint;
    try { checkpoint = selectNanoCheckpoint(rpc.checkpoint, config.nanoAddress); }
    catch { need(false, "nano-checkpoint-unavailable"); }
    if (config.nanoStandby || rpc.cooldowns !== undefined || rpc.configuration !== undefined) {
      need(rpc.configuration === rpcPeerSetId(peerUrls), "nano-peer-configuration-mismatch");
      try { nanoCooldowns = selectRpcCooldowns(rpc.cooldowns, peerUrls.length, now()); }
      catch { need(false, "nano-cooldown-observation-invalid"); }
    }
    let coldPaymentScanRequests = NANO_LEGACY_COLD_STANDBY_SCAN_REQUESTS;
    if (config.nanoStandby) {
      const { inUse, requestsPerMinute, coldPaymentScanRequests: reportedCost } = rpc.standby ?? {};
      need(typeof inUse === "boolean" && requestsPerMinute === config.nanoStandby.requestsPerMinute
        && (reportedCost === undefined || reportedCost === NANO_COLD_STANDBY_SCAN_REQUESTS)
        && (!inUse || (rpc.readablePeers === 2 && !nanoCooldowns.some(item => item.peer === peerUrls.length - 1))), "nano-standby-observation-invalid");
      if (reportedCost !== undefined) coldPaymentScanRequests = reportedCost;
      if (inUse) standbyCheckpoint = checkpoint.confirmed;
    }
    const pause = selectFundingPause(value.pause, Math.min(now(), checkedAt));
    const expiresAt = Math.min(checkedAt + FUNDING_REPORT_MAX_AGE_MS, rpc.lastReadAt + FUNDING_REPORT_MAX_AGE_MS,
      rpc.fundingEvidenceExpiresAt ?? Infinity);
    return { availableRaw, expiresAt, checkpoint, coldPaymentScanRequests,
      fundingPause: pause?.recoveredAt != null ? pause : null };
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
  let nanoLedgerSync = null;
  if (config.nanoLedgerTelemetry) await check("nano-ledger-sync", async () => {
    need(nanoNodes.some(({ peer }) => peer === 0), "nano-ledger-primary-unavailable");
    const owned = config.nanoRpcUrls[0];
    const [{ counts, observedAt }, telemetry] = await Promise.all([
      nanoRpc(owned, { action: "block_count", include_cemented: "true" }).then(counts => ({ counts, observedAt: now() })),
      nanoRpc(owned, { action: "telemetry", raw: "true" }),
    ]);
    const local = nanoLedgerCounters(counts.count, counts.cemented);
    need(local, "nano-ledger-local-counters-invalid");
    const network = nanoPeerLedgerBaseline(telemetry.metrics, now());
    nanoLedgerSync = { observedAt, localBlocks: local.blocks.toString(), localConfirmed: local.confirmed.toString(),
      peerMedianConfirmed: network.median.toString(), peers: network.peers };
    need(network.median - local.blocks < NANO_LEDGER_LAG_BLOCKS, "nano-ledger-blocks-behind");
    need(network.median - local.confirmed < NANO_LEDGER_LAG_BLOCKS, "nano-ledger-confirmations-behind");
  }, []);
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
  const paymentViews = nano ? (await Promise.all(nano.peers.map(async index => {
    const account = config.nanoAddress, head = nano.view.confirmedFrontier;
    let view;
    const paymentReads = await check(`nano-payment-read-peer-${index}`, async () => {
      const url = config.nanoRpcUrls[index];
      const deadline = AbortSignal.timeout(config.timeoutMs || 12_000);
      const rpc = body => nanoRpc(url, body, deadline);
      const receivableRequest = { action: "receivable", account, count: String(NANO_RECEIVABLE_COUNT), threshold: "1",
        source: "true", include_only_confirmed: "true" };
      const pending = await rpc(receivableRequest);
      const info = await rpc({ action: "account_info", account, representative: "true", include_confirmed: "true", receivable: "true" });
      view = nanoAccountView(info, checkAddress);
      need(view.confirmedHeight >= nano.view.confirmedHeight
        && (view.confirmedHeight !== nano.view.confirmedHeight || view.confirmedFrontier === head), "nano-payment-read-anchor-moved");
      checkedReceivable(pending, receivableRequest, view, checkAddress);
      const historyRequest = { action: "account_history", account, head: view.confirmedFrontier, count: String(NANO_HISTORY_PAGE), raw: "true" };
      checkedAnchoredNanoHistory(await rpc(historyRequest), historyRequest, checkAddress, view.confirmedHeight);
      return true;
    }, []);
    // A valid but newer account view still matters when its payment window
    // failed validation. Two older windows cannot then prove current reads.
    return view && { view, peer: index, paymentReads: paymentReads === true };
  }))).filter(Boolean) : [];
  const activePaymentPeers = await check("nano-payment-read-quorum", () => {
    need(nano, "nano-payment-read-anchor-unavailable");
    const ready = currentNanoPaymentPeers(paymentViews);
    const standbyMatches = ready.length === 1 && standbyCheckpoint?.hash === ready[0].view.confirmedFrontier
      && standbyCheckpoint.blockCount === ready[0].view.confirmedHeight.toString();
    need(ready.length >= Math.min(2, config.nanoRpcUrls.length),
      standbyMatches ? "nano-payment-read-standby-unverified" : "nano-payment-read-quorum-unavailable");
    return ready;
  }, ["nano"]);
  const fallbackPaymentReads = config.nanoRpcUrls.length >= 3 && await check("nano-fallback-payment-reads", () => {
    need(nano, "nano-fallback-payment-read-anchor-unavailable");
    // A fallback pair must cover the newest observed confirmed head, even
    // when only the first peer reported it or its own history read failed.
    need(activePaymentPeers?.filter(row => row.peer !== 0).length >= 2, "nano-fallback-payment-read-quorum-unavailable");
    return true;
  }, []);
  if (config.nanoStandby && !fallbackPaymentReads) await check("nano-standby-cold-scan-budget", () => {
    const needed = runtimeFunding?.coldPaymentScanRequests ?? NANO_LEGACY_COLD_STANDBY_SCAN_REQUESTS;
    need(config.nanoStandby.requestsPerMinute >= needed, "nano-standby-cold-scan-budget-insufficient");
  }, []);
  if (state) await check("nano-payment-scan-progress", async () => {
    const at = now(), ledger = readNanoLedger();
    const { history, waiting } = nanoWatchDemand(ledger, at);
    if (!waiting.length) return;
    if (ledger.historyScan !== undefined) {
      const advancedAt = history.backfill?.advancedAt;
      need((history.coveredAt === null || history.coveredAt <= at + 30_000)
        && (advancedAt === undefined || advancedAt <= at + 30_000), "nano-payment-coverage-invalid");
      if (history.coveredAt !== null && at - history.coveredAt <= NANO_SCAN_GRACE_MS) return;
      if (advancedAt === undefined) throw new CheckError("nano-payment-coverage-stale");
      throw new CheckError(at - advancedAt > NANO_SCAN_GRACE_MS ? "nano-history-backfill-stalled" : "nano-history-backfill-in-progress");
    }
    need(nano, "nano-payment-observation-unavailable");
    const observed = await check("nano-legacy-payment-observation", async () => {
      const matchesSend = (block, hash) => hashBlock(block).toUpperCase() === hash
        && deriveAddress(block.link, { useNanoPrefix: true }) === config.nanoAddress;
      let failure;
      for (const index of nano.peers) {
        try {
          return await findUnrecordedNanoPayments({ rpc: body => nanoRpc(config.nanoRpcUrls[index], body), matchesSend, checkAddress,
            account: config.nanoAddress, head: nano.view.confirmedFrontier, height: nano.view.confirmedHeight, ledger, waiting, now: at });
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
  if (config.nearDiscoveryReport) {
    const sample = await check("near-canary-discovery-proof", () => {
      let report;
      try { report = read(config.nearDiscoveryReport); }
      catch { throw new CheckError("near-discovery-canary-proof-unavailable"); }
      const age = now() - Date.parse(report?.checkedAt);
      const payer = config.canaryPayer?.accountId;
      need(payer && payer !== config.merchant && report?.v === 1 && Number.isFinite(age) && age >= -30_000,
        "near-discovery-canary-proof-invalid");
      need(age <= NEAR_DISCOVERY_MAX_PROOF_AGE_MS, "near-discovery-canary-proof-stale");
      try { base58Decode(report.paymentTx, 32); }
      catch { throw new CheckError("near-discovery-canary-proof-invalid"); }
      return { paymentTx: report.paymentTx, payer };
    }, []);
    if (sample) await check("near-payment-discovery", async () => {
      need(near, "near-discovery-finalized-anchor-unavailable");
      const { paymentTx, payer } = sample;
      const accounts = [config.merchant, USDC_CONTRACTS[config.network]];
      const witnessed = await Promise.all(nearNodes.map(({ index, rpc, identity }) => check(`near-discovery-peer-${index}`, async () => {
        const tx = await readDiscoveryStep("transaction", () => rpc.txStatus({ txHash: paymentTx, senderId: payer }));
        const receipt = Array.isArray(tx.receipts_outcome)
          && tx.receipts_outcome.find(row => row.outcome?.executor_id === config.merchant);
        need(tx.final_execution_status === "FINAL" && Object.hasOwn(tx.status ?? {}, "SuccessValue")
          && tx.transaction?.hash === paymentTx && tx.transaction.signer_id === payer && tx.transaction.receiver_id === config.merchant
          && typeof receipt?.id === "string" && typeof receipt.block_hash === "string"
          && Object.hasOwn(receipt.outcome.status ?? {}, "SuccessValue"), "near-discovery-canary-transaction-unverified");
        const block = nearBlockIdentity(await readDiscoveryStep("block", () => rpc.block({ blockId: receipt.block_hash })));
        need(block.hash === receipt.block_hash && block.height <= identity.height, "near-discovery-canary-block-mismatch");
        const ids = await readDiscoveryStep("account-changes", () => readNearPaymentReceipts(rpc, block.hash, accounts));
        need(ids.has(receipt.id), "near-discovery-canary-receipt-missing");
        const resolved = await readDiscoveryStep("receipt-lookup", () => readNearReceiptTransaction(rpc, receipt.id, block.height));
        need(resolved.transaction_hash === paymentTx && resolved.sender_account_id === payer, "near-discovery-canary-receipt-mismatch");
        return true;
      }, [])));
      need(witnessed.some(Boolean), "near-payment-discovery-unverified");
    }, []);
    const checkout = sample && state && await check("near-settled-checkout-proof", () => {
      const { payer, paymentTx } = sample;
      const { quotes, consumedTx, refunds } = readNearLedger();
      const id = consumedTx?.[paymentTx];
      need(typeof id === "string" && /^nq_[A-Za-z0-9_-]{12}$/.test(id), "near-checkout-canary-record-missing");
      const quote = quotes[id];
      const refund = quote ? refunds[quote.refundId] : Object.values(refunds).find(row => row?.paymentId === id);
      need(refund?.status === "sent" && refund.reason === "change" && refund.paymentId === id && refund.to === payer
        && typeof refund.txHash === "string" && refund.txHash, "near-checkout-canary-refund-unverified");
      // The replay index and refund survive quote pruning. A reused daily
      // proof can be newer than the checkout it originally verified.
      const finishedAt = quote?.finishedAt ?? refund.sentAt;
      need(Number.isSafeInteger(finishedAt) && finishedAt > 0 && finishedAt <= now() + 30_000,
        "near-checkout-canary-record-invalid");
      if (now() - finishedAt >= SETTLED_NEAR_QUOTE_RETENTION_MS) return null;
      need(quote?.id === id && quote.payTx === paymentTx && quote.payer === payer && quote.status === "settled"
        && quote.outcome === "succeeded" && quote.settlement, "near-checkout-canary-record-invalid");
      return { id, quote, refund };
    }, []);
    if (checkout) await check("near-settled-checkout", async () => {
      const { payer, paymentTx } = sample;
      const { id, quote, refund } = checkout;
      const [page, status, watch, resultResponse] = await Promise.all([
        request(`${config.site}/pay/${id}`, { cache: "no-store" }),
        http(`${config.site}/near/status/${id}`, { cache: "no-store" }),
        request(`${config.site}/near/watch/${id}?run=1`, { cache: "no-store", headers: { accept: "text/event-stream" } }),
        request(`${config.site}/near/result/${id}`, { cache: "no-store" }),
      ]);
      need(page.status === 200 && /^text\/html\b/.test(page.headers.get("content-type") || ""),
        "near-settled-payment-page-invalid");
      const html = await page.text();
      need(html.includes('id="near-payment"') && html.includes('id="pay-result"'), "near-settled-payment-page-invalid");
      const { receipt, workflow } = status ?? {};
      need(status?.paymentId === id && status.status === "settled" && status.done === true
        && receipt?.paymentId === id && receipt.rail === "near" && receipt.network === config.network
        && receipt.outcome === "succeeded" && receipt.deposit?.txHash === paymentTx && receipt.deposit.yocto === quote.paidYocto
        && receipt.charged?.yocto === quote.settlement.chargedYocto && receipt.refund?.yocto === refund.amountYocto
        && receipt.refund.to === payer && receipt.refund.status === "sent" && receipt.refund.txHash === refund.txHash,
      "near-settled-payment-receipt-invalid");
      const amounts = [quote.paidYocto, quote.settlement.chargedYocto, refund.amountYocto];
      need(amounts.every(value => typeof value === "string" && /^\d{1,39}$/.test(value)),
        "near-settled-payment-receipt-invalid");
      const [deposited, charged, refunded] = amounts.map(BigInt);
      need(refunded > 0n && deposited === charged + refunded && quote.settlement.refundYocto === refund.amountYocto,
        "near-settled-payment-receipt-invalid");
      need(workflow?.v === 1 && workflow.status === "succeeded" && Array.isArray(workflow.links)
        && Array.isArray(workflow.nodes) && workflow.nodes.length > 0 && workflow.nodes.every(node => node?.status === "done"),
      "near-settled-payment-workflow-missing");
      const frame = await checkoutStreamFrame(watch, "near-settled-payment-stream-invalid");
      need(frame?.paymentId === id && frame.status === "settled" && frame.done === true
        && isDeepStrictEqual(frame.receipt, receipt) && isDeepStrictEqual(frame.workflow, workflow),
        "near-settled-payment-stream-invalid");
      need(resultResponse.status === 200, "near-settled-payment-result-invalid");
      const result = await resultResponse.json();
      const output = Array.isArray(result?.content) && result.content.find(part => part?.type === "text")?.text;
      // A receipt and an eviction notice can be returned even when the paid output is gone.
      need(!result?.isError && typeof output === "string" && /^(?:NANOODLE_OK:)?[a-f0-9]{16}$/.test(output.trim())
        && isDeepStrictEqual(result.structuredContent?.receipt, receipt), "near-settled-payment-result-invalid");
    }, []);
  }
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
      need(unknownTerminal(await checkoutStreamFrame(response, `${rail}-payment-stream-response-invalid`)),
        `${rail}-payment-stream-response-invalid`);
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
  const rateView = await check("exchange-rates", async () => {
    const result = await http(config.site + "/rates");
    need(typeof result?.quoting === "boolean", "exchange-rate-not-usable");
    return result;
  });
  function verifyRate(name) {
    const source = rateView.sources?.[name];
    need(source?.usable === true && parseUsdNano(rateView[name]) > 0n, "exchange-rate-not-usable");
    if (source.live) {
      const age = now() - Date.parse(source.at);
      need(age >= -30_000 && age < LIVE_RATE_MAX_AGE_MS, "exchange-rate-stale");
    } else checks.push({ stage: `static-rate-${name}`, ok: false, code: "static-rate-needs-operator-review", domains: [] });
  }
  const rates = rateView && await check("exchange-rate-xno", () => {
    verifyRate("xnoUsd");
    return rateView;
  });
  if (rateView) await check("exchange-rate-near", () => {
    verifyRate("nearUsd");
    // The aggregate quoting flag can also be down because XNO is unavailable.
    if (rates || rateView.xnoRequired === false) need(rateView.quoting, "exchange-rate-not-usable");
  }, ["near"]);
  if (state && nano && rates) await check("nano-liquidity", async () => {
    const result = nanoLiquidityCheck({ liabilities: state.liabilities, nanoBalanceRaw: nano.info.confirmed_balance,
      xnoUsd: rates.xnoUsd, providerReserveUsd });
    need(result.ok, result.code);
  });
  if (runtimeFunding && rates) await check("nano-unreserved-liquidity", () => {
    // The runtime already accounts for live reservations and liabilities. The
    // on-disk accounting above remains independent so neither counts them twice.
    need(now() < runtimeFunding.expiresAt, "nano-read-guard-stale");
    const minimumUsd = parseUsdNano(providerReserveUsd), rateUsd = parseUsdNano(rates.xnoUsd);
    need(runtimeFunding.availableRaw * rateUsd >= minimumUsd * RAW_PER_XNO, "nano-pool-insufficient-after-reservations");
  }, []);
  const hasCapitalEvidence = () => state && nano && rates && runtimeFunding && now() < runtimeFunding.expiresAt;
  function hasCapital(requiredRaw, market = null) {
    // The durable check already reserves Market work. Use the newer gross
    // estimate to correct that reserve upward, without adding it again.
    const independent = nanoLiquidityCheck({ liabilities: { ...state.liabilities, nanoRaw: state.liabilities.nanoRaw + requiredRaw },
      nanoBalanceRaw: nano.info.confirmed_balance, xnoUsd: rates.xnoUsd, providerReserveUsd: "0", marketFundingRaw: market?.totalRaw });
    return runtimeFunding.availableRaw >= requiredRaw + (market?.waitingRaw ?? 0n) && independent.ok;
  }
  let queuedNearRaw = null, queuedNanoRaw = config.providerUsesWallet === false ? 0n : null, marketFunding = null;
  if (state) await check("near-paid-run-funding", () => {
    // The runtime sample came first. Re-read the ledger so a quote that has
    // since acquired a live reservation is not counted again as unstarted.
    try { queuedNearRaw = paidNearRunFundingRaw(readNearLedger().quotes); }
    catch { throw new CheckError("near-paid-run-funding-unverified"); }
    const requiredRaw = queuedNearRaw;
    if (requiredRaw === 0n) return;
    need(hasCapitalEvidence(), "near-paid-run-funding-unverified");
    need(hasCapital(requiredRaw), "near-paid-run-funding-insufficient");
  }, []);
  if (state && config.providerUsesWallet !== false) await check("nano-paid-run-funding", () => {
    try { queuedNanoRaw = paidNanoRunFundingRaw(readNanoLedger().quotes); }
    catch { throw new CheckError("nano-paid-run-funding-unverified"); }
    if (queuedNanoRaw === 0n) return;
    need(hasCapitalEvidence() && queuedNearRaw !== null, "nano-paid-run-funding-unverified");
    need(hasCapital(queuedNanoRaw + queuedNearRaw), "nano-paid-run-funding-insufficient");
  }, []);
  if (state && config.providerUsesWallet !== false) await check("market-paid-run-funding", () => {
    try { marketFunding = marketRunFunding(readMarketLedgers(), rates?.xnoUsd); }
    catch { throw new CheckError("market-paid-run-funding-unverified"); }
    if (marketFunding.waitingRaw === 0n) return;
    need(hasCapitalEvidence() && queuedNearRaw !== null && queuedNanoRaw !== null, "market-paid-run-funding-unverified");
    need(hasCapital(queuedNanoRaw + queuedNearRaw, marketFunding), "market-paid-run-funding-insufficient");
  }, []);
  async function checkRunCapital(stage, buildBudget) {
    if (config.providerUsesWallet === false) return;
    await check(stage, () => {
      need(hasCapitalEvidence() && queuedNearRaw !== null && queuedNanoRaw !== null && marketFunding, "workflow-nano-capital-unverified");
      const { maxRaw, overheadRaw } = buildBudget();
      // A prospective run must fit alongside already paid work that has yet
      // to reserve Nano. Compare the runtime and durable balances separately.
      need(hasCapital(maxRaw + overheadRaw + queuedNearRaw + queuedNanoRaw, marketFunding), "workflow-nano-capital-insufficient");
    }, []);
  }
  function checkNearPreviewCapital(stage, graph, content, { base, rate, step }) {
    return checkRunCapital(stage, () => nearRunFundingBudget({
      id: "operational-preview", depositUsd: content.pricing.deposit.usd, author: authorAddress(graph.x402),
      // This is the largest transfer this preview can produce, including
      // quote dust, for the creator payout overhead computed at run time.
      paidYocto: (base + BigInt(QUOTE_DUST_SLOTS) * step).toString(),
      rate: { usdNano: rate.usdNano.toString(), yocto: rate.yocto.toString(),
        xnoUsd: content.near?.rate?.xnoUsd ?? rates.xnoUsd },
    }));
  }
  function checkUsdRunCapital(stage, budgetUsd, creator) {
    return checkRunCapital(stage, () => runFundingBudget({
      id: "operational-preview", budgetUsd, pair: { usdNano: parseUsdNano(rates.xnoUsd), raw: RAW_PER_XNO }, creator,
    }));
  }
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
  const { graph, inputs } = checkGraph("readonly-operational-probe", true);
  const customCharge = await check("custom-workflow-pricing", () => freshCharge({ graph, inputs }), ["near", "usdc"]);
  if (customCharge !== null) for (const asset of ["near", "usdc"]) {
    await check(`custom-workflow-pricing-${asset}`, async () => {
      const result = await mcp("tools/call", { name: "price_noodle", arguments: { graph, inputs, _pay_with: asset } });
      const content = savedPricingContent(result);
      need(parseUsdNano(content.pricing.deposit.usd) >= customCharge, "custom-workflow-deposit-too-low");
      const denomination = previewDeposit(content, asset, config.network);
      await checkNearPreviewCapital(`workflow-nano-capital-${asset}-custom`, graph, content, denomination);
    }, [asset]);
  }
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
  const fees = createMarketFeeGuard({ baseUrl: config.marketUrl, fetch: deps.fetch, timeoutMs: config.timeoutMs });
  await check("market-platform-fee", async () => {
    try { await fees.check(); }
    catch (error) {
      throw new CheckError(error.code === "MARKET_FEE_CHANGED" ? "market-fee-assumption-changed" : "market-fee-unavailable");
    }
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
    const intake = assignments && await check(`market-intake-${agent.handle}`, () => {
      need(assignments.length < MARKET_MAX_PAGES * 100, "market-intake-scan-incomplete");
      const active = assignments.filter(row => row?.job?.jobKind !== "competition");
      const risks = new Set();
      const pendingPricing = [];
      if (!active.length) return { risks, pendingPricing };
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
        const timing = marketDeliveryWindow(a);
        need(timing && timing.hiredAt <= checkedAt + 30_000, "market-intake-timing-invalid");
        const { hiredAt, deadline, executionDeadlineAt, warningAt } = timing;
        need(deadline > checkedAt, "market-intake-sla-expired");
        const hasRecord = Object.hasOwn(state.assignments, a.assignmentId);
        const record = hasRecord ? state.assignments[a.assignmentId] : null;
        if (!hasRecord) {
          need(!a.startedAt && !a.submittedAt && !a.deliverableUrl && row.latestMessage?.senderSide !== "worker",
            "market-intake-start-without-record");
          need(checkedAt - hiredAt <= MARKET_PICKUP_GRACE_MS, "market-intake-untracked");
        } else {
          const needUsd = record?.pricing?.depositUsd;
          if (["starting", "started"].includes(record?.phase) && !a.submittedAt && !a.deliverableUrl) {
            const { budgetUsd } = marketEscrowTerms(a);
            if (budgetUsd !== undefined) {
              if (Number.isFinite(needUsd)) need(needUsd <= budgetUsd, "market-intake-escrow-below-priced-need");
              const lockedBudget = Number.isFinite(record.budgetUsd) && record.budgetUsd > 0 ? record.budgetUsd : budgetUsd;
              pendingPricing.push({ job: row.job, assignmentId: a.assignmentId, budgetUsd: Math.min(lockedBudget, budgetUsd) });
            }
          }
        }
        const beforeRun = !record || ["new", "starting", "started"].includes(record.phase);
        const cutoff = beforeRun ? executionDeadlineAt : deadline;
        if (beforeRun && checkedAt >= executionDeadlineAt) risks.add("market-sla-start-window-ended");
        if (record?.phase === "running") {
          const recorded = Number.isSafeInteger(record.executionDeadlineAt) ? record.executionDeadlineAt : executionDeadlineAt;
          if (checkedAt >= Math.min(recorded, executionDeadlineAt)) risks.add("market-sla-execution-overdue");
        }
        if (Number.isSafeInteger(record?.nextAttemptAt) && record.nextAttemptAt >= cutoff) risks.add("market-sla-retry-after-cutoff");
        if (checkedAt >= warningAt) risks.add("market-sla-delivery-due");
      }
      return { risks, pendingPricing };
    }, ["market"]);
    if (intake) await check(`market-sla-${agent.handle}`, () => {
      const risk = MARKET_SLA_WARNINGS.find(code => intake.risks.has(code));
      need(!risk, risk);
    }, []);
    if (intake?.pendingPricing.length) await check(`market-pending-pricing-${agent.handle}`, async () => {
      for (const { job, assignmentId, budgetUsd } of intake.pendingPricing.slice(0, MARKET_MAX_REPRICES)) {
        const { args } = resolveJobBrief(job, assignmentId, { defaultWorkflow: agent.defaultWorkflow, customWorkflows: agent.custom });
        need(args, "market-pending-brief-unpriceable");
        // Resolve and price private briefs in process; only public catalog reads use the network.
        const priced = await priceWorkflow(args, freshPriceOptions).catch(() => null);
        const estimate = priced?.pricing?.estimatedCostUsd;
        need(priced?.safety?.ok === true && Number.isFinite(estimate) && estimate >= 0, "market-pending-price-unavailable");
        need(marketNeedUsd(estimate) <= budgetUsd, "market-pending-price-over-budget");
      }
      need(intake.pendingPricing.length <= MARKET_MAX_REPRICES, "market-pending-pricing-scan-incomplete");
    }, []);
    if (agent.bids) {
      await checkUsdRunCapital(`workflow-nano-capital-market-bids-${agent.handle}`, budgetFromPrice(agent.maxBidUsd), true);
    }
    if (!agent.defaultWorkflow) return;
    await check(`workflow-price-${agent.handle}`, async () => {
      const priced = await priceWorkflow(listingWorkflowPriceSample(agent.defaultWorkflow), freshPriceOptions);
      need(priced.safety.ok && priced.pricing, "workflow-not-priceable");
      const listing = await fetchListingPrice({ baseUrl: config.marketUrl, handle: agent.handle, fetch: request });
      need(listing.ok && listing.listingStatus === "live", "market-price-unavailable");
      const needUsd = marketNeedUsd(priced.pricing.estimatedCostUsd);
      need(budgetFromPrice(listing.priceUsd) >= needUsd, "market-workflow-underpriced");
      const remote = await mcp("tools/call", { name: "price_noodle", arguments: { graph: agent.defaultWorkflow.graph, inputs: { [agent.defaultWorkflow.inputName]: "A lighthouse at dawn" } } });
      need(!remote.isError && remote.structuredContent?.pricing?.safety?.ok, "mcp-pricing-unavailable");
      await checkUsdRunCapital(`workflow-nano-capital-market-${agent.handle}`, needUsd, Boolean(authorAddress(agent.defaultWorkflow.graph.x402)));
    }, ["market"]);
  }));
  const finishedAt = now();
  if (runtimeFunding) await check("nano-funding-evidence-freshness", () => {
    need(runtimeFunding.expiresAt > finishedAt, "nano-read-guard-stale");
  });
  return finishOperationalReport(config.stateDir, checks.sort((a, b) => a.stage.localeCompare(b.stage)), finishedAt,
    { fundingPause: runtimeFunding?.fundingPause, nearBackfilling: watcherHealth?.backfilling, nanoLedgerSync,
      nanoPaymentReadPeers: activePaymentPeers?.length, invocationId: config.invocationId });
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
    backupExportReport: env.OPERATIONAL_BACKUP_EXPORT_REPORT, backupCopyReport: env.OPERATIONAL_BACKUP_COPY_REPORT,
    nearDiscoveryReport: env.OPERATIONAL_NEAR_DISCOVERY_REPORT,
    outDir: "/srv/nanoodle-mcp/out",
    marketStateDir: env.MARKET_STATE_DIR, merchant, network: env.NEAR_NETWORK, canaryPayer,
    nanoAddress: deriveAddress(derivePublicKey(secret), { useNanoPrefix: true }), nearPublicKey: signer.publicKey,
    nanoRpcUrls, nanoStandby, nanoLedgerTelemetry: env.OPERATIONAL_NANO_LEDGER_TELEMETRY === "1",
    nearRpcUrls: env.NEAR_RPC_URL.split(",").map(s => s.trim()),
    site: env.NEAR_PUBLIC_URL || "https://near.nanoodle.com", nanoSite: env.NANO_PUBLIC_URL || "https://mcp.nanoodle.com", marketUrl: env.MARKET_BASE_URL || "https://market.near.ai",
    nanoGptBase: env.NANOGPT_BASE_URL || "https://nano-gpt.com", providerUsesWallet: !env.NANOGPT_API_KEY?.trim(),
    agents: readCatalog(env.MARKET_AGENTS_FILE).agents };
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
