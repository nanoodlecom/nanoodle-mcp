/**
 * NEAR/USD rate: a static value for tests and demos, or CoinGecko's public
 * simple-price endpoint, cached. When no rate younger than maxStaleMs is
 * available, current() throws RATE_UNAVAILABLE: quoting fails closed rather
 * than guessing a price.
 */
import { rateFromNearUsd } from "./amount.mjs";
import { NearError } from "./errors.mjs";

export const COINGECKO_NEAR_URL = "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true";

const USD_FIELD = /"usd"\s*:\s*([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/;
const UPDATED_FIELD = /"last_updated_at"\s*:\s*([0-9]{1,13})\b/;

export function createNearUsdRate({
  staticUsd = null,
  fetch = globalThis.fetch,
  now = Date.now,
  ttlMs = 60_000,
  maxStaleMs = 300_000,
  url = COINGECKO_NEAR_URL,
  timeoutMs = 8_000,
} = {}) {
  if (staticUsd != null) {
    const base = rateFromNearUsd(staticUsd);
    const rate = Object.freeze({ nearUsd: String(staticUsd).trim(), usdNano: base.usdNano, yocto: base.yocto, source: "static", at: new Date(now()).toISOString() });
    return { current: async () => rate };
  }
  if (typeof fetch !== "function") throw new TypeError("createNearUsdRate needs a fetch function for a live rate");

  let cache = null; // { rate, fetchedAt }
  let inflight = null;

  async function fetchRate() {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const text = await res.text();
    if (!res.ok) throw new Error(`rate source answered HTTP ${res.status}`);
    const m = text.match(USD_FIELD);
    if (!m) throw new Error("rate source returned no NEAR/USD price");
    const base = rateFromNearUsd(m[1]);
    const fetchedAt = now();
    const updated = text.match(UPDATED_FIELD);
    const atMs = updated ? Number(updated[1]) * 1000 : fetchedAt;
    const rate = Object.freeze({ nearUsd: m[1], usdNano: base.usdNano, yocto: base.yocto, source: "coingecko", at: new Date(atMs).toISOString() });
    cache = { rate, fetchedAt };
    return rate;
  }

  async function current() {
    if (cache && now() - cache.fetchedAt < ttlMs) return cache.rate;
    inflight ??= fetchRate().finally(() => { inflight = null; });
    try {
      return await inflight;
    } catch (cause) {
      if (cache && now() - cache.fetchedAt < maxStaleMs) return cache.rate;
      throw new NearError("RATE_UNAVAILABLE", "no current NEAR/USD rate is available; not quoting", { cause });
    }
  }

  return { current };
}
