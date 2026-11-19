import { createProbeFetch } from "../probe-http.mjs";

export const MARKET_PLATFORM_FEE_BPS = 500;

/** Fresh public config before accepting/starting inference; no buyer token or
 * estimated future revenue is used to vouch for a stale fee assumption. */
export function createMarketFeeGuard({ baseUrl, fetch = globalThis.fetch, maxFeeBps = MARKET_PLATFORM_FEE_BPS, timeoutMs = 10_000 }) {
  if (!Number.isSafeInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) throw new TypeError("maxFeeBps must be an integer from 0 to 10000");
  const request = createProbeFetch({ fetch, timeoutMs, maxBytes: 32_768 });
  let inflight = null;
  async function check() {
    let body;
    try {
      const response = await request(new URL("/v1/platform/config", baseUrl));
      if (!response.ok) throw Error("unavailable");
      body = await response.json();
      if (!Number.isSafeInteger(body.platform_fee_bps) || body.platform_fee_bps < 0 || body.platform_fee_bps > 10_000) throw Error("malformed");
    } catch {
      const error = Error("Market platform fee could not be verified; no new inference or bids");
      error.code = "MARKET_FEE_UNAVAILABLE"; throw error;
    }
    if (body.platform_fee_bps > maxFeeBps) {
      const error = Error("Market platform fee exceeds the accepted pricing assumption; no inference or bids");
      error.code = "MARKET_FEE_CHANGED"; throw error;
    }
    return body.platform_fee_bps;
  }
  return { check() {
    // Share simultaneous reads, but never reuse a completed answer for the next
    // phase. A fee change between award and inference must be checked again.
    if (!inflight) inflight = check().finally(() => { inflight = null; });
    return inflight;
  } };
}
