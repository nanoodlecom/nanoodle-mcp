import { createProbeFetch } from "./probe-http.mjs";

const NANO = "https://mcp.nanoodle.com";
const NANO_ALIAS = "https://nano.nanoodle.com";
const NEAR = "https://near.nanoodle.com";
const NEAR_ALIAS = "https://mcp-near.nanoodle.com";
const BABEL = "https://babel.255bits.com";
const INIT = { protocolVersion: "2025-06-18", capabilities: {},
  clientInfo: { name: "nanoodle-public-check", version: "1" } };
const REQUIRED_TOOLS = ["noodle_guide", "price_noodle", "run_noodle"];
const DECIDER_MODEL = "perplexity/pplx-decider-v1.2";
const CONDITIONAL_GRAPH = {
  v: 1,
  nodes: [
    { id: "input", type: "text", fields: { text: "The budget was approved." } },
    { id: "decision", type: "decide-branch", fields: { model: DECIDER_MODEL, question: "Was the budget approved?" } },
    { id: "yes-answer", type: "llm", fields: { model: "openai/gpt-4.1-nano", maxTokens: 64 } },
    { id: "no-answer", type: "llm", fields: { model: "openai/gpt-4.1-nano", maxTokens: 64 } },
  ],
  links: [
    { id: "input-text", from: { node: "input", port: "text" }, to: { node: "decision", port: "text" } },
    { id: "yes-route", from: { node: "decision", port: "yes" }, to: { node: "yes-answer", port: "prompt" } },
    { id: "no-route", from: { node: "decision", port: "no" }, to: { node: "no-answer", port: "prompt" } },
  ],
};

class ProbeError extends Error {}
function need(condition, code) { if (!condition) throw new ProbeError(code); }

function fresh(age, maxAge) {
  return Number.isFinite(age) && age >= -30_000 && age <= maxAge;
}

function positiveUsd(value) {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
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

  // Discovery and free pricing only. A paid tool is never called by a probe.
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

  async function conditionalPrice(site, asset) {
    const response = await json(site + "/mcp", { body: rpc("tools/call", {
      name: "price_noodle", arguments: { graph: CONDITIONAL_GRAPH, ...(asset ? { _pay_with: asset } : {}) },
    }) });
    const result = response.result, content = result?.structuredContent, pricing = content?.pricing;
    need(response.jsonrpc === "2.0" && response.id === 1 && !response.error && !result?.isError
      && pricing?.currency === "USD" && pricing.safety?.ok === true && Array.isArray(pricing.unpriced)
      && pricing.unpriced.length === 0, "conditional-price-unavailable");
    need(!content.payment && !content.quote && !content.x402 && (!asset || content[asset]?.network === "mainnet"),
      "conditional-price-response-invalid");
    const estimate = pricing.estimatedCost, likely = pricing.likelyCharge?.usd, deposit = pricing.deposit?.usd;
    const items = estimate?.items;
    need(Array.isArray(items) && items.length === 3
      && items.some(item => item?.nodeId === "decision" && item.model === DECIDER_MODEL && positiveUsd(item.usd))
      && ["yes-answer", "no-answer"].every(id => items.some(item => item?.nodeId === id && positiveUsd(item.usd))),
      "conditional-price-branch-missing");
    need([estimate.usd, likely, deposit].every(positiveUsd) && Number(estimate.usd) <= Number(likely)
      && Number(likely) <= Number(deposit), "conditional-price-deposit-invalid");
  }

  const probes = {
    "nano-mcp": () => discover(NANO),
    "nano-alias-mcp": () => discover(NANO_ALIAS),
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
      if (funding.canQuoteUsdc === false && funding.usdcCode === "USDC_FUNDING_UNAVAILABLE") throw new ProbeError("usdc-refund-funding-unavailable");
      need(funding.canQuoteNear === true && funding.canQuoteUsdc === true, "near-refund-funding-exhausted");
    },
    "babel-ingress": async () => {
      const result = await json(BABEL + "/mcp/v1", { body: rpc("initialize", INIT), status: 401 });
      need(result.error, "invalid-babel-challenge");
    },
  };
  const checkedAt = new Date(now()).toISOString();
  async function check(stage, probe) {
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
  }
  const checks = await Promise.all(Object.entries(probes).map(([stage, probe]) => check(stage, probe)));
  checks.push(...await Promise.all([
    check("nano-conditional-graph-pricing", () => conditionalPrice(NANO)),
    check("nano-alias-conditional-graph-pricing", () => conditionalPrice(NANO_ALIAS)),
    check("near-conditional-pricing", () => conditionalPrice(NEAR, "near")),
    check("usdc-conditional-pricing", () => conditionalPrice(NEAR, "usdc")),
  ]));
  return { checkedAt, ok: checks.every(check => check.ok), checks };
}
