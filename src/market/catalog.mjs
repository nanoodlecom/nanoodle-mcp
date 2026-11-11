/**
 * Several Agent Market listings served by one worker: the catalog file, the
 * listing price read from the market, the per-job budget derived from it, and
 * the price a listing needs to cover its own workflow.
 *
 * The market charges a flat price per hire, per listing, and refunds nothing
 * per run. So each listing is priced close to what its own workflow can cost,
 * and that price follows NanoGPT's catalog. Money here is integer arithmetic
 * (cents, tenths of cents, micro-dollars): 0.95 × 0.40 is not 0.38 in floating
 * point.
 *
 * Market reads (public, OpenAPI "agents-market API" 2.0.0):
 *   GET   /v1/agents/{id_or_handle}            AgentPublic (owner view for an owner)
 *   GET   /v1/agents/{agent_id}/pricing-plans  PricingPlan[] ("public sees only live")
 *   PATCH /v1/pricing-plans/{pricing_plan_id}  { price_amount }  (MARKET_AUTO_PRICE only;
 *         the docs suggest only the owner's session may do this, so a refusal is expected)
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MarketConfigError, readDefaultWorkflow } from "./service.mjs";

/** The package directory: relative graph paths in a catalog resolve against it. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Handles as the market allows them, kept to the length the catalog accepts. */
export const HANDLE_RE = /^[a-z][a-z0-9-]{2,29}$/;
/** The market keeps 5% of the price (GET /v1/platform/config: platform_fee_bps 500). */
const FEE_BPS = 500;
/** Prices are recommended in steps of this many cents. */
const MIN_PRICE_CENTS = 2; // at $0.01 nothing is left after the market's 5% fee
/** The default refresh of the market price. */
export const PRICE_REFRESH_SECONDS = 600;
/** The brief used to price a listing's own workflow: as long as a brief may be (the input cap), so the estimate is for the longest brief. */
export const PROBE_BRIEF = "a lighthouse at dawn, ".repeat(1000).slice(0, 20_000);

const AGENT_KEYS = new Set(["handle", "tokenFile", "graph", "input", "custom", "priceUsd", "fields"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const die = (msg) => { throw new MarketConfigError(msg); };

/** The market's page for a listing (an on-market link: buyers hire there). */
export const listingUrl = (handle) => `https://market.near.ai/a/${handle}`;

/* ------------------------------ money ------------------------------ */

/**
 * A decimal USD amount as integer micro-dollars (the market stores NUMERIC(18, 6)).
 * Accepts a decimal string ("0.5000") or a finite number. null when unreadable or negative.
 */
export function usdMicros(v) {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 1e6) : null;
  const m = /^\s*(\d{1,12})(?:\.(\d{0,6})\d*)?\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  return Number(m[1]) * 1e6 + Number((m[2] || "").padEnd(6, "0"));
}

/** Format dollars for a log line or a PATCH: 2 decimals, more only when needed (0.4 → "0.40", 0.375 → "0.375"). */
export function fmtUsd(usd) {
  const micros = usdMicros(usd) ?? 0;
  const whole = Math.floor(micros / 1e6);
  let frac = String(micros % 1e6).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/**
 * The per-job budget a price pays for: price × 0.95 (the market's 5% fee),
 * rounded DOWN to the cent.
 * @param {number|string} priceUsd
 * @returns {number} dollars (0 when the price is unreadable)
 */
export function budgetFromPrice(priceUsd) {
  const micros = usdMicros(priceUsd);
  if (micros == null) return 0;
  // micros × (10000 − 500) / 10000 → micro-dollars after the fee; / 10000 → cents.
  const cents = Math.floor((micros * (10_000 - FEE_BPS)) / 100_000_000);
  return cents / 100;
}

/**
 * The smallest price, in whole cents and at least $0.02, whose payout after
 * the market's 5% fee covers what the listing's own workflow needs (its
 * estimated cost + 20%, runner.mjs marketNeedUsd): 0.95 × price ≥ need.
 * `depositUsd` is that need; the name is the pricing object's field.
 * @param {{ depositUsd: number }} o
 * @returns {number} dollars
 */
export function recommendPrice({ depositUsd }) {
  if (!(typeof depositUsd === "number" && Number.isFinite(depositUsd) && depositUsd >= 0)) throw new TypeError("recommendPrice needs the job's need in USD");
  // Micro-dollars, rounded UP (a need is never underestimated): 0.37 → 370000.
  // (The float is first rounded at 1e-8, so 0.37 × 1e6 = 370000.00000000006 is not taken for 370001.)
  const d = Math.ceil(Math.round(depositUsd * 1e8) / 100);
  // price = c cents = 10000c micro-dollars; 0.95 × 10000c = 9500c ≥ d.
  const c = Math.max(MIN_PRICE_CENTS, Math.ceil(d / 9_500));
  return c / 100;
}

/**
 * How a listing's price compares with what its own workflow needs.
 * @param {{ priceUsd: number|null, depositUsd: number }} o
 * @returns {{ verdict: "ok"|"too-low"|"lower"|"unknown", recommendedUsd: number, budgetUsd: number|null, text: string }}
 */
export function priceVerdict({ priceUsd, depositUsd }) {
  const recommendedUsd = recommendPrice({ depositUsd });
  if (priceUsd == null) return { verdict: "unknown", recommendedUsd, budgetUsd: null, text: `no price known; set $${fmtUsd(recommendedUsd)}` };
  const budgetUsd = budgetFromPrice(priceUsd);
  const cents = (x) => Math.round(x * 100);
  if (cents(depositUsd) > cents(budgetUsd)) return { verdict: "too-low", recommendedUsd, budgetUsd, text: "too low: the worker would decline this listing's own workflow" };
  if (usdMicros(priceUsd) > usdMicros(recommendedUsd)) return { verdict: "lower", recommendedUsd, budgetUsd, text: `could be lowered to $${fmtUsd(recommendedUsd)}` };
  return { verdict: "ok", recommendedUsd, budgetUsd, text: "ok" };
}

/* ------------------------------ catalog ------------------------------ */

/**
 * Read and check a catalog file. Token files are not read here (a listing whose
 * token is not there yet is skipped when the worker starts, not refused here).
 * @param {string} file
 * @param {{ root?: string }} [o]  where relative graph paths resolve (default: the package directory)
 * @returns {{ file: string, agents: Array<{ handle, tokenFile, graphFile, input, custom, priceUsd, defaultWorkflow }> }}
 * @throws {MarketConfigError}
 */
export function readCatalog(file, { root = REPO_ROOT } = {}) {
  let path = resolve(file);
  if (!existsSync(path) && !isAbsolute(file) && existsSync(resolve(root, file))) path = resolve(root, file);
  let doc;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch (e) { die(`agents file ${file}: cannot read it as JSON (${e.message})`); }
  const bad = (msg) => die(`agents file ${file}: ${msg}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) bad('expected an object { "agents": [ … ] }');
  const extra = Object.keys(doc).filter((k) => k !== "agents" && k !== "comment");
  if (extra.length) bad(`unknown key ${JSON.stringify(extra[0])} (allowed: "agents")`);
  if (!Array.isArray(doc.agents) || !doc.agents.length) bad('"agents" must be a non-empty array');
  const seen = new Set();
  const agents = doc.agents.map((a, i) => {
    const where = `agents[${i}]${a && typeof a.handle === "string" ? ` (${a.handle})` : ""}`;
    if (!a || typeof a !== "object" || Array.isArray(a)) bad(`${where}: not an object`);
    const unknown = Object.keys(a).filter((k) => !AGENT_KEYS.has(k));
    if (unknown.length) bad(`${where}: unknown key ${JSON.stringify(unknown[0])} (allowed: ${[...AGENT_KEYS].join(", ")})`);
    if (typeof a.handle !== "string" || !HANDLE_RE.test(a.handle)) bad(`${where}: "handle" must be 3-30 characters, [a-z][a-z0-9-]*`);
    if (seen.has(a.handle)) bad(`${where}: handle ${a.handle} appears twice`);
    seen.add(a.handle);
    if (typeof a.tokenFile !== "string" || !isAbsolute(a.tokenFile)) bad(`${where}: "tokenFile" must be an absolute path`);
    if (a.custom !== undefined && typeof a.custom !== "boolean") bad(`${where}: "custom" must be true or false`);
    const custom = a.custom === true;
    if (a.graph !== undefined && a.graph !== null && (typeof a.graph !== "string" || !a.graph)) bad(`${where}: "graph" must be a file path or null`);
    const graphFile = a.graph ? (isAbsolute(a.graph) ? a.graph : resolve(root, a.graph)) : null;
    if (!graphFile && !custom) bad(`${where}: a listing needs a "graph", or "custom": true (or both)`);
    if (a.input !== undefined && (typeof a.input !== "string" || !a.input)) bad(`${where}: "input" must be the name of a text input`);
    if (a.input && !graphFile) bad(`${where}: "input" needs a "graph"`);
    if (a.priceUsd !== undefined && a.priceUsd !== null && !(typeof a.priceUsd === "number" && Number.isFinite(a.priceUsd) && a.priceUsd > 0)) {
      bad(`${where}: "priceUsd" must be a number above 0`);
    }
    if (a.priceUsd != null && budgetFromPrice(a.priceUsd) <= 0) bad(`${where}: "priceUsd" ${a.priceUsd} leaves no budget after the market's 5% fee`);
    let defaultWorkflow = null;
    if (graphFile) {
      try { defaultWorkflow = readDefaultWorkflow(graphFile, a.input); } catch (e) {
        if (!(e instanceof MarketConfigError)) throw e;
        bad(`${where}: ${e.message.replace(/--default-graph |--default-input /g, "")}`);
      }
    }
    if (a.fields !== undefined) {
      if (!a.fields || typeof a.fields !== "object" || Array.isArray(a.fields)) bad(`${where}: "fields" must be an object { "<input name>": { "seconds": { … } } }`);
      if (!defaultWorkflow) bad(`${where}: "fields" needs a "graph"`);
      for (const [name, spec] of Object.entries(a.fields)) {
        if (!defaultWorkflow.fieldNames.includes(name)) bad(`${where}: "fields" names ${JSON.stringify(name)}, which is not a named text input of the graph besides the brief's (it has: ${defaultWorkflow.fieldNames.join(", ") || "none"})`);
        const s = spec && typeof spec === "object" && !Array.isArray(spec) && Object.keys(spec).length === 1 ? spec.seconds : null;
        const ints = s && typeof s === "object" ? ["min", "max", "defaultMin", "defaultMax"].map((k) => s[k]) : [];
        if (ints.length !== 4 || !ints.every((n) => Number.isInteger(n) && n > 0) || Object.keys(s).length !== 4) {
          bad(`${where}: field ${JSON.stringify(name)} must be { "seconds": { "min", "max", "defaultMin", "defaultMax" } } with whole seconds above 0`);
        }
        if (!(s.min <= s.defaultMin && s.defaultMin <= s.defaultMax && s.defaultMax <= s.max)) bad(`${where}: field ${JSON.stringify(name)} needs min <= defaultMin <= defaultMax <= max`);
      }
      defaultWorkflow = { ...defaultWorkflow, fieldSpecs: a.fields };
    }
    return { handle: a.handle, tokenFile: a.tokenFile, graphFile, input: defaultWorkflow ? defaultWorkflow.inputName : null, custom, priceUsd: a.priceUsd ?? null, defaultWorkflow };
  });
  return { file: path, agents };
}

/* ------------------------------ market reads ------------------------------ */

/**
 * Read a listing's current default price from the market: first without
 * credentials (live listings are public), then with the agent's own token
 * (a draft is not public; whether its token sees it is not documented).
 * The token goes only to `baseUrl` and is never part of a result or message.
 * @returns {Promise<{ ok: true, priceUsd: number, priceText: string, planId: string, agentId: string, listingStatus: string|null, via: "public"|"token" } | { ok: false, reason: string }>}
 */
export async function fetchListingPrice({ baseUrl, handle, token = null, fetch = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!HANDLE_RE.test(String(handle))) return { ok: false, reason: "not a valid handle" };
  const base = String(baseUrl).replace(/\/+$/, "");
  async function get(path, auth) {
    const res = await fetch(base + path, {
      headers: { accept: "application/json", ...(auth ? { authorization: `Bearer ${String(token).trim()}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }
  let reason = "not read";
  for (const auth of token ? [false, true] : [false]) {
    const how = auth ? " (with the agent token)" : "";
    try {
      const a = await get(`/v1/agents/${handle}`, auth);
      if (a.status !== 200 || !a.json || !UUID.test(String(a.json.agent_id))) {
        reason = `GET /v1/agents/${handle}${how}: ${a.status === 200 ? "no agent_id in the answer" : `HTTP ${a.status}`}`;
        continue;
      }
      if (a.json.handle !== undefined && a.json.handle !== handle) { reason = `GET /v1/agents/${handle}${how}: answered for another handle`; continue; }
      const agentId = a.json.agent_id;
      const p = await get(`/v1/agents/${agentId}/pricing-plans`, auth);
      if (p.status !== 200 || !Array.isArray(p.json)) { reason = `GET /v1/agents/{agent_id}/pricing-plans${how}: HTTP ${p.status}`; continue; }
      const plan = p.json.find((x) => x && x.is_default === true);
      if (!plan) { reason = `no default pricing plan is visible${how}`; continue; }
      const micros = usdMicros(plan.price_amount);
      if (typeof plan.price_amount !== "string" || micros == null || micros <= 0) { reason = `the default plan's price_amount is not a positive decimal${how}`; continue; }
      return {
        ok: true, priceUsd: micros / 1e6, priceText: plan.price_amount, planId: String(plan.pricing_plan_id || ""),
        agentId, listingStatus: typeof plan.listing_status === "string" ? plan.listing_status : null, via: auth ? "token" : "public",
      };
    } catch (e) {
      reason = `no answer from the market${how} (${(e && e.name) || "error"})`;
    }
  }
  return { ok: false, reason };
}

/**
 * Raise a pricing plan's price with the agent's own token. The market may well
 * refuse this (its docs suggest only the owner's session may change prices).
 * @returns {Promise<{ ok: boolean, status: number|null, priceText?: string }>}
 */
export async function patchListingPrice({ baseUrl, planId, token, priceUsd, fetch = globalThis.fetch, timeoutMs = 15_000 }) {
  if (!UUID.test(String(planId))) return { ok: false, status: null };
  const base = String(baseUrl).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/pricing-plans/${planId}`, {
      method: "PATCH",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${String(token).trim()}` },
      body: JSON.stringify({ price_amount: fmtUsd(priceUsd) }),
      signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.status === 200, status: res.status, priceText: json && typeof json.price_amount === "string" ? json.price_amount : undefined };
  } catch {
    return { ok: false, status: null };
  }
}
