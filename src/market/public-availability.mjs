// Public availability only: no credentials, hires, inference or payments.
import { createProbeFetch } from "../probe-http.mjs";
import { MARKET_PLATFORM_FEE_BPS } from "./fee-guard.mjs";

// The custom-workflow profile is still unpublished. Add it after it goes live.
export const MARKET_HANDLES = ["nanoodle-song", "nanoodle-image", "nanoodle-character", "nanoodle-clip"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class ProbeError extends Error {}
const requireProbe = (condition, code) => { if (!condition) throw new ProbeError(code); };

export async function checkMarketAvailability({ url = "https://market.near.ai", attempts = 3, timeoutMs = 12_000, retryMs = 2_000 } = {}, deps = {}) {
  const request = createProbeFetch({ fetch: deps.fetch, timeoutMs, maxBytes: 524288 });
  const now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const base = new URL(url).origin, checkedAt = new Date(now()).toISOString();
  async function get(path, json = true) {
    const response = await request(base + path, { method: "GET",
      headers: { accept: json ? "application/json" : "text/html", "cache-control": "no-cache, no-store",
        "user-agent": "Nanoodle-Market-Availability/1.0" } });
    requireProbe(response.status === 200, `http-${response.status}`);
    if (!json) {
      requireProbe(/text\/html/i.test(response.headers.get("content-type") || "") && /NEAR AI Agent Market/.test(await response.text()), "unexpected-page");
      return;
    }
    try { return await response.json(); } catch { throw new ProbeError("invalid-json"); }
  }
  async function probe(stage, check) {
    let error;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return { stage, ok: true, attempts: attempt, ...await check() }; }
      catch (e) {
        // Never retain a remote response body or an arbitrary exception message.
        error = e instanceof ProbeError ? e.message : ["TimeoutError", "AbortError"].includes(e?.name) ? "timeout" : "request-failed";
        if (e?.message === "probe-response-too-large") error = "response-too-large";
        if (attempt < attempts) await sleep(retryMs);
      }
    }
    return { stage, ok: false, attempts, error };
  }
  const checks = await Promise.all([
    probe("market-site", async () => { await get("/", false); }),
    probe("market-api", async () => {
      const config = await get("/v1/platform/config");
      requireProbe(config?.public_host === new URL(base).host && Number.isInteger(config.platform_fee_bps)
        && config.platform_fee_bps >= 0 && config.platform_fee_bps <= 10000, "unexpected-config");
      requireProbe(config.platform_fee_bps <= MARKET_PLATFORM_FEE_BPS, "market-fee-assumption-changed");
    }),
    ...MARKET_HANDLES.map(handle => probe(`listing-${handle}`, async () => {
      const agent = await get(`/v1/agents/${handle}`);
      requireProbe(agent?.handle === handle && UUID.test(agent.agent_id), "unexpected-listing");
      requireProbe(agent.listing_status === "live", "listing-not-live");
      requireProbe(agent.availability === "available" && agent.funding_paused === false, "listing-unavailable");
      // available_now can be false while legitimate jobs occupy the agent's slots.
      const plans = await get(`/v1/agents/${agent.agent_id}/pricing-plans`);
      const defaults = Array.isArray(plans) ? plans.filter(plan => plan?.is_default === true) : [];
      requireProbe(defaults.length === 1, "missing-default-price");
      const plan = defaults[0];
      requireProbe(plan.agent_id === agent.agent_id && plan.listing_status === "live" && typeof plan.price_amount === "string"
        && /^\d+(?:\.\d+)?$/.test(plan.price_amount) && Number.isFinite(Number(plan.price_amount)) && Number(plan.price_amount) > 0, "invalid-default-price");
      return { handle, listingStatus: agent.listing_status, availability: agent.availability, availableNow: agent.available_now === true, priceUsd: plan.price_amount };
    })),
  ]);
  const failed = checks.find(check => !check.ok);
  return { ok: !failed, checkedAt, finishedAt: new Date(now()).toISOString(), stage: failed?.stage || "complete", checks };
}
