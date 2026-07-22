/**
 * x402 charge gate — sell tool calls for Nano (XNO), no accounts anywhere.
 *
 * Flow (mirrors NanoGPT's own x402 shape, adapted to MCP's in-band tool results):
 *   1. tools/call without `_payment_id` → a payment-required result: price, a
 *      pay-page link (QR), the exact raw amount, and agent-directed instructions.
 *   2. The caller pays the EXACT amount to the gate's wallet address. Nano has
 *      no payment memo, so each quote's amount carries a random tag in whole
 *      1e-8 XNO steps that makes it unique among retained quotes — the amount
 *      IS the memo, and it survives being typed into a wallet by hand (8
 *      decimals is what wallets display and send).
 *   3. tools/call again with `_payment_id` → the gate long-polls its watcher
 *      (RPC polling, plus node websocket push when configured), then runs the
 *      tool exactly once. Re-calls replay the cached result; run failures are
 *      refunded to the payer's account automatically.
 *
 * Detection watches `receivable` on the gate address and, as a race-cover,
 * `account_history` — a concurrently running wallet may pocket the customer's
 * send between polls, at which point it only shows up as a received entry.
 * Payments that arrive after their quote expired are refunded automatically.
 *
 * With `stateFile` set, quotes and the owed-send queue persist across restarts —
 * a deploy landing between "customer paid" and "run replied" must never eat the
 * payment (observed live 2026-07-22).
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { checkAddress } from "nanocurrency";
import { rawToXno } from "./wallet.mjs";
import { fmtDur } from "./tools.mjs";

const QUOTE_TTL_MS = 15 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep dead quotes around to auto-refund late payments
const HISTORY_EVERY = 5; // check account_history every Nth poll tick
/**
 * 1e-8 XNO in raw — the resolution wallets actually display and let a human
 * type. Quote amounts are whole multiples of this, so the friendly "0.13647256
 * XNO" figure IS the exact payable amount; payments are matched at this
 * resolution too, so a wallet that pads or truncates deeper digits can't
 * orphan a payment.
 */
const GRAIN = 10n ** 22n;

/**
 * Exact money math — no floating point anywhere near an on-chain amount.
 *
 * USD values are parsed from their decimal-string form into integer
 * nano-dollars (1e-9 USD) by string manipulation; digits beyond 1e-9 USD
 * truncate (a defined floor of under a billionth of a dollar, in the payer's
 * favor). The "rate" is never a number: it is the oracle invoice's exact pair
 * (R raw costs U nano-dollars), and conversions are BigInt ratio arithmetic
 * with an explicit floor/ceil.
 */
export function parseUsdNano(v) {
  const s = String(v).trim();
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!m || m[1] === "-") throw new Error(`unusable USD amount: ${JSON.stringify(v)}`);
  const digits = m[2] + (m[3] || "");
  const exp = (m[4] ? parseInt(m[4], 10) : 0) - (m[3] ? m[3].length : 0) + 9; // scale to nano-USD
  if (exp >= 0) return BigInt(digits) * 10n ** BigInt(exp);
  return BigInt(digits.slice(0, digits.length + exp) || "0"); // truncate below 1e-9 USD
}

/** USD → raw via the exact oracle pair {usdNano, raw}: raw = usd·R/U, floor or ceil. */
function usdToRaw(usdValue, pair, mode = "floor") {
  const num = parseUsdNano(usdValue) * pair.raw;
  return mode === "ceil" ? (num + pair.usdNano - 1n) / pair.usdNano : num / pair.usdNano;
}

/** Deterministic hash of (tool, arguments) — a payment id is bound to exactly this call. */
export function hashArgs(name, args) {
  const stable = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  };
  return createHash("sha256").update(name + "\n" + stable(args)).digest("hex").slice(0, 16);
}

const fmtUsd = (n) => "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2)).replace(/(\.\d\d\d*?)0+$/, "$1");

/**
 * @param {object} opts
 * @param {string} opts.address           Nano address payments arrive at (the wallet account)
 * @param {object} opts.ops               wallet ops ({ rpc, transfer, pocket }) — refunds + chain RPC
 * @param {number} opts.usd               default price per call
 * @param {(params) => Promise<void>} [opts.validate]  registry arg validation — quotes are only
 *                                        issued for calls that would actually run (never charge for a typo)
 * @param {number|null} [opts.xnoUsd]     static XNO/USD rate override; null (default) → NanoGPT's own
 *                                        x402 invoices are the oracle (60s cache, stale-tolerant)
 * @param {string} [opts.oracleBase]      NanoGPT API base for the rate probe (default https://nano-gpt.com)
 * @param {string|null} [opts.wsUrl]      Nano node websocket (wss://…) for push confirmations
 * @param {string} opts.publicBase        absolute base URL for pay links (no trailing slash)
 * @param {number} [opts.pollMs]          receivable poll interval while quotes are pending
 * @param {number} [opts.waitMs]          how long a NON-streaming _payment_id call blocks waiting for
 *                                        settlement — kept under typical MCP client tool timeouts so the
 *                                        caller gets our "not arrived yet, call again" message, never an
 *                                        opaque client-side timeout. Streaming calls wait out the quote's
 *                                        whole TTL (heartbeats keep the connection alive).
 * @param {string|null} [opts.stateFile]  persist quotes + owed sends here (write-then-rename JSON) and
 *                                        restore them at startup — in-flight money survives restarts
 * @param {(event: string, fields: object) => void} [opts.usage]  usage-log sink
 */
export function createChargeGate({
  address,
  ops,
  usd,
  validate = null,
  xnoUsd = null,
  oracleBase = null,
  wsUrl = null,
  publicBase,
  pollMs = 1000,
  waitMs = 20_000,
  stateFile = null,
  fetch = globalThis.fetch,
  log = () => {},
  usage = () => {},
  now = () => Date.now(),
}) {
  if (!address || !ops) throw new Error("charge gate needs a funded Nano wallet (address + ops)");
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("charge gate needs a positive default price");

  /** @type {Map<string, object>} paymentId → quote */
  const quotes = new Map();

  /* ---------------- pricing ---------------- */

  // The rate oracle is NanoGPT itself: any keyless request with `x-x402: true`
  // answers 402 with the SAME invoice pair (raw XNO amount + USD value) they
  // settle our downstream payments at — so we quote callers at the rate we pay,
  // not a market feed's. The probe invoice is never paid; it expires on their
  // side, and the 60s cache keeps probes to at most one a minute while quoting.
  const oracleUrl = `${String(oracleBase || "https://nano-gpt.com").replace(/\/+$/, "")}/api/v1/chat/completions`;
  const ORACLE_MODEL = "glm-5.2"; // any keyless-quotable model works

  async function nanoGptPair() {
    const r = await fetch(oracleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-x402": "true" },
      body: JSON.stringify({ model: ORACLE_MODEL, messages: [{ role: "user", content: "x402 rate probe" }] }),
    });
    if (r.status !== 402) throw new Error(`expected 402 from x402 probe, got HTTP ${r.status}`);
    const body = await r.json();
    // Extract the pair straight off the wire, before anything Number()s it —
    // amountUsd is a decimal string in the payload and we keep it exact.
    const pay = body && body.payment;
    const pool = [
      ...(Array.isArray(body && body.accepts) ? body.accepts : []),
      ...(Array.isArray(pay && pay.accepted) ? pay.accepted : []),
    ];
    const nano = pool.find((a) => a && a.scheme === "nano");
    const rawStr = String((nano && (nano.maxAmountRequired || nano.amount)) || "");
    const usdVal = nano && (nano.maxAmountRequiredUSD ?? nano.amountUsd ?? (pay && pay.amountUsd));
    if (!/^\d+$/.test(rawStr) || BigInt(rawStr) <= 0n || usdVal == null) {
      throw new Error("402 carried no usable XNO/USD pair");
    }
    const usdNano = parseUsdNano(usdVal);
    if (usdNano <= 0n) throw new Error("402 USD amount parsed to zero");
    return { usdNano, raw: BigInt(rawStr) };
  }

  let rate = Number.isFinite(xnoUsd) && xnoUsd > 0
    ? { pair: { usdNano: parseUsdNano(xnoUsd), raw: 10n ** 30n }, at: Infinity, source: "static" }
    : null;
  async function ratePair() {
    if (rate && (rate.at === Infinity || now() - rate.at < 60_000)) return rate.pair;
    try {
      const pair = await nanoGptPair();
      rate = { pair, at: now(), source: "nanogpt-x402" };
      return pair;
    } catch (e) {
      if (rate) {
        log(`NanoGPT rate oracle failed (${e.message}) — using stale cached pair`);
        return rate.pair;
      }
      throw new Error("cannot price this call: the NanoGPT x402 rate probe failed " +
        `(${e.message}) and there is no cached rate or --xno-usd override`);
    }
  }
  const rateSource = () => (rate ? rate.source : null);
  /** Display-only float view of the pair — never used for money. */
  const rateDisplay = (pair) => (Number(pair.usdNano) / 1e9) * (1e30 / Number(pair.raw));

  /**
   * Deposit → raw amount with a tag unique among retained quotes (the amount is
   * the memo). The whole amount is a multiple of GRAIN, so its 8-decimal XNO
   * rendering is EXACT — a human typing "0.13647256 XNO" into any wallet sends
   * precisely the quoted amount. (An early version hid the tag below display
   * resolution; a hand-typed payment then never matched and sat orphaned.)
   */
  function tagAmount(usdPrice, pair) {
    // exact conversion, ceiled so the deposit always covers its USD figure,
    // then ceiled again to a whole 1e-8 XNO…
    let base = usdToRaw(usdPrice, pair, "ceil");
    base = ((base + GRAIN - 1n) / GRAIN) * GRAIN;
    if (base < GRAIN) base = GRAIN;
    for (;;) {
      // …plus up to 0.0001 XNO (a few thousandths of a cent) of random tag in
      // whole 1e-8 XNO steps: visible to the matcher, negligible to the payer,
      // and returned with the change anyway.
      const tag = (BigInt("0x" + randomBytes(4).toString("hex")) % 10_000n) * GRAIN;
      const amountRaw = (base + tag).toString();
      // Unique across ALL retained quotes (not just pending) — the matcher
      // compares at GRAIN resolution against every quote it still remembers.
      let clash = false;
      for (const q of quotes.values()) if (BigInt(q.amountRaw) / GRAIN === (base + tag) / GRAIN) { clash = true; break; }
      if (!clash) return amountRaw;
    }
  }

  /* ---------------- quote lifecycle ---------------- */

  function resolveWaiters(q) {
    for (const w of q.waiters.splice(0)) w();
  }

  async function markPaid(q, { source, hash, via }) {
    q.status = "paid";
    q.paidAt = now();
    q.source = source || null;
    q.payHash = hash || null;
    log(`payment ${q.id}: ${rawToXno(q.amountRaw)} XNO received via ${via}` +
      (source ? ` from ${source}` : "") + ` (${q.tool})`);
    usage("paid", { paymentId: q.id, tool: q.tool, amountRaw: q.amountRaw, usd: q.usd, source: q.source, via, settleMs: q.paidAt - q.createdAt });
    persist();
    resolveWaiters(q);
  }

  /*
   * Money owed to someone whose send bounced (RPC hiccup, work outage, rate
   * limit) — retried on the watcher timer with backoff until it lands. A
   * failed send must never silently strand a customer's or author's money:
   * that's the difference between "the RPC blipped" and "the operator kept it".
   */
  const owed = []; // { to, amountRaw, describe, event, fields, onOk, tries, at }
  const OWED_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const OWED_MAX_TRIES = 100; // ≈16h at the 10-min cap — after that it needs a human
  function owe(to, amountRaw, describe, event, fields, onOk) {
    owed.push({ to, amountRaw: String(amountRaw), describe, event, fields, onOk, tries: 0, at: now() + OWED_BACKOFF_MS[0] });
    log(`${describe} ${rawToXno(amountRaw)} XNO to ${to} failed — queued for retry`);
    persist();
    ensureWatching();
  }
  async function retryOwed() {
    const t = now();
    for (const o of [...owed]) {
      if (t < o.at) continue;
      o.tries++;
      try {
        const hash = await ops.transfer(o.to, o.amountRaw, o.describe);
        owed.splice(owed.indexOf(o), 1);
        usage(o.event, { ...o.fields, ok: true, to: o.to, amountRaw: o.amountRaw, hash, retries: o.tries });
        persist();
        if (o.onOk) o.onOk(hash);
      } catch (e) {
        if (o.tries >= OWED_MAX_TRIES) {
          owed.splice(owed.indexOf(o), 1);
          log(`GIVING UP on ${o.describe} ${rawToXno(o.amountRaw)} XNO to ${o.to} after ${o.tries} tries (${e.message}) — refund manually`);
          usage(o.event, { ...o.fields, ok: false, to: o.to, amountRaw: o.amountRaw, error: e.message, retries: o.tries, gaveUp: true });
          persist();
          continue;
        }
        o.at = t + OWED_BACKOFF_MS[Math.min(o.tries, OWED_BACKOFF_MS.length - 1)];
        log(`retry ${o.tries} of ${o.describe} to ${o.to} failed: ${e.message}`);
      }
    }
  }

  async function refund(q, reason) {
    if (q.refunding) return q.refunding;
    if (!q.source) {
      log(`cannot refund ${q.id}: payer account unknown — ${rawToXno(q.amountRaw)} XNO stays in the wallet`);
      usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: "payer account unknown", reason });
      return false;
    }
    q.refunding = (async () => {
      try {
        const hash = await ops.transfer(q.source, q.amountRaw, "refunded");
        q.status = "refunded";
        usage("refund", { paymentId: q.id, tool: q.tool, ok: true, amountRaw: q.amountRaw, to: q.source, hash, reason });
        persist();
        return true;
      } catch (e) {
        log(`refund of ${q.id} to ${q.source} failed: ${e.message}`);
        usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: e.message, reason });
        owe(q.source, q.amountRaw, "refunded", "refund",
          { paymentId: q.id, tool: q.tool, reason }, () => { q.status = "refunded"; });
        return false;
      }
    })();
    return q.refunding;
  }

  /* ---------------- durable state ---------------- */

  /*
   * Quotes and the owed queue are money in flight; both must survive a restart
   * (CI deploys restart the process on every merge). Serialization drops the
   * live-only bits: waiters/refunding always, inline image blocks from cached
   * results (the media files themselves persist on disk and keep their /out/
   * URLs), and a consumed-but-unfinished run demotes back to "paid" so the
   * retry after restart runs it — charged once, delivered once.
   */
  let saveChain = Promise.resolve();
  let saveQueued = false;
  function persist() {
    if (!stateFile || saveQueued) return;
    saveQueued = true;
    saveChain = saveChain.then(async () => {
      saveQueued = false; // snapshot at write time — later mutations queue another write
      const data = JSON.stringify({
        v: 1,
        quotes: [...quotes.values()].map((q) => ({
          id: q.id, tool: q.tool, argsHash: q.argsHash, usd: q.usd,
          pair: { usdNano: q.pair.usdNano.toString(), raw: q.pair.raw.toString() },
          amountRaw: q.amountRaw, createdAt: q.createdAt, expiresAt: q.expiresAt,
          status: q.status === "consumed" && !q.result && !q.error ? "paid" : q.status,
          source: q.source ?? null, payHash: q.payHash ?? null, paidAt: q.paidAt ?? null,
          result: q.result ? { ...q.result, content: (q.result.content || []).filter((c) => c.type !== "image") } : null,
          error: q.error ?? null,
        })),
        owed: owed.map((o) => ({ to: o.to, amountRaw: o.amountRaw, describe: o.describe, event: o.event, fields: o.fields, tries: o.tries })),
      });
      await mkdir(dirname(stateFile), { recursive: true });
      const tmp = stateFile + ".tmp";
      await writeFile(tmp, data);
      await rename(tmp, stateFile);
    }).catch((e) => log(`cannot persist gate state to ${stateFile}: ${e.message}`));
  }

  if (stateFile) {
    try {
      const data = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const s of Array.isArray(data.quotes) ? data.quotes : []) {
        const q = { ...s, pair: { usdNano: BigInt(s.pair.usdNano), raw: BigInt(s.pair.raw) }, waiters: [] };
        // A finished run replays its cached outcome; without this, a retry
        // after restart would run (and settle) the same payment twice.
        if (q.status === "consumed" && (q.result || q.error)) q.running = Promise.resolve();
        quotes.set(q.id, q);
      }
      for (const s of Array.isArray(data.owed) ? data.owed : []) {
        owed.push({
          ...s, at: now() + OWED_BACKOFF_MS[0],
          onOk: s.event === "refund" && s.fields && s.fields.paymentId
            ? () => { const q = quotes.get(s.fields.paymentId); if (q) { q.status = "refunded"; persist(); } }
            : null,
        });
      }
      if (quotes.size || owed.length) log(`restored ${quotes.size} quote(s) and ${owed.length} queued send(s) from ${stateFile}`);
    } catch (e) {
      if (e.code !== "ENOENT") log(`cannot read gate state ${stateFile}: ${e.message} — starting fresh`);
    }
  }

  function prune() {
    const t = now();
    let changed = false;
    for (const q of quotes.values()) {
      if (q.status === "pending" && t > q.expiresAt) {
        q.status = "expired";
        resolveWaiters(q);
        changed = true;
      }
      if (t - q.createdAt > RETAIN_MS) { quotes.delete(q.id); changed = true; }
    }
    if (changed) persist();
  }

  /**
   * An incoming amount either settles a pending quote or, on a dead quote,
   * bounces back. Matching is at GRAIN (1e-8 XNO) resolution — quotes are exact
   * multiples of it, so this accepts the exact send AND a send some wallet
   * padded with sub-display dust, while staying unambiguous (tagAmount enforces
   * bucket uniqueness across retained quotes).
   */
  function matchAmount(amountRaw, meta) {
    const amt = String(amountRaw);
    if (!/^\d+$/.test(amt)) return;
    const bucket = BigInt(amt) / GRAIN;
    for (const q of quotes.values()) {
      if (BigInt(q.amountRaw) / GRAIN !== bucket) continue;
      if (q.status === "pending") return void markPaid(q, meta);
      if (q.status === "expired" && !q.refunding) {
        log(`late payment for expired quote ${q.id} — refunding`);
        q.source = q.source || meta.source || null;
        return void refund(q, "quote expired before payment arrived");
      }
      return; // paid/consumed already — a re-scan of the same block, not a new payment
    }
  }

  /* ---------------- payment watcher: RPC polling + optional websocket ---------------- */

  let timer = null;
  let tickCount = 0;
  let wsConnected = false;

  const anyPending = () => [...quotes.values()].some((q) => q.status === "pending");
  // Recently expired quotes stay watched so a payment that arrives too late is
  // noticed and bounced straight back instead of silently kept.
  const LATE_WATCH_MS = 60 * 60 * 1000;
  const anyWatchable = () => {
    const t = now();
    return owed.length > 0 || [...quotes.values()].some((q) =>
      q.status === "pending" || (q.status === "expired" && t - q.expiresAt < LATE_WATCH_MS));
  };

  async function scan() {
    prune();
    await retryOwed();
    if (!anyWatchable()) return;
    tickCount++;
    const r = await ops.rpc({ action: "receivable", account: address, count: "50", threshold: "1", source: "true" });
    const blocks = r && r.blocks && typeof r.blocks === "object" ? Object.entries(r.blocks) : [];
    for (const [hash, v] of blocks) {
      const amount = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
      const source = typeof v === "object" && v !== null ? v.source : null;
      matchAmount(amount, { source, hash, via: "receivable poll" });
    }
    // Race cover: a concurrently running wallet may have pocketed the customer's send
    // between polls — then it only exists as a received history entry.
    if (tickCount % HISTORY_EVERY === 0 && anyWatchable()) {
      const h = await ops.rpc({ action: "account_history", account: address, count: "25" });
      for (const entry of Array.isArray(h && h.history) ? h.history : []) {
        if (entry && entry.type === "receive") {
          matchAmount(entry.amount, { source: entry.account, hash: entry.hash, via: "history poll" });
        }
      }
    }
  }

  function tick() {
    timer = null;
    scan().catch((e) => log(`payment scan failed (${e.message}) — will retry`)).then(() => {
      if (!anyWatchable()) return;
      // With a live websocket the poll is only a safety net — relax it.
      timer = setTimeout(tick, wsConnected ? Math.max(pollMs, 5000) : pollMs);
      if (timer.unref) timer.unref();
    });
  }

  function ensureWatching() {
    connectWs();
    if (!timer) tick();
  }

  let ws = null;
  let wsEverFailed = false;
  function connectWs() {
    if (!wsUrl || ws) return;
    if (typeof WebSocket === "undefined") {
      if (!wsEverFailed) { wsEverFailed = true; log("--nano-ws ignored: no global WebSocket (needs Node ≥ 21)"); }
      return;
    }
    try { ws = new WebSocket(wsUrl); } catch (e) { log(`websocket ${wsUrl} failed to open: ${e.message}`); return; }
    ws.onopen = () => {
      wsConnected = true;
      log(`websocket connected: ${wsUrl} — payment detection is push-based`);
      ws.send(JSON.stringify({ action: "subscribe", topic: "confirmation", options: { accounts: [address] } }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.topic === "confirmation" && m.message) {
        const blk = m.message.block || {};
        if (blk.subtype === "send" && blk.link_as_account === address) {
          matchAmount(m.message.amount, { source: blk.account, hash: m.message.hash, via: "websocket" });
        }
      }
    };
    ws.onclose = ws.onerror = () => {
      if (wsConnected) log(`websocket ${wsUrl} disconnected — falling back to polling`);
      wsConnected = false;
      ws = null;
      // reconnect lazily next time something needs watching
      if (anyPending()) setTimeout(connectWs, 10_000).unref?.();
    };
  }

  /* ---------------- MCP-facing results ---------------- */

  const payUrl = (q) => `${publicBase}/pay/${q.id}`;
  const nanoUri = (q) => `nano:${address}?amount=${q.amountRaw}`;

  function paymentRequiredResult(q) {
    const x402 = {
      paymentId: q.id,
      payUrl: payUrl(q),
      uri: nanoUri(q),
      address,
      amountRaw: q.amountRaw,
      amountXno: rawToXno(q.amountRaw),
      amountUsd: q.usd,
      expiresAt: new Date(q.expiresAt).toISOString(),
    };
    const text =
      `PAYMENT REQUIRED — this tool takes a ${fmtUsd(q.usd)} deposit (exactly ${rawToXno(q.amountRaw)} XNO), paid in Nano. No account needed. ` +
      `The actual price is the run's metered model cost + 20%; everything above that comes back to the paying wallet as change after the run.\n\n` +
      `To proceed:\n` +
      `1. Show your user this payment link (it renders a QR code to scan with any Nano wallet, and turns into a green check the moment the payment lands):\n` +
      `   ${payUrl(q)}\n` +
      `2. Call this tool again with the SAME arguments plus "_payment_id": "${q.id}". You can call again right away — ` +
      `the call waits for the payment to land (settlement takes about a second) and then runs.` +
      (q.etaMs ? ` Once paid, this tool typically finishes in ~${fmtDur(q.etaMs)}.` : "") + `\n\n` +
      `Paying without the page: send exactly ${rawToXno(q.amountRaw)} XNO (${q.amountRaw} raw) to ${address} — ` +
      `the exact amount is how the payment is recognized (URI: ${nanoUri(q)}).\n` +
      `This quote expires ${x402.expiresAt}. If the run fails after payment, the payment is refunded automatically.`;
    return { content: [{ type: "text", text }], structuredContent: { x402 } };
  }

  const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

  /* ---------------- public surface ---------------- */

  const gate = {
    address,

    /** Quote/pay state for the HTTP pay page + status endpoint. */
    quote(id) {
      const q = quotes.get(String(id));
      if (!q) return null;
      prune();
      return {
        id: q.id, tool: q.tool, status: q.status, usd: q.usd,
        amountRaw: q.amountRaw, amountXno: rawToXno(q.amountRaw),
        address, uri: nanoUri(q), expiresAt: new Date(q.expiresAt).toISOString(),
      };
    },

    /** Resolve when the quote leaves `pending` (paid/expired), or after ms. Returns the status. */
    waitForPayment(id, ms) {
      const q = quotes.get(String(id));
      if (!q) return Promise.resolve("unknown");
      if (q.status !== "pending") return Promise.resolve(q.status);
      ensureWatching();
      return new Promise((res) => {
        const t = setTimeout(() => res(q.status), ms);
        if (t.unref) t.unref();
        q.waiters.push(() => { clearTimeout(t); res(q.status); });
      });
    },

    /**
     * Decorate a tool registry: descriptions gain prices, schemas gain _payment_id,
     * run_noodle is withdrawn (arbitrary share links can't be priced up front),
     * and callTool enforces quote → pay → run-once → replay.
     */
    wrapRegistry(registry, { runNoodleName = "run_noodle" } = {}) {
      const priceFor = (tool) => {
        const v = tool.x402 && Number(tool.x402.usd);
        return Number.isFinite(v) && v > 0 ? v : usd;
      };
      const prices = new Map(registry.tools.map((t) => [t.name, priceFor(t)]));
      // Under-deposited graphs cost the operator money every call — say so up front.
      for (const t of registry.tools) {
        const rec = registry.costs && registry.costs[t.name];
        const dep = prices.get(t.name) ?? usd;
        if (rec && typeof rec.usd === "number" && rec.usd * 1.2 > dep) {
          log(`warning: ${t.name} deposit ${fmtUsd(dep)} is below its last observed cost ${fmtUsd(rec.usd)} + 20% — ` +
            `runs may exceed the deposit and you eat the difference; raise x402.usd in its graph file`);
        }
      }
      // Hand-added `"x402": {"author": "nano_…"}` on a graph routes the whole 20%
      // markup of each successful call to its author — Nano has no fees, so
      // nothing is skimmed off it. No field → the wallet keeps the markup.
      const authorFor = (tool) => {
        const a = tool.x402 && typeof tool.x402.author === "string" ? tool.x402.author.trim() : "";
        if (!a) return null;
        if (!checkAddress(a)) { log(`ignoring x402.author on ${tool.name}: not a valid Nano address`); return null; }
        return a;
      };
      const authors = new Map(registry.tools.map((t) => [t.name, authorFor(t)]));

      /**
       * Settle a completed call against what it ACTUALLY cost — the quote was
       * only a deposit, never the price. In exact raw:
       *
       *   deposit  = what the caller paid (quote incl. dust)
       *   cost     = metered model cost, converted at the quote's own oracle
       *              rate, rounded up (unreported cost settles as $0 — the
       *              caller is never billed off a number we don't have)
       *   markup   = cost / 5 (20% of the true cost, integer floor)
       *   take     = min(markup, deposit − cost)  → the author (100%, no cut),
       *              or kept by the wallet when the graph names no author
       *   change   = deposit − cost − take       → sent back to the payer
       *
       * A run costing more than its deposit keeps the whole deposit and the
       * operator eats the rest; take and change are then zero. Transfers are
       * queued and never block the caller's result. Returns the numbers for
       * the receipt.
       */
      function settle(q, name, costUsd) {
        const author = authors.get(name);
        const deposit = BigInt(q.amountRaw);
        const known = Number.isFinite(costUsd);
        const costRaw0 = known ? usdToRaw(costUsd, q.pair, "ceil") : 0n;
        const costRaw = costRaw0 > deposit ? deposit : costRaw0;
        const remaining = deposit - costRaw;
        const markup = costRaw0 / 5n;
        const take = markup < remaining ? markup : remaining;
        const change = remaining - take;

        if (costRaw0 > deposit) {
          log(`call ${q.id} (${name}) cost $${costUsd} — more than its ${rawToXno(deposit)} XNO deposit; keeping the deposit, no payouts`);
        }
        if (author && take > 0n) {
          ops.transfer(author, take.toString(), "author payout:")
            .then((hash) => usage("author_payout", { paymentId: q.id, tool: name, ok: true, to: author, amountRaw: take.toString(), costUsd: known ? costUsd : null, hash }))
            .catch((e) => {
              log(`author payout for ${q.id} (${name} → ${author}) failed: ${e.message}`);
              owe(author, take.toString(), "author payout:", "author_payout", { paymentId: q.id, tool: name });
            });
        }
        if (change > 0n) {
          if (q.source) {
            ops.transfer(q.source, change.toString(), "change:")
              .then((hash) => usage("change", { paymentId: q.id, tool: name, ok: true, to: q.source, amountRaw: change.toString(), hash }))
              .catch((e) => {
                log(`change for ${q.id} (→ ${q.source}) failed: ${e.message}`);
                owe(q.source, change.toString(), "change:", "change", { paymentId: q.id, tool: name });
              });
          } else {
            log(`cannot return ${rawToXno(change)} XNO change for ${q.id}: payer account unknown`);
            usage("change", { paymentId: q.id, tool: name, ok: false, amountRaw: change.toString(), error: "payer account unknown" });
          }
        }
        return { known, costRaw, take, change, author: !!author };
      }

      const listTools = () =>
        registry.listTools()
          .filter((t) => t.name !== runNoodleName)
          .map((t) => {
            const price = prices.get(t.name) ?? usd;
            const description = t.description.replace(
              /every call spends real credit from [^;.]+/,
              `${fmtUsd(price)} deposit per call, paid in Nano (XNO) — settles at actual model cost + 20%, change returned; no account needed`) +
              (authors.get(t.name) ? " The 20% markup goes to the graph's author." : "");
            const inputSchema = {
              ...t.inputSchema,
              properties: {
                ...(t.inputSchema.properties || {}),
                _payment_id: {
                  type: "string",
                  description: "Payment id from this tool's previous payment-required response. " +
                    "First call the tool without it to get a payment link; after the user pays, " +
                    "call again with the same arguments plus this id.",
                },
              },
            };
            return { ...t, description, inputSchema };
          });

      // Typical runtime for a tool, from the cost sidecar — only when it's long
      // enough to be worth saying (sub-second graphs don't need an ETA).
      const etaOf = (n) => {
        const rec = registry.costs && registry.costs[n];
        return rec && Number.isFinite(rec.ms) && rec.ms >= 2500 ? rec.ms : null;
      };

      async function callTool(params, ctx = null) {
        // Malformed shells fall through to the registry for its usual ParamsError texts.
        if (params == null || typeof params !== "object" || Array.isArray(params)) return registry.callTool(params);
        if (params.name === runNoodleName) {
          return errResult("run_noodle is not available on this paid server — arbitrary share links can't be " +
            "priced up front. Use the listed tools, or run your own nanoodle-mcp (npx nanoodle-mcp) to run any link.");
        }
        const rawArgs = params.arguments == null ? {} : params.arguments;
        if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return registry.callTool(params);
        const { _payment_id, ...args } = rawArgs;
        const name = params.name;
        const argsHash = hashArgs(name, args);
        const price = prices.get(name);

        if (_payment_id == null) {
          // Never charge for a call that couldn't run: unknown tool / bad args throw here, pre-quote.
          if (validate) await validate({ name, arguments: args });
          const pair = await ratePair();
          const q = {
            id: "pay_" + randomBytes(9).toString("base64url"),
            tool: name, argsHash, usd: price ?? usd,
            pair, // settle math must use the exact pair the deposit was priced at
            amountRaw: tagAmount(price ?? usd, pair),
            createdAt: now(), expiresAt: now() + QUOTE_TTL_MS,
            status: "pending", waiters: [],
            etaMs: etaOf(name),
          };
          quotes.set(q.id, q);
          persist();
          ensureWatching();
          usage("quote", { paymentId: q.id, tool: name, usd: q.usd, amountRaw: q.amountRaw, xnoUsd: rateDisplay(pair), rateSource: rateSource() });
          return paymentRequiredResult(q);
        }

        const q = quotes.get(String(_payment_id));
        if (!q) {
          return errResult(`unknown or expired payment id "${_payment_id}" — call the tool again without _payment_id for a fresh quote.`);
        }
        if (q.tool !== name || q.argsHash !== argsHash) {
          return errResult(`payment ${q.id} was issued for a different call (tool/arguments changed) — ` +
            `call again without _payment_id to get a quote for these arguments.`);
        }
        if (q.status === "refunded") {
          return errResult(`payment ${q.id} was refunded${q.source ? ` to ${q.source}` : ""} — call again without _payment_id to retry.`);
        }
        if (q.status === "expired") {
          return errResult(`payment ${q.id} expired unpaid — call again without _payment_id for a fresh quote.`);
        }
        if (q.status === "pending") {
          // Streaming callers can afford to wait out the quote — heartbeats keep
          // their tool timeout at bay. Plain-JSON callers get one short wait, so
          // OUR "not arrived yet" message always beats their client-side timeout.
          if (ctx && ctx.report) ctx.report(`waiting for the ${rawToXno(q.amountRaw)} XNO payment to land`);
          const budget = ctx && ctx.streaming ? Math.max(waitMs, q.expiresAt - now()) : waitMs;
          const st = await gate.waitForPayment(q.id, budget);
          if (st === "pending") {
            return errResult(`payment ${q.id} hasn't arrived yet. If your user has the page open at ${payUrl(q)} ` +
              `it will show a green check when it lands — then call this tool again with the same _payment_id.`);
          }
          if (st === "expired") {
            return errResult(`payment ${q.id} expired unpaid — call again without _payment_id for a fresh quote.`);
          }
        }
        if (ctx && ctx.report) ctx.report(`payment received — running ${name}` + (q.etaMs ? ` (typically ~${fmtDur(q.etaMs)})` : ""));
        // paid (or consumed): run exactly once, replay the cached outcome afterwards
        if (!q.running) {
          q.status = "consumed";
          const t0 = now();
          q.running = (async () => {
            try {
              const { costUsd, ...result } = await registry.callTool({ name, arguments: args });
              const s = settle(q, name, costUsd);
              const receipt = `paid ${rawToXno(q.amountRaw)} XNO deposit` +
                (q.payHash ? ` (block ${q.payHash})` : "") +
                (s.known
                  ? ` — settled at actual cost ${fmtUsd(costUsd)} + 20%` +
                    (s.author && s.take > 0n ? " (markup goes to this noodle's author)" : "") +
                    (s.change > 0n ? `; ${rawToXno(s.change)} XNO change returned to your wallet` : "")
                  : " — the model reported no cost, so the whole deposit is being returned to your wallet");
              q.result = { ...result, content: [...result.content, { type: "text", text: receipt }] };
              usage("run", { paymentId: q.id, tool: name, ok: true, ms: now() - t0, usd: q.usd, costUsd: costUsd ?? null, paid: true });
              persist();
            } catch (e) {
              const msg = String((e && e.message) || e);
              usage("run", { paymentId: q.id, tool: name, ok: false, ms: now() - t0, usd: q.usd, paid: true, error: msg });
              const refunded = await refund(q, `run failed: ${msg}`);
              q.error = `run failed: ${msg}` + (refunded
                ? ` — your payment of ${rawToXno(q.amountRaw)} XNO was refunded to ${q.source}.`
                : q.source
                  ? ` — your ${rawToXno(q.amountRaw)} XNO deposit is being refunded to ${q.source} automatically (the first send bounced; the server retries until it lands).`
                  : " — the run was paid for; contact the operator about a refund.");
              persist();
            }
          })();
        }
        await q.running;
        return q.error ? errResult(q.error) : q.result;
      }

      return { listTools, callTool };
    },
  };
  // Restored pending quotes / owed sends need the watcher running from boot,
  // not from the next quote — a payment may land while nobody is calling.
  if (anyWatchable()) ensureWatching();
  return gate;
}
