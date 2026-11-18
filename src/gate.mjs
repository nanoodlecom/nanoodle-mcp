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
import { randomBytes, randomInt, createHash } from "node:crypto";
import { readFileSync, constants } from "node:fs";
import { open, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { checkAddress } from "nanocurrency";
import { rawToXno, authorAddress } from "./wallet.mjs";
import { knownUsd, parseUsdNano } from "./usd.mjs";
import { fmtDur, formatCostUsd, ParamsError } from "./tools.mjs";
import { redactUrl } from "./redact.mjs";
import { runFundingBudget } from "./run-funding.mjs";
import { nanoFundingCoverage, nanoFundingLiabilities, nanoQuoteClaim } from "./funding-liabilities.mjs";
import { syncPrivateStateParentSync } from "./private-state.mjs";
import { isNanoHistoryHash, isNanoHistoryHeight, NANO_LATE_WATCH_MS, NANO_PAYMENT_GRAIN as GRAIN,
  NANO_RECEIVABLE_COUNT as RECEIVABLE_COUNT, NANO_HISTORY_PAGE as HISTORY_PAGE,
  checkedAnchoredNanoHistory, nanoHistoryKind, nanoQuoteNeedsHistory, readNanoPaymentHistory } from "./nano-payment-history.mjs";
import { gateNanoTransferClaims, nanoGateTransferId } from "./nano-transfer-journal.mjs";
import { withHostedRun, hostedRunTimeout } from "./hosted-run.mjs";

const QUOTE_TTL_MS = 15 * 60 * 1000;
const QUOTE_READ_PROOF_TTL_MS = 30_000;
const QUOTE_READ_RETRY_MS = 5_000;
const QUOTE_READ_UNAVAILABLE = "Nano payment detection is temporarily unavailable. Try again shortly. Nothing was quoted or charged.";
const QUOTE_FUNDING_UNAVAILABLE = "Cannot accept a new payment right now: funding is temporarily unavailable. Try again shortly. Nothing was quoted or charged.";
/**
 * The ONLY refund reasons the payments ledger may record — fixed categories,
 * never free text. A ledger line must never carry an upstream error string
 * (it can quote user content), so any reason outside this set is coerced to
 * "run_failed" before it can reach usage.jsonl.
 */
const REFUND_REASONS = new Set(["run_failed", "late_payment", "interrupted"]);
const INTERRUPTED_RUN = "The server restarted before recording this workflow's result.";
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
const HISTORY_MAX_PAGES = 10; // churn cap per scan — far above real block throughput per poll
const NANO_TAG_SPAN = 1_000_000;

/** Choose a free displayed grain within the quote's bounded amount range. */
export function pickNanoQuoteGrain(base, taken, randomOffset = randomInt) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const grain = base + BigInt(randomOffset(10_000));
    if (!taken.has(grain)) return grain;
  }
  // Starting anywhere in the wider range, one more probe than the number of
  // occupied grains must find a free slot unless the entire range is held.
  const start = randomOffset(NANO_TAG_SPAN);
  const probes = Math.min(NANO_TAG_SPAN, taken.size + 1);
  for (let i = 0; i < probes; i++) {
    const grain = base + BigInt((start + i) % NANO_TAG_SPAN);
    if (!taken.has(grain)) return grain;
  }
  return null;
}

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
export { parseUsdNano } from "./usd.mjs";

/** USD → raw via the exact oracle pair {usdNano, raw}: raw = usd·R/U, floor or ceil. */
function usdToRaw(usdValue, pair, mode = "floor") {
  const num = parseUsdNano(usdValue) * pair.raw;
  return mode === "ceil" ? (num + pair.usdNano - 1n) / pair.usdNano : num / pair.usdNano;
}

/** The NanoGPT endpoint the XNO/USD rate probe asks (default base https://nano-gpt.com). */
export function x402ProbeUrl(base) {
  return `${String(base || "https://nano-gpt.com").replace(/\/+$/, "")}/api/v1/chat/completions`;
}

const ORACLE_MODEL = "glm-5.2"; // any keyless-quotable model works

/**
 * The XNO/USD rate oracle: a keyless request with `x-x402: true` answers 402
 * with the invoice pair (raw XNO amount + USD value) NanoGPT settles x402
 * payments at. Returns that exact pair { usdNano, raw }. The probe invoice is
 * never paid; it expires on their side. `signal` is optional (the charge gate
 * passes none).
 */
export async function probeX402Pair({ fetch, url, signal }) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: ORACLE_MODEL, messages: [{ role: "user", content: "x402 rate probe" }] }),
    ...(signal ? { signal } : {}),
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

/**
 * Free custom-workflow helpers (src/tools.mjs). This rail does not run custom
 * graphs, so it withdraws them along with run_noodle.
 */
const FREE_DESIGN_TOOLS = new Set(["price_noodle", "noodle_guide"]);

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
/** Exact deposit figure (up to 8 decimals, trailing zeros trimmed) so the quote text matches the amount collected. */
const exactUsd = (n) => "$" + Number(n).toFixed(8).replace(/(\.\d*?)0+$/, "$1");

function settlementReceipt(q, journaled = false) {
  const r = q.settleReceipt;
  if (!r) return `paid ${rawToXno(q.amountRaw)} XNO deposit; this payment was already settled`;
  const take = BigInt(r.take), change = BigInt(r.change);
  const settledLine = !r.known
    ? journaled ? " — the model reported no cost, so the whole deposit is due back" : " — the model reported no cost, so the whole deposit is being returned to your wallet"
    : r.clamped && r.providerUsd != null && r.billedUsd != null
      ? ` — provider cost $${formatCostUsd(r.providerUsd)} (${r.providerExact ? "exact" : "a lower bound — some calls did not report a price"}); billed $${formatCostUsd(r.billedUsd)} (capped at the deposit)`
      : r.exact === false
        ? ` — settled at estimated cost $${formatCostUsd(r.costUsd)} (a lower bound: some calls did not report a price) + 20%`
        : ` — settled at actual cost $${formatCostUsd(r.costUsd)} + 20%`;
  return `paid ${rawToXno(q.amountRaw)} XNO deposit` + (q.payHash ? ` (block ${q.payHash})` : "") + settledLine +
    (r.known ? (r.author && take > 0n ? " (markup goes to this noodle's author)" : "") +
      (change > 0n ? `; ${rawToXno(change, 30)} XNO change ${!q.source ? "reserved pending payer verification" : journaled && !q.transferReceipts?.change ? "due back to your wallet" : "returned to your wallet"}` : "") : "");
}

/**
 * @param {object} opts
 * @param {string} opts.address           Nano address payments arrive at (the wallet account)
 * @param {object} opts.ops               wallet ops ({ rpc, transfer, transferOnce, pocket })
 *                                        durable state uses transferOnce for all outgoing payments
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
  requireExistingState = false,
  fetch = globalThis.fetch,
  log = () => {},
  usage = () => {},
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  fundRun = null,
  canQuote = () => true,
  verifyPaymentReads = false,
  maintenance = null,
  runTimeoutMs = undefined,
}) {
  const executionLimit = hostedRunTimeout(runTimeoutMs);
  if (typeof requireExistingState !== "boolean" || (requireExistingState && !stateFile)) throw TypeError("required Nano state needs a state file");
  if (!address || !ops) throw new Error("charge gate needs a funded Nano wallet (address + ops)");
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("charge gate needs a positive default price");
  if (fundRun !== null && typeof fundRun !== "function") throw new TypeError("fundRun must be a function or null");
  if (typeof canQuote !== "function") throw new TypeError("canQuote must be a function");
  if (typeof verifyPaymentReads !== "boolean" || (verifyPaymentReads && typeof ops.checkpoint !== "function")) {
    throw new TypeError("verifying Nano payment reads requires a wallet checkpoint");
  }
  if (maintenance !== null && (typeof maintenance.run !== "function" || typeof maintenance.accepting !== "function" || typeof maintenance.assertAdmitted !== "function")) throw new TypeError("maintenance must provide operation admission and accounting");

  /** @type {Map<string, object>} paymentId → quote */
  const quotes = new Map();
  const refundsNeedingReview = new Set();
  const interruptedRuns = new Set();
  let restoredStateNeedsWrite = false;
  let recordingRestoredState = null;
  let historyScan = readNanoPaymentHistory();
  let paymentReadSequence = 0;
  let lastPaymentRead = null;
  let quoteReadInFlight = null;

  /* ---------------- pricing ---------------- */

  // The rate oracle is NanoGPT itself: any keyless request with `x-x402: true`
  // answers 402 with the SAME invoice pair (raw XNO amount + USD value) they
  // settle our downstream payments at — so we quote callers at the rate we pay,
  // not a market feed's. The probe invoice is never paid; it expires on their
  // side, and the 60s cache keeps probes to at most one a minute while quoting.
  const oracleUrl = x402ProbeUrl(oracleBase);
  const nanoGptPair = () => probeX402Pair({ fetch, url: oracleUrl });

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
    const base = (usdToRaw(usdPrice, pair, "ceil") + GRAIN - 1n) / GRAIN;
    // The payment matcher compares at this resolution against every quote
    // it still remembers, including expired and settled records.
    const taken = new Set();
    for (const q of quotes.values()) taken.add(BigInt(q.amountRaw) / GRAIN);
    const grain = pickNanoQuoteGrain(base > 0n ? base : 1n, taken);
    return grain === null ? null : (grain * GRAIN).toString();
  }

  /* ---------------- quote lifecycle ---------------- */

  function resolveWaiters(q) {
    for (const w of q.waiters.splice(0)) w();
  }

  const historyPending = q => q.status === "expired" && !q.payHash
    && (q.historyUnproven || (historyScan.backfill !== null && (historyScan.coveredAt ?? 0) <= q.expiresAt));
  const statusOf = q => (q.depositPending && q.status === "paid") || historyPending(q) ? "pending"
    : refundsNeedingReview.has(q.id) ? "paid" : q.status;

  function publishDeposit(q) {
    const via = q.depositPending;
    delete q.depositPending;
    if (q.status === "expired") {
      resolveWaiters(q);
      if (q.refundOwed) startOwed(q.refundOwed);
      return;
    }
    log(`payment ${q.id}: ${rawToXno(q.amountRaw)} XNO received via ${via}` +
      (q.source ? ` from ${q.source}` : "") + ` (${q.tool})`);
    usage("paid", { paymentId: q.id, tool: q.tool, amountRaw: q.amountRaw, usd: q.usd, source: q.source, via, settleMs: q.paidAt - q.createdAt });
    resolveWaiters(q);
  }

  async function commitDeposits() {
    const pending = [...quotes.values()].filter(q => q.depositPending);
    if (!pending.length && !persistenceFailed) return;
    if (!await persist()) throw new Error("Nano payment storage is unavailable");
    // Another observation may have committed the same records while we waited.
    for (const q of pending) if (q.depositPending) publishDeposit(q);
  }

  // Every outgoing leg reserves funds before any wallet work. The quote
  // outcome, these intents and each signed block share the same durable file.
  const owed = [];
  const OWED_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
  const OWED_MAX_TRIES = 100; // ≈16h at the 10-min cap — after that it needs a human
  const owedDescriptions = { refund: "refunded", change: "change:", author_payout: "author payout:" };

  function queueOwed(to, amountRaw, event, fields) {
    const createdAt = now();
    const o = { to, amountRaw: String(amountRaw), describe: owedDescriptions[event], event, fields,
      journaled: true, prepared: null, tries: 0, createdAt, at: createdAt };
    owed.push(o);
    return o;
  }

  async function completeOwed(o) {
    const q = quotes.get(o.fields?.paymentId);
    const refunded = q && o.event === "refund";
    const completedAt = now();
    // Retain the liability and public status until we can save both the queue
    // removal and (for refunds) the quote transition in a single snapshot.
    o.completing = true;
    if (q) {
      q.transferReceipts ??= {};
      q.transferReceipts[o.event] = { hash: o.confirmedHash, amountRaw: o.amountRaw, to: o.to, completedAt };
    }
    if (refunded) q.refundCompletedAt = completedAt;
    let saved;
    try { saved = await persist(); }
    finally {
      delete o.completing;
      if (refunded) delete q.refundCompletedAt;
      if (!saved && q) delete q.transferReceipts[o.event];
    }
    if (!saved) throw new Error("Nano transfer confirmation could not be recorded");
    owed.splice(owed.indexOf(o), 1);
    if (refunded) {
      q.status = "refunded";
      q.completedAt = completedAt;
      delete q.refundOwed;
      resolveWaiters(q);
    }
    try {
      usage(o.event, { ...o.fields, ok: true, to: o.to, amountRaw: o.amountRaw, hash: o.confirmedHash,
        ...(o.tries > 0 && { retries: o.tries }) });
    } catch { log(`Could not append the already recorded Nano ${o.event} to the usage ledger`); }
    return true;
  }

  function attemptOwed(o, retry = false) {
    if (o.sending || o.held) return Promise.resolve(false);
    const execute = async () => {
      o.sending = true;
      if (retry) o.tries++;
      try {
        if (!o.confirmedHash) {
          if (!await persist()) throw new Error("Nano transfer intent could not be recorded");
          if (stateFile) {
            if (typeof ops.transferOnce !== "function") throw new Error("Durable Nano transfers are unavailable");
            o.confirmedHash = await ops.transferOnce(o.to, o.amountRaw, {
              prepared: o.prepared, liabilityRaw: o.amountRaw, describe: o.describe,
              transferId: nanoGateTransferId(o.fields.paymentId, o.event),
              async onPrepared(prepared) {
                o.prepared = prepared;
                if (!await persist()) throw new Error("Signed Nano transfer could not be recorded");
              },
            });
          } else {
            o.confirmedHash = await ops.transfer(o.to, o.amountRaw, o.describe, { liabilityRaw: o.amountRaw });
          }
        }
        return await completeOwed(o);
      } catch (e) {
        if (!o.confirmedHash && o.tries >= OWED_MAX_TRIES) {
          o.held = true;
          o.at = Infinity;
          log(`Nano ${o.event} requires reconciliation after ${o.tries} retries`);
        } else {
          o.at = now() + OWED_BACKOFF_MS[Math.min(o.tries, OWED_BACKOFF_MS.length - 1)];
          log(`Nano ${o.event} queued after unsuccessful attempt: ${e.message}`);
        }
        if (!retry || o.held) usage(o.event, { ...o.fields, ok: false, to: o.to, amountRaw: o.amountRaw,
          ...(o.held && { retries: o.tries, gaveUp: true, held: true }) });
        await persist();
        return false;
      } finally {
        o.sending = false;
      }
    };
    return maintenance ? maintenance.run(execute, "wallet") : execute();
  }

  function startOwed(o) {
    const attempt = attemptOwed(o);
    ensureWatching();
    attempt.catch(() => log(`Nano ${o.event} needs reconciliation`));
    return attempt;
  }

  async function retryOwed() {
    for (const o of [...owed]) {
      if (o.at <= now() && !quotes.get(o.fields?.paymentId)?.depositPending) await attemptOwed(o, true);
    }
  }

  function queueRefund(q, reason) {
    q.refundExpected = true;
    if (!q.refundOwed && checkAddress(q.source ?? "")) q.refundOwed = queueOwed(q.source, q.amountRaw, "refund", { paymentId: q.id, tool: q.tool, reason });
    return q.refundOwed;
  }

  function recordRunFailure(q, msg, retainedDetail = "(error details not retained across restarts)") {
    const payer = q.settled
      ? "The result could not be delivered. Your original payment was already settled. Contact the operator for result recovery."
      : q.status === "refunded"
        ? `The run didn't complete, so your hosted payment of ${rawToXno(q.amountRaw)} XNO was refunded to ${q.source}. Provider costs already incurred by the service remain separate from this refund. You can try again in a moment.`
        : q.refundOwed
          ? `The run didn't complete. Your ${rawToXno(q.amountRaw)} XNO hosted deposit is being refunded to ${q.source} automatically. The refund is pending confirmation. Provider costs already incurred by the service remain separate from this refund. Contact the operator if the refund does not arrive.`
          : "The run didn't complete. The payment was received and the refund account is unknown. Contact the operator to be made whole.";
    q.error = `${payer}\n\nDetails: ${msg}`;
    q.errorPersist = `${payer}\n\nDetails: ${retainedDetail}`;
    q.completedAt ??= now();
  }

  async function recordOutcome(q) {
    if (!stateFile) return true;
    q.outcomePending = !await persist();
    if (q.outcomePending) ensureWatching();
    return !q.outcomePending;
  }

  function recordRestoredState() {
    if (recordingRestoredState || !restoredStateNeedsWrite) return recordingRestoredState;
    recordingRestoredState = (async () => {
      for (const q of interruptedRuns) {
        if (q.error) continue;
        queueRefund(q, "interrupted");
        recordRunFailure(q, INTERRUPTED_RUN, INTERRUPTED_RUN);
        q.running = Promise.resolve();
      }
      // Persist the failure and its refund together before allowing the queue
      // to publish anything. Another restart can resume the same refund.
      if (!await persist()) throw Error("Could not record restored Nano payment state");
      interruptedRuns.clear();
      restoredStateNeedsWrite = false;
    })().finally(() => { recordingRestoredState = null; });
    return recordingRestoredState;
  }

  /* ---------------- durable state ---------------- */

  /*
   * Quotes and the owed queue are money in flight; both must survive a restart
   * (CI deploys restart the process on every merge). Serialization drops the
   * live-only waiters and running operations, inline image blocks from cached
   * results (the media files themselves persist on disk and keep their /out/
   * URLs). Persist a started execution separately from an unused deposit.
   * A lost text result can retain its financial receipt without rerunning.
   */
  let saveChain = Promise.resolve(true);
  let saveQueued = false, pendingWrites = 0, persistenceFailed = false;
  function persist() {
    if (!stateFile || saveQueued) return saveChain;
    const write = async () => {
      saveQueued = false; // snapshot at write time — later mutations queue another write
      const data = JSON.stringify({
        // v:2 is the content-stripping era — its results are provably media-only
        // (text output is written as null) and its errors are pre-redacted. A
        // v:1 (or unversioned) file predates this and may hold user content, so
        // restore treats it as legacy: drop its results, redact its errors.
        v: 2,
        historyScan,
        quotes: [...quotes.values()].map((q) => {
          // What we're willing to write to disk for this quote's outcome:
          //   - Media-only results persist as today (minus inline image blocks;
          //     the files live on disk and keep their /out/ URLs). Their text is
          //     pointers + a cost line + a gate-authored receipt — no user content.
          //   - Text-output results (LLM/text nodes) hold the customer's paid
          //     content, so they NEVER hit disk: persist null. The settled flag
          //     retains the financial outcome; replay reports lost result text
          //     without paying for another inference or moving settlement twice.
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
            status: q.refundCompletedAt != null ? "refunded" : q.status === "consumed" && q.settled && !result && !error ? "paid" : q.status,
            source: q.source ?? null, payHash: q.payHash ?? null, paidAt: q.paidAt ?? null,
            ...(q.historyAfter != null && { historyAfter: q.historyAfter }),
            ...(q.historyUnproven && { historyUnproven: true }),
            ...(q.runDeadlineAt !== undefined && { runDeadlineAt: q.runDeadlineAt }),
            ...(q.executionNeedsReconciliation && { executionNeedsReconciliation: true }),
            ...(q.refundExpected && { refundExpected: true }),
            completedAt: q.refundCompletedAt ?? q.completedAt ?? null,
            settled: q.settled === true,
            settleReceipt: q.settleReceipt ?? null, // money figures only; no user content
            ...(q.transferReceipts && Object.keys(q.transferReceipts).length > 0 && { transferReceipts: q.transferReceipts }),
            result,
            error,
          };
        }),
        owed: owed.filter(o => !o.completing).map((o) => ({
          to: o.to, amountRaw: o.amountRaw, describe: o.describe, event: o.event, fields: o.fields,
          createdAt: o.createdAt, tries: o.tries, held: o.held === true,
          ...(o.journaled && { journaled: true, prepared: o.prepared, nextAttemptAt: Number.isFinite(o.at) ? o.at : null }),
        })),
      });
      const parent = dirname(stateFile);
      await mkdir(parent, { recursive: true });
      const tmp = stateFile + ".tmp";
      const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
          const state = await handle.stat();
          if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid()) throw Error("unsafe payment-state staging file");
          await handle.chmod(0o600);
          await handle.truncate(0);
          await handle.writeFile(data);
          await handle.sync();
        } finally { await handle.close(); }
        await rename(tmp, stateFile);
        await directory.sync();
      } finally { await directory.close(); }
      persistenceFailed = false;
    };
    const complete = async () => {
      try { await write(); return true; }
      catch (error) { persistenceFailed = true; log(`cannot persist gate state to ${stateFile}: ${error.message}`); return false; }
      finally { pendingWrites--; }
    };
    // Count the queued write before yielding. Completion of a refund or model
    // result is insufficient while its retry debt/receipt is still in memory.
    const scheduled = maintenance ? maintenance.capture(complete, "wallet") : complete;
    saveQueued = true; pendingWrites++;
    saveChain = saveChain.then(scheduled);
    return saveChain;
  }

  if (stateFile) {
    try {
      const data = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!data || typeof data !== "object" || !Array.isArray(data.quotes) || !Array.isArray(data.owed)) {
        throw new Error("invalid gate state structure");
      }
      try { syncPrivateStateParentSync(stateFile); }
      catch (cause) { throw new Error("cannot synchronize the restored Nano payment state", { cause }); }
      historyScan = readNanoPaymentHistory(data.historyScan);
      // A pre-v2 file predates content stripping: its results may be full tool
      // output (text included) and its errors may be free-text upstream messages
      // — both can quote user content. We can't prove any legacy field is clean,
      // so we scrub at the door and never let it re-persist.
      const legacy = data.v !== 2;
      for (const s of Array.isArray(data.quotes) ? data.quotes : []) {
        if (!s || typeof s.id !== "string" || !s.id || quotes.has(s.id) ||
            !["pending", "paid", "consumed", "expired", "refunded"].includes(s.status) ||
            !/^\d+$/.test(s.amountRaw) || BigInt(s.amountRaw) <= 0n ||
            !Number.isFinite(s.createdAt) || !Number.isFinite(s.expiresAt)
            || (s.historyAfter != null && !isNanoHistoryHeight(s.historyAfter))
            || (s.historyUnproven != null && typeof s.historyUnproven !== "boolean")
            || (s.runDeadlineAt != null && (!Number.isSafeInteger(s.runDeadlineAt) || s.runDeadlineAt < 0))
            || (s.executionNeedsReconciliation != null && typeof s.executionNeedsReconciliation !== "boolean")
            || (s.refundExpected != null && typeof s.refundExpected !== "boolean")) {
          throw new Error("invalid quote in gate state");
        }
        const q = { ...s, source: checkAddress(s.source ?? "") ? s.source : null,
          pair: { usdNano: BigInt(s.pair.usdNano), raw: BigInt(s.pair.raw) }, waiters: [] };
        if (q.transferReceipts != null) {
          if (typeof q.transferReceipts !== "object" || Array.isArray(q.transferReceipts)
            || Object.entries(q.transferReceipts).some(([event, receipt]) =>
              !Object.hasOwn(owedDescriptions, event) || !isNanoHistoryHash(receipt?.hash)
              || !/^\d+$/.test(receipt.amountRaw) || BigInt(receipt.amountRaw) <= 0n
              || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 0)) {
            throw new Error("invalid confirmed Nano transfer receipt");
          }
        }
        if (q.pair.usdNano <= 0n || q.pair.raw <= 0n) throw new Error("invalid quote rate in gate state");
        if (legacy) {
          // Legacy result: drop it. Old code only cached a result AFTER settling,
          // so a consumed quote that carried one was already settled — mark it so
          // the replay must neither run inference nor pay change/author again.
          // No legacy output text survives to be written into the new v2 file.
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
        // handled separately by the settled-receipt guard below.
        if (["paid", "consumed"].includes(q.status) && (q.result || q.error)) q.running = Promise.resolve();
        quotes.set(q.id, q);
      }
      const transferIds = new Set();
      for (const s of data.owed) {
        if (!s || !checkAddress(s.to) || !/^\d+$/.test(s.amountRaw) || BigInt(s.amountRaw) <= 0n ||
            !["refund", "change", "author_payout"].includes(s.event) ||
            (s.createdAt != null && (!Number.isSafeInteger(s.createdAt) || s.createdAt < 0)) ||
            (s.tries != null && (!Number.isSafeInteger(s.tries) || s.tries < 0)) ||
            (s.held != null && typeof s.held !== "boolean")) {
          throw new Error("invalid owed send in gate state");
        }
        // Legacy state files predate the payments-ledger policy: their queued
        // refunds carry free-text reasons like "run failed: <upstream error>",
        // which can quote user content. When such an owed send later lands (or
        // gives up), its fields are spread verbatim into a NEW ledger line — so
        // scrub any non-category reason down to "run_failed" here, at the door,
        // keeping every other field intact.
        const fields = s.fields && typeof s.fields === "object" ? { ...s.fields } : s.fields;
        if (fields && "reason" in fields && !REFUND_REASONS.has(fields.reason)) fields.reason = "run_failed";
        const journaled = s.journaled === true;
        if (journaled && (typeof fields?.paymentId !== "string" || !fields.paymentId
          || (s.prepared !== null && (!isNanoHistoryHash(s.prepared?.hash) || s.prepared.block?.account !== address
            || s.prepared.block.link_as_account !== s.to))
          || (!s.held && (!Number.isSafeInteger(s.nextAttemptAt) || s.nextAttemptAt < 0)))) {
          throw new Error("invalid Nano transfer journal");
        }
        const q = quotes.get(fields?.paymentId);
        const transferId = nanoGateTransferId(fields?.paymentId, s.event);
        if (journaled && (transferIds.has(transferId) || q?.transferReceipts?.[s.event])) throw new Error("duplicate Nano transfer intent");
        if (journaled) transferIds.add(transferId);
        // The old queue was written after a possibly successful publication.
        // Its unsigned entries still reserve funds. Reconcile against the
        // chain before sending again.
        const held = !journaled || s.held === true;
        const o = { to: s.to, amountRaw: s.amountRaw, describe: owedDescriptions[s.event], event: s.event, fields,
          journaled, prepared: s.prepared ?? null, createdAt: s.createdAt ?? now(), tries: s.tries ?? 0,
          held, at: held ? Infinity : s.nextAttemptAt };
        owed.push(o);
        if (q && s.event === "refund") q.refundOwed = o;
        if (q && (!journaled || (s.event === "refund" ? q.status !== "expired" && !q.error : !q.settled))) {
          q.settlementNeedsReconciliation = true;
        }
      }
      for (const q of quotes.values()) {
        if (!["paid", "consumed"].includes(q.status) || q.settled || q.result || q.error
          || q.settlementNeedsReconciliation || q.refundOwed || q.executionNeedsReconciliation) continue;
        if (q.status === "paid" && q.runDeadlineAt === null) continue;
        if (q.status === "consumed" && q.runDeadlineAt != null) interruptedRuns.add(q);
        else q.executionNeedsReconciliation = true;
        restoredStateNeedsWrite = true;
      }
      const coverage = nanoFundingCoverage({ quotes: [...quotes.values()], owed });
      for (const id of coverage.unresolvedQuotes) {
        const q = quotes.get(id);
        if (q.status === "refunded") refundsNeedingReview.add(id);
        if (q.refundExpected && ["paid", "consumed"].includes(q.status) && !q.error) q.settlementNeedsReconciliation = true;
      }
      for (const debt of coverage.unsafeDebts) {
        if (debt.held) continue;
        debt.held = true;
        debt.at = Infinity;
        restoredStateNeedsWrite = true;
      }
      if (quotes.size || owed.length) log(`restored ${quotes.size} quote(s) and ${owed.length} queued send(s) from ${stateFile}`);
    } catch (e) {
      // Starting fresh could forget a paid run or an outstanding refund, then
      // overwrite the only recovery record. A missing first-run file is fine;
      // unreadable or corrupt money state requires operator recovery.
      if (e.code !== "ENOENT" || requireExistingState) throw new Error(`cannot restore gate state ${stateFile} — refusing to accept payments; recover the state file before restarting`, { cause: e });
    }
  }

  function prune() {
    if (maintenance) {
      try { maintenance.assertAdmitted(); }
      catch (error) { if (error.code === "SERVICE_DRAINING") return; throw error; }
    }
    const t = now();
    let changed = false;
    const unpaidTransfers = new Set(owed.map(o => o.fields?.paymentId));
    const { unresolvedQuotes } = nanoFundingCoverage({ quotes: [...quotes.values()], owed });
    for (const q of quotes.values()) {
      if (q.unpublished || q.depositPending) continue;
      if (q.status === "pending" && t > q.expiresAt) {
        q.status = "expired";
        resolveWaiters(q);
        changed = true;
      }
      // Retention may remove completed outcomes, never an unclaimed payment
      // or a run still in flight. Those records are outstanding obligations.
      const unfinished = unpaidTransfers.has(q.id) || unresolvedQuotes.has(q.id) || nanoQuoteClaim(q) > 0n
        || q.status === "paid" || (q.status === "consumed" && !q.result && !q.error);
      if (!unfinished && !q.historyUnproven && !nanoQuoteNeedsHistory(q, historyScan.coveredAt, t)
        && t - (q.completedAt ?? q.createdAt) > RETAIN_MS) { quotes.delete(q.id); changed = true; }
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
      if (q.unpublished || q.depositPending || q.payHash || q.refundOwed || !["pending", "expired"].includes(q.status)) return;
      const observedAt = now();
      if (meta.history) {
        const { height, local_timestamp: timestamp } = meta.history;
        const stamp = /^\d{1,12}$/.test(timestamp || "") ? Number(timestamp) * 1000 : 0;
        const recordedAt = stamp <= observedAt + 30_000 ? stamp : 0;
        if (recordedAt && recordedAt + 999 < q.createdAt) return;
        if (q.historyAfter != null && isNanoHistoryHeight(height) && BigInt(height) <= BigInt(q.historyAfter)) return;
        // A local node timestamp can screen old legacy receipts. An absent
        // timestamp requires the quote's confirmed-history height instead.
        if ((q.historyAfter != null && !isNanoHistoryHeight(height))
          || (q.historyAfter == null && !recordedAt && typeof ops.checkpoint === "function")) {
          if (!q.historyUnproven) { q.historyUnproven = true; persist(); }
          return;
        }
      }
      if (q.status === "pending") q.status = observedAt <= q.expiresAt ? "paid" : "expired";
      if (q.status === "paid") q.runDeadlineAt = null;
      if (!q.source && checkAddress(meta.source ?? "")) q.source = meta.source;
      q.payHash = q.payHash || meta.hash || null;
      q.paidAt ??= observedAt;
      delete q.historyUnproven;
      q.depositPending = meta.via;
      if (q.status === "expired") queueRefund(q, "late_payment");
      if (!stateFile) publishDeposit(q);
      return;
    }
  }

  /* ---------------- payment watcher: RPC polling + optional websocket ---------------- */

  let timer = null;
  let wsConnected = false;

  const anyPending = () => [...quotes.values()].some(q => !q.unpublished && statusOf(q) === "pending");
  // Recently expired quotes stay watched so a payment that arrives too late is
  // noticed and bounced straight back instead of silently kept.
  // Someone is waiting on money to ARRIVE — poll fast, a caller is blocked on it.
  const anyPaymentWatchable = () => {
    const t = now();
    return [...quotes.values()].some((q) =>
      !q.unpublished && (q.depositPending || q.status === "pending"
        || (q.status === "expired" && !q.payHash && (t - q.expiresAt < NANO_LATE_WATCH_MS || nanoQuoteNeedsHistory(q, historyScan.coveredAt, t)))));
  };
  // Keep ticking for the owed queue too, but that is money going OUT on its own
  // backoff (OWED_BACKOFF_MS) — it must never pull the receivable poll up to
  // payment speed. A queued refund used to make anyWatchable() true forever,
  // which pinned scan() at one `receivable` call every 5s for as long as the
  // refund kept failing — and since a refund typically fails because the RPC is
  // throttling, that poll fed the very rate limit that was blocking it. One
  // failed refund held the loop for 34h and 5,158 calls on 2026-07-23/25.
  const anyWatchable = () => restoredStateNeedsWrite || persistenceFailed || owed.some(o => !o.held) || anyPaymentWatchable();

  function initialHistoryFloor() {
    let floor = null;
    for (const q of quotes.values()) {
      if (q.unpublished || q.payHash || !["pending", "expired"].includes(q.status)) continue;
      if (q.historyAfter == null) return null;
      const height = BigInt(q.historyAfter);
      if (floor === null || height < floor) floor = height;
    }
    return floor;
  }

  async function readHistoryPage(head, raw, height = null) {
    const request = { action: "account_history", account: address, count: String(HISTORY_PAGE),
      ...(head && { head }), ...(raw && { raw: "true" }) };
    const page = await ops.rpc(request);
    if (raw) {
      const proved = checkedAnchoredNanoHistory(page, request, checkAddress, height);
      return { entries: proved.history, next: proved.previous };
    }
    if (page?.history !== "" && !Array.isArray(page?.history)) throw new Error("Invalid Nano history page");
    if (page.account && page.account.replace(/^xrb_/, "nano_") !== address.replace(/^xrb_/, "nano_")) throw new Error("Nano history returned the wrong account");
    const entries = [];
    let lastHeight = null;
    for (const row of page.history || []) {
      if (!isNanoHistoryHash(row?.hash)) throw new Error("Invalid Nano history block hash");
      if (row.height !== undefined) {
        const height = isNanoHistoryHeight(row.height) ? BigInt(row.height) : 0n;
        if (height === 0n || (lastHeight !== null && height >= lastHeight)) throw new Error("Invalid Nano history block order");
        lastHeight = height;
      }
      if (![false, "false"].includes(row.confirmed)) entries.push({ ...row, hash: row.hash.toUpperCase() });
    }
    if (page.previous != null && !/^0{64}$/.test(page.previous) && !isNanoHistoryHash(page.previous)) throw new Error("Invalid Nano history continuation");
    const next = isNanoHistoryHash(page.previous) ? page.previous.toUpperCase() : null;
    if (next && head === next) throw new Error("Nano history continuation did not advance");
    return { entries, next };
  }

  function receivableBlocks(reply) {
    const blocks = reply?.blocks;
    if (verifyPaymentReads && blocks !== "" && (!blocks || typeof blocks !== "object" || Array.isArray(blocks))) {
      throw new Error("Invalid Nano receivable window");
    }
    return blocks && typeof blocks === "object" ? Object.entries(blocks) : [];
  }

  async function readPaymentWindow({ existingPayments = false } = {}) {
    if (verifyPaymentReads && ops.readPaymentWindow) {
      try {
        const { receivable, history } = await ops.readPaymentWindow({ existingPayments });
        return { blocks: receivableBlocks(receivable), history: history && {
          anchored: true, latest: { entries: history.history, next: history.previous },
        } };
      } catch (error) {
        // Keep finding already-issued payments when the standby has enough
        // budget to corroborate receivables but cannot also read history.
        if (!existingPayments || error?.code !== "NANO_RPC_STANDBY_BUDGET") throw error;
      }
    }
    const receivable = await ops.rpc({ action: "receivable", account: address, count: String(RECEIVABLE_COUNT), threshold: "1",
      source: "true", include_only_confirmed: "true" });
    return { blocks: receivableBlocks(receivable), history: null };
  }

  async function readLatestHistory() {
    const anchor = ops.checkpoint?.()?.confirmed;
    const anchored = isNanoHistoryHash(anchor?.hash);
    if (verifyPaymentReads && (!anchored || !isNanoHistoryHeight(anchor.blockCount))) {
      throw new Error("Nano payment history lacks a confirmed checkpoint");
    }
    const latest = await readHistoryPage(anchored ? anchor.hash.toUpperCase() : null, anchored, anchored ? anchor.blockCount : null);
    return { anchored, latest };
  }

  function recordPaymentRead(ready, sequence) {
    // A response from an older overlapping read must not erase newer evidence.
    if (verifyPaymentReads && (!lastPaymentRead || sequence >= lastPaymentRead.sequence)) {
      lastPaymentRead = { ready, sequence, at: monotonicNow() };
    }
  }

  function recentPaymentRead() {
    if (!lastPaymentRead) return null;
    const age = monotonicNow() - lastPaymentRead.at;
    const interval = lastPaymentRead.ready ? QUOTE_READ_PROOF_TTL_MS : QUOTE_READ_RETRY_MS;
    return age >= 0 && age < interval ? lastPaymentRead.ready : null;
  }

  async function paymentReadsReady() {
    const recent = recentPaymentRead();
    if (recent !== null) return recent;
    // Idle wallets have no regular incoming scan. Concurrent quoters share
    // this read-only probe without waiting for outgoing transfers or for PoW.
    quoteReadInFlight ||= (async () => {
      const sequence = ++paymentReadSequence;
      try {
        const { history } = await readPaymentWindow();
        if (!history) await readLatestHistory();
        recordPaymentRead(true, sequence);
      } catch {
        recordPaymentRead(false, sequence);
        log("Nano checkout could not verify the payment reads");
      }
    })().finally(() => { quoteReadInFlight = null; });
    await quoteReadInFlight;
    return recentPaymentRead() === true;
  }

  function inspectHistory(entries, stop, floor) {
    for (const entry of entries) {
      if (entry.hash === stop || (floor !== null && isNanoHistoryHeight(entry.height) && BigInt(entry.height) <= floor)) return true;
      if (["receive", "open"].includes(nanoHistoryKind(entry))) {
        matchAmount(entry.amount, { source: entry.account, hash: entry.hash, via: "history poll", history: entry });
      }
    }
    return false;
  }

  async function saveHistory(next) {
    await commitDeposits();
    const previous = historyScan;
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    historyScan = next;
    let saved = false;
    try { saved = await persist(); }
    finally { if (!saved) historyScan = previous; }
    if (!saved) throw new Error("Could not save Nano payment history progress");
    if (previous.backfill && !next.backfill) {
      for (const q of quotes.values()) if (q.status === "expired" && !q.payHash) resolveWaiters(q);
    }
  }

  /** Pocketed payments disappear from receivable. Inspect the latest page for
   * quick confirmation, while a fixed backfill resumes older pages across
   * ticks and restarts until it reaches the last completed checkpoint. */
  async function scanHistory(startedAt, fullReceivableWindow, history) {
    const prior = historyScan;
    const { anchored, latest } = history ?? await readLatestHistory();
    const replay = prior.backfill;
    const batch = replay ? { ...replay } : { newest: null, next: null, startedAt, fullReceivableWindow };
    const floor = prior.through === null ? initialHistoryFloor() : null;
    if (replay) inspectHistory(latest.entries, replay.newest || prior.through, floor);

    for (let used = replay ? 1 : 0; used < HISTORY_MAX_PAGES; used++) {
      const page = batch.next ? await readHistoryPage(batch.next, anchored) : latest;
      // A completed cursor must still be visible if an older release resumes
      // with the default history mode, which skips change and epoch blocks.
      batch.newest ??= page.entries.find(entry => ["send", "receive", "open"].includes(nanoHistoryKind(entry)))?.hash ?? null;
      const reached = inspectHistory(page.entries, prior.through, floor);
      if (reached || !page.next) {
        if (!reached && prior.through) throw new Error("Nano history ended before the saved checkpoint");
        const through = batch.newest || prior.through;
        const refreshCoverage = prior.coveredAt === null || through !== prior.through || batch.startedAt - prior.coveredAt >= 30_000;
        const coveredAt = !batch.fullReceivableWindow && refreshCoverage ? Math.max(prior.coveredAt ?? 0, batch.startedAt) : prior.coveredAt;
        return saveHistory({ through, coveredAt, backfill: null });
      }
      batch.next = page.next;
    }
    await saveHistory({ ...prior, backfill: batch });
  }

  async function scan() {
    await commitDeposits();
    await recordRestoredState();
    prune();
    await retryOwed();
    // Only the owed queue left → retryOwed above is the whole job. Skip the
    // receivable/history reads: nobody is waiting for an incoming payment, so
    // asking the node about one is pure load on an endpoint that is usually
    // already throttling us (that is why the refund is queued at all).
    if (!anyPaymentWatchable()) return;
    const startedAt = now();
    const sequence = ++paymentReadSequence;
    try {
      const { blocks, history } = await readPaymentWindow({ existingPayments: true });
      for (const [hash, v] of blocks) {
        const amount = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
        const source = typeof v === "object" && v !== null ? v.source : null;
        matchAmount(amount, { source, hash, via: "receivable poll" });
      }
      await commitDeposits();
      // A full window means blocks beyond it are invisible — ask the wallet to
      // pocket (queued housekeeping, never blocks a payment) so the overflow
      // reappears in account_history, which the walk below reads exhaustively.
      if (blocks.length >= RECEIVABLE_COUNT && ops.pocket) {
        ops.pocket().catch(() => {}); // best-effort; the next tick retries
      }
      if (anyPaymentWatchable()) {
        await scanHistory(startedAt, blocks.length >= RECEIVABLE_COUNT, history);
        recordPaymentRead(true, sequence);
      }
    } catch (error) {
      recordPaymentRead(false, sequence);
      throw error;
    }
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
  let scanning = null, stopped = false;

  function tick() {
    // tick() nulls `timer` and then awaits, so for the whole duration of a scan
    // every ensureWatching() call sees no timer and starts ANOTHER scan on top
    // of it. That is what let concurrent retryOwed() passes double-send (see the
    // o.sending guard). Belt and braces: never run two scans at once — the one
    // in flight schedules the next tick when it finishes.
    if (scanning) return scanning;
    if (stopped) return Promise.resolve();
    timer = null;
    scanning = (maintenance ? maintenance.run(scan, "background") : scan()).then(
      () => { scanFails = 0; },
      (e) => {
        if (e.code === "SERVICE_DRAINING") return;
        scanFails++;
        // Log the first few, then only every 12th — a stuck endpoint used to
        // write one line per poll (5,158 in 34h), burying everything else.
        if (scanFails <= 3 || scanFails % 12 === 0) {
          log(`payment scan failed (${e.message}) — will retry` +
            (scanFails > 3 ? ` (${scanFails} consecutive failures)` : ""));
        }
      },
    ).then(() => {
      scanning = null;
      if (stopped || !anyWatchable()) return;
      // With a live websocket the poll is only a safety net — relax it.
      let delay = wsConnected ? Math.max(pollMs, 5000) : pollMs;
      // Only back off the tick when a scan actually failed. Owed-only ticks keep
      // the base cadence on purpose: with the RPC skipped above they are a local
      // array check costing nothing, so there is no reason to slow the retry.
      if (scanFails > 0) delay = Math.min(delay * 2 ** Math.min(scanFails, 10), SCAN_BACKOFF_CAP_MS);
      timer = setTimeout(tick, delay);
      if (timer.unref) timer.unref();
    });
    return scanning;
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
    if (stopped || (maintenance && !maintenance.accepting()) || !wsUrl || ws) return;
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
          const observe = async () => {
            matchAmount(m.message.amount, { source: blk.account, hash: m.message.hash, via: "websocket" });
            await commitDeposits();
          };
          (maintenance ? maintenance.run(observe, "background") : observe()).catch(error => {
            if (error.code !== "SERVICE_DRAINING") log("Websocket payment observation needs retry through polling");
          });
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
      `PAYMENT REQUIRED — this tool takes a ${exactUsd(q.usd)} deposit (exactly ${rawToXno(q.amountRaw)} XNO), paid in Nano. No account needed. ` +
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
    if (refundsNeedingReview.has(q.id)) return "The Nano payment was received. Its refund needs reconciliation. Keep the original payment ID.";
    if (q.settlementNeedsReconciliation) return "The Nano settlement for this payment needs reconciliation. Keep the original payment ID.";
    if (q.executionNeedsReconciliation) return "The execution history for this Nano payment needs reconciliation. Keep the original payment ID.";
    if (interruptedRuns.has(q)) return "The server is recording the interrupted Nano workflow. Keep the original payment ID.";
    if (q.settled === true && !q.result && !q.error) {
      return "Payment already settled before restart. Result text was not retained and this payment will not run the workflow again. Request a new quote to generate another result.";
    }
    if (!q || q.status === "pending") return undefined;
    if (q.status === "paid" || q.status === "consumed") {
      return `Payment received — this watch stream is done; hang it up. ` +
        `NOW open the RESULTS stream: call the SAME tool with identical arguments plus "_payment_id": "${q.id}". ` +
        `That tools/call runs the workflow (progress heartbeats on a streaming transport) and returns the result. ` +
        `Do not open a results tools/call before the watch closes, and do not keep this watch open in parallel with the results call.`;
    }
    if (q.status === "expired") {
      if (q.payHash) return q.refundOwed && !q.refundOwed.held
        ? "Payment arrived after this quote expired. Its Nano refund is pending."
        : "Payment arrived after this quote expired. Its Nano refund needs reconciliation.";
      return `Quote expired unpaid — call the tool again without _payment_id for a fresh quote.`;
    }
    if (q.status === "refunded") {
      return `Payment was refunded${q.source ? ` to ${q.source}` : ""} — call the tool again without _payment_id to retry.`;
    }
    return undefined;
  }

  const gate = {
    address,
    fundingPair: ratePair,
    persistenceStatus: () => ({ enabled: !!stateFile, ok: !persistenceFailed, pendingWrites }),
    fundingLiabilitiesRaw: () => nanoFundingLiabilities({ quotes: [...quotes.values()], owed }),
    nanoTransferClaims: () => gateNanoTransferClaims({ quotes: quotes.values(), owed }),
    resume: recordRestoredState,

    /** Quote/pay state for the HTTP pay page + status/watch endpoints. */
    quote(id) {
      prune();
      const q = quotes.get(String(id));
      if (!q || q.unpublished) return null;
      const status = statusOf(q);
      const out = {
        id: q.id, tool: q.tool, status, usd: q.usd,
        amountRaw: q.amountRaw, amountXno: rawToXno(q.amountRaw),
        address, uri: nanoUri(q), expiresAt: new Date(q.expiresAt).toISOString(),
        ...(q.depositPending && q.status === "paid" && { checkingPayment: true }),
        ...(historyPending(q) && { checkingPayment: true, checkingHistory: true }),
      };
      // Terminal states close the watch SSE — package the next-step so an agent
      // (or any event-loop subscriber) does not sit on a bare "paid" with no path
      // to the result stream.
      if (status !== "pending") {
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
    waitForPayment(id, ms, { signal } = {}) {
      const q = quotes.get(String(id));
      if (!q || q.unpublished) return Promise.resolve("unknown");
      if (statusOf(q) !== "pending" || signal?.aborted) return Promise.resolve(statusOf(q));
      ensureWatching();
      return new Promise((res) => {
        const finish = () => {
          clearTimeout(t);
          signal?.removeEventListener("abort", finish);
          const index = q.waiters.indexOf(finish);
          if (index !== -1) q.waiters.splice(index, 1);
          res(statusOf(q));
        };
        const t = setTimeout(finish, ms);
        q.waiters.push(finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    },

    /**
     * Decorate a tool registry: descriptions gain prices, schemas gain _payment_id,
     * run_noodle is withdrawn (arbitrary share links can't be priced up front),
     * and callTool enforces quote → pay → run-once → replay.
     */
    wrapRegistry(registry, { runNoodleName = "run_noodle" } = {}) {
      const pinned = new Map(registry.tools.map((t) => {
        const v = t.x402 ? knownUsd(t.x402.usd) : null;
        return [t.name, v != null && v > 0 ? v : null];
      }));
      /**
       * Deposit for a tool as of right now. The deposit is a HOLD, not the price:
       * the run settles at its true metered cost + 20% and the rest comes back as
       * change, so a deposit only needs to be big enough to cover the call — never
       * exact. It must, though, actually cover it: a deposit below cost + 20% means
       * the operator eats the difference (see settle()).
       *
       * Precedence:
       *   1. A tool with a per-request quote (registry.quoteDeposit) uses that
       *      for the call in front of it. humanize-comment prices its own
       *      length and maxChars this way. Built-ins with a quote function use
       *      the same hook. The graph's x402.usd stays the cold ceiling for
       *      tools/list and for a quote that cannot be priced.
       *   2. Otherwise a graph's own x402.usd is pinned and wins.
       *   3. Otherwise quote off the largest of two cost signals — an UP-FRONT
       *      catalog forecast (registry.estimates, valid before the tool has ever
       *      run) and the worst metered cost actually seen (registry.costs, a live
       *      high-water mark) — times a safety multiplier for run-to-run variance:
       *      1.25× when the cost is deterministic (image only), 2× otherwise.
       *   4. With no signal at all (never run, uncatalogued), fall back to the flat
       *      --charge-usd opening deposit.
       *
       * --charge-usd is the cold-start deposit, NOT a ceiling: expensive graphs
       * quote what they actually cost (change still returns the slack), so the
       * operator stops absorbing overages on video / multi-step tools.
       *
       * `args` is the call being quoted. Omit it for the cold figure (the pin,
       * or the opening deposit) used by tools/list and the startup check.
       */
      const priceFor = (name, args) => {
        if (args && registry.quoteDeposit) {
          try {
            const quoted = registry.quoteDeposit(name, args);
            if (Number.isFinite(quoted) && quoted > 0) return quoted;
          } catch (e) {
            // A refusal (humanize-comment with no computable ceiling) is final:
            // never fall back to a pin that may be stale.
            if (e && e.refuse) throw e;
            log(`warning: ${name} per-request deposit failed (${e.message}); using the pinned deposit`);
          }
        }
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
        try { return authorAddress(tool.x402); }
        catch { log(`ignoring x402.author on ${tool.name}: not a valid Nano address`); return null; }
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
       */
      function settlement(q, name, costUsd) {
        const author = authors.get(name);
        const deposit = BigInt(q.amountRaw);
        // "1e-7" and ".001" are that cost. Text knownUsd rejects stays unknown.
        const parsed = knownUsd(costUsd);
        const known = parsed != null;
        const costRaw0 = known ? usdToRaw(parsed, q.pair, "ceil") : 0n;
        const costRaw = costRaw0 > deposit ? deposit : costRaw0;
        const remaining = deposit - costRaw;
        const markup = costRaw0 / 5n;
        const take = markup < remaining ? markup : remaining;
        const change = remaining - take;

        if (costRaw0 > deposit) {
          log(`call ${q.id} (${name}) cost $${parsed} — more than its ${rawToXno(deposit)} XNO deposit; keeping the deposit, no payouts`);
        }
        return { known, take, change, author, costUsd: known ? parsed : null };
      }

      const listTools = () =>
        registry.listTools()
          .filter((t) => t.name !== runNoodleName && !FREE_DESIGN_TOOLS.has(t.name))
          .map((t) => {
            const full = registry.tools.find((x) => x.name === t.name);
            const price = priceFor(t.name);
            // Per-request tools have no single figure to advertise. The quote
            // for the call is the amount collected. No payment rail in this line:
            // it is the text agents show before a quote exists. A tool may bring
            // its own depositNote; humanize-comment uses the sentence below.
            const depositLine = full && full.pricedPerRequest
              ? (full.depositNote || "a deposit is quoted for each request from its length and maxChars and caps what the customer pays; it settles at the lesser of the metered cost plus 20% and that deposit, and any difference is returned; the operator absorbs any overrun. When Cydonia fails and the Starry Ocean fallback runs, both calls are charged. This refund and cap apply to hosted payments. Direct-wallet spending has no cap")
              : `${fmtUsd(price)} deposit per call, paid in Nano (XNO) — settles at actual model cost + 20%, change returned; no account needed`;
            const description = t.description.replace(
              /every call spends real credit from [^;.]+/,
              depositLine) +
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
        if (FREE_DESIGN_TOOLS.has(params.name)) {
          return errResult(`${params.name} is not available on this Nano-paid server — it does not run custom workflows. ` +
            "Use the listed tools, or run your own nanoodle-mcp (npx nanoodle-mcp) to design and price workflows.");
        }
        const rawArgs = params.arguments == null ? {} : params.arguments;
        if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return registry.callTool(params);
        const { _payment_id, ...args } = rawArgs;
        const name = params.name;
        const argsHash = hashArgs(name, args);

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
          if (persistenceFailed && !await persist()) return errResult("Cannot issue a Nano quote while payment storage is unavailable. Try again shortly.");
          if (await canQuote() !== true) return errResult(QUOTE_FUNDING_UNAVAILABLE);
          // After validation, so the quote is for a call that will run and matches
          // the arguments the caller will pay for.
          const price = priceFor(name, args);
          const pair = await ratePair();
          if (verifyPaymentReads) {
            if (!await paymentReadsReady()) return errResult(QUOTE_READ_UNAVAILABLE);
            if (await canQuote() !== true) return errResult(QUOTE_FUNDING_UNAVAILABLE);
            if (recentPaymentRead() !== true) return errResult(QUOTE_READ_UNAVAILABLE);
          }
          const amountRaw = tagAmount(price, pair);
          if (amountRaw === null) {
            return errResult("This server is holding too many Nano quotes at this price right now. Try again later. Nothing was quoted or charged.");
          }
          const confirmedHeight = ops.checkpoint?.()?.confirmed?.blockCount;
          if (verifyPaymentReads && !isNanoHistoryHeight(confirmedHeight)) {
            return errResult(QUOTE_READ_UNAVAILABLE);
          }
          q = {
            id: "pay_" + randomBytes(9).toString("base64url"),
            tool: name, argsHash, usd: price,
            pair, // settle math must use the exact pair the deposit was priced at
            amountRaw,
            createdAt: now(), expiresAt: now() + QUOTE_TTL_MS,
            ...(isNanoHistoryHeight(confirmedHeight) && { historyAfter: confirmedHeight }),
            status: "pending", unpublished: true, waiters: [],
            etaMs: etaOf(name),
          };
          quotes.set(q.id, q);
          let committed = false;
          try { committed = await persist(); }
          finally { if (!committed) quotes.delete(q.id); }
          if (!committed) {
            ensureWatching();
            return errResult("Cannot issue a Nano quote while payment storage is unavailable. Try again shortly.");
          }
          delete q.unpublished;
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
          if (!q || q.unpublished) {
            return errResult(`unknown or expired payment id "${_payment_id}" — call the tool again without _payment_id for a fresh quote.`);
          }
          if (q.tool !== name || q.argsHash !== argsHash) {
            return errResult(`payment ${q.id} was issued for a different call (tool/arguments changed) — ` +
              `call again without _payment_id to get a quote for these arguments.`);
          }
          if (refundsNeedingReview.has(q.id)) return errResult(nextFor(q));
          if (q.status === "refunded") {
            return errResult(`payment ${q.id} was refunded${q.source ? ` to ${q.source}` : ""} — call again without _payment_id to retry.`);
          }
          if (q.settlementNeedsReconciliation || q.executionNeedsReconciliation || interruptedRuns.has(q)) return errResult(nextFor(q));
          if (statusOf(q) === "expired") {
            return errResult(nextFor(q));
          }
          if (q.settled === true && !q.result && !q.error) {
            return errResult("This workflow finished and its payment was already settled before the server restarted. " +
              "The result text was not retained. This payment will not run the workflow again. " +
              "Request a new quote if you want to generate another result.\n\n" + settlementReceipt(q, !!stateFile));
          }
        }

        // Prefer announce (immediate progress event) over report (next heartbeat).
        const note = (s) => {
          if (ctx && typeof ctx.announce === "function") ctx.announce(s);
          else if (ctx && typeof ctx.report === "function") ctx.report(s);
        };

        if (statusOf(q) === "pending") {
          // Phase 3 is the RESULTS stream — it must not also be the payment
          // monitor. A short waitMs covers the race where payment lands as the
          // agent switches from watch → results; it never holds through the
          // quote TTL (that used to race a parallel watch SSE and look like a
          // silent load). Agents still pending should be on /x402/watch.
          note(`checking payment ${q.id}`);
          const st = await gate.waitForPayment(q.id, waitMs);
          if (st === "pending") {
            if (q.depositPending) return errResult("The original Nano transfer is being recorded. Keep monitoring this payment ID.");
            if (historyPending(q)) return errResult("Nano is checking the history for this quote. Keep monitoring the original payment ID.");
            return errResult(
              `payment ${q.id} hasn't arrived yet — this tools/call is the RESULTS stream, not the payment monitor. ` +
              `Hang it up. Open the agent-only watch SSE ${watchUrl(q)} (never show that URL to the user), ` +
              `wait until it closes with status "paid", THEN call again with the same _payment_id. ` +
              `Do not hold a tools/call open while waiting for payment.`
            );
          }
          if (st === "expired") {
            return errResult(nextFor(q));
          }
          if (st === "refunded") return errResult(nextFor(q));
        }
        // The result call claims an unused deposit. No model or funding
        // operation begins until the claim is durable.
        if (!q.running) {
          q.status = "consumed";
          q.runDeadlineAt = now() + executionLimit;
          q.running = Promise.resolve().then(async () => {
            if (stateFile && !await persist()) {
              q.status = "paid";
              q.runDeadlineAt = null;
              ensureWatching();
              return errResult("Payment received. The Nano checkout could not record the workflow start. Retry with the original payment ID.");
            }
            try {
              note(`payment received — running ${name}` + (q.etaMs ? ` (typically ~${fmtDur(q.etaMs)})` : ""));
              const execute = () => registry.callTool({ name, arguments: args }, fundRun ? { ...ctx, paidFunding: true } : ctx);
              const { costUsd, costExact, providerUsd, providerExact, billedUsd, textOutput, ...result } = await withHostedRun(() => fundRun
                ? fundRun(runFundingBudget({ id: `nano:${q.id}`, budgetUsd: q.usd, pair: q.pair, creator: !!authors.get(name) }), execute)
                : execute(), executionLimit);
              // Whether this result carries the customer's paid text output. Kept
              // on q (not inside q.result) so in-process replay is unchanged but
              // persist() knows this result must not be written to disk.
              q.textOutput = !!textOutput;
              const s = settlement(q, name, costUsd);
              const clamped = typeof providerUsd === "number" && typeof costUsd === "number" && providerUsd - costUsd > 1e-9;
              q.settleReceipt = { known: s.known, costUsd: s.costUsd, exact: costExact !== false,
                providerUsd: typeof providerUsd === "number" ? providerUsd : null,
                providerExact: providerExact === true,
                billedUsd: typeof billedUsd === "number" ? billedUsd : null,
                clamped, take: s.take.toString(), change: s.change.toString(), author: !!s.author, authorAddress: s.author ?? null };
              const receipt = settlementReceipt(q, !!stateFile);
              q.result = { ...result, content: [...result.content, { type: "text", text: receipt }] };
              q.completedAt = now();
              const fields = { paymentId: q.id, tool: name };
              const payout = s.author && s.take > 0n
                ? queueOwed(s.author, s.take, "author_payout", { ...fields, costUsd: s.costUsd }) : null;
              const change = checkAddress(q.source ?? "") && s.change > 0n ? queueOwed(q.source, s.change, "change", fields) : null;
              q.settled = true;
              // Commit both legs with the result before either can be sent.
              if (await recordOutcome(q)) {
                if (payout) startOwed(payout);
                if (change) startOwed(change);
              }
            } catch (e) {
              const msg = String((e && e.message) || e);
              const refund = q.settled ? null : queueRefund(q, "run_failed");
              recordRunFailure(q, msg);
              if (await recordOutcome(q) && refund && await startOwed(refund)) recordRunFailure(q, msg);
            }
          });
        } else if (!q.result && !q.error) {
          note("Payment received. Waiting for the original workflow.");
        }
        const run = q.running;
        const startFailure = await run;
        if (startFailure) {
          if (q.running === run) q.running = null;
          return startFailure;
        }
        if (q.outcomePending && !await recordOutcome(q)) {
          return errResult("The Nano checkout is recording this outcome. Check again with the original payment ID.");
        }
        return q.error ? errResult(q.error) : q.result;
      }

      return { listTools, callTool: maintenance ? (params, ctx) => maintenance.run(() => callTool(params, ctx)) : callTool };
    },
  };
  // Restored pending quotes / owed sends need the watcher running from boot,
  // not from the next quote — a payment may land while nobody is calling.
  gate.stop = async () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    ws?.close();
    await scanning;
    await saveChain;
  };
  if (anyWatchable()) ensureWatching();
  return gate;
}
