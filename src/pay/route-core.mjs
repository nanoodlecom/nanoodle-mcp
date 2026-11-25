/**
 * The shared payment-route lifecycle — one machine, per-asset adapters.
 *
 * Generalized from the two production gates (src/gate.mjs for Nano,
 * src/near-gate.mjs for NEAR), which implement the same flow:
 *
 *   quote → pay → detect → run once → settle at min(actual model cost
 *   + 20%, deposit) at the rate locked in the quote → change/refund in
 *   the asset paid → three-leg receipt → replay returns the stored
 *   outcome and never runs or charges again.
 *
 * The core owns: the quote lifecycle and replay, deposit tagging via the
 * adapter, the settle formula, the owed-send protocol (the debt is
 * journaled BEFORE any broadcast; refund reasons are a fixed category
 * set, never free text), and receipt assembly (leg 2 is derived at the
 * locked rate pair and labelled derived — never read off an invoice).
 *
 * Everything chain-specific sits behind the adapter contract:
 *   { rail, idPrefix, assets, asset, network, ttlMs, merchant,
 *     detection: "watch" | "claim",
 *     validateAddress(a), formatAtomic(atomic),
 *     rate: { current() -> frozen { usdNano, atomic, source, at } },
 *     tagging: { tag(baseAtomic, taken) -> { depositAtomic, tag } },
 *     observe(pendingQuotes) -> [{ ref, payer, amountAtomic }],   // watch
 *     verifyClaim(quote, claim) -> { ref, payer, amountAtomic },  // claim
 *     sendBack({ to, amountAtomic, reason, idempotencyKey }) -> ref }
 *
 * Named seams that deliberately do NOT abstract (detection direction,
 * finality semantics, send-back internals, multi-asset rails, author
 * payout denomination, per-asset trust posture) live in the adapters.
 *
 * This module is storage-free (in-memory journal) so it can be driven
 * end to end in tests; a production route supplies the durable store
 * behind the same shapes (compare src/near/ledger.mjs).
 */
import { randomUUID } from "node:crypto";
import { parseUsdNano, usdNanoToAtomic, atomicToUsdNano, formatUsdNano } from "./money.mjs";

export const MARKUP_NUM = 6n, MARKUP_DEN = 5n; // model cost + 20%
export const REFUND_REASONS = new Set(["change", "run_failed", "wrong_amount", "late_payment", "interrupted"]);

export function createPaymentRoute({ adapter, now = Date.now }) {
  if (!adapter || !adapter.rail || !adapter.idPrefix) throw new TypeError("adapter needs rail + idPrefix");
  if (adapter.detection !== "watch" && adapter.detection !== "claim") throw new TypeError("adapter.detection must be watch|claim");
  adapter.validateAddress(adapter.merchant); // fail fast: a wrong-network merchant strands every payment

  const quotes = new Map();
  const consumedRefs = new Set(); // a payment reference settles at most one quote, once
  const journal = [];             // owed-send journal; production: durable, fsync'd

  async function issueQuote({ tool, usdEstimate }) {
    const pair = await adapter.rate.current(); // locked into the quote for its whole TTL
    const estNano = parseUsdNano(usdEstimate);
    const baseAtomic = usdNanoToAtomic(estNano, pair, "ceil");
    const taken = new Set([...quotes.values()].filter((q) => q.status === "pending").map((q) => q.depositAtomic));
    const { depositAtomic, tag } = adapter.tagging.tag(baseAtomic, taken);
    const id = adapter.idPrefix + randomUUID().replaceAll("-", "").slice(0, 24);
    const q = {
      id, rail: adapter.rail, asset: adapter.asset, network: adapter.network, tool,
      status: "pending", merchant: adapter.merchant,
      depositAtomic: depositAtomic.toString(), tag,
      depositUsd: formatUsdNano(atomicToUsdNano(depositAtomic, pair)),
      estimateUsd: String(usdEstimate),
      pair: { usdNano: pair.usdNano.toString(), atomic: pair.atomic.toString(), source: pair.source },
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + adapter.ttlMs).toISOString(),
      payment: null, receipt: null,
    };
    quotes.set(id, q);
    return q;
  }

  function markPaid(q, { ref, payer, amountAtomic }) {
    if (consumedRefs.has(ref)) return false;
    consumedRefs.add(ref);
    q.status = "paid";
    q.payment = { ref, payer, amountAtomic: amountAtomic.toString() };
    return true;
  }

  /** Watch mode: the gate finds the money itself (Nano-style). Returns newly paid quotes. */
  async function detectPayments() {
    if (adapter.detection !== "watch") throw new Error(`${adapter.rail} is claim-mode; use confirmPayment`);
    const found = [];
    const pending = [...quotes.values()].filter((q) => q.status === "pending");
    for (const q of pending) if (now() > Date.parse(q.expiresAt)) q.status = "expired";
    const live = pending.filter((q) => q.status === "pending");
    if (!live.length) return found;
    const observed = await adapter.observe(live);
    for (const obs of observed) {
      const q = live.find((x) => x.depositAtomic === obs.amountAtomic.toString());
      if (q && markPaid(q, obs)) found.push(q);
    }
    return found;
  }

  /** Claim mode: the caller names the payment; the adapter verifies it against the chain (NEAR-style). */
  async function confirmPayment(id, claim) {
    if (adapter.detection !== "claim") throw new Error(`${adapter.rail} is watch-mode; use detectPayments`);
    const q = quotes.get(id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if (q.status === "paid") return q;
    if (q.status !== "pending") throw new Error(`quote ${id} is ${q.status}, not pending`);
    if (now() > Date.parse(q.expiresAt)) { q.status = "expired"; throw new Error(`quote ${id} expired`); }
    const verified = await adapter.verifyClaim(q, claim); // the chain supplies payer + amount; the claim only routes the lookup
    if (consumedRefs.has(verified.ref)) throw new Error(`payment ${verified.ref} was already consumed by another quote`);
    if (verified.amountAtomic.toString() !== q.depositAtomic) {
      const err = new Error(`paid amount ${verified.amountAtomic} != quoted deposit ${q.depositAtomic}`);
      err.reason = "wrong_amount";
      throw err;
    }
    markPaid(q, verified);
    return q;
  }

  /**
   * Settle a paid quote after its run. Shared formula (both production
   * gates): charged = min(actual + 20%, deposit) at the locked pair;
   * a failed run refunds the whole deposit. Idempotent.
   */
  async function settle(id, { actualUsd, runOk }) {
    const q = quotes.get(id);
    if (!q) throw new Error(`unknown quote ${id}`);
    if (q.receipt) return q.receipt;
    if (q.status !== "paid") throw new Error(`quote ${id} is ${q.status}, not paid`);

    const pair = { usdNano: BigInt(q.pair.usdNano), atomic: BigInt(q.pair.atomic) };
    const depositAtomic = BigInt(q.depositAtomic);
    let chargedAtomic = 0n, chargedNano = 0n;
    if (runOk) {
      chargedNano = (parseUsdNano(actualUsd) * MARKUP_NUM) / MARKUP_DEN;
      const depositNano = atomicToUsdNano(depositAtomic, pair);
      if (chargedNano > depositNano) chargedNano = depositNano;
      chargedAtomic = usdNanoToAtomic(chargedNano, pair);
      if (chargedAtomic > depositAtomic) chargedAtomic = depositAtomic;
    }
    const changeAtomic = depositAtomic - chargedAtomic;

    let sendRef = null;
    if (changeAtomic > 0n) {
      const reason = runOk ? "change" : "run_failed";
      if (!REFUND_REASONS.has(reason)) throw new Error(`bad refund reason ${reason}`);
      const entry = { kind: reason, quoteId: id, to: q.payment.payer, amountAtomic: changeAtomic.toString(), idempotencyKey: `${id}:${reason}` };
      journal.push(entry); // journal first — a crash must not lose the debt
      sendRef = await adapter.sendBack(entry);
      entry.ref = sendRef;
    }

    q.status = runOk ? "settled" : "refunded";
    q.receipt = {
      quoteId: id, rail: q.rail, asset: q.asset, network: q.network,
      legs: {
        callerPayment: { ref: q.payment.ref, from: q.payment.payer, to: q.merchant, amountAtomic: q.depositAtomic, amountDisplay: adapter.formatAtomic(depositAtomic), amountUsd: q.depositUsd },
        modelPayment: { derived: true, rateSource: q.pair.source, pair: q.pair, amountUsd: runOk ? String(actualUsd) : "0" },
        refund: changeAtomic > 0n ? { ref: sendRef, to: q.payment.payer, amountAtomic: changeAtomic.toString(), amountDisplay: adapter.formatAtomic(changeAtomic), amountUsd: formatUsdNano(atomicToUsdNano(changeAtomic, pair)), kind: runOk ? "change" : "refund" } : null,
      },
      chargedUsd: formatUsdNano(chargedNano),
      markup: "model cost + 20%",
    };
    return q.receipt;
  }

  /**
   * Execution reuse: wrap a tool registry so this route sells its tools
   * with the same shape both production gates expose to the rail router
   * ({ listTools, callTool, sells, assets, railOnly }).
   *
   * The money lifecycle around execution is the core's; execution itself
   * is injected: `estimate(name, args)` prices a call in USD (the server
   * wires its pricing machinery), `execute(name, args, ctx)` runs it and
   * reports the metered cost on the result's `costUsd` sidecar (the
   * convention both gates read). Free tools pass through untouched.
   * A paid call without _payment_id is validated, priced and answered
   * with a quote — never charged. Resuming with _payment_id detects (or,
   * for claim-mode adapters, verifies) the payment, runs the tool
   * exactly once, settles, and replays the stored result thereafter.
   */
  function wrapRegistry(registry, {
    freeTools = ["price_noodle", "noodle_guide"],
    railOnly = ["run_noodle", "price_noodle", "noodle_guide"],
    paidTools = null,
    estimate,
    execute = (name, args, ctx) => registry.callTool({ name, arguments: args }, ctx),
    publicBase = "",
    paidLine = null,
  } = {}) {
    if (typeof estimate !== "function") throw new TypeError("wrapRegistry needs an estimate(name, args) pricing hook");
    const free = new Set(freeTools);
    const all = registry.listTools().map((t) => t.name);
    const paid = new Set(paidTools ?? all.filter((n) => !free.has(n)));
    const offered = new Set([...paid, ...free]);
    const line = paidLine ?? `paid in ${adapter.asset} on the ${adapter.network} network: a deposit is held up front, you are charged the actual model cost + 20% service fee, and the rest is refunded automatically in ${adapter.asset}`;
    const locks = new Map();
    const withLock = (id, fn) => {
      const prev = locks.get(id) || Promise.resolve();
      const run = prev.then(fn, fn);
      locks.set(id, run.catch(() => {}));
      return run;
    };
    const paymentBlock = (q) => ({
      paymentId: q.id, rail: q.rail, asset: q.asset, network: q.network, merchant: q.merchant,
      amountRaw: q.depositAtomic, amountDisplay: adapter.formatAtomic(BigInt(q.depositAtomic)), amountUsd: q.depositUsd,
      expiresAt: q.expiresAt, status: q.status,
      ...(publicBase ? { payUrl: `${publicBase}/${q.rail}/pay/${q.id}`, statusUrl: `${publicBase}/${q.rail}/status/${q.id}` } : {}),
    });
    const quoteResult = (q) => ({
      content: [{ type: "text", text:
        `PAYMENT REQUIRED — send exactly ${adapter.formatAtomic(BigInt(q.depositAtomic))} (about $${q.depositUsd}) to ${q.merchant} on the ${q.network} network, then call the same tool again with the same arguments plus "_payment_id": "${q.id}". ` +
        `The deposit caps the charge: you pay the actual model cost + 20%, and the rest returns to the paying account in ${q.asset}. Quote expires ${q.expiresAt}.` }],
      structuredContent: { payment: paymentBlock(q) },
    });

    function listTools() {
      return registry.listTools()
        .filter((t) => offered.has(t.name))
        .map((t) => {
          if (!paid.has(t.name)) return t;
          return {
            ...t,
            description: `${t.description} (${line})`,
            inputSchema: {
              ...t.inputSchema,
              properties: {
                ...(t.inputSchema.properties || {}),
                _payment_id: { type: "string", description: `The paymentId from this tool's ${adapter.asset} quote. After paying the exact quoted amount, repeat the original arguments plus this id.` },
                ...Object.fromEntries((adapter.claimFields || []).map((f) => [f.name, f.schema])),
              },
            },
          };
        });
    }

    async function callTool(params, ctx = null) {
      if (params == null || typeof params !== "object" || Array.isArray(params)) return registry.callTool(params, ctx);
      const name = params.name;
      if (free.has(name) && !paid.has(name)) return registry.callTool(params, ctx);
      if (!paid.has(name)) throw new Error(`unknown tool "${name}" — available: ${[...offered].join(", ")}`);
      const rawArgs = params.arguments == null ? {} : params.arguments;
      if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new Error("tools/call arguments must be an object");
      const { _payment_id, _pay_with, ...claimArgs } = rawArgs;
      const args = Object.fromEntries(Object.entries(claimArgs).filter(([k]) => !(adapter.claimFields || []).some((f) => f.name === k)));

      if (_payment_id == null) {
        if (typeof registry.prepareCall === "function") registry.prepareCall({ name, arguments: args }); // never quote a call that would not run
        const usdEstimate = await estimate(name, args);
        return quoteResult(await issueQuote({ tool: name, usdEstimate }));
      }
      const paymentId = String(_payment_id);
      return withLock(paymentId, async () => {
        const q = quotes.get(paymentId);
        if (!q) throw new Error(`unknown payment id "${paymentId}" — call without _payment_id for a fresh quote`);
        if (q.result) return q.result; // replay: never runs or charges again
        if (q.status === "pending") {
          if (adapter.detection === "watch") await detectPayments();
          else await confirmPayment(paymentId, adapter.claimFromArgs ? adapter.claimFromArgs(claimArgs) : claimArgs);
        }
        if (q.status !== "paid") {
          return { content: [{ type: "text", text: `Payment for ${paymentId} has not been detected yet (status: ${q.status}). Pay the exact quoted amount, wait for it to confirm, then call again with the same _payment_id.` }],
            structuredContent: { payment: paymentBlock(q) } };
        }
        let result, runError = null;
        try { result = await execute(name, args, ctx); } catch (e) { runError = e; }
        if (runError) {
          const receipt = await settle(paymentId, { actualUsd: "0", runOk: false });
          return { content: [{ type: "text", text: `The run failed (${String(runError.message || runError)}). Your deposit of ${adapter.formatAtomic(BigInt(q.depositAtomic))} was refunded in full to ${q.payment.payer} in ${q.asset}.` }],
            structuredContent: { receipt }, isError: true };
        }
        const actualUsd = result?.costUsd ?? result?.structuredContent?.costUsd ?? q.estimateUsd;
        const receipt = await settle(paymentId, { actualUsd: String(actualUsd), runOk: true });
        const settled = {
          ...(result && typeof result === "object" ? result : { content: [{ type: "text", text: String(result ?? "") }] }),
          structuredContent: { ...(result?.structuredContent || {}), receipt },
        };
        q.result = settled;
        return settled;
      });
    }

    return { listTools, callTool, sells: (n) => paid.has(n), assets: new Set(adapter.assets), railOnly: new Set(railOnly) };
  }

  return {
    rail: adapter.rail, assets: adapter.assets, idPrefix: adapter.idPrefix,
    issueQuote, detectPayments, confirmPayment, settle, wrapRegistry,
    quote: (id) => quotes.get(id) || null,
    journal: () => [...journal],
  };
}
