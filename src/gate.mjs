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
 * walks `account_history` back to the last block it has already seen — a
 * concurrently running wallet may pocket the customer's send between polls, at
 * which point it only exists as a received history entry. The walk is bounded
 * by actual chain churn, never a fixed window, so a burst of simultaneous
 * payments of any size settles instead of scrolling out of view (a fixed
 * 25-entry window demonstrably stranded every payment past ~70 in a burst).
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
/**
 * The ONLY refund reasons the payments ledger may record — fixed categories,
 * never free text. A ledger line must never carry an upstream error string
 * (it can quote user content), so any reason outside this set is coerced to
 * "run_failed" before it can reach usage.jsonl.
 */
const REFUND_REASONS = new Set(["run_failed", "late_payment"]);
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep dead quotes around to auto-refund late payments
/**
 * Payment-detection windows. RECEIVABLE_COUNT must comfortably exceed any
 * plausible burst of concurrent payments: matched deposits stay receivable
 * until housekeeping pockets them, so during a burst the window fills with
 * already-matched blocks and payments beyond it are invisible. If it fills
 * anyway, the scanner asks the wallet to pocket — pocketed blocks reappear in
 * account_history, which is walked exhaustively (see scanHistory), so overflow
 * recovers instead of stranding.
 */
const RECEIVABLE_COUNT = 500;
const HISTORY_PAGE = 100; // account_history entries per RPC while walking
const HISTORY_MAX_PAGES = 10; // churn cap per scan — far above real block throughput per poll
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
 * @param {number} opts.usd               cold-start deposit per call — tools with a forecast
 *                                        (registry.estimates) or a known metered cost quote off
 *                                        that instead (see priceFor); this is the fallback, not a cap
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
 * @param {(event: string, fields: object) => void} [opts.usage]  payments-ledger sink:
 *                                        money lifecycle events only (quote, paid, refund,
 *                                        change, author_payout) — never run telemetry or
 *                                        error strings, which can quote user content
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
  let rateProbe = null; // in-flight oracle probe — concurrent cold quoters share one request
  async function ratePair() {
    if (rate && (rate.at === Infinity || now() - rate.at < 60_000)) return rate.pair;
    try {
      if (!rateProbe) rateProbe = nanoGptPair().finally(() => { rateProbe = null; });
      const pair = await rateProbe;
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
    for (let attempt = 0; ; attempt++) {
      // …plus up to 0.0001 XNO (a few thousandths of a cent) of random tag in
      // whole 1e-8 XNO steps: visible to the matcher, negligible to the payer,
      // and returned with the change anyway. If the retained-quote population
      // ever crowds that space, widen it 100× (still under a cent) rather than
      // loop forever.
      const span = attempt < 50 ? 10_000n : 1_000_000n;
      const tag = (BigInt("0x" + randomBytes(4).toString("hex")) % span) * GRAIN;
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

  /*
   * `reason` is a FIXED CATEGORY, never free text — it is written to the
   * payments ledger (usage.jsonl), and that file must never carry an upstream
   * error string, which can quote user content. Callers pass "run_failed" or
   * "late_payment"; the full failure text reaches the caller (q.error) and
   * stderr (log()) instead. Any transport-level error attached below
   * (ops.transfer bounced) is operational, not user content.
   */
  async function refund(q, reason) {
    reason = REFUND_REASONS.has(reason) ? reason : "run_failed";
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
        // v:2 is the content-stripping era — its results are provably media-only
        // (text output is written as null) and its errors are pre-redacted. A
        // v:1 (or unversioned) file predates this and may hold user content, so
        // restore treats it as legacy: drop its results, redact its errors.
        v: 2,
        quotes: [...quotes.values()].map((q) => {
          // What we're willing to write to disk for this quote's outcome:
          //   - Media-only results persist as today (minus inline image blocks;
          //     the files live on disk and keep their /out/ URLs). Their text is
          //     pointers + a cost line + a gate-authored receipt — no user content.
          //   - Text-output results (LLM/text nodes) hold the customer's paid
          //     content, so they NEVER hit disk: persist null. With the status
          //     rule below that demotes the quote back to "paid", so a retry after
          //     a restart RE-RUNS instead of replaying content from disk. Charged
          //     once / delivered once still holds; the only cost is one duplicate
          //     model call in the rare restart-between-run-and-retry window — the
          //     operator eats it, and privacy wins the trade.
          //   - Errors persist in their redacted q.errorPersist form (upstream
          //     text swapped for a placeholder, refund status kept). Its presence
          //     keeps status "consumed" so the redacted error replays after restart.
          const result = q.result && !q.textOutput
            ? { ...q.result, content: (q.result.content || []).filter((c) => c.type !== "image") }
            : null;
          const error = q.error ? (q.errorPersist ?? "run failed: (error details not retained across restarts)") : null;
          return {
            id: q.id, tool: q.tool, argsHash: q.argsHash, usd: q.usd,
            pair: { usdNano: q.pair.usdNano.toString(), raw: q.pair.raw.toString() },
            amountRaw: q.amountRaw, createdAt: q.createdAt, expiresAt: q.expiresAt,
            status: q.status === "consumed" && !result && !error ? "paid" : q.status,
            source: q.source ?? null, payHash: q.payHash ?? null, paidAt: q.paidAt ?? null,
            settled: q.settled === true, // don't re-pay change/author if this quote re-runs after restart
            settleReceipt: q.settleReceipt ?? null, // FIRST run's money figures — a re-run's receipt is built from these, not its own cost
            result,
            error,
          };
        }),
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
      // A pre-v2 file predates content stripping: its results may be full tool
      // output (text included) and its errors may be free-text upstream messages
      // — both can quote user content. We can't prove any legacy field is clean,
      // so we scrub at the door and never let it re-persist.
      const legacy = data.v !== 2;
      for (const s of Array.isArray(data.quotes) ? data.quotes : []) {
        const q = { ...s, pair: { usdNano: BigInt(s.pair.usdNano), raw: BigInt(s.pair.raw) }, waiters: [] };
        if (legacy) {
          // Legacy result: drop it. Old code only cached a result AFTER settling,
          // so a consumed quote that carried one was already settled — mark it so
          // the forced re-run (result now null → demoted to "paid") recomputes the
          // receipt WITHOUT paying change/author a second time. Money-safe; the
          // operator eats at most one duplicate model call, and no output text
          // survives to be written into the new v2 file.
          if (q.result) { q.settled = q.settled === true || q.status === "consumed"; q.result = null; }
          // Legacy error: it inlines the upstream message. Replace it wholesale
          // with a gate-authored placeholder and keep the quote a REPLAY (below)
          // — an errored quote was already refunded, so re-running it would refund
          // twice. The caller sees the placeholder instead of their content; both
          // the memory and persistable copies are the redacted string so a second
          // restart round-trips it unchanged.
          if (q.error) q.error = q.errorPersist = "run failed: (error details not retained across restarts) — the run was paid for; if you have not received a refund, contact the operator.";
        }
        // A restored error IS already the redacted form (v2 only ever persists
        // errorPersist). Mirror it back into errorPersist so the NEXT persist
        // writes the same redacted string — otherwise it would collapse to the
        // bare fallback and drop the gate-authored refund-status sentence.
        if (q.error && q.errorPersist == null) q.errorPersist = q.error;
        // A finished run replays its cached outcome; without this, a retry
        // after restart would run (and settle) the same payment twice. A quote
        // whose result we just dropped has neither result nor error, so it is
        // NOT marked a replay here — it re-runs on retry (guarded by q.settled).
        if (q.status === "consumed" && (q.result || q.error)) q.running = Promise.resolve();
        quotes.set(q.id, q);
      }
      for (const s of Array.isArray(data.owed) ? data.owed : []) {
        // Legacy state files predate the payments-ledger policy: their queued
        // refunds carry free-text reasons like "run failed: <upstream error>",
        // which can quote user content. When such an owed send later lands (or
        // gives up), its fields are spread verbatim into a NEW ledger line — so
        // scrub any non-category reason down to "run_failed" here, at the door,
        // keeping every other field intact.
        const fields = s.fields && typeof s.fields === "object" ? { ...s.fields } : s.fields;
        if (fields && "reason" in fields && !REFUND_REASONS.has(fields.reason)) fields.reason = "run_failed";
        owed.push({
          ...s, fields, at: now() + OWED_BACKOFF_MS[0],
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
        return void refund(q, "late_payment");
      }
      return; // paid/consumed already — a re-scan of the same block, not a new payment
    }
  }

  /* ---------------- payment watcher: RPC polling + optional websocket ---------------- */

  let timer = null;
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

  /**
   * Race cover for pocketed payments: the wallet (same process, other duties)
   * pockets receivables indiscriminately — including deposits this scanner has
   * not matched yet — after which they only exist as received history entries.
   * A fixed history window loses them under burst churn, so this walks
   * newest-to-oldest until the newest block the PREVIOUS walk saw: work done
   * scales with actual chain activity and nothing scrolls out of view. The
   * first walk (marker unset) reads one page to seed the marker — anything
   * older and unpocketed is still in `receivable`, which scan() reads first.
   */
  let lastHistoryHash = null;
  async function scanHistory() {
    let head = null;
    let newest = null;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const h = await ops.rpc({
        action: "account_history", account: address,
        count: String(HISTORY_PAGE), ...(head ? { head } : {}),
      });
      const entries = Array.isArray(h && h.history) ? h.history : [];
      if (!entries.length) break;
      if (newest === null) newest = entries[0].hash || null;
      let reachedMarker = false;
      for (const entry of entries) {
        if (!entry) continue;
        if (entry.hash === lastHistoryHash) { reachedMarker = true; break; }
        if (entry.type === "receive") {
          matchAmount(entry.amount, { source: entry.account, hash: entry.hash, via: "history poll" });
        }
      }
      if (reachedMarker || lastHistoryHash === null) break; // caught up (first walk seeds the marker from one page)
      head = typeof (h && h.previous) === "string" ? h.previous : null;
      if (head === null) break; // history exhausted before the marker — everything was scanned anyway
      if (page === HISTORY_MAX_PAGES - 1) {
        log(`history walk hit its ${HISTORY_MAX_PAGES * HISTORY_PAGE}-entry cap before the last-seen block — ` +
          "a payment pocketed under that churn may go unmatched until its quote expires");
      }
    }
    // Empty history seeds an empty-string sentinel: it matches no real hash, so
    // once the account's FIRST blocks appear the walk reads them all (bounded by
    // the page cap) instead of treating that scan as another one-page seeding.
    if (newest) lastHistoryHash = newest;
    else if (lastHistoryHash === null) lastHistoryHash = "";
  }

  async function scan() {
    prune();
    await retryOwed();
    if (!anyWatchable()) return;
    const r = await ops.rpc({ action: "receivable", account: address, count: String(RECEIVABLE_COUNT), threshold: "1", source: "true" });
    const blocks = r && r.blocks && typeof r.blocks === "object" ? Object.entries(r.blocks) : [];
    for (const [hash, v] of blocks) {
      const amount = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
      const source = typeof v === "object" && v !== null ? v.source : null;
      matchAmount(amount, { source, hash, via: "receivable poll" });
    }
    // A full window means blocks beyond it are invisible — ask the wallet to
    // pocket (queued housekeeping, never blocks a payment) so the overflow
    // reappears in account_history, which the walk below reads exhaustively.
    if (blocks.length >= RECEIVABLE_COUNT && ops.pocket) {
      ops.pocket().catch(() => {}); // best-effort; the next tick retries
    }
    if (anyWatchable()) await scanHistory();
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
  const watchUrl = (q) => `${publicBase}/x402/watch/${q.id}`;
  const nanoUri = (q) => `nano:${address}?amount=${q.amountRaw}`;

  function paymentRequiredResult(q) {
    const x402 = {
      paymentId: q.id,
      payUrl: payUrl(q),
      // An SSE endpoint that emits one `status` event per state change and closes
      // when the payment lands (or the quote dies) — a browser/HTTP client can
      // subscribe instead of polling. An MCP agent can't consume it directly, but
      // on a streaming tools/call the gate already holds THIS call open through
      // payment (no re-invoke); the URL is here for the pay page and other clients.
      watchUrl: watchUrl(q),
      uri: nanoUri(q),
      address,
      amountRaw: q.amountRaw,
      amountXno: rawToXno(q.amountRaw),
      amountUsd: q.usd,
      expiresAt: new Date(q.expiresAt).toISOString(),
    };
    // Agents relay this text to humans verbatim — "in 15 minutes" is usable
    // at a glance where a bare ISO timestamp forces timezone math.
    const expMin = Math.max(1, Math.round((q.expiresAt - now()) / 60_000));
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
      `This quote expires in about ${expMin} minute${expMin === 1 ? "" : "s"} (${x402.expiresAt}). ` +
      `If the run fails after payment, the payment is refunded automatically.`;
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
      const pinned = new Map(registry.tools.map((t) => {
        const v = t.x402 && Number(t.x402.usd);
        return [t.name, Number.isFinite(v) && v > 0 ? v : null];
      }));
      /**
       * Deposit for a tool as of right now. The deposit is a HOLD, not the price:
       * the run settles at its true metered cost + 20% and the rest comes back as
       * change, so a deposit only needs to be big enough to cover the call — never
       * exact. It must, though, actually cover it: a deposit below cost + 20% means
       * the operator eats the difference (see settle()).
       *
       * Precedence:
       *   1. A graph's own x402.usd is pinned and always wins.
       *   2. Otherwise quote off the largest of two cost signals — an UP-FRONT
       *      catalog forecast (registry.estimates, valid before the tool has ever
       *      run) and the worst metered cost actually seen (registry.costs, a live
       *      high-water mark) — times a safety multiplier for run-to-run variance:
       *      1.25× when the cost is deterministic (image only), 2× otherwise.
       *   3. With no signal at all (never run, uncatalogued), fall back to the flat
       *      --charge-usd opening deposit.
       *
       * --charge-usd is the cold-start deposit, NOT a ceiling: expensive graphs
       * quote what they actually cost (change still returns the slack), so the
       * operator stops absorbing overages on video / multi-step tools.
       */
      const priceFor = (name) => {
        const pin = pinned.get(name);
        if (pin) return pin;
        const rec = registry.costs && registry.costs[name];
        const obsHi = rec && rec.exact !== false
          ? Math.max(Number.isFinite(rec.usd) ? rec.usd : 0, Number.isFinite(rec.hiUsd) ? rec.hiUsd : 0)
          : 0;
        const est = registry.estimates && registry.estimates[name];
        const estUsd = est && Number.isFinite(est.usd) ? est.usd : 0;
        const basis = Math.max(estUsd, obsHi);
        if (!(basis > 0)) return usd; // nothing to price off yet → flat opening deposit
        // deterministic (all-image forecast, and reality hasn't exceeded it) → tight hold; else headroom for variance
        const exact = !!(est && est.exact && est.unpriced === 0) && obsHi <= estUsd;
        let dep = Math.max(0.01, Math.ceil(basis * 1.2 * (exact ? 1.25 : 2) * 100) / 100);
        // a forecast with unpriceable nodes is a lower bound — never quote below the opening deposit
        if (est && est.unpriced > 0 && dep < usd) dep = usd;
        return dep;
      };
      // Under-deposited graphs cost the operator money every call — say so up front.
      for (const t of registry.tools) {
        const rec = registry.costs && registry.costs[t.name];
        const dep = priceFor(t.name);
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
       *
       * `alreadySettled` is set only on the re-run that follows a restart of a
       * text-output quote (see the persist() note): that quote's change and
       * author payout went out on the FIRST run, so the re-run recomputes the
       * receipt numbers but must NOT move money again. Without this the caller
       * would be paid change twice and the author twice — the demote-and-re-run
       * trade-off is meant to cost the operator exactly one duplicate model
       * call, nothing more.
       */
      function settle(q, name, costUsd, alreadySettled = false) {
        const author = authors.get(name);
        const deposit = BigInt(q.amountRaw);
        const known = Number.isFinite(costUsd);
        const costRaw0 = known ? usdToRaw(costUsd, q.pair, "ceil") : 0n;
        const costRaw = costRaw0 > deposit ? deposit : costRaw0;
        const remaining = deposit - costRaw;
        const markup = costRaw0 / 5n;
        const take = markup < remaining ? markup : remaining;
        const change = remaining - take;

        // Recompute-only replay after a restart: the money already moved.
        if (alreadySettled) return { known, costRaw, take, change, author: !!author };

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
            const price = priceFor(t.name);
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
        const price = priceFor(name);

        let q;
        if (_payment_id == null) {
          // Never charge for a call that couldn't run: unknown tool / bad args throw here, pre-quote.
          if (validate) await validate({ name, arguments: args });
          const pair = await ratePair();
          q = {
            id: "pay_" + randomBytes(9).toString("base64url"),
            tool: name, argsHash, usd: price,
            pair, // settle math must use the exact pair the deposit was priced at
            amountRaw: tagAmount(price, pair),
            createdAt: now(), expiresAt: now() + QUOTE_TTL_MS,
            status: "pending", waiters: [],
            etaMs: etaOf(name),
          };
          quotes.set(q.id, q);
          persist();
          ensureWatching();
          usage("quote", { paymentId: q.id, tool: name, usd: q.usd, amountRaw: q.amountRaw, xnoUsd: rateDisplay(pair), rateSource: rateSource() });
          // The FIRST call always returns the payment-required quote as its tool
          // RESULT — every MCP client surfaces a result, so the pay link is always
          // seen. (An earlier build held streaming calls open and pushed the link
          // as a progress notification instead; clients that don't render progress
          // messages showed the human nothing and the call hung until timeout —
          // observed live on talking-avatar. Delivering the link in-band as a
          // progress message is not reliable, so we don't.) To avoid a re-invoke
          // after paying, the caller passes _payment_id on the NEXT call and, on a
          // streaming transport, that call is held open until the payment lands.
          return paymentRequiredResult(q);
        } else {
          q = quotes.get(String(_payment_id));
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
              const { costUsd, textOutput, ...result } = await registry.callTool({ name, arguments: args });
              // Whether this result carries the customer's paid text output. Kept
              // on q (not inside q.result) so in-process replay is unchanged but
              // persist() knows this result must not be written to disk.
              q.textOutput = !!textOutput;
              // q.settled is only ever true here on the re-run of a text-output
              // quote that was demoted to "paid" across a restart — its money
              // already moved, so settle() recomputes the numbers without paying
              // change/author twice.
              const s = settle(q, name, costUsd, q.settled === true);
              // The receipt must describe the money that ACTUALLY moved, which is
              // the FIRST run's settlement — a post-restart re-run may report a
              // different cost (or none), and the change/payout already went out at
              // the first run's figures. So on the first settle we stash those
              // figures (money integers + the display cost only — no content, safe
              // at rest) and every receipt, first run or replay, is built from them.
              // Keyed on settleReceipt (not settled) so a legacy quote — marked
              // settled on restore but carrying no stored figures — falls back to
              // this recompute-only run's numbers rather than reading undefined.
              if (!q.settleReceipt) {
                q.settleReceipt = { known: s.known, costUsd: s.known ? costUsd : null,
                  take: s.take.toString(), change: s.change.toString(), author: s.author };
              }
              q.settled = true;
              const r = q.settleReceipt;
              const rTake = BigInt(r.take), rChange = BigInt(r.change);
              const receipt = `paid ${rawToXno(q.amountRaw)} XNO deposit` +
                (q.payHash ? ` (block ${q.payHash})` : "") +
                (r.known
                  ? ` — settled at actual cost ${fmtUsd(r.costUsd)} + 20%` +
                    (r.author && rTake > 0n ? " (markup goes to this noodle's author)" : "") +
                    (rChange > 0n ? `; ${rawToXno(rChange)} XNO change returned to your wallet` : "")
                  : " — the model reported no cost, so the whole deposit is being returned to your wallet");
              q.result = { ...result, content: [...result.content, { type: "text", text: receipt }] };
              // usage.jsonl is a PAYMENTS LEDGER — money lifecycle events only
              // (quote, paid, refund, change, author_payout), never run telemetry.
              // A run event would record the tool, timing, cost, and (on failure)
              // the upstream error string, which can quote user content; none of
              // that belongs in a privacy-respecting ledger. The settle() below
              // still emits the money events (change / author_payout).
              persist();
            } catch (e) {
              const msg = String((e && e.message) || e);
              // Only the CALLER (q.error) and the operator's stderr (via log,
              // inside refund) see the upstream error text; the ledger records
              // the failure as the fixed category "run_failed".
              const refunded = await refund(q, "run_failed");
              // The refund-status sentence is gate-authored (no user content), so
              // it's safe on disk; the upstream `msg` can quote prompt content, so
              // it is not. q.error carries the full text for in-process replay;
              // q.errorPersist swaps msg for a placeholder and is what persist()
              // writes. After a restart the placeholder variant IS q.error, so a
              // replayed failure shows "(error details not retained…)" plus the
              // real refund status — enough for the caller to know the money is
              // handled, without keeping their content at rest.
              const refundStatus = refunded
                ? ` — your payment of ${rawToXno(q.amountRaw)} XNO was refunded to ${q.source}.`
                : q.source
                  ? ` — your ${rawToXno(q.amountRaw)} XNO deposit is being refunded to ${q.source} automatically (the first send bounced; the server retries until it lands).`
                  : " — the run was paid for; contact the operator about a refund.";
              q.error = `run failed: ${msg}` + refundStatus;
              q.errorPersist = `run failed: (error details not retained across restarts)` + refundStatus;
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
