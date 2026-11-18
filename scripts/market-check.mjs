#!/usr/bin/env node
// Public availability only: no credentials, hires, inference or payments.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "./near-check.mjs";

// The custom-workflow profile is still unpublished. Add it after it goes live.
export const MARKET_HANDLES = ["nanoodle-song", "nanoodle-image", "nanoodle-character", "nanoodle-clip"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class ProbeError extends Error {}
const requireProbe = (condition, code) => { if (!condition) throw new ProbeError(code); };

export async function runMarketCheck({ stateDir, url = "https://market.near.ai", attempts = 3, timeoutMs = 12_000, retryMs = 2_000 }, deps = {}) {
  const request = deps.fetch || globalThis.fetch, now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const base = new URL(url).origin, checkedAt = new Date(now()).toISOString();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  async function get(path, json = true) {
    const response = await request(base + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: json ? "application/json" : "text/html", "user-agent": "Nanoodle-Market-Availability/1.0" } });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProbeError(`http-${response.status}`);
    }
    // The deadline covers the body too; bound memory even on an erroneous response.
    const chunks = []; let bytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; requireProbe(bytes <= 524288, "response-too-large"); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!json) {
      requireProbe(/text\/html/i.test(response.headers.get("content-type") || "") && /NEAR AI Agent Market/.test(text), "unexpected-page");
      return;
    }
    try { return JSON.parse(text); } catch { throw new ProbeError("invalid-json"); }
  }
  async function probe(stage, check) {
    let error;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return { stage, ok: true, attempts: attempt, ...await check() }; }
      catch (e) {
        // Never retain a remote response body or an arbitrary exception message.
        error = e instanceof ProbeError ? e.message : ["TimeoutError", "AbortError"].includes(e?.name) ? "timeout" : "request-failed";
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
  const report = { ok: !failed, checkedAt, finishedAt: new Date(now()).toISOString(), stage: failed?.stage || "complete", checks };
  atomicJson(join(stateDir, "market-latest.json"), report);
  return report;
}

if (import.meta.main) {
  try {
    const report = await runMarketCheck({ stateDir: process.env.CHECK_STATE_DIR || "/var/lib/nanoodle-near-check" });
    console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ ok: false, stage: "service", error: "Market check could not finish; inspect the service journal" })); process.exitCode = 1; }
}
