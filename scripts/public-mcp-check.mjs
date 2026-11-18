#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createProbeFetch } from "../src/probe-http.mjs";

const NANO = "https://mcp.nanoodle.com";
const NEAR = "https://near.nanoodle.com";
const NEAR_ALIAS = "https://mcp-near.nanoodle.com";
const BABEL = "https://babel.255bits.com";
const INIT = { protocolVersion: "2025-06-18", capabilities: {},
  clientInfo: { name: "nanoodle-public-check", version: "1" } };
const REQUIRED_TOOLS = ["noodle_guide", "price_noodle", "run_noodle"];

class ProbeError extends Error {}
function need(condition, code) { if (!condition) throw new ProbeError(code); }

function fresh(age, maxAge) {
  return Number.isFinite(age) && age >= -30_000 && age <= maxAge;
}

export async function runPublicMcpCheck({ fetch, now = Date.now, retryMs = 2000 } = {}) {
  const request = createProbeFetch({ fetch, timeoutMs: 6000, maxBytes: 512 * 1024 });
  async function json(url, { body, status = 200 } = {}) {
    const headers = { accept: "application/json", "cache-control": "no-cache" };
    const init = body ? { method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body) } : { headers };
    const response = await request(url, init);
    need(response.status === status, `http-${response.status}`);
    let result;
    try { result = await response.json(); } catch { throw new ProbeError("invalid-json"); }
    need(result !== null && typeof result === "object" && !Array.isArray(result), "invalid-response");
    return result;
  }

  // Public smoke testing can discover tools but cannot call them or make a quote.
  function rpc(method, params) { return { jsonrpc: "2.0", id: 1, method, params }; }
  async function discover(site) {
    const hello = await json(site + "/mcp", { body: rpc("initialize", INIT) });
    need(hello.jsonrpc === "2.0" && hello.id === 1 && !hello.error && hello.result?.serverInfo?.name === "nanoodle-mcp",
      "invalid-mcp-initialize");
    const list = await json(site + "/mcp", { body: rpc("tools/list", {}) });
    const tools = list.result?.tools;
    need(list.jsonrpc === "2.0" && list.id === 1 && !list.error && Array.isArray(tools)
      && REQUIRED_TOOLS.every(name => tools.some(tool => tool?.name === name)), "mcp-tools-missing");
  }

  const probes = {
    "nano-mcp": () => discover(NANO),
    "near-mcp": () => discover(NEAR),
    "near-alias-mcp": () => discover(NEAR_ALIAS),
    "nano-rates": async () => {
      const rates = await json(NANO + "/rates");
      need(rates.sources?.xnoUsd?.usable === true && typeof rates.xnoUsd === "string"
        && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(rates.xnoUsd)
        && Number(rates.xnoUsd) > 0 && Number.isFinite(Number(rates.xnoUsd)), "xno-rate-unavailable");
      need(fresh(now() - Date.parse(rates.sources.xnoUsd.at), 300_000), "xno-rate-stale");
    },
    "near-payment-watcher": async () => {
      const health = await json(NEAR + "/near/health");
      need(health.active === true && health.network === "mainnet" && health.merchant === "nanoodle.near"
        && health.watcher?.listening === true, "near-watcher-unavailable");
      need(fresh(now() - Date.parse(health.watcher.lastScanAt), 120_000), "near-watcher-stale");
      need(health.watcher.backfilling === false, "near-watcher-backfilling");
    },
    "near-refund-funding": async () => {
      const { funding } = await json(NEAR + "/near/health");
      need(funding?.enforced === true, "near-refund-funding-unavailable");
      need(Number.isSafeInteger(funding.checkedAt) && fresh(now() - funding.checkedAt, 60_000), "near-refund-funding-stale");
      if (funding.ok === false && funding.code === "NEAR_FUNDING_INSUFFICIENT") throw new ProbeError("near-refund-funding-insufficient");
      need(funding.ok === true, "near-refund-funding-unavailable");
      need(funding.canQuoteNear === true && funding.canQuoteUsdc === true, "near-refund-funding-exhausted");
    },
    "babel-ingress": async () => {
      const result = await json(BABEL + "/mcp/v1", { body: rpc("initialize", INIT), status: 401 });
      need(result.error, "invalid-babel-challenge");
    },
  };
  const checkedAt = new Date(now()).toISOString();
  const checks = await Promise.all(Object.entries(probes).map(async ([stage, probe]) => {
    for (let attempt = 1; ; attempt++) {
      try { await probe(); return { stage, ok: true, attempts: attempt }; }
      catch (error) {
        if (attempt === 2) {
          const code = error instanceof ProbeError ? error.message : error?.name === "TimeoutError" ? "timeout" : "request-failed";
          return { stage, ok: false, attempts: attempt, code };
        }
        await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
  }));
  return { checkedAt, ok: checks.every(check => check.ok), checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const report = await runPublicMcpCheck();
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
