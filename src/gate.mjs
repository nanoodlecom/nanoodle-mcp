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
import { readFileSync, statSync } from "node:fs";
import { open, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { checkAddress } from "nanocurrency";
import { rawToXno } from "./wallet.mjs";
import { fmtDur, formatCostUsd, ParamsError } from "./tools.mjs";
import { redactUrl } from "./redact.mjs";

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
 * @param {number} [opts.waitMs]          short grace on a _payment_id call that arrives just as payment
 *                                        lands (race cover) — kept under typical MCP client tool timeouts.
 *                                        Payment monitoring is NOT this call: agents open /x402/watch SSE
 *                                        for that. A pending quote after waitMs returns "not arrived yet"
 *                                        with instructions to watch, never holds the results stream open
 *                                        through the quote TTL.
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
      // An entry is only removed from `owed` AFTER its send resolves, so any
      // second retryOwed() running during that await sees it as still owed and
      // sends it again. That is money out the door, once per concurrent pass.
      // It is reachable: tick() nulls `timer` before awaiting scan(), so every
      // ensureWatching() during an in-flight send re-enters tick() — and owe()
      // and waitForPayment() both call ensureWatching(). Observed in production
      // 2026-07-24: three identical 0.31294478 XNO sends inside one second, same
      // PID, no restart (blocks 52DEA6AC…, 8CC22CDE…, 58EE40E5…). A local repro
      // with a slow transfer and four watchers reached 45 sends of one entry.
      if (o.sending) continue;
      o.sending = true;
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
      } finally {
        o.sending = false;
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
  /**
   * Raw still held from this quote, which is the most a refund may send.
   *
   * Unsettled, and a settled quote with no payout intent: the whole deposit.
   * A receipt alone is not proof the change or the author payout left, and
   * subtracting it under-refunds. Confirmed, pending (`sent`), unknown, and
   * still-queued payouts are reserved — a refund must not pay them out again
   * on top of a send that is in flight or might already have landed. An
   * intended leg is reserved too until a successful chain read shows it was
   * never published. A `not_sent` leg is known never to have been signed or
   * published (its intent write failed, or dispatch failed before a block was
   * signed), so it reserves nothing. Markup kept by the operator (no leg)
   * stays refundable.
   */
  function legReserves(leg) {
    if (!leg) return false;
    if (leg.state === "not_sent" && !leg.hash) return false;
    if (leg.chainAbsent === true && leg.state === "intended" && !leg.hash) return false;
    return true;
  }
  /**
   * Terminal "definitely never went out". Only for a leg with no signed block:
   * a hash means a publish may have been attempted, and that is `unknown`.
   */
  function markNotSent(leg) {
    if (!leg || leg.state === "confirmed" || leg.hash) return;
    leg.state = "not_sent";
    leg.chainAbsent = false;
  }
  function reservedRaw(q) {
    let reserved = 0n;
    const covered = [];
    if (Array.isArray(q.settlementIntents)) {
      for (const leg of q.settlementIntents) {
        if (!legReserves(leg)) continue;
        reserved += BigInt(leg.amountRaw || "0");
        covered.push(leg);
      }
    }
    for (const o of owed) {
      if (!o.fields || o.fields.paymentId !== q.id) continue;
      if (o.event !== "change" && o.event !== "author_payout") continue;
      const kind = o.event === "author_payout" ? "author_payout" : "change";
      const amountRaw = String(o.amountRaw);
      if (covered.some((leg) => leg.kind === kind && String(leg.amountRaw) === amountRaw)) continue;
      reserved += BigInt(amountRaw || "0");
    }
    return reserved;
  }
  function heldRaw(q) {
    const deposit = BigInt(q.amountRaw);
    const reserved = reservedRaw(q);
    return reserved >= deposit ? 0n : deposit - reserved;
  }

  /*
   * A refund is an intent too, recorded BEFORE ops.transfer, the same way as
   * a payout leg:
   *   intended — amount + recipient durable, no block signed yet
   *   sent     — the wallet signed the block and its hash is durable
   *   unknown  — a block was signed but the publish errored or timed out
   *   queued   — failed before signing; the owed queue owns the retry
   * The same snapshot carries every planned payout leg as `not_sent`, so a
   * restart that finds the refund intent never dispatches a payout beside it.
   * If that snapshot does not land, nothing is sent and the deposit stays in
   * the wallet, reserved. A signed refund is never sent a second time.
   */
  async function refund(q, reason) {
    reason = REFUND_REASONS.has(reason) ? reason : "run_failed";
    if (q.refunding) return q.refunding;
    // A restart may still be matching payout sends to the chain. Subtracting
    // before that match treats an unconfirmed send as already returned.
    await reconcileDone;
    if (q.refunding) return q.refunding;
    let ri = q.refundIntent;
    // A signed (or queued) refund is never sent again from here.
    if (ri && ri.state !== "intended") return false;
    if (!ri) {
      // Committing to a refund means never dispatching a payout that has not
      // started. Mark those legs first so the amount below includes them.
      for (const leg of Array.isArray(q.settlementIntents) ? q.settlementIntents : []) {
        if (leg.state === "intended" && !leg.hash && !leg.retried && !leg.inflight) markNotSent(leg);
      }
      const amount = heldRaw(q);
      q.refundAmountRaw = amount.toString();
      if (!q.source) {
        log(`cannot refund ${q.id}: payer account unknown — ${rawToXno(amount.toString())} XNO stays in the wallet`);
        usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: "payer account unknown", reason });
        return false;
      }
      // Nothing left to send (the deposit already went back as change). Mark
      // it refunded so a replay does not try again.
      if (amount === 0n) {
        q.status = "refunded";
        usage("refund", { paymentId: q.id, tool: q.tool, ok: true, amountRaw: "0", to: q.source, reason });
        persist();
        return true;
      }
      ri = q.refundIntent = { amountRaw: amount.toString(), to: q.source, reason, state: "intended", hash: null };
    }
    q.refundAmountRaw = ri.amountRaw;
    const run = (async () => {
      try {
        // Durable before any publish: the refund intent, the quote, and its
        // not_sent legs in one snapshot.
        await flush();
      } catch (e) {
        refundHeld(q, e);
        return false;
      }
      return sendRefund(q);
    })();
    // `run` always yields before it can clear this (flush is async), so a
    // held refund's reset in refundHeld() lands after this assignment.
    q.refunding = run;
    return run;
  }
  function refundHeld(q, e) {
    log(`refund of ${q.id} held: cannot record the refund intent (${e.message}) — nothing sent; the deposit stays in the wallet until the intent is durable`);
    usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: "refund intent not durable", reason: q.refundIntent.reason });
    q.refundIntent.hash = null;
    q.refundIntent.state = "intended";
    q.refundHeldAt = Date.now();
    // Not in flight: a later trigger (or a restart that finds the intent on
    // disk) may try again with this same intent.
    q.refunding = null;
  }
  /** Publish the recorded refund intent once. Its hash is durable before publish. */
  async function sendRefund(q, { fromRestart = false } = {}) {
    const ri = q.refundIntent;
    const fields = { paymentId: q.id, tool: q.tool, reason: ri.reason };
    try {
      const hash = await ops.transfer(ri.to, ri.amountRaw, "refunded", async (preHash) => {
        ri.hash = preHash;
        ri.state = "sent";
        await flush(); // a failed snapshot throws here and the block is never published
      });
      if (!ri.hash) ri.hash = hash;
      ri.state = "sent";
      q.refundHeldAt = null;
      q.status = "refunded";
      usage("refund", { ...fields, ok: true, amountRaw: ri.amountRaw, to: ri.to, hash: ri.hash, ...(fromRestart ? { retries: 1 } : {}) });
      persist();
      return true;
    } catch (e) {
      if (e.persistFailed) { refundHeld(q, e); return false; }
      log(`refund of ${q.id} to ${ri.to} failed: ${e.message}`);
      usage("refund", { ...fields, ok: false, error: e.message });
      if (ri.hash) {
        // Signed, then the publish failed or timed out: it may have landed.
        // Stay reserved; never sign a second refund block.
        ri.state = "unknown";
        persist();
        return false;
      }
      // Failed before signing: nothing was published. The owed queue retries it.
      ri.state = "queued";
      owe(ri.to, ri.amountRaw, "refunded", "refund", fields, (okHash) => {
        ri.hash = okHash;
        ri.state = "sent";
        q.status = "refunded";
      });
      return false;
    }
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
  let persistGen = 0;
  let lastWritten = 0;
  let writing = false;
  function quoteSnapshot(q) {
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
    const row = {
      id: q.id, tool: q.tool, argsHash: q.argsHash, usd: q.usd,
      pair: { usdNano: q.pair.usdNano.toString(), raw: q.pair.raw.toString() },
      amountRaw: q.amountRaw, createdAt: q.createdAt, expiresAt: q.expiresAt,
      // A quote with a recorded refund intent never demotes to "paid": a
      // restart must finish that refund, not re-run (and re-settle) the call.
      status: q.status === "consumed" && !result && !error && !q.refundIntent ? "paid" : q.status,
      source: q.source ?? null, payHash: q.payHash ?? null, paidAt: q.paidAt ?? null,
      settled: q.settled === true, // don't re-pay change/author if this quote re-runs after restart
      settleReceipt: q.settleReceipt ?? null, // FIRST run's money figures — a re-run's receipt is built from these, not its own cost
      result,
      error,
    };
    // Live-only `inflight` is dropped. Amount, recipient, and state are the
    // whole record a restart needs to avoid paying a payout twice.
    if (Array.isArray(q.settlementIntents)) {
      row.settlementIntents = q.settlementIntents.map(intentRecord);
    }
    if (q.refundIntent) row.refundIntent = refundRecord(q.refundIntent);
    return row;
  }
  function refundRecord(ri) {
    return { amountRaw: String(ri.amountRaw), to: ri.to, reason: ri.reason, state: ri.state, hash: ri.hash || null };
  }
  function intentRecord(leg) {
    return {
      id: leg.id || null,
      kind: leg.kind,
      to: leg.to,
      amountRaw: String(leg.amountRaw),
      state: leg.state,
      hash: leg.hash || null,
      retried: leg.retried === true,
    };
  }
  function payoutSidecarPath() {
    return stateFile + ".payouts.json";
  }
  async function durableWrite(path, data) {
    // A private temp name. Two gates writing `path.tmp` used to rename each
    // other's file out from under the fsync, and the loser threw ENOENT and
    // dropped the snapshot.
    const tmp = path + "." + randomBytes(6).toString("hex") + ".tmp";
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data);
      await fh.sync(); // fsync the bytes before the name points at them
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, path); // atomic replace
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  async function syncDir(dir) {
    const dh = await open(dir, "r");
    try { await dh.sync(); }
    finally { await dh.close(); }
  }
  async function writeSnapshot() {
    // v:2 is the content-stripping era — its results are provably media-only
    // (text output is written as null) and its errors are pre-redacted. A
    // v:1 (or unversioned) file predates this and may hold user content, so
    // restore treats it as legacy: drop its results, redact its errors.
    // Payout intents also live in a sidecar the previous build never rewrites.
    // A rollback that saves v:2 again drops in-file intents; the sidecar is
    // what stops the rolled-forward process from paying those sends twice.
    // One writer at a time. A snapshot stringified before a slow fsync must
    // not rename over a newer writer's file. Re-entrant when reconcile
    // already holds the lock and then flushes.
    const held = !!recoveryLockPath;
    if (!held) {
      const t0 = Date.now();
      while (!(await acquireRecoveryLock())) {
        if (Date.now() - t0 > 10_000) throw new Error("timed out waiting for the state lock");
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    try {
      const dir = dirname(stateFile);
      await mkdir(dir, { recursive: true });
      const data = JSON.stringify({
        v: 2,
        quotes: [...quotes.values()].map(quoteSnapshot),
        owed: owed.map((o) => ({ to: o.to, amountRaw: o.amountRaw, describe: o.describe, event: o.event, fields: o.fields, tries: o.tries })),
      });
      const intents = {};
      const refunds = {};
      for (const q of quotes.values()) {
        if (Array.isArray(q.settlementIntents)) intents[q.id] = q.settlementIntents.map(intentRecord);
        if (q.refundIntent) refunds[q.id] = refundRecord(q.refundIntent);
      }
      // The main file lands first and is atomic on its own: once it holds a
      // refund intent it also holds every not_sent leg. A sidecar that then
      // fails to write is stale, and the merge below never lets a stale
      // `intended` leg outrank `not_sent` or a refund intent disappear.
      await durableWrite(stateFile, data);
      await durableWrite(payoutSidecarPath(), JSON.stringify({ v: 1, intents, refunds }));
      await syncDir(dir);
    } finally {
      if (!held) await releaseRecoveryLock();
    }
  }
  let saveError = null;
  function persist() {
    if (!stateFile) return;
    persistGen++;
    drainSaves();
  }
  function drainSaves() {
    if (!stateFile || writing) return;
    writing = true;
    saveChain = saveChain.then(async () => {
      try {
        while (lastWritten !== persistGen) {
          const target = persistGen;
          await writeSnapshot(); // snapshot at write time — later mutations queue another write
          lastWritten = target;
          saveError = null;
        }
      } catch (e) {
        saveError = e;
        log(`cannot persist gate state to ${stateFile}: ${e.message}`);
        // Leave lastWritten behind. flush() rejects; dispatch must not proceed.
      } finally {
        writing = false;
        if (!saveError && lastWritten !== persistGen) drainSaves();
      }
    });
  }
  /**
   * Durable before the next send. Rejects unless the snapshot was fsynced and
   * the rename landed. A swallowed write error used to let dispatch continue.
   */
  async function flush() {
    if (!stateFile) return;
    saveError = null;
    persist();
    await saveChain;
    if (saveError) {
      const err = new Error(`cannot persist gate state to ${stateFile}: ${saveError.message}`);
      err.persistFailed = true;
      err.code = saveError.code;
      throw err;
    }
  }

  const INTENT_STATES = new Set(["confirmed", "sent", "unknown", "intended", "not_sent"]);
  function normalizeIntents(raw) {
    if (!Array.isArray(raw)) return undefined;
    return raw.filter((leg) => leg && typeof leg === "object").map((leg) => ({
      id: typeof leg.id === "string" && leg.id ? leg.id : null,
      kind: leg.kind === "author_payout" ? "author_payout" : "change",
      to: typeof leg.to === "string" ? leg.to : "",
      amountRaw: String(leg.amountRaw ?? "0"),
      state: INTENT_STATES.has(leg.state) ? leg.state : (leg.hash ? "sent" : "intended"),
      hash: typeof leg.hash === "string" && leg.hash ? leg.hash : null,
      retried: leg.retried === true,
    }));
  }
  const REFUND_STATES = new Set(["intended", "sent", "unknown", "queued"]);
  function normalizeRefund(raw) {
    if (!raw || typeof raw !== "object" || !/^\d+$/.test(String(raw.amountRaw ?? ""))) return undefined;
    return {
      amountRaw: String(raw.amountRaw),
      to: typeof raw.to === "string" ? raw.to : "",
      reason: REFUND_REASONS.has(raw.reason) ? raw.reason : "run_failed",
      state: REFUND_STATES.has(raw.state) ? raw.state : (raw.hash ? "unknown" : "intended"),
      hash: typeof raw.hash === "string" && raw.hash ? raw.hash : null,
    };
  }
  function mergeRefund(main, side) {
    if (!side) return main;
    if (!main) return side;
    const rank = (r) => (r.hash ? 3 : r.state === "queued" ? 2 : 1);
    return rank(side) > rank(main) ? side : main;
  }
  function intentRank(leg) {
    if (leg.state === "confirmed") return 5;
    if (leg.state === "sent") return 4;
    if (leg.state === "unknown") return 3;
    // Terminal: a stale `intended` copy must not revive a leg we know never left.
    if (leg.state === "not_sent") return 2;
    return 1;
  }
  function mergeIntents(main, side) {
    if (!side) return main;
    if (!main) return side;
    const out = [...main];
    for (const leg of side) {
      const i = out.findIndex((prev) =>
        (leg.id && prev.id === leg.id) ||
        (prev.kind === leg.kind && prev.amountRaw === leg.amountRaw && (prev.hash || leg.hash) && prev.hash === leg.hash) ||
        (prev.kind === leg.kind && prev.amountRaw === leg.amountRaw && !prev.hash && !leg.hash));
      if (i === -1) { out.push(leg); continue; }
      const prev = out[i];
      // A confirmed leg is never replaced by a weaker copy. A hash may fill in.
      if (intentRank(leg) > intentRank(prev)) out[i] = { ...prev, ...leg, hash: leg.hash || prev.hash, retried: prev.retried || leg.retried };
      else if (leg.hash && !prev.hash) out[i] = { ...prev, hash: leg.hash };
      else if (leg.retried && !prev.retried) out[i] = { ...prev, retried: true };
    }
    return out;
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
        q.settlementIntents = normalizeIntents(q.settlementIntents);
        q.refundIntent = normalizeRefund(q.refundIntent);
        // A finished run replays its cached outcome; without this, a retry
        // after restart would run (and settle) the same payment twice. A quote
        // whose result we just dropped has neither result nor error, so it is
        // NOT marked a replay here — it re-runs on retry (guarded by q.settled).
        if (q.status === "consumed" && (q.result || q.error)) q.running = Promise.resolve();
        quotes.set(q.id, q);
      }
      // A rollback to a build that does not know payout intents rewrites this
      // file and drops them. The sidecar is never opened by that build, so it
      // is the source of truth when the main file lost the intents. A confirmed
      // leg is never downgraded to a weaker copy.
      let side = null;
      try { side = JSON.parse(readFileSync(payoutSidecarPath(), "utf8")); }
      catch (e) { if (e.code !== "ENOENT") log(`cannot read payout sidecar ${payoutSidecarPath()}: ${e.message}`); }
      const sideIntents = side && side.intents && typeof side.intents === "object" ? side.intents : null;
      if (sideIntents) {
        for (const [id, legs] of Object.entries(sideIntents)) {
          const q = quotes.get(id);
          if (!q) continue;
          q.settlementIntents = mergeIntents(q.settlementIntents, normalizeIntents(legs));
        }
      }
      const sideRefunds = side && side.refunds && typeof side.refunds === "object" ? side.refunds : null;
      if (sideRefunds) {
        for (const [id, r] of Object.entries(sideRefunds)) {
          const q = quotes.get(id);
          if (q) q.refundIntent = mergeRefund(q.refundIntent, normalizeRefund(r));
        }
      }
      for (const q of quotes.values()) {
        if (!q.refundIntent || q.status === "refunded") continue;
        // A recorded refund owns this quote: it replays, never re-runs, and no
        // second refund starts (watcher or rerun) while reconcile finishes it.
        q.refunding = Promise.resolve(false);
        if (!q.running) {
          if (q.status === "paid") q.status = "consumed";
          if (q.status === "consumed") {
            if (!q.error) {
              q.error = q.errorPersist = `The run didn't complete, so ${rawToXno(q.refundIntent.amountRaw)} XNO is being refunded to ${q.refundIntent.to} — you won't be charged for a run that didn't finish.\n\nDetails: (error details not retained across restarts)`;
            }
            q.running = Promise.resolve();
          }
        }
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
        let onOk = s.event === "refund" && fields && fields.paymentId
          ? () => { const q = quotes.get(fields.paymentId); if (q) { q.status = "refunded"; persist(); } }
          : null;
        // A queued change or author payout is money still leaving. Reserve it
        // on the quote so a refund of the original deposit cannot land beside it.
        if ((s.event === "change" || s.event === "author_payout") && fields && fields.paymentId) {
          const q = quotes.get(fields.paymentId);
          if (q) {
            if (!Array.isArray(q.settlementIntents)) q.settlementIntents = [];
            const kind = s.event === "author_payout" ? "author_payout" : "change";
            let leg = q.settlementIntents.find((l) => l.kind === kind && l.amountRaw === String(s.amountRaw));
            if (!leg) {
              leg = {
                id: randomBytes(8).toString("hex"), kind, to: s.to,
                amountRaw: String(s.amountRaw), state: "sent", hash: null, retried: true,
              };
              q.settlementIntents.push(leg);
            } else if (leg.state !== "confirmed") {
              leg.state = "sent";
              leg.retried = true;
            }
            const bound = leg;
            const prev = onOk;
            onOk = (hash) => {
              bound.hash = hash;
              if (bound.state !== "confirmed") bound.state = "sent";
              persist();
              promoteIfConfirmed(bound);
              if (prev) prev();
            };
          }
        }
        owed.push({ ...s, fields, at: now() + OWED_BACKOFF_MS[0], onOk });
        // issue #23: q.refunding is a live-only Promise that persistence drops,
        // so after a restart a restored owed refund retries the send WHILE the
        // watcher re-scans the same payer block, sees `expired && !q.refunding`,
        // and starts a second refund(). Both can land — the payer is refunded
        // twice out of the operator's float. Re-arm the marker for any quote
        // this queue is already carrying a refund for.
        if (s.event === "refund" && s.fields && s.fields.paymentId) {
          const q = quotes.get(s.fields.paymentId);
          if (q) q.refunding = Promise.resolve(false); // "already in flight", resolved so nothing awaits forever
        }
      }
      if (quotes.size || owed.length) log(`restored ${quotes.size} quote(s) and ${owed.length} queued send(s) from ${stateFile}`);
    } catch (e) {
      if (e.code !== "ENOENT") log(`cannot read gate state ${stateFile}: ${e.message} — starting fresh`);
    }
  }

  /*
   * Settlement payouts (change back to the payer, author markup) are recorded
   * as intents BEFORE the send is dispatched:
   *   intended  — amount + recipient durable, send not dispatched (or the
   *               dispatch never returned a hash)
   *   sent      — dispatch returned a block hash; chain confirmation unknown
   *   confirmed — account_history or block_info shows that send
   *   unknown   — a publish was attempted (block signed, hash persisted) but
   *               its outcome is uncertain: an error or timeout after the
   *               hash, or a chain read that could not resolve it
   *   not_sent  — terminal: definitely never signed or published. The intent
   *               write failed before dispatch, or dispatch failed before the
   *               wallet signed a block. Reserves nothing; never dispatched.
   * Confirmed, pending, and unknown legs are reserved against a refund. A
   * hashless `intended` leg is dispatched once only after a successful chain
   * read fails to find ITS block. An RPC error leaves it unresolved: reserved,
   * and not sent again. Matching is by block hash — the unique link persisted
   * before publish — never by recipient and amount.
   */
  let reconcileDone = Promise.resolve();
  const recoveryId = randomBytes(8).toString("hex");
  let recoveryLockPath = null;
  const RECOVERY_LEASE_MS = 60_000;

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
  function lockHeldByOther(cur) {
    if (!cur || cur.owner === recoveryId) return false;
    if (cur.pid !== process.pid && !pidAlive(cur.pid)) return false;
    if (!(cur.expiresAt > Date.now())) return false;
    return true;
  }
  async function acquireRecoveryLock() {
    if (!stateFile) return true;
    const lockPath = stateFile + ".lock";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lockPath, "wx");
        try {
          await fh.writeFile(JSON.stringify({ owner: recoveryId, pid: process.pid, expiresAt: Date.now() + RECOVERY_LEASE_MS }));
          await fh.sync();
        } finally {
          await fh.close();
        }
        recoveryLockPath = lockPath;
        return true;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let cur = null;
        let fresh = true;
        try { cur = JSON.parse(readFileSync(lockPath, "utf8")); } catch { cur = null; }
        try { fresh = Date.now() - statSync(lockPath).mtimeMs < RECOVERY_LEASE_MS; } catch { fresh = true; }
        // An empty lock is the other recovery still writing it. Do not steal it.
        if (cur ? lockHeldByOther(cur) : fresh) return false;
        try { await unlink(lockPath); }
        catch (u) {
          if (u.code === "ENOENT") continue;
          // Not writable (or otherwise not stealable). Fail the snapshot now
          // instead of spinning until the lock timeout.
          throw u;
        }
      }
    }
    return false;
  }
  async function releaseRecoveryLock() {
    if (!recoveryLockPath) return;
    const path = recoveryLockPath;
    recoveryLockPath = null;
    try {
      const cur = JSON.parse(readFileSync(path, "utf8"));
      if (!cur || cur.owner !== recoveryId) return;
    } catch { return; }
    await unlink(path).catch(() => {});
  }

  function legDescribe(leg) {
    return leg.kind === "author_payout" ? "author payout:" : "change:";
  }
  function legEvent(leg) {
    return leg.kind === "author_payout" ? "author_payout" : "change";
  }
  function historyMatches(entry, leg) {
    if (!entry || entry.type !== "send") return false;
    const dest = entry.account || entry.link_as_account;
    if (dest !== leg.to) return false;
    try { return BigInt(entry.amount) === BigInt(leg.amountRaw); }
    catch { return false; }
  }
  function blockMatchesLeg(info, leg) {
    if (!info || typeof info !== "object") return false;
    const subtype = info.subtype || (info.contents && info.contents.subtype);
    const dest = (info.contents && info.contents.link_as_account) || info.link_as_account || null;
    if (subtype !== "send" && !dest) return false;
    if (subtype && subtype !== "send") return false;
    if (dest && dest !== leg.to) return false;
    if (info.amount != null) {
      try { if (BigInt(info.amount) !== BigInt(leg.amountRaw)) return false; }
      catch { return false; }
    }
    return true;
  }
  function confirmationOf(info) {
    if (!info) return "absent";
    const c = info.confirmed;
    if (c === false || c === "false") return "pending";
    if (c === true || c === "true") return "confirmed";
    return "unknown";
  }
  function explicitlyConfirmed(v) {
    return v === true || v === "true";
  }
  function historyUncertain(message) {
    const err = new Error(message);
    err.uncertain = true;
    return err;
  }
  async function loadHistory() {
    const entries = [];
    let head = null;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      let h;
      try {
        h = await ops.rpc({
          action: "account_history", account: address,
          count: String(HISTORY_PAGE), ...(head ? { head } : {}),
        });
      } catch (e) {
        log(`settlement history lookup failed: ${e.message}`);
        throw historyUncertain(`settlement history lookup failed: ${e.message}`);
      }
      if (!h || h.error) {
        const message = `settlement history lookup failed: ${(h && h.error) || "empty response"}`;
        log(message);
        throw historyUncertain(message);
      }
      const batch = Array.isArray(h.history) ? h.history : [];
      entries.push(...batch.filter(Boolean));
      if (!batch.length) break;
      const prev = typeof h.previous === "string" ? h.previous : null;
      if (!prev || prev === head) break;
      head = prev;
    }
    return entries;
  }
  /** block_info for THIS hash only. Errors are unknown, never "not on chain". */
  async function lookupBlock(hash, leg) {
    let info;
    try {
      info = await ops.rpc({ action: "block_info", json_block: "true", hash });
    } catch (e) {
      log(`settlement block lookup failed: ${e.message}`);
      return "unknown";
    }
    if (!info) return "unknown";
    if (info.error) {
      if (/not found/i.test(String(info.error))) return "absent";
      log(`settlement block lookup failed: ${info.error}`);
      return "unknown";
    }
    const conf = confirmationOf(info);
    if (conf === "pending") return "pending";
    if (conf === "confirmed" && blockMatchesLeg(info, leg)) return "confirmed";
    if (conf === "confirmed") return "absent"; // a different block is not this intent
    return "unknown"; // no explicit confirmation
  }
  /**
   * `confirmed` only for this intent's block hash with an explicit confirmation.
   * A history row that merely shares the recipient and amount is not a match.
   * An RPC failure is `unknown` — never an empty history that would resend.
   */
  async function chainStatus(leg) {
    if (leg.hash) {
      const block = await lookupBlock(leg.hash, leg);
      if (block === "confirmed" || block === "pending") return block;
      let history;
      try { history = await loadHistory(); }
      catch (e) { if (e.uncertain) return "unknown"; throw e; }
      const entry = history.find((e) => e && e.hash === leg.hash);
      if (entry && historyMatches(entry, leg)) {
        if (explicitlyConfirmed(entry.confirmed)) return "confirmed";
        if (entry.confirmed === false || entry.confirmed === "false") return "pending";
        return "unknown"; // present, but not explicitly confirmed
      }
      if (block === "unknown") return "unknown";
      // This node does not have our hash. That is not proof it was never sent.
      return "unknown";
    }
    try { await loadHistory(); }
    catch (e) { if (e.uncertain) return "unknown"; throw e; }
    // No hash of our own: nothing in the history can be tied to this intent.
    return "absent";
  }
  async function promoteIfConfirmed(leg) {
    if (!leg.hash || leg.state === "confirmed") return false;
    const st = await chainStatus(leg);
    if (st !== "confirmed") return false;
    leg.state = "confirmed";
    leg.chainAbsent = false;
    persist();
    return true;
  }
  /**
   * Publish one payout. The intent is already on disk. A returned hash moves
   * the leg to `sent`; a chain hit moves it to `confirmed`. A throw on the
   * live path joins the owed queue (existing bounce retry) and sets `retried`
   * so a restart does not publish a second copy. A restart retry does not
   * join that queue — it is the one shot.
   */
  async function dispatchLeg(q, toolName, leg, { fromRestart = false, costUsd = null } = {}) {
    if (!leg || leg.state !== "intended" || leg.inflight) return;
    if (fromRestart && leg.retried) return;
    leg.inflight = true;
    const describe = legDescribe(leg);
    const event = legEvent(leg);
    try {
      if (fromRestart) {
        // One restart attempt. Durable before publish so a crash mid-send
        // cannot queue a second copy.
        leg.retried = true;
        await flush();
      }
      // The wallet announces the block hash before it publishes. That hash is
      // the unique link: persist it, then let process run. A failed snapshot
      // throws here and process never starts.
      const hash = await ops.transfer(leg.to, leg.amountRaw, describe, async (preHash) => {
        leg.hash = preHash;
        leg.state = "sent";
        leg.retried = true;
        leg.chainAbsent = false;
        await flush();
      });
      if (!leg.hash) leg.hash = hash;
      if (leg.state !== "confirmed") leg.state = "sent";
      leg.chainAbsent = false;
      persist();
      const fields = {
        paymentId: q.id, tool: toolName, ok: true, to: leg.to,
        amountRaw: String(leg.amountRaw), hash: leg.hash,
      };
      if (event === "author_payout") fields.costUsd = costUsd;
      if (fromRestart) fields.retries = 1;
      usage(event, fields);
      await promoteIfConfirmed(leg);
    } catch (e) {
      log(`${describe} for ${q.id} (→ ${leg.to}) failed: ${e.message}`);
      if (e.persistFailed) {
        // The snapshot did not land, so publish did not run (the wallet calls
        // onSigned before `process`). The leg definitely never went out:
        // mark it `not_sent` so a refund does not hold its amount back, and
        // do not queue another send.
        if (leg.state !== "confirmed") {
          leg.hash = null;
          leg.retried = false;
          markNotSent(leg);
        }
        persist();
        throw e;
      }
      // A hash means publish was attempted. Its on-chain outcome is uncertain:
      // keep it reserved (`unknown`), do not send a second block, and do not
      // owe() a different one.
      if (leg.hash) {
        if (leg.state !== "confirmed") leg.state = "unknown";
        persist();
        return;
      }
      // No hash: the wallet failed before signing (balance, work, frontier),
      // so no block was published. The restart path has no retry queue — this
      // was its one shot — so the leg definitely never went out.
      if (fromRestart) {
        markNotSent(leg);
        persist();
        return;
      }
      // Live path, no hash: the owed queue retries this exact send, so the leg
      // stays `intended` (retried) and reserved until that send lands.
      leg.retried = true;
      owe(leg.to, leg.amountRaw, describe, event, { paymentId: q.id, tool: toolName }, (okHash) => {
        leg.hash = okHash;
        if (leg.state !== "confirmed") leg.state = "sent";
        persist();
        promoteIfConfirmed(leg);
      });
    } finally {
      leg.inflight = false;
    }
  }
  /**
   * Finish a refund whose intent was durable before a restart. A signed block
   * (hash on disk) is matched to the chain and never re-sent; only a hashless
   * intent — never signed, so never published — is sent, once.
   */
  async function reconcileRefund(q) {
    const ri = q.refundIntent;
    if (ri.hash) {
      const st = await chainStatus({ to: ri.to, amountRaw: ri.amountRaw, hash: ri.hash });
      if (st === "confirmed") {
        ri.state = "sent";
        q.status = "refunded";
      } else {
        ri.state = st === "pending" ? "sent" : "unknown";
      }
      persist();
      return;
    }
    if (owed.some((o) => o.event === "refund" && o.fields && o.fields.paymentId === q.id)) return;
    const run = sendRefund(q, { fromRestart: true });
    q.refunding = run;
    await run;
  }
  async function reconcileIntents() {
    let locked = false;
    try {
      const rows = [];
      for (const q of quotes.values()) {
        if (!Array.isArray(q.settlementIntents)) continue;
        for (const leg of q.settlementIntents) rows.push({ q, leg });
      }
      const refundRows = [...quotes.values()].filter((q) => q.refundIntent && q.status !== "refunded" && q.refundIntent.state !== "queued");
      if (!refundRows.length && !rows.some(({ leg }) => leg && leg.state !== "confirmed" && leg.state !== "not_sent")) return;
      // Two processes restoring the same file must not both publish the change.
      // The loser returns without dispatching and without writing state.
      if (stateFile) {
        locked = await acquireRecoveryLock();
        if (!locked) return;
      }
      for (const { q, leg } of rows) {
        // `not_sent` is terminal: never signed, never dispatched, nothing to match.
        if (!leg || leg.state === "confirmed" || (leg.state === "not_sent" && !leg.hash)) continue;
        try {
          const st = await chainStatus(leg);
          if (st === "confirmed") {
            leg.state = "confirmed";
            leg.chainAbsent = false;
            persist();
            continue;
          }
          // Pending, or the lookup itself failed: unresolved. Never republish.
          if (st === "pending" || st === "unknown") {
            if (leg.state !== "confirmed") leg.state = st === "pending" ? "sent" : "unknown";
            leg.chainAbsent = false;
            persist();
            continue;
          }
          // A successful read that did not bind THIS block. A hash, a send we
          // already dispatched, or an unresolved leg is not proof of absence.
          if (leg.hash || leg.state === "sent" || leg.state === "unknown") {
            if (leg.state === "intended") leg.state = "unknown";
            persist();
            continue;
          }
          if (leg.state !== "intended" || leg.retried) {
            // Retried, hashless, and a successful read shows no block of ours.
            // The publish never landed, so the amount is refundable again.
            if (leg.state === "intended" && leg.retried && !leg.hash) leg.chainAbsent = true;
            persist();
            continue;
          }
          // A recorded refund already returned this leg's amount. Never pay it too.
          if (q.refundIntent) {
            markNotSent(leg);
            persist();
            continue;
          }
          await dispatchLeg(q, q.tool, leg, { fromRestart: true });
        } catch (e) {
          log(`settlement reconcile for ${q.id} failed: ${e.message}`);
        }
      }
      for (const q of refundRows) {
        try { await reconcileRefund(q); }
        catch (e) { log(`refund reconcile for ${q.id} failed: ${e.message}`); }
      }
      if (stateFile && !saveError) await flush();
    } catch (e) {
      log(`settlement reconcile failed: ${e.message}`);
    } finally {
      if (locked) await releaseRecoveryLock();
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
  // Someone is waiting on money to ARRIVE — poll fast, a caller is blocked on it.
  const anyPaymentWatchable = () => {
    const t = now();
    return [...quotes.values()].some((q) =>
      q.status === "pending" || (q.status === "expired" && t - q.expiresAt < LATE_WATCH_MS));
  };
  // Keep ticking for the owed queue too, but that is money going OUT on its own
  // backoff (OWED_BACKOFF_MS) — it must never pull the receivable poll up to
  // payment speed. A queued refund used to make anyWatchable() true forever,
  // which pinned scan() at one `receivable` call every 5s for as long as the
  // refund kept failing — and since a refund typically fails because the RPC is
  // throttling, that poll fed the very rate limit that was blocking it. One
  // failed refund held the loop for 34h and 5,158 calls on 2026-07-23/25.
  const anyWatchable = () => owed.length > 0 || anyPaymentWatchable();

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
    // Only the owed queue left → retryOwed above is the whole job. Skip the
    // receivable/history reads: nobody is waiting for an incoming payment, so
    // asking the node about one is pure load on an endpoint that is usually
    // already throttling us (that is why the refund is queued at all).
    if (!anyPaymentWatchable()) return;
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
    if (anyPaymentWatchable()) await scanHistory();
  }

  /*
   * Consecutive-failure backoff for the scan itself. retryOwed() has had a
   * backoff since day one; the receivable poll beside it had none, so a node
   * answering 429 was re-asked at the full poll rate indefinitely. Doubling from
   * the base interval keeps a genuinely pending payment responsive (a transient
   * blip costs one or two slow ticks); the 60s ceiling means a sustained outage
   * settles to 60 receivable calls/hour instead of 720 (ws up, 5s base: 10, 20,
   * 40, 60…; ws down, 1s base: 2, 4, 8, 16, 32, 60…).
   */
  const SCAN_BACKOFF_CAP_MS = 60 * 1000; // a quote only lives ~15min — never go quiet longer than this
  let scanFails = 0;
  let scanning = false;

  function tick() {
    // tick() nulls `timer` and then awaits, so for the whole duration of a scan
    // every ensureWatching() call sees no timer and starts ANOTHER scan on top
    // of it. That is what let concurrent retryOwed() passes double-send (see the
    // o.sending guard). Belt and braces: never run two scans at once — the one
    // in flight schedules the next tick when it finishes.
    if (scanning) return;
    scanning = true;
    timer = null;
    scan().then(
      () => { scanFails = 0; },
      (e) => {
        scanFails++;
        // Log the first few, then only every 12th — a stuck endpoint used to
        // write one line per poll (5,158 in 34h), burying everything else.
        if (scanFails <= 3 || scanFails % 12 === 0) {
          log(`payment scan failed (${e.message}) — will retry` +
            (scanFails > 3 ? ` (${scanFails} consecutive failures)` : ""));
        }
      },
    ).then(() => {
      scanning = false;
      if (!anyWatchable()) return;
      // With a live websocket the poll is only a safety net — relax it.
      let delay = wsConnected ? Math.max(pollMs, 5000) : pollMs;
      // Only back off the tick when a scan actually failed. Owed-only ticks keep
      // the base cadence on purpose: with the RPC skipped above they are a local
      // array check costing nothing, so there is no reason to slow the retry.
      if (scanFails > 0) delay = Math.min(delay * 2 ** Math.min(scanFails, 10), SCAN_BACKOFF_CAP_MS);
      timer = setTimeout(tick, delay);
      if (timer.unref) timer.unref();
    });
  }

  function ensureWatching() {
    connectWs();
    if (!timer) tick();
  }

  /*
   * A backed-off timer must not delay a caller who just arrived: their quote has
   * its own 15-minute life and did not cause the earlier failures. Only the
   * quote-creation path may do this. Doing it in ensureWatching() instead looks
   * equivalent and is not: waitForPayment() calls ensureWatching() on every
   * iteration, and each open /x402/watch stream re-enters it on a 25s ceiling
   * for the life of the quote (src/http.mjs). That would zero the backoff every
   * 25s per watcher — continuously, and precisely while the RPC is struggling.
   */
  function watchNow() {
    scanFails = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    ensureWatching();
  }

  let ws = null;
  let wsEverFailed = false;
  function connectWs() {
    if (!wsUrl || ws) return;
    if (typeof WebSocket === "undefined") {
      if (!wsEverFailed) { wsEverFailed = true; log("--nano-ws ignored: no global WebSocket (needs Node ≥ 21)"); }
      return;
    }
    const wsSafe = redactUrl(wsUrl); // ws URLs carry an api_key — never log it raw
    try { ws = new WebSocket(wsUrl); } catch (e) { log(`websocket ${wsSafe} failed to open: ${e.message}`); return; }
    ws.onopen = () => {
      wsConnected = true;
      log(`websocket connected: ${wsSafe} — payment detection is push-based`);
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
      if (wsConnected) log(`websocket ${wsSafe} disconnected — falling back to polling`);
      wsConnected = false;
      ws = null;
      // reconnect lazily next time something needs watching
      if (anyPending()) setTimeout(connectWs, 10_000).unref?.();
    };
  }

  /* ---------------- MCP-facing results ---------------- */

  const payUrl = (q) => `${publicBase}/pay/${q.id}`;
  const nanoUri = (q) => `nano:${address}?amount=${q.amountRaw}`;

  const watchUrl = (q) => `${publicBase}/x402/watch/${q.id}`;

  function paymentRequiredResult(q) {
    // Three sequential phases — never parallel:
    //   1) this tools/call HANGS UP with pay instructions (payUrl for the human)
    //   2) agent opens watchUrl SSE (agent-only) until it closes with paid
    //   3) agent opens tools/call + _payment_id = the RESULTS stream only
    // watchUrl rides in structuredContent for the agent; the human-facing text
    // never mentions it (agents used to relay it next to payUrl — don't).
    const pUrl = payUrl(q);
    const wUrl = watchUrl(q);
    const x402 = {
      paymentId: q.id,
      payUrl: pUrl,
      // Agent-only payment-monitor SSE. Open it the moment you have this quote —
      // never show this URL to the user (they get payUrl only).
      watchUrl: wUrl,
      // Sequential phases. blocking:false — do NOT open the results tools/call while
      // payment is still pending; that used to hold one SSE through pay+run and race
      // the watch stream in parallel.
      blocking: false,
      phases: ["pay", "watch", "results"],
      // Lead with the watch imperative: agents that only skim `next` must still
      // open the monitor SSE as soon as they have the payment link.
      next: `On this payment link: show the user ONLY ${pUrl}, and IMMEDIATELY open the payment-monitor SSE yourself: GET ${wUrl} (Accept: text/event-stream). Never show the watch URL to the user. Wait until that stream CLOSES with status "paid" (done:true + next). ONLY THEN call this SAME tool with identical arguments plus "_payment_id": "${q.id}" — that is the RESULTS stream. Do not open results while the watch is still open. Paying is the consent; do not wait for a human "go".`,
      uri: nanoUri(q),
      address,
      amountRaw: q.amountRaw,
      amountXno: rawToXno(q.amountRaw),
      amountUsd: q.usd,
      expiresAt: new Date(q.expiresAt).toISOString(),
    };
    // Agents relay this text to humans — keep the payUrl line user-safe. The
    // agent-only watch URL is stated with an explicit "do not show the user"
    // so the agent has a concrete URL to open without mistaking it for the link
    // to hand over.
    const expMin = Math.max(1, Math.round((q.expiresAt - now()) / 60_000));
    const text =
      `PAYMENT REQUIRED — this tool takes a ${fmtUsd(q.usd)} deposit (exactly ${rawToXno(q.amountRaw)} XNO), paid in Nano. No account needed. ` +
      `The actual price is the run's metered model cost + 20%; everything above that comes back to the paying wallet as change after the run.\n\n` +
      `This call is done — hang up. On this payment link, do BOTH of these now:\n` +
      `1. Show your user ONLY this payment link (QR to scan; green check when paid). Do not show them any other URL or the wallet address:\n` +
      `   ${pUrl}\n` +
      `2. YOU IMMEDIATELY open and watch this payment-monitor SSE (agent-only — NEVER show this URL to the user):\n` +
      `   ${wUrl}\n` +
      `   Wait until that stream CLOSES with status "paid" (done:true + next).\n` +
      `3. ONLY AFTER the watch stream closes paid: call this tool again with the SAME arguments plus "_payment_id": "${q.id}". That call is the RESULTS stream` +
      (q.etaMs ? ` (typically ~${fmtDur(q.etaMs)})` : "") + ` — it runs and returns the result. Do not open the results call while still watching for payment.\n\n` +
      `Manual-pay fallback (only if the user can't use the link): send exactly ${rawToXno(q.amountRaw)} XNO (${q.amountRaw} raw) to ${address} — ` +
      `the exact amount is how the payment is recognized (URI: ${nanoUri(q)}).\n` +
      `This quote expires in about ${expMin} minute${expMin === 1 ? "" : "s"} (${x402.expiresAt}). ` +
      `If the run fails after payment, the payment is refunded automatically.`;
    return { content: [{ type: "text", text }], structuredContent: { x402 } };
  }

  const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

  /* ---------------- public surface ---------------- */

  /**
   * Terminal-state instructions for an agent watching this quote settle
   * (/x402/watch SSE or /x402/status poll). Pending quotes have no `next` —
   * the stream is still open. Once settled, the watch SSE closes with these
   * instructions so the agent knows how to open the result stream (tools/call
   * with _payment_id) rather than sitting on a bare "paid" with no next step.
   */
  function nextFor(q) {
    if (!q || q.status === "pending") return undefined;
    if (q.status === "paid" || q.status === "consumed") {
      return `Payment received — this watch stream is done; hang it up. ` +
        `NOW open the RESULTS stream: call the SAME tool with identical arguments plus "_payment_id": "${q.id}". ` +
        `That tools/call runs the workflow (progress heartbeats on a streaming transport) and returns the result. ` +
        `Do not open a results tools/call before the watch closes, and do not keep this watch open in parallel with the results call.`;
    }
    if (q.status === "expired") {
      return `Quote expired unpaid — call the tool again without _payment_id for a fresh quote.`;
    }
    if (q.status === "refunded") {
      return `Payment was refunded${q.source ? ` to ${q.source}` : ""} — call the tool again without _payment_id to retry.`;
    }
    return undefined;
  }

  const gate = {
    address,

    /** Quote/pay state for the HTTP pay page + status/watch endpoints. */
    quote(id) {
      const q = quotes.get(String(id));
      if (!q) return null;
      prune();
      const out = {
        id: q.id, tool: q.tool, status: q.status, usd: q.usd,
        amountRaw: q.amountRaw, amountXno: rawToXno(q.amountRaw),
        address, uri: nanoUri(q), expiresAt: new Date(q.expiresAt).toISOString(),
      };
      // Terminal states close the watch SSE — package the next-step so an agent
      // (or any event-loop subscriber) does not sit on a bare "paid" with no path
      // to the result stream.
      if (q.status !== "pending") {
        out.done = true;
        const next = nextFor(q);
        if (next) out.next = next;
      }
      return out;
    },

    /**
     * Resolve when the quote leaves `pending` (paid/expired), or after ms. Returns the status.
     *
     * This timer is deliberately NOT unref'd, and that is the opposite of the
     * background poll timer in tick(). The two are different jobs:
     *
     *   - tick()'s timer is an UNBOUNDED background poll. It must be unref'd, or
     *     an idle stdio server could never exit.
     *   - this timer is a BOUNDED wait that a caller is awaiting right now. It is
     *     the only thing that guarantees the returned promise settles.
     *
     * Unref'ing this one made the promise's liveness depend on unrelated handles
     * elsewhere in the process. With nothing else ref'd, node drained the event
     * loop while a tools/call sat inside `await waitForPayment(...)`: the timeout
     * never fired, the poll that would have seen the payment never ran, and the
     * call never returned an answer of any kind. The whole of tests/serve-gate
     * died this way on node 20 ("Promise resolution is still pending but the
     * event loop has already resolved").
     *
     * Holding a ref for the wait is correct, not a leak: `ms` is bounded (waitMs,
     * default 20s), the wait only exists while a call is genuinely in flight, and
     * a payment arriving early clears the timer through the waiter below.
     */
    waitForPayment(id, ms) {
      const q = quotes.get(String(id));
      if (!q) return Promise.resolve("unknown");
      if (q.status !== "pending") return Promise.resolve(q.status);
      ensureWatching();
      return new Promise((res) => {
        const t = setTimeout(() => res(q.status), ms);
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
        // No pin, no catalog forecast, no observed cost → this tool quotes the
        // flat opening deposit, which is a guess, not a price. That is how three
        // calls on 2026-07-23 took a $0.05 deposit against real costs up to
        // $0.2455. Say it out loud rather than discovering it in the ledger.
        const est = registry.estimates && registry.estimates[t.name];
        if (!pinned.get(t.name) && !est && !(rec && Number.isFinite(rec.usd))) {
          log(`warning: ${t.name} has no cost forecast (its models are not in the public catalog) and has never run — ` +
            `it quotes the flat ${fmtUsd(usd)} opening deposit and you eat any overage; pin a price with x402.usd in its graph file`);
        } else if (est && est.unpriced > 0) {
          log(`note: ${t.name} forecast covers ${est.priced} of ${est.priced + est.unpriced} priced node(s) — ` +
            `${fmtUsd(dep)} deposit is a lower bound; pin x402.usd if runs exceed it`);
        }
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
       * operator eats the rest; take and change are then zero.
       *
       * Each payout is an intent (amount, recipient, state) flushed to the
       * state file BEFORE `ops.transfer`. The caller's result waits until that
       * publish has been recorded as `sent` (hash in hand) or `confirmed`
       * (chain lookup), so a restart cannot treat a send that never left as
       * already returned. A block that is still unconfirmed stays `sent` and
       * is reserved against a refund. If the intent write fails, nothing is sent
       * and every leg is marked `not_sent`, so the refund that follows returns
       * the full held amount instead of reserving payouts that never left.
       *
       * `alreadySettled`, or a quote that already has intents, recomputes the
       * receipt numbers and does not dispatch. The restart reconcile owns any
       * intent that never got a hash. Paying here as well would send twice.
       */
      async function settle(q, name, costUsd, alreadySettled = false) {
        const author = authors.get(name);
        const deposit = BigInt(q.amountRaw);
        const known = Number.isFinite(costUsd);
        const costRaw0 = known ? usdToRaw(costUsd, q.pair, "ceil") : 0n;
        const costRaw = costRaw0 > deposit ? deposit : costRaw0;
        const remaining = deposit - costRaw;
        const markup = costRaw0 / 5n;
        const take = markup < remaining ? markup : remaining;
        const change = remaining - take;
        const numbers = { known, costRaw, take, change, author: !!author };

        // Recompute-only: the first run already recorded the payout intents.
        if (alreadySettled || Array.isArray(q.settlementIntents)) return numbers;

        if (costRaw0 > deposit) {
          log(`call ${q.id} (${name}) cost $${costUsd} — more than its ${rawToXno(deposit)} XNO deposit; keeping the deposit, no payouts`);
        }
        const legs = [];
        if (author && take > 0n) {
          legs.push({ id: randomBytes(8).toString("hex"), kind: "author_payout", to: author, amountRaw: take.toString(), state: "intended", hash: null, retried: false });
        }
        if (change > 0n) {
          if (q.source) {
            legs.push({ id: randomBytes(8).toString("hex"), kind: "change", to: q.source, amountRaw: change.toString(), state: "intended", hash: null, retried: false });
          } else {
            log(`cannot return ${rawToXno(change)} XNO change for ${q.id}: payer account unknown`);
            usage("change", { paymentId: q.id, tool: name, ok: false, amountRaw: change.toString(), error: "payer account unknown" });
          }
        }
        // Durable before any publish. `settled` stays false until the sends
        // below have been recorded, so a crash here retries an intended leg
        // once instead of treating the receipt as money already returned.
        q.settlementIntents = legs;
        try {
          await flush();
        } catch (e) {
          // The intents never became durable, so nothing was dispatched. Every
          // leg definitely never went out: a refund must not hold them back.
          for (const leg of legs) markNotSent(leg);
          persist(); // best effort; the refund that follows persists again
          throw e;
        }
        for (let i = 0; i < legs.length; i++) {
          try {
            await dispatchLeg(q, name, legs[i], { costUsd: known ? costUsd : null });
          } catch (e) {
            // dispatchLeg already marked the failing leg. The legs after it
            // were never attempted, so they never went out either.
            for (const leg of legs.slice(i + 1)) if (leg.state === "intended" && !leg.inflight) markNotSent(leg);
            persist();
            throw e;
          }
        }
        q.settleReceipt = {
          known, costUsd: known ? costUsd : null,
          take: take.toString(), change: change.toString(), author: !!author,
        };
        q.settled = true;
        await flush();
        return numbers;
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
                    "Phase 3 only: after /x402/watch closes with status paid, call again with the " +
                    "same arguments plus this id to open the RESULTS stream. Do not pass it while " +
                    "payment is still pending — monitor the watch SSE first.",
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
          // validate is registry.prepareCall, whose unknown-tool text always appends
          // run_noodle. That tool is hidden from tools/list and refused above, so
          // name only what this paid server will actually run.
          const offered = listTools();
          if (!offered.some((t) => t.name === name)) {
            throw new ParamsError(`unknown tool "${name}" — available: ${offered.map((t) => t.name).join(", ")}`);
          }
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
          watchNow();
          usage("quote", { paymentId: q.id, tool: name, usd: q.usd, amountRaw: q.amountRaw, xnoUsd: rateDisplay(pair), rateSource: rateSource() });
          // Phase 1: this tools/call always HANGS UP with the payment-required
          // quote as its RESULT — every MCP client surfaces a result, so the pay
          // link is always seen. (An earlier build held streaming calls open and
          // pushed the link as progress; clients that don't render progress
          // showed nothing and hung — observed live on talking-avatar.)
          // Phase 2 is /x402/watch; phase 3 is tools/call + _payment_id (results).
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

        // Prefer announce (immediate progress event) over report (next heartbeat).
        const note = (s) => {
          if (ctx && typeof ctx.announce === "function") ctx.announce(s);
          else if (ctx && typeof ctx.report === "function") ctx.report(s);
        };

        if (q.status === "pending") {
          // Phase 3 is the RESULTS stream — it must not also be the payment
          // monitor. A short waitMs covers the race where payment lands as the
          // agent switches from watch → results; it never holds through the
          // quote TTL (that used to race a parallel watch SSE and look like a
          // silent load). Agents still pending should be on /x402/watch.
          note(`checking payment ${q.id}`);
          const st = await gate.waitForPayment(q.id, waitMs);
          if (st === "pending") {
            return errResult(
              `payment ${q.id} hasn't arrived yet — this tools/call is the RESULTS stream, not the payment monitor. ` +
              `Hang it up. Open the agent-only watch SSE ${watchUrl(q)} (never show that URL to the user), ` +
              `wait until it closes with status "paid", THEN call again with the same _payment_id. ` +
              `Do not hold a tools/call open while waiting for payment.`
            );
          }
          if (st === "expired") {
            return errResult(`payment ${q.id} expired unpaid — call again without _payment_id for a fresh quote.`);
          }
        }
        note(`payment received — running ${name}` + (q.etaMs ? ` (typically ~${fmtDur(q.etaMs)})` : ""));
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
              // quote that was demoted to "paid" across a restart — its payout
              // intents were recorded on the first run, so settle() recomputes
              // the numbers without paying change/author twice.
              const s = await settle(q, name, costUsd, q.settled === true);
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
              // Settled cost uses the cost line's precision (formatCostUsd), not the
              // deposit's cent rounding — $0.0656 must not print as $0.07. Change is
              // the exact raw remainder (30 decimals); the 8-decimal grain is only
              // how wallets display a quote, and it clips a sub-grain refund.
              const receipt = `paid ${rawToXno(q.amountRaw)} XNO deposit` +
                (q.payHash ? ` (block ${q.payHash})` : "") +
                (r.known
                  ? ` — settled at actual cost $${formatCostUsd(r.costUsd)} + 20%` +
                    (r.author && rTake > 0n ? " (markup goes to this noodle's author)" : "") +
                    (rChange > 0n ? `; ${rawToXno(rChange, 30)} XNO change returned to your wallet` : "")
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
              // Lead with the outcome that matters to the payer — not charged,
              // money coming back, safe to retry — then the technical detail.
              // A throttled-RPC failure (all nodes 429) lands here too, so the
              // caller should read "try again," never "payment failed."
              // A settled quote has already returned change (and maybe an author
              // payout). The refund is only what is still held, not the original
              // deposit — saying the whole payment came back would be a lie, and
              // sending it would pay the change twice.
              const owed = q.refundAmountRaw != null ? BigInt(q.refundAmountRaw) : BigInt(q.amountRaw);
              const deposit = BigInt(q.amountRaw);
              const payer = !q.source
                ? `The run didn't complete. The payment was received but the refund account is unknown — contact the operator to be made whole.`
                : q.refundHeldAt && !refunded
                  ? `The run didn't complete. ${rawToXno(owed.toString())} XNO is held in the server's wallet for your refund to ${q.source} — the server could not record the refund safely, so it has not been sent yet; it goes out once it can be recorded. You won't be charged for a run that didn't finish.`
                : owed === deposit
                  ? (refunded
                    ? `The run didn't complete, so your payment of ${rawToXno(q.amountRaw)} XNO was refunded to ${q.source} — you were not charged. You can try again in a moment.`
                    : `The run didn't complete, so your ${rawToXno(q.amountRaw)} XNO deposit is being refunded to ${q.source} automatically (the first send bounced; the server retries until it lands) — you won't be charged for a run that didn't finish. You can try again shortly.`)
                  : owed === 0n
                    ? `The run didn't complete. Your deposit was already settled and the change was returned, so nothing further is held — you were not charged again.`
                    : (refunded
                      ? `The run didn't complete. ${rawToXno(owed.toString())} XNO still held after settlement was refunded to ${q.source} — change already returned was not paid again. You can try again in a moment.`
                      : `The run didn't complete. ${rawToXno(owed.toString())} XNO still held after settlement is being refunded to ${q.source} automatically (the first send bounced; the server retries until it lands) — change already returned is not paid again.`);
              q.error = `${payer}\n\nDetails: ${msg}`;
              q.errorPersist = `${payer}\n\nDetails: (error details not retained across restarts)`;
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
  // Match uncertain payouts to the chain before any refund or watcher tick
  // subtracts them from what is still held. refund() awaits this promise.
  reconcileDone = reconcileIntents();
  gate.reconciled = reconcileDone;
  // Restored pending quotes / owed sends need the watcher running from boot,
  // not from the next quote — a payment may land while nobody is calling.
  if (anyWatchable()) ensureWatching();
  return gate;
}
