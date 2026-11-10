/**
 * Rates for the NEAR rail: NEAR/USD, XNO/USD and the swap rate derived from
 * them, each with its source and timestamp.
 *
 * Callers pay in NEAR; the server pays its model provider (NanoGPT) with an API
 * key or in XNO from its Nano wallet. So in wallet mode the operator is in
 * effect swapping NEAR for XNO. The swap rate here is DERIVED from the two USD
 * rates (xnoPerNear = nearUsd / xnoUsd); no swap venue is queried, and nothing
 * here swaps anything.
 *
 * Sources:
 *   NEAR/USD  static (--near-usd / NEAR_USD), else CoinGecko's public price
 *   XNO/USD   static (--xno-usd), else NanoGPT's own x402 invoice pair (the
 *             rate the float is actually spent at, the same probe the Nano
 *             gate uses), else CoinGecko's `nano` price
 *
 * Refresh: a background timer (refreshMs, unref'd), a lazy refresh when a
 * quote finds a live rate older than ttlMs, and a forced refresh (SIGHUP in
 * the bin, `GET /rates?refresh=1` at most once per forceMinIntervalMs).
 *
 * Fails closed: without a NEAR/USD rate younger than maxStaleMs, current()
 * throws RATE_UNAVAILABLE (data.pair "NEAR/USD"). When the server pays NanoGPT
 * from its Nano wallet (xnoRequired), the same holds for XNO/USD; otherwise
 * XNO/USD is informational and reported as null when unavailable.
 *
 * Swap margin: spreadBps (0-2000) makes every NEAR amount larger by that
 * fraction: the locked pair is { usdNano, yocto: 10^24 * (10000 + bps) / 10000 },
 * exact in BigInt. With 0 the pair is exactly { usdNano, 10^24 }, as before.
 */
import { parseUsdNano, probeX402Pair, x402ProbeUrl } from "../gate.mjs";
import { YOCTO_PER_NEAR } from "./amount.mjs";
import { NearError } from "./errors.mjs";

export const COINGECKO_RATES_URL = "https://api.coingecko.com/api/v3/simple/price?ids=near,nano&vs_currencies=usd&include_last_updated_at=true";
export const RAW_PER_XNO = 10n ** 30n;
export const MAX_SPREAD_BPS = 2000;
const NANO_PER_USD = 1_000_000_000n;

/** num/den as a decimal string, rounded half-up to `decimals`, trailing zeros trimmed. */
export function ratioDecimal(num, den, decimals = 9) {
  if (typeof num !== "bigint" || typeof den !== "bigint" || den <= 0n || num < 0n) throw new RangeError("ratioDecimal needs bigints, num >= 0, den > 0");
  const scale = 10n ** BigInt(decimals);
  const q = (num * scale * 2n + den) / (2n * den);
  const whole = q / scale;
  const frac = decimals ? (q % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** An integer number of basis points, 0..MAX_SPREAD_BPS. */
export function parseSpreadBps(v) {
  if (v == null || v === "") return 0;
  const s = String(v).trim();
  if (!/^\d{1,5}$/.test(s) || Number(s) > MAX_SPREAD_BPS) {
    throw new NearError("BAD_RATE", `the swap spread must be a whole number of basis points from 0 to ${MAX_SPREAD_BPS}, got ${JSON.stringify(String(v).slice(0, 32))}`);
  }
  return Number(s);
}

/** The NEAR/USD pair NEAR amounts are computed at: worse for the caller by spreadBps. */
export function spreadPair(usdNano, spreadBps = 0) {
  return { usdNano, yocto: (YOCTO_PER_NEAR * BigInt(10000 + spreadBps)) / 10000n };
}

/** "150" bps → "1.5" (percent). */
export const bpsPercent = (bps) => ratioDecimal(BigInt(bps), 100n, 2);

function positiveUsd(text, what) {
  let nano;
  try { nano = parseUsdNano(typeof text === "string" ? text.trim() : text); } catch { nano = 0n; }
  if (nano <= 0n) throw new NearError("BAD_RATE", `the ${what} rate must be a positive decimal, got ${JSON.stringify(String(text).slice(0, 32))}`);
  return nano;
}

function cgField(text, id) {
  const block = text.match(new RegExp(`"${id}"\\s*:\\s*\\{([^}]*)\\}`));
  if (!block) return null;
  const usd = block[1].match(/"usd"\s*:\s*([0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?)/);
  if (!usd) return null;
  let usdNano;
  try { usdNano = parseUsdNano(usd[1]); } catch { return null; }
  if (usdNano <= 0n) return null;
  const upd = block[1].match(/"last_updated_at"\s*:\s*([0-9]{1,13})\b/);
  return { usd: usd[1], usdNano, updatedMs: upd ? Number(upd[1]) * 1000 : null };
}

const errText = (e) => String((e && e.message) || e).slice(0, 200);

/**
 * @param {object} [o]
 * @param {string|null} [o.nearUsd]   static NEAR/USD (decimal text); null = live
 * @param {string|null} [o.xnoUsd]    static XNO/USD (decimal text); null = live
 * @param {number|string} [o.spreadBps]  swap margin in basis points (0-2000)
 * @param {boolean} [o.xnoRequired]   the server pays NanoGPT in XNO: no XNO/USD, no quote
 * @param {number} [o.ttlMs]          a live rate older than this is refetched before a quote (60 s)
 * @param {number} [o.maxStaleMs]     a live rate older than this is not used at all (5 min)
 * @param {number} [o.refreshMs]      background refresh interval; 0 disables the timer (60 s)
 * @param {number} [o.forceMinIntervalMs]  minimum gap between forced refreshes from HTTP (15 s)
 */
export function createNearRates({
  nearUsd = null,
  xnoUsd = null,
  spreadBps = 0,
  xnoRequired = false,
  fetch = globalThis.fetch,
  now = Date.now,
  ttlMs = 60_000,
  maxStaleMs = 300_000,
  refreshMs = 60_000,
  forceMinIntervalMs = 15_000,
  timeoutMs = 8_000,
  coingeckoUrl = COINGECKO_RATES_URL,
  nanoGptBase = null,
  log = () => {},
  setInterval: setIntervalFn = globalThis.setInterval,
  clearInterval: clearIntervalFn = globalThis.clearInterval,
} = {}) {
  if (!Number.isInteger(refreshMs) || refreshMs < 0) throw new TypeError("refreshMs must be a non-negative integer");
  const probeUrl = x402ProbeUrl(nanoGptBase);

  let cfg = null; // { nearStatic, xnoStatic, spreadBps }
  let near = null; // { usd, usdNano, source, at, fetchedAt }
  let xno = null; // { usd, pair: { usdNano, raw }, source, at, fetchedAt }
  let nearError = null, xnoError = null;
  let inflight = null;
  let lastRefreshAt = null, lastForcedAt = null;
  let timer = null, nextRefreshAt = null;

  const iso = (ms) => new Date(ms).toISOString();

  function staticNear(text, t) {
    const usd = String(text).trim();
    return { usd, usdNano: positiveUsd(usd, "NEAR/USD"), source: "static", at: iso(t), fetchedAt: Infinity };
  }
  function staticXno(text, t) {
    const usd = String(text).trim();
    return { usd, pair: { usdNano: positiveUsd(usd, "XNO/USD"), raw: RAW_PER_XNO }, source: "static", at: iso(t), fetchedAt: Infinity };
  }

  /** Validate everything first, then apply: a bad value leaves the old configuration in place. */
  function configure({ nearUsd: n = null, xnoUsd: x = null, spreadBps: s = 0 } = {}) {
    const t = now();
    const next = { nearStatic: n == null ? null : String(n).trim(), xnoStatic: x == null ? null : String(x).trim(), spreadBps: parseSpreadBps(s) };
    const nRec = next.nearStatic != null ? staticNear(next.nearStatic, t) : null;
    const xRec = next.xnoStatic != null ? staticXno(next.xnoStatic, t) : null;
    const prev = cfg;
    cfg = next;
    if (nRec) { if (!(prev && prev.nearStatic === next.nearStatic && near)) near = nRec; nearError = null; }
    else if (!prev || prev.nearStatic != null) near = null; // static → live: never serve the old pin as a live price
    if (xRec) { if (!(prev && prev.xnoStatic === next.xnoStatic && xno)) xno = xRec; xnoError = null; }
    else if (!prev || prev.xnoStatic != null) xno = null;
    return { nearUsd: next.nearStatic, xnoUsd: next.xnoStatic, spreadBps: next.spreadBps };
  }
  configure({ nearUsd, xnoUsd, spreadBps });

  const nearLive = () => cfg.nearStatic == null;
  const xnoLive = () => cfg.xnoStatic == null;
  const anyLive = () => nearLive() || xnoLive();

  async function fetchCoinGecko() {
    const res = await fetch(coingeckoUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const text = await res.text();
    if (!res.ok) throw new Error(`CoinGecko answered HTTP ${res.status}`);
    return { near: cgField(text, "near"), nano: cgField(text, "nano") };
  }

  async function doRefresh() {
    if (!anyLive()) return;
    const wantNear = nearLive(), wantXno = xnoLive();
    // CoinGecko answers both ids in one request; with a static NEAR/USD it is
    // asked only when the NanoGPT probe fails (XNO/USD fallback).
    let [cg, probe] = await Promise.allSettled([
      wantNear ? fetchCoinGecko() : Promise.resolve({ near: null, nano: null }),
      wantXno ? probeX402Pair({ fetch, url: probeUrl, signal: AbortSignal.timeout(timeoutMs) }) : Promise.resolve(null),
    ]);
    if (wantXno && !wantNear && probe.status === "rejected") [cg] = await Promise.allSettled([fetchCoinGecko()]);
    const t = now();
    lastRefreshAt = t;
    // The configuration may have changed while the fetches ran (SIGHUP): only fill sides still live.
    if (wantNear && nearLive()) {
      const v = cg.status === "fulfilled" ? cg.value.near : null;
      if (v) {
        near = { usd: v.usd, usdNano: v.usdNano, source: "coingecko", at: iso(v.updatedMs ?? t), fetchedAt: t };
        nearError = null;
      } else {
        nearError = cg.status === "rejected" ? errText(cg.reason) : "CoinGecko returned no NEAR/USD price";
      }
    }
    if (wantXno && xnoLive()) {
      if (probe.status === "fulfilled" && probe.value) {
        const pair = probe.value;
        xno = { usd: ratioDecimal(pair.usdNano * RAW_PER_XNO, pair.raw * NANO_PER_USD, 9), pair, source: "nanogpt-x402", at: iso(t), fetchedAt: t };
        xnoError = null;
      } else {
        const v = cg.status === "fulfilled" ? cg.value.nano : null;
        const why = `NanoGPT x402 probe: ${probe.status === "rejected" ? errText(probe.reason) : "no answer"}`;
        if (v) {
          xno = { usd: v.usd, pair: { usdNano: v.usdNano, raw: RAW_PER_XNO }, source: "coingecko", at: iso(v.updatedMs ?? t), fetchedAt: t };
          xnoError = `${why}; using CoinGecko`;
        } else {
          xnoError = `${why}; CoinGecko: ${cg.status === "rejected" ? errText(cg.reason) : "no XNO/USD price"}`;
        }
      }
    }
    // One log line per new problem, not one per minute while a source stays down.
    const say = (k, msg) => { if (msg && msg !== logged[k]) log(msg); logged[k] = msg; };
    say("near", nearError && nearLive() ? `NEAR/USD refresh failed (${nearError})` : null);
    say("xno", xnoError && xnoLive() ? `XNO/USD: ${xnoError}` : null);
  }
  const logged = { near: null, xno: null };

  /** Refetch every live rate. Concurrent callers share one refresh. Never throws. */
  function refresh() {
    inflight ??= doRefresh().catch((e) => { log(`rate refresh failed (${errText(e)})`); }).finally(() => { inflight = null; });
    return inflight;
  }

  const usable = (rec, t) => !!rec && t - rec.fetchedAt < maxStaleMs;
  const due = (rec, t) => !rec || t - rec.fetchedAt >= ttlMs;

  function build(n, x) {
    const s = cfg.spreadBps;
    const pair = spreadPair(n.usdNano, s);
    const out = {
      nearUsd: n.usd, usdNano: pair.usdNano, yocto: pair.yocto, source: n.source, at: n.at,
      xnoUsd: x ? x.usd : null, xnoSource: x ? x.source : null, xnoAt: x ? x.at : null,
      // xnoPerNear = (NEAR/USD) / (XNO/USD), from the market NEAR/USD (no margin).
      xnoPerNear: x ? ratioDecimal(n.usdNano * x.pair.raw, x.pair.usdNano * RAW_PER_XNO, 9) : null,
      nearPerXno: x ? ratioDecimal(x.pair.usdNano * RAW_PER_XNO, n.usdNano * x.pair.raw, 9) : null,
      spreadBps: s,
    };
    if (s) out.effectiveNearUsd = ratioDecimal(n.usdNano * 10000n, BigInt(10000 + s) * NANO_PER_USD, 9);
    return Object.freeze(out);
  }

  /**
   * The rate a quote locks: the NEAR gate's { nearUsd, usdNano, yocto, source, at }
   * plus the XNO/USD and swap fields. Throws RATE_UNAVAILABLE (fail closed).
   */
  async function current() {
    let t = now();
    const nearDue = nearLive() && due(near, t);
    const xnoDue = xnoLive() && due(xno, t);
    if (nearDue || (xnoDue && xnoRequired)) await refresh();
    else if (xnoDue) void refresh(); // informational: never hold a quote for it
    t = now();
    if (!usable(near, t)) {
      throw new NearError("RATE_UNAVAILABLE", "no current NEAR/USD rate is available; not quoting", { data: { pair: "NEAR/USD" } });
    }
    const x = usable(xno, t) ? xno : null;
    if (!x && xnoRequired) {
      throw new NearError("RATE_UNAVAILABLE", "no current XNO/USD rate is available and this server pays its model provider in XNO; not quoting", { data: { pair: "XNO/USD" } });
    }
    return build(near, x);
  }

  function sourceView(rec, err, live, t) {
    const age = rec && rec.fetchedAt !== Infinity ? Math.max(0, Math.round((t - rec.fetchedAt) / 1000)) : null;
    return {
      source: rec ? rec.source : live ? null : "static",
      live,
      at: rec ? rec.at : null,
      fetchedAt: rec && rec.fetchedAt !== Infinity ? iso(rec.fetchedAt) : null,
      ageSeconds: age,
      usable: usable(rec, t),
      lastValue: rec ? rec.usd : null,
      lastError: err,
    };
  }

  /** The public JSON for GET /rates. `refresh: true` forces a refetch, at most once per forceMinIntervalMs. */
  async function view({ refresh: force = false } = {}) {
    let refreshed = false, refreshNote = null;
    if (force) {
      const t0 = now();
      if (!anyLive()) {
        refreshNote = "every rate is static; nothing to refetch";
      } else if (lastForcedAt != null && t0 - lastForcedAt < forceMinIntervalMs) {
        const wait = Math.ceil((forceMinIntervalMs - (t0 - lastForcedAt)) / 1000);
        refreshNote = `answered from cache: a forced refresh runs at most once every ${Math.round(forceMinIntervalMs / 1000)} s (next allowed in ${wait} s)`;
      } else {
        lastForcedAt = t0;
        await refresh();
        refreshed = true;
      }
    }
    const t = now();
    const n = usable(near, t) ? near : null;
    const x = usable(xno, t) ? xno : null;
    const r = n ? build(n, x) : null;
    return {
      nearUsd: n ? n.usd : null,
      xnoUsd: x ? x.usd : null,
      xnoPerNear: r ? r.xnoPerNear : null,
      nearPerXno: r ? r.nearPerXno : null,
      spreadBps: cfg.spreadBps,
      effectiveNearUsd: r ? (r.effectiveNearUsd ?? r.nearUsd) : null,
      quoting: !!n && (!!x || !xnoRequired),
      xnoRequired,
      sources: {
        nearUsd: sourceView(near, nearError, nearLive(), t),
        xnoUsd: sourceView(xno, xnoError, xnoLive(), t),
      },
      derivation: "xnoPerNear = nearUsd / xnoUsd and nearPerXno = xnoUsd / nearUsd, from the two USD rates; no swap venue is queried. " +
        "NEAR amounts are computed at nearUsd reduced by the swap margin (spreadBps). This server does not swap NEAR to XNO.",
      refresh: {
        intervalSeconds: refreshMs ? Math.round(refreshMs / 1000) : null,
        ttlSeconds: Math.round(ttlMs / 1000),
        maxStaleSeconds: Math.round(maxStaleMs / 1000),
        lastAt: lastRefreshAt != null ? iso(lastRefreshAt) : null,
        nextAt: timer && anyLive() && nextRefreshAt != null ? iso(nextRefreshAt) : null,
        forcedMinIntervalSeconds: Math.round(forceMinIntervalMs / 1000),
        refreshed,
        ...(refreshNote ? { note: refreshNote } : {}),
      },
      now: iso(t),
    };
  }

  /** Start the background refresh (and one refresh now). Returns the first refresh's promise. */
  function start() {
    if (refreshMs > 0 && !timer) {
      timer = setIntervalFn(() => { nextRefreshAt = now() + refreshMs; if (anyLive()) void refresh(); }, refreshMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      nextRefreshAt = now() + refreshMs;
    }
    return refresh();
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    nextRefreshAt = null;
  }

  /**
   * Replace the static values (SIGHUP) and refetch the live ones. Throws
   * BAD_RATE on an invalid value and changes nothing in that case.
   */
  async function reload(values) {
    const applied = configure(values);
    await refresh();
    return applied;
  }

  return {
    current, refresh, view, start, stop, reload,
    get config() { return { nearUsd: cfg.nearStatic, xnoUsd: cfg.xnoStatic, spreadBps: cfg.spreadBps, xnoRequired }; },
  };
}
