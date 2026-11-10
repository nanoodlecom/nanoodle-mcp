/**
 * NEAR-rail rates service (src/near/rates.mjs): NEAR/USD, XNO/USD, the derived
 * swap rate, the swap margin, TTL, the background timer, forced refresh and
 * its rate limit, fail-closed staleness and the SIGHUP-style reload. Offline:
 * every fetch is a local function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNearRates, COINGECKO_RATES_URL, parseSpreadBps, spreadPair, ratioDecimal, bpsPercent,
} from "../src/near/rates.mjs";
import { createNearUsdRate } from "../src/near/rate.mjs";
import { usdToYocto, settleYocto, depositYocto } from "../src/near/amount.mjs";

const CG = '{"near":{"usd":3.64,"last_updated_at":1794262198},"nano":{"usd":0.8,"last_updated_at":1794262190}}';
// NanoGPT's 402 invoice: 0.01 XNO (1e28 raw) for $0.0095, so 1 XNO = $0.95.
const PROBE = { accepts: [{ scheme: "nano", maxAmountRequired: "10000000000000000000000000000", maxAmountRequiredUSD: "0.0095" }] };

/** A scripted network: CoinGecko and the NanoGPT x402 probe, each a list of answers (the last repeats). */
function net({ cg = [{ text: CG }], probe = [{ status: 402, json: PROBE }] } = {}) {
  const calls = { cg: 0, probe: 0, urls: [] };
  const next = (list) => (list.length > 1 ? list.shift() : list[0]);
  const fetch = async (url, init = {}) => {
    calls.urls.push(String(url));
    const isProbe = init.headers && init.headers["x-x402"] === "true";
    const a = isProbe ? (calls.probe++, next(probe)) : (calls.cg++, next(cg));
    if (a instanceof Error) throw a;
    if (typeof a === "function") return a();
    return new Response(a.json ? JSON.stringify(a.json) : a.text, { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const noTimer = { refreshMs: 0 };

test("spread math: exact yocto, and 0 bps is the old pair exactly", () => {
  assert.deepEqual(spreadPair(3_640_000_000n, 0), { usdNano: 3_640_000_000n, yocto: 10n ** 24n });
  const p = spreadPair(3_640_000_000n, 150);
  assert.deepEqual(p, { usdNano: 3_640_000_000n, yocto: 1_015_000_000_000_000_000_000_000n });
  // The worked example's $0.03 deposit: 0.008242 NEAR before dust at 0 bps, 1.5% more at 150 bps.
  assert.equal(usdToYocto("0.03", spreadPair(3_640_000_000n, 0), "ceil"), 8241758241758241758242n);
  assert.equal(usdToYocto("0.03", p, "ceil"), 8365384615384615384616n);
  const dep = depositYocto("0.03", p, () => false, () => 137);
  assert.equal(dep, 8366000000000000000000n + 137n * 10n ** 18n);
  // Settlement at the locked (spread) pair: $0.00941 actual cost + 20%.
  const s = settleYocto({ depositYocto: 8379000000000000000000n, costUsd: 0.00941, rate: p });
  assert.equal(s.costYocto, 2623942307692307692308n);
  assert.equal(s.chargedYocto, 3148730769230769230769n);
  assert.equal(s.refundYocto, 5230269230769230769231n);
  assert.equal(settleYocto({ depositYocto: 8379000000000000000000n, costUsd: 0.00941, rate: spreadPair(3_640_000_000n, 0) }).chargedYocto, 3102197802197802197803n);
  assert.equal(bpsPercent(150), "1.5");
  assert.equal(bpsPercent(2000), "20");
  assert.equal(ratioDecimal(2n, 3n, 4), "0.6667");
});

test("parseSpreadBps: whole basis points from 0 to 2000", () => {
  assert.equal(parseSpreadBps(null), 0);
  assert.equal(parseSpreadBps("0"), 0);
  assert.equal(parseSpreadBps(" 150 "), 150);
  assert.equal(parseSpreadBps(2000), 2000);
  for (const bad of ["2001", "-1", "1.5", "abc", "1e3"]) assert.throws(() => parseSpreadBps(bad), { code: "BAD_RATE" }, bad);
});

test("all static: never fetches; matches the old NEAR/USD-only rate field for field, plus the XNO and swap fields", async () => {
  const fetch = async () => { throw new Error("must not fetch"); };
  const t = Date.UTC(2026, 10, 9, 12);
  const r = createNearRates({ nearUsd: "3.64", xnoUsd: "0.95", fetch, now: () => t, ...noTimer });
  const a = await r.current();
  const old = await createNearUsdRate({ staticUsd: "3.64", now: () => t }).current();
  for (const k of ["nearUsd", "usdNano", "yocto", "source", "at"]) assert.equal(a[k], old[k], k);
  assert.equal(a.xnoUsd, "0.95");
  assert.equal(a.xnoSource, "static");
  assert.equal(a.xnoPerNear, "3.831578947");
  assert.equal(a.nearPerXno, "0.260989011");
  assert.equal(a.spreadBps, 0);
  assert.equal("effectiveNearUsd" in a, false);
  await r.start(); // nothing live: no fetch
});

test("swap margin shows the effective NEAR/USD and enlarges the pair", async () => {
  const r = createNearRates({ nearUsd: "3.64", xnoUsd: "0.95", spreadBps: 150, fetch: async () => { throw new Error("no"); }, ...noTimer });
  const a = await r.current();
  assert.equal(a.yocto, 1_015_000_000_000_000_000_000_000n);
  assert.equal(a.usdNano, 3_640_000_000n);
  assert.equal(a.effectiveNearUsd, "3.586206897");
  assert.equal(a.xnoPerNear, "3.831578947", "the swap rate itself is the market one; the margin is separate");
});

test("live: CoinGecko NEAR/USD and the NanoGPT x402 pair for XNO/USD (preferred over CoinGecko's nano)", async () => {
  const { fetch, calls } = net();
  const r = createNearRates({ fetch, now: () => 1_794_262_200_000, ...noTimer });
  const a = await r.current();
  assert.equal(a.nearUsd, "3.64");
  assert.equal(a.source, "coingecko");
  assert.equal(a.at, new Date(1794262198 * 1000).toISOString());
  assert.equal(a.xnoUsd, "0.95");
  assert.equal(a.xnoSource, "nanogpt-x402");
  assert.equal(a.xnoPerNear, "3.831578947");
  assert.equal(calls.cg, 1);
  assert.equal(calls.probe, 1);
  assert.ok(calls.urls.includes(COINGECKO_RATES_URL));
  assert.ok(calls.urls.includes("https://nano-gpt.com/api/v1/chat/completions"));
});

test("probe fails: XNO/USD falls back to CoinGecko nano; with a static NEAR/USD CoinGecko is asked only then", async () => {
  const live = net({ probe: [new Error("down")] });
  const a = await createNearRates({ fetch: live.fetch, ...noTimer }).current();
  assert.equal(a.xnoUsd, "0.8");
  assert.equal(a.xnoSource, "coingecko");
  assert.equal(a.xnoPerNear, "4.55");

  // With NEAR/USD pinned, only the informational XNO side is live; refresh() is what start() does at boot.
  const pinned = net();
  const rb = createNearRates({ nearUsd: "3.64", fetch: pinned.fetch, ...noTimer });
  await rb.refresh();
  const b = await rb.current();
  assert.equal(b.xnoSource, "nanogpt-x402");
  assert.equal(pinned.calls.cg, 0, "probe worked: no CoinGecko call");
  const fallback = net({ probe: [{ status: 200, json: {} }] });
  const rc = createNearRates({ nearUsd: "3.64", fetch: fallback.fetch, ...noTimer });
  await rc.refresh();
  const c = await rc.current();
  assert.equal(c.xnoSource, "coingecko");
  assert.equal(fallback.calls.cg, 1);
});

test("TTL: one fetch within the TTL, a lazy refresh at it; concurrent quotes share one refresh", async () => {
  let t = 0;
  const { fetch, calls } = net();
  const r = createNearRates({ fetch, now: () => t, ...noTimer });
  await Promise.all([r.current(), r.current(), r.current()]);
  assert.equal(calls.cg, 1);
  t = 59_999;
  await r.current();
  assert.equal(calls.cg, 1);
  t = 60_000;
  await r.current();
  assert.equal(calls.cg, 2);
});

test("fail closed: no fresh NEAR/USD, no quote; stale-but-young is served until maxStale", async () => {
  let t = 0;
  const { fetch } = net({ cg: [{ text: CG }, new Error("network down")] });
  const r = createNearRates({ fetch, now: () => t, ...noTimer });
  const first = await r.current();
  t = 61_000;
  assert.equal((await r.current()).nearUsd, first.nearUsd);
  t = 300_000;
  await assert.rejects(r.current(), (e) => e.code === "RATE_UNAVAILABLE" && e.data.pair === "NEAR/USD");
  const v = await r.view();
  assert.equal(v.nearUsd, null);
  assert.equal(v.quoting, false);
  assert.match(v.sources.nearUsd.lastError, /network down/);
});

test("XNO/USD: required when runs are paid from the Nano wallet, informational with an API key", async () => {
  const down = () => net({ cg: [{ text: '{"near":{"usd":3.64}}' }], probe: [new Error("probe down")] });
  const required = createNearRates({ fetch: down().fetch, xnoRequired: true, ...noTimer });
  await assert.rejects(required.current(), (e) => e.code === "RATE_UNAVAILABLE" && e.data.pair === "XNO/USD");

  const informational = createNearRates({ fetch: down().fetch, xnoRequired: false, ...noTimer });
  const a = await informational.current();
  assert.equal(a.nearUsd, "3.64");
  assert.equal(a.xnoUsd, null);
  assert.equal(a.xnoPerNear, null);
  const v = await informational.view();
  assert.equal(v.quoting, true);
  assert.equal(v.xnoUsd, null);
  assert.match(v.sources.xnoUsd.lastError, /probe down/);

  // informational XNO/USD never holds a quote: only a stale XNO side refreshes in the background
  let t = 0, release;
  const hold = new Promise((r) => { release = r; });
  let probes = 0;
  const fetch = async (url, init) => {
    if (init.headers["x-x402"]) { probes++; if (probes > 1) await hold; return new Response(JSON.stringify(PROBE), { status: 402 }); }
    return new Response(CG);
  };
  const r = createNearRates({ nearUsd: "3.64", fetch, now: () => t, ...noTimer });
  await r.refresh();
  t = 61_000;
  const b = await r.current(); // the probe is held; this must not wait for it
  assert.equal(b.xnoUsd, "0.95");
  release();
});

test("background timer: unref'd, refreshes every interval, reports the next refresh, stops", async () => {
  let t = 1_000_000;
  let tick = null, unrefd = false, cleared = false;
  const setInterval = (fn, ms) => { tick = fn; assert.equal(ms, 60_000); return { unref() { unrefd = true; } }; };
  const clearInterval = () => { cleared = true; };
  const { fetch, calls } = net();
  const r = createNearRates({ fetch, now: () => t, setInterval, clearInterval });
  await r.start();
  assert.ok(unrefd);
  assert.equal(calls.cg, 1);
  assert.equal((await r.view()).refresh.nextAt, new Date(1_060_000).toISOString());
  t += 60_000;
  tick();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(calls.cg, 2);
  assert.equal((await r.view()).refresh.nextAt, new Date(1_120_000).toISOString());
  r.stop();
  assert.ok(cleared);
  assert.equal((await r.view()).refresh.nextAt, null);
});

test("GET /rates view: forced refresh at most once per 15 s, otherwise answered from cache and says so", async () => {
  let t = 0;
  const { fetch, calls } = net();
  const r = createNearRates({ fetch, now: () => t, ...noTimer });
  await r.current();
  assert.equal(calls.cg, 1);
  let v = await r.view({ refresh: true });
  assert.equal(v.refresh.refreshed, true);
  assert.equal(calls.cg, 2);
  t = 14_000;
  v = await r.view({ refresh: true });
  assert.equal(v.refresh.refreshed, false);
  assert.match(v.refresh.note, /answered from cache: a forced refresh runs at most once every 15 s \(next allowed in 1 s\)/);
  assert.equal(calls.cg, 2);
  t = 15_000;
  v = await r.view({ refresh: true });
  assert.equal(v.refresh.refreshed, true);
  assert.equal(calls.cg, 3);
  // the published shape
  for (const k of ["nearUsd", "xnoUsd", "xnoPerNear", "nearPerXno", "spreadBps", "effectiveNearUsd", "quoting", "sources", "derivation", "refresh", "now"]) assert.ok(k in v, k);
  assert.equal(v.sources.nearUsd.source, "coingecko");
  assert.equal(v.sources.nearUsd.ageSeconds, 0);
  assert.equal(v.sources.xnoUsd.source, "nanogpt-x402");
  assert.match(v.derivation, /no swap venue is queried/);
  assert.match(v.derivation, /does not swap NEAR to XNO/);
});

test("reload (SIGHUP): new static values apply, static → live refetches, an invalid value changes nothing", async () => {
  let t = 0;
  const { fetch, calls } = net();
  const r = createNearRates({ nearUsd: "3.64", xnoUsd: "0.95", fetch, now: () => t, ...noTimer });
  assert.equal((await r.current()).nearUsd, "3.64");
  await r.reload({ nearUsd: "4.00", xnoUsd: "0.95", spreadBps: "100" });
  let a = await r.current();
  assert.equal(a.nearUsd, "4.00");
  assert.equal(a.spreadBps, 100);
  assert.equal(calls.cg + calls.probe, 0, "all static: nothing fetched");
  await assert.rejects(r.reload({ nearUsd: "zero", xnoUsd: "0.95", spreadBps: 0 }), { code: "BAD_RATE" });
  await assert.rejects(r.reload({ nearUsd: "4.00", xnoUsd: "0.95", spreadBps: 5000 }), { code: "BAD_RATE" });
  a = await r.current();
  assert.equal(a.nearUsd, "4.00");
  assert.equal(a.spreadBps, 100);
  await r.reload({ nearUsd: null, xnoUsd: null, spreadBps: 0 });
  a = await r.current();
  assert.equal(a.source, "coingecko");
  assert.equal(a.xnoSource, "nanogpt-x402");
  assert.equal(calls.cg, 1);
  assert.deepEqual(r.config, { nearUsd: null, xnoUsd: null, spreadBps: 0, xnoRequired: false });
});
