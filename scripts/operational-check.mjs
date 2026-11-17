#!/usr/bin/env node
// Read-only production readiness. No Workflow.run, payment, work generation,
// signing, receive sweep, assignment start, bid, submission or price mutation.
import { readFileSync, mkdirSync, chmodSync, statfsSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { deriveAddress, derivePublicKey, checkAddress } from "nanocurrency";
import { createProbeFetch } from "../src/probe-http.mjs";
import { paymentLiabilities, liquidityChecks, nanoLiquidityCheck } from "../src/operational-state.mjs";
import { createNearRpc, loadNearSigner, checkUsdcMerchant } from "../src/near/index.mjs";
import { resolveWalletKey } from "../src/wallet.mjs";
import { parseUsdNano } from "../src/gate.mjs";
import { readCatalog, fetchListingPrice } from "../src/market/catalog.mjs";
import { marketNeedUsd } from "../src/market/runner.mjs";
import { computePrice } from "../src/tools.mjs";
import { DEFAULT_HOSTED_RUN_MS } from "../src/hosted-run.mjs";
import { NANO_GENESIS, checkNanoGenesis, nanoAccountView } from "../src/nano-read-pool.mjs";
import { readNearFunding } from "../src/near/funding.mjs";
import { atomicJson, checkGraph } from "./near-check.mjs";

const ALL = ["nano", "near", "usdc", "market"];
class CheckError extends Error {}
const need = (condition, code) => { if (!condition) throw new CheckError(code); };
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const safeCode = e => e instanceof CheckError ? e.message : /^[A-Z_]{2,60}$/.test(e?.code || "") ? e.code : /Timeout|Abort/.test(e?.name || "") ? "request-timeout" : "probe-failed";

export function finishOperationalReport(stateDir, checks, now = Date.now()) {
  const latest = join(stateDir, "latest.json");
  let previous; try { previous = readJson(latest); } catch { /* first probe */ }
  const failed = checks.filter(c => !c.ok);
  const fingerprint = createHash("sha256").update(JSON.stringify(failed.map(c => [c.stage, c.code]).sort())).digest("hex");
  const firstSeenAt = previous?.fingerprint === fingerprint && previous.ok === false ? previous.firstSeenAt : now;
  const reminder = Math.floor((now - firstSeenAt) / (6 * 3_600_000));
  const incidentId = createHash("sha256").update(`${fingerprint}:${firstSeenAt}:${reminder}`).digest("hex").slice(0, 32);
  const admission = Object.fromEntries(ALL.map(asset => [asset, !failed.some(c => c.domains?.includes(asset))]));
  const report = { v: 1, ok: failed.length === 0, checkedAt: new Date(now).toISOString(), stage: failed[0]?.stage || "complete",
    admission, checks, ...(failed.length ? { fingerprint, firstSeenAt, incidentId } : {}) };
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
  const checks = [];
  const check = async (stage, fn, domains = ALL) => {
    try { const value = await fn(); checks.push({ stage, ok: true }); return value; }
    catch (e) { checks.push({ stage, ok: false, code: safeCode(e), domains }); return null; }
  };
  const http = async (url, init = {}) => {
    const response = await request(url, init); need(response.ok, `http-${response.status}`); return response.json();
  };
  const nanoRpc = async (url, body) => {
    need(["account_info", "block_count", "version", "block_info"].includes(body.action), "probe-action-forbidden");
    const result = await http(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  await check("runtime-funding", async () => {
    const value = read(join(config.outDir, "funding-health.json"));
    need(value?.v === 1, "funding-report-missing");
    const age = now() - Date.parse(value.checkedAt);
    need(Number.isFinite(age) && age <= 60_000 && age >= -30_000, "funding-report-stale");
    need(value.enforced === true && value.protectTransfers === true, "funding-not-enforced");
    need([value.balanceRaw, value.liabilitiesRaw, value.reservedRaw].every(v => typeof v === "string" && /^\d{1,39}$/.test(v)), "funding-report-invalid");
    need(value.ok === true && BigInt(value.balanceRaw) >= BigInt(value.liabilitiesRaw) + BigInt(value.reservedRaw), "funding-underfunded");
    need(Number.isSafeInteger(value.activeRuns) && value.activeRuns >= 0, "funding-report-invalid");
    const limit = Object.hasOwn(value, "runTimeoutMs") ? value.runTimeoutMs : DEFAULT_HOSTED_RUN_MS;
    need(Number.isSafeInteger(limit) && limit > 0 && limit <= 24 * 3_600_000, "funding-report-invalid");
    need(value.activeRuns === 0 ? value.oldestStartedAt === null : Number.isSafeInteger(value.oldestStartedAt)
      && value.oldestStartedAt <= now() + 30_000 && now() - value.oldestStartedAt <= limit + 15 * 60_000, "funding-run-stuck");
    const rpc = value.nanoRpc;
    need(rpc?.enforced === true && rpc.configuredPeers === config.nanoRpcUrls.length, "nano-read-guard-not-enforced");
    const minimum = Math.min(2, config.nanoRpcUrls.length);
    need([rpc.networkPeers, rpc.readablePeers].every(n => Number.isSafeInteger(n) && n >= minimum && n <= config.nanoRpcUrls.length)
      && rpc.minimumPeers === minimum, "nano-read-guard-no-quorum");
    need(Number.isSafeInteger(rpc.lastReadAt) && now() - rpc.lastReadAt <= 60_000 && now() - rpc.lastReadAt >= -30_000, "nano-read-guard-stale");
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
    checkNanoGenesis(await nanoRpc(url, { action: "block_info", hash: NANO_GENESIS, json_block: "true" }));
    const info = await nanoRpc(url, { action: "account_info", account: config.nanoAddress, representative: "true", include_confirmed: "true", receivable: "true" });
    nanoAccountView(info, checkAddress);
    return info;
  }, [])))).filter(Boolean);
  const nano = await check("nano-frontier-agreement", async () => {
    need(nanoNodes.length >= Math.min(2, config.nanoRpcUrls.length), "nano-read-quorum-unavailable");
    const highest = nanoNodes.reduce((a, b) => BigInt(a.confirmed_height) >= BigInt(b.confirmed_height) ? a : b);
    const consistent = nanoNodes.every(n => BigInt(highest.confirmed_height) - BigInt(n.confirmed_height) <= 2n
      && (n.confirmed_height !== highest.confirmed_height || n.confirmed_frontier === highest.confirmed_frontier));
    need(consistent, "nano-wallet-nodes-disagree");
    return highest;
  });
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
  const site = await check("near-payment-watcher", async () => {
    const health = await http(config.site + "/near/health");
    need(health.active && health.merchant === config.merchant && health.network === config.network, "near-listener-not-active");
    const age = now() - Date.parse(health.watcher?.lastScanAt);
    need(health.watcher?.listening && Number.isFinite(age) && age < 120_000 && age >= -30_000, "near-watcher-stale");
    need(health.funding?.enforced === true, "near-refund-funding-not-enforced");
    need(health.funding.ok === true && Number.isSafeInteger(health.funding.checkedAt)
      && now() - health.funding.checkedAt <= 60_000 && now() - health.funding.checkedAt >= -30_000, "near-refund-funding-unhealthy");
    if (near) need(Number(near.block.header.height) - Number(health.watcher.height) <= 120, "near-watcher-behind");
    return health;
  }, ["near", "usdc"]);
  if (site) for (const [asset, key] of [["near", "canQuoteNear"], ["usdc", "canQuoteUsdc"]]) {
    await check(`${asset}-refund-admission`, async () => {
      need(site.funding[key] === true, "near-refund-capacity-exhausted");
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
      xnoUsd: rates.xnoUsd, providerReserveUsd: config.providerReserveUsd || "2" });
    need(result.ok, result.code);
  });
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
        xnoUsd: rates.xnoUsd, providerReserveUsd: config.providerReserveUsd || "2" });
      for (const result of results.filter(r => r.stage !== "nano-liquidity")) checks.push({ ...result, ...(result.ok ? {} : { domains: result.stage === "usdc-liquidity" ? ["usdc"] : ["near", "usdc"] }) });
    }, ["near", "usdc"]);
  }
  const platform = await check("market-platform-fee", async () => {
    const result = await http(config.marketUrl + "/v1/platform/config");
    need(result.platform_fee_bps === 500, "market-fee-assumption-changed"); return result;
  }, ["market"]);
  await Promise.all(config.agents.map(async agent => {
    await check(`market-process-${agent.handle}`, async () => {
      const lock = read(join(config.marketStateDir, agent.handle, "worker.lock"));
      const alive = deps.isWorkerAlive || (value => {
        need(value.host === hostname() && value.boot === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "market-worker-lock-is-foreign");
        process.kill(value.pid, 0);
        const command = readFileSync(`/proc/${value.pid}/cmdline`, "utf8").split("\0");
        return command.includes("/srv/nanoodle-mcp/app/bin/nanoodle-mcp.mjs");
      });
      need(Number.isSafeInteger(lock?.pid) && lock.pid > 0 && alive(lock), "market-worker-process-missing");
    }, ["market"]);
    await check(`market-auth-${agent.handle}`, async () => {
      const token = (deps.readText || (file => readFileSync(file, "utf8")))(agent.tokenFile).trim();
      const result = await http(config.marketUrl + "/v1/agents/me/assignments?status=in_progress&limit=1&offset=0", { headers: { authorization: `Bearer ${token}` } });
      need(Array.isArray(result.assignments), "market-auth-response-invalid");
    }, ["market"]);
    if (!agent.defaultWorkflow) return;
    await check(`workflow-price-${agent.handle}`, async () => {
      const priced = await priceWorkflow({ graph: agent.defaultWorkflow.graph, inputs: { [agent.defaultWorkflow.inputName]: "A lighthouse at dawn" } },
        { fetch: request, baseUrl: config.nanoGptBase, allowShortLinks: false, limits: { maxDepositUsd: 1_000_000 } });
      need(priced.safety.ok && priced.pricing, "workflow-not-priceable");
      const listing = await fetchListingPrice({ baseUrl: config.marketUrl, handle: agent.handle, fetch: request });
      need(listing.ok && listing.listingStatus === "live", "market-price-unavailable");
      const needUsd = marketNeedUsd(priced.pricing.estimatedCostUsd);
      need(platform && parseUsdNano(String(listing.priceUsd)) * 9500n >= parseUsdNano(String(needUsd)) * 10000n, "market-workflow-underpriced");
      const remote = await mcp("tools/call", { name: "price_noodle", arguments: { graph: agent.defaultWorkflow.graph, inputs: { [agent.defaultWorkflow.inputName]: "A lighthouse at dawn" } } });
      need(!remote.isError && remote.structuredContent?.pricing?.safety?.ok, "mcp-pricing-unavailable");
    }, ["market"]);
  }));
  return finishOperationalReport(config.stateDir, checks.sort((a, b) => a.stage.localeCompare(b.stage)), now());
}

async function productionConfig(env = process.env) {
  const secret = resolveWalletKey({ privateKey: env.NANO_PRIVATE_KEY, seed: env.NANO_SEED });
  need(secret, "nano-wallet-not-configured");
  const merchant = env.NEAR_MERCHANT;
  const signer = await loadNearSigner({ accountId: merchant, keyFile: env.NEAR_KEY_FILE || null, env });
  return { stateDir: env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check", outDir: "/srv/nanoodle-mcp/out",
    marketStateDir: env.MARKET_STATE_DIR, merchant, network: env.NEAR_NETWORK,
    nanoAddress: deriveAddress(derivePublicKey(secret), { useNanoPrefix: true }), nearPublicKey: signer.publicKey,
    nanoRpcUrls: env.NANO_RPC_URL.split(",").map(s => s.trim()), nearRpcUrls: env.NEAR_RPC_URL.split(",").map(s => s.trim()),
    site: env.NEAR_PUBLIC_URL || "https://near.nanoodle.com", nanoSite: env.NANO_PUBLIC_URL || "https://mcp.nanoodle.com", marketUrl: env.MARKET_BASE_URL || "https://market.near.ai",
    nanoGptBase: env.NANOGPT_BASE_URL || "https://nano-gpt.com", agents: readCatalog(env.MARKET_AGENTS_FILE).agents };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  let report;
  try { report = await runOperationalCheck(await productionConfig()); }
  catch { report = finishOperationalReport(process.env.OPERATIONAL_CHECK_STATE_DIR || "/var/lib/nanoodle-operational-check", [{ stage: "preflight", ok: false, code: "check-could-not-finish", domains: ALL }]); }
  console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
}
