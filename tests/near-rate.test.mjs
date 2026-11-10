/**
 * NEAR/USD rate: static, live (CoinGecko shape) with cache, shared in-flight
 * fetches, bounded staleness and fail-closed behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNearUsdRate, COINGECKO_NEAR_URL } from "../src/near/rate.mjs";

function source(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return new Response(next.text, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const REAL = { text: '{"near":{"usd":3.64,"last_updated_at":1794262198}}' };

test("the default source URL", () => {
  assert.equal(COINGECKO_NEAR_URL, "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd&include_last_updated_at=true");
});

test("static rate never fetches", async () => {
  const fetch = async () => { throw new Error("must not fetch"); };
  const r = createNearUsdRate({ staticUsd: "3.64", fetch, now: () => Date.UTC(2026, 10, 9, 12) });
  const a = await r.current();
  assert.deepEqual({ ...a }, { nearUsd: "3.64", usdNano: 3_640_000_000n, yocto: 10n ** 24n, source: "static", at: "2026-11-09T12:00:00.000Z" });
  assert.equal(await r.current(), a);
  assert.equal((await createNearUsdRate({ staticUsd: 2.5, fetch }).current()).usdNano, 2_500_000_000n);
  assert.throws(() => createNearUsdRate({ staticUsd: "0" }), { code: "BAD_RATE" });
  assert.throws(() => createNearUsdRate({ staticUsd: "abc" }), { code: "BAD_RATE" });
});

test("live: parses the real response shape exactly", async () => {
  const { fetch, calls } = source([REAL]);
  const r = createNearUsdRate({ fetch, now: () => 1_794_262_200_000 });
  const a = await r.current();
  assert.equal(a.source, "coingecko");
  assert.equal(a.nearUsd, "3.64");
  assert.equal(a.usdNano, 3_640_000_000n);
  assert.equal(a.yocto, 10n ** 24n);
  assert.equal(a.at, new Date(1794262198 * 1000).toISOString());
  assert.equal(calls[0].url, COINGECKO_NEAR_URL);
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("live: decimals the float parser would round are kept exactly; no last_updated_at uses fetch time", async () => {
  const { fetch } = source([{ text: '{"near":{"usd":3.123456789}}' }]);
  const r = createNearUsdRate({ fetch, now: () => Date.UTC(2026, 10, 9) });
  const a = await r.current();
  assert.equal(a.nearUsd, "3.123456789");
  assert.equal(a.usdNano, 3_123_456_789n);
  assert.equal(a.at, "2026-11-09T00:00:00.000Z");
});

test("cache within ttl: one fetch", async () => {
  let t = 0;
  const { fetch, calls } = source([REAL]);
  const r = createNearUsdRate({ fetch, now: () => t });
  await r.current();
  t = 59_999;
  await r.current();
  assert.equal(calls.length, 1);
  t = 60_000;
  await r.current();
  assert.equal(calls.length, 2);
});

test("concurrent callers share one fetch", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { fetch, calls } = source([async () => { await gate; return new Response(REAL.text); }]);
  const r = createNearUsdRate({ fetch });
  const all = Promise.all([r.current(), r.current(), r.current()]);
  release();
  const [a, b, c] = await all;
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("stale cache is served within maxStaleMs, then RATE_UNAVAILABLE", async () => {
  let t = 0;
  const { fetch, calls } = source([REAL, new Error("network down")]);
  const r = createNearUsdRate({ fetch, now: () => t });
  const first = await r.current();
  t = 61_000;
  assert.equal(await r.current(), first); // refresh failed, served stale
  t = 299_999;
  assert.equal(await r.current(), first);
  t = 300_000;
  await assert.rejects(r.current(), { name: "NearError", code: "RATE_UNAVAILABLE" });
  assert.ok(calls.length >= 3);
});

test("a failed refresh recovers on the next success", async () => {
  let t = 0;
  const { fetch } = source([REAL, { status: 429, text: "rate limited" }, { text: '{"near":{"usd":4.01,"last_updated_at":1794262300}}' }]);
  const r = createNearUsdRate({ fetch, now: () => t });
  await r.current();
  t = 400_000;
  await assert.rejects(r.current(), { code: "RATE_UNAVAILABLE" });
  assert.equal((await r.current()).nearUsd, "4.01");
});

test("HTTP error or junk with no cache -> RATE_UNAVAILABLE", async () => {
  for (const resp of [{ status: 500, text: "oops" }, { text: '{"near":{}}' }, { text: '{"near":{"usd":0}}' }, { text: "<html>" }]) {
    const { fetch } = source([resp]);
    await assert.rejects(createNearUsdRate({ fetch }).current(), { code: "RATE_UNAVAILABLE" }, resp.text);
  }
});

test("timeout -> RATE_UNAVAILABLE", async () => {
  const fetch = (url, init) => new Promise((_, reject) => { const keep = setInterval(() => {}, 1_000); /* Node 22 unrefs AbortSignal.timeout; a real fetch holds a socket */ init.signal.addEventListener("abort", () => { clearInterval(keep); reject(init.signal.reason); }); });
  await assert.rejects(createNearUsdRate({ fetch, timeoutMs: 20 }).current(), { code: "RATE_UNAVAILABLE" });
});
