import { parseUsdNano } from "./usd.mjs";

export const COINGECKO_RATES_URL = "https://api.coingecko.com/api/v3/simple/price?ids=near,nano&vs_currencies=usd&include_last_updated_at=true";
const KRAKEN_NANO_TRADES = "https://api.kraken.com/0/public/Trades?pair=NANOUSD&count=1";
export const RAW_PER_XNO = 10n ** 30n;
export const LIVE_RATE_MAX_AGE_MS = 300_000;

export function marketRateFresh(observedAt, now, maxAgeMs = LIVE_RATE_MAX_AGE_MS) {
  return Number.isSafeInteger(observedAt) && now - observedAt >= -30_000 && now - observedAt < maxAgeMs;
}

function marketRate(price, timestampSeconds, source) {
  if (typeof price !== "number" && typeof price !== "string") return null;
  const usd = String(price);
  if (!/^\d{1,12}(?:\.\d{1,15})?(?:e[+-]?\d{1,2})?$/i.test(usd)) return null;
  const usdNano = parseUsdNano(usd);
  if (usdNano <= 0n) return null;
  const observedAt = typeof timestampSeconds === "number" ? Math.trunc(timestampSeconds * 1000) : null;
  return { usd, usdNano, source, observedAt };
}

async function readMarket(fetch, url, timeoutMs) {
  const response = await fetch(url, { headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`market feed answered HTTP ${response.status}`);
  return JSON.parse(await response.text(), (key, value, context) =>
    key === "usd" && typeof value === "number" ? context?.source ?? value : value);
}

export async function fetchCoinGeckoRates(fetch, { url = COINGECKO_RATES_URL, timeoutMs = 3_000 } = {}) {
  const body = await readMarket(fetch, url, timeoutMs);
  return {
    near: marketRate(body?.near?.usd, body?.near?.last_updated_at, "coingecko"),
    nano: marketRate(body?.nano?.usd, body?.nano?.last_updated_at, "coingecko"),
  };
}

export async function fetchKrakenNanoRate(fetch, { timeoutMs = 3_000 } = {}) {
  const body = await readMarket(fetch, KRAKEN_NANO_TRADES, timeoutMs);
  if (!Array.isArray(body?.error) || body.error.length !== 0) return null;
  const trade = body.result?.NANOUSD?.[0];
  return Array.isArray(trade) ? marketRate(trade[0], trade[2], "kraken") : null;
}

// Both hosted checkout rails share a short cache. Every quote still verifies
// the provider's observation timestamp against its existing freshness limit.
export function createMarketRateReader({ fetch = globalThis.fetch, now = () => performance.now() } = {}) {
  function share(read) {
    let fetchedAt = -Infinity, value, inflight;
    return () => {
      if (now() - fetchedAt < 15_000) return Promise.resolve(value);
      inflight ??= read().then(result => {
        value = result;
        fetchedAt = now();
        return result;
      }).finally(() => { inflight = null; });
      return inflight;
    };
  }
  return {
    coingecko: share(() => fetchCoinGeckoRates(fetch)),
    kraken: share(() => fetchKrakenNanoRate(fetch)),
  };
}
