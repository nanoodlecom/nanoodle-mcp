/**
 * Price and run a buyer's workflow on the operator's NanoGPT key, with the
 * same rules as the NEAR gate. Nothing here is forked from it:
 *
 *   - check + price:  computePrice() from src/tools.mjs, the function behind
 *     price_noodle and the NEAR quote check. It reads the graph or share link
 *     (fragment links only), applies the custom-workflow safety allowlist and
 *     caps, checks the inputs, prices every paid node from NanoGPT's public
 *     catalog, and adds the quote refusals (live-priced or unpriced models).
 *   - what a job needs: NOT the direct rails' deposit. A market buyer pays a
 *     flat price and nothing can be refunded in part, so there is no deposit.
 *     A job needs its estimated model cost plus 20% (marketNeedUsd), and is
 *     refused when that is above the operator's per-job budget. The returned
 *     pricing carries that figure as `depositUsd`.
 *   - run: the priced graph with every bound quantity written in
 *     (pricing.boundGraph from priceGraph/bindPaidGraph), through
 *     prepareRunNoodle() and the engine, exactly as the NEAR gate runs it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MediaRef } from "nanoodle";
import { computePrice, prepareRunNoodle, describeRunFailure, runNotices, extForMedia, ParamsError } from "../tools.mjs";
import { DEFAULT_LIMITS, GraphArgsError, GraphRefusedError, exactUsd } from "../custom-workflow.mjs";

/** The operator's margin on a market job, on top of the estimated model cost. */
export const MARKET_MARGIN_RATE = 0.2;

/**
 * What a job needs on the market: the estimated model cost plus 20%, rounded up
 * to the cent, at least $0.01. (Rounded at 1e-8 first, so 0.25 × 1.2 is 0.30, not 0.31.)
 */
export function marketNeedUsd(estimatedCostUsd) {
  if (!(typeof estimatedCostUsd === "number" && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0)) throw new TypeError("marketNeedUsd needs an estimated cost in USD");
  return Math.max(0.01, Math.ceil(Math.round(estimatedCostUsd * (1 + MARKET_MARGIN_RATE) * 1e8) / 1e6) / 100);
}

/** A run failure caused by the operator's NanoGPT account, not by the buyer's workflow. */
export function isOperatorSideFailure(message) {
  return /API key rejected|NANOGPT_API_KEY|HTTP 40[123]\b|insufficient (balance|funds|credit)|payment required/i.test(String(message || ""));
}

/**
 * Ask NanoGPT whether the key is accepted, before any buyer depends on it.
 * @returns {Promise<{ ok: boolean, status: number|null, detail: string }>} ok=false only on a
 *   definite rejection (401/403); a network error or any other status is "unknown" and ok.
 */
export async function checkNanoGptKey({ apiKey, baseUrl = "https://nano-gpt.com", fetch = globalThis.fetch, timeoutMs = 15_000 }) {
  try {
    const res = await fetch(new URL("/api/check-balance", baseUrl), {
      method: "POST", headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, detail: "NanoGPT rejected the API key" };
    return { ok: true, status: res.status, detail: res.ok ? "accepted" : `not checked (HTTP ${res.status})` };
  } catch (e) {
    return { ok: true, status: null, detail: `not checked (${(e && e.name) || "error"})` };
  }
}

/**
 * @param {object} o
 * @param {string} [o.apiKey]      operator's NanoGPT API key (never logged), or
 * @param {(invoice: object) => Promise<void>} [o.payment]  an x402 payment callback (the server's Nano wallet)
 * @param {number} o.budgetUsd     per-job budget: the most a job may need (estimated cost + 20%)
 * @param {string} [o.baseUrl]     NanoGPT base URL (tests point it at a stand-in)
 * @param {typeof fetch} [o.fetch] for catalogs and share links
 * @param {object} [o.limits]      custom-workflow caps (maxDepositUsd is replaced by budgetUsd)
 * @param {(line: string) => void} [o.log]
 */
export function createWorkflowRunner({ apiKey, payment, budgetUsd, baseUrl, fetch = globalThis.fetch, limits = DEFAULT_LIMITS, log = () => {} }) {
  const keyed = typeof apiKey === "string" && !!apiKey;
  if (!keyed && typeof payment !== "function") throw new TypeError("createWorkflowRunner needs the operator's NanoGPT API key or an x402 payment callback");
  // A key always wins, as everywhere else in this package.
  const funding = keyed ? { apiKey } : { payment };
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new TypeError("createWorkflowRunner needs a positive budgetUsd");
  const L = { ...DEFAULT_LIMITS, ...(limits || {}), maxDepositUsd: budgetUsd };

  return {
    limits: L,

    /**
     * Check and price a request. Never runs anything, never throws for a bad graph.
     * @param {object} args
     * @param {{ budgetUsd?: number }} [o]  the budget for this request (default: the runner's
     *   budgetUsd). A worker whose listing price changes passes the budget a job was accepted under.
     * @returns {Promise<{ ok: boolean, refusals: Array<{code,message}>, pricing: object|null, inputs: object }>}
     */
    async price(args, { budgetUsd: cap } = {}) {
      if (cap !== undefined && !(Number.isFinite(cap) && cap > 0)) throw new TypeError("price: budgetUsd must be a positive number");
      const budget = cap === undefined ? L.maxDepositUsd : cap;
      // The direct rails' deposit check is switched off; the market rule is applied below.
      const limits = { ...L, maxDepositUsd: Number.MAX_SAFE_INTEGER };
      let computed;
      try {
        computed = await computePrice(args, { baseUrl, fetch, log, allowShortLinks: false, limits });
      } catch (e) {
        if (e instanceof GraphArgsError || e instanceof ParamsError) {
          return { ok: false, refusals: [{ code: "BAD_REQUEST", message: e.message }], pricing: null, inputs: {} };
        }
        if (e instanceof GraphRefusedError) return { ok: false, refusals: e.refusals, pricing: null, inputs: {} };
        throw e;
      }
      const refusals = [...(computed.safety.refusals || [])];
      let pricing = computed.pricing;
      if (pricing) {
        const need = marketNeedUsd(pricing.estimatedCostUsd);
        pricing = { ...pricing, depositUsd: need };
        if (need > budget) {
          refusals.push({
            code: "OVER_BUDGET",
            message: `this workflow's estimated cost plus 20% is $${exactUsd(need)}; this listing covers at most $${exactUsd(budget)} — use cheaper models, fewer paid nodes or a lower maxTokens`,
          });
        }
      }
      return {
        ok: !!computed.safety.ok && refusals.length === 0,
        refusals,
        pricing,
        inputs: (computed.read && computed.read.inputs) || {},
        x402: computed.read?.graph?.x402 || null,
      };
    },

    /**
     * Run the priced graph once. Media outputs are written to outDir.
     * @returns {Promise<{ costUsd: number|null, costExact: boolean, notices: string[], outputs: Array }>}
     *   outputs: [{ key, kind: "text", text }] | [{ key, kind: "file", path, filename, byteSize, mime }]
     * @throws on a failed run (message from describeRunFailure; `buyerMessage` is set only
   *   when the message is the provider's per-step errors, safe to show the buyer)
     */
    async run({ pricing, inputs, outDir }) {
      const { wf, inputs: resolved } = await prepareRunNoodle(
        { graph: pricing.boundGraph, inputs },
        { ...funding, baseUrl, fetch, log, allowShortLinks: false },
      );
      const { onProgress, notices } = runNotices(wf);
      let result;
      try {
        result = await wf.run(resolved, { onProgress });
      } catch (e) {
        const d = describeRunFailure(e);
        // describeRunFailure returns a new error only when the engine reported per-step
        // (provider) errors; that text may go to the buyer. Anything else stays operator-only.
        // ...unless the failure is the operator's own (a rejected key, an empty balance):
        // the buyer cannot act on it and should not read about the operator's account.
        if (d !== e && !isOperatorSideFailure(d.message)) d.buyerMessage = d.message;
        throw d;
      }
      const outputs = [];
      let n = 0;
      for (const o of wf.outputs) {
        const value = result.outputs[o.key];
        if (value === undefined) continue;
        if (value instanceof MediaRef) {
          const bytes = Buffer.from(await value.bytes());
          const ext = extForMedia(bytes, value.mime);
          const safe = String(o.key).replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "output";
          const filename = `${String(++n).padStart(2, "0")}-${safe}.${ext}`;
          const path = join(outDir, filename);
          writeFileSync(path, bytes, { mode: 0o600 });
          outputs.push({ key: o.key, kind: "file", path, filename, byteSize: bytes.length, mime: value.mime || null });
        } else {
          outputs.push({ key: o.key, kind: "text", text: String(value) });
        }
      }
      const costUsd = typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? result.costUsd : null;
      return { costUsd, costExact: result.costExact !== false && costUsd != null, notices: [...notices], outputs };
    },
  };
}
