/**
 * NEAR payment gate: quote → verify → run once → settle → refund → replay.
 *
 * Wraps a tool registry (src/tools.mjs) so every paid call is bought with one
 * native NEAR transfer:
 *
 *   1. A call without payment arguments is checked completely (argument
 *      shapes, graph safety, caps, inputs, that every paid node is priced)
 *      and answered with a quote: an exact yoctoNEAR deposit with unique dust,
 *      the itemized price and a locked NEAR/USD rate. Nothing is charged.
 *   2. The caller sends that exact amount in one transfer and repeats the call
 *      with _payment_id, _payment_tx and _payment_sender.
 *   3. The gate reads the transaction at FINAL finality, records its hash as
 *      consumed (durably, before anything runs), runs the priced graph once
 *      (maxTokens and durations written in, see bindPaidGraph), and settles:
 *      charged = min(actual model cost + 20% service fee, deposit) at the
 *      locked rate; the rest is refunded to the transaction's signer. When the
 *      provider reports only part of the cost, the estimated cost is charged.
 *   4. Repeating the paying call returns the stored outcome. It never runs,
 *      charges or refunds again, also across restarts.
 *
 * Money state lives in src/near/ledger.mjs (sync, fsync'd). Text output, the
 * caller's paid content, is kept in memory only. See docs/near-payments.md.
 */
import { randomBytes } from "node:crypto";
import { graphModelKinds } from "nanoodle";
import { hashArgs } from "./gate.mjs";
import {
  fetchCatalogs, computePrice, priceNoodleResult, ParamsError,
  PRICE_NOODLE_NAME, NOODLE_GUIDE_NAME,
} from "./tools.mjs";
import {
  DEFAULT_LIMITS, GraphArgsError, GraphRefusedError, readGraphArgs, assertGraphSafe, checkGraphSafety,
  priceGraph, refusalsForQuote, formatQuote, formatReceipt, exactUsd, estUsd, shortNear, rateExtras,
} from "./custom-workflow.mjs";
import { parseUsdNano } from "./gate.mjs";
import {
  NearError, isNearAccountId, base58Decode, formatYoctoAsNear, usdToYocto, depositYocto, settleYocto,
  DUST_STEP_YOCTO, readPaymentTransfer, explorerTxUrl,
} from "./near/index.mjs";
import { knownUsd } from "./usd.mjs";
import { formatUsdc, usdcDeposit } from "./near/ft.mjs";
import { authorPayoutRaw } from "./author-payouts.mjs";
import { rawToXno, authorAddress } from "./wallet.mjs";

const RUN_NOODLE = "run_noodle";
const FINAL = new Set(["settled", "failed", "rejected"]);
const SIDE_CARS = ["costUsd", "costExact", "providerUsd", "providerExact", "billedUsd", "textOutput"];
const TEXT_NOT_RETAINED = "The result text was not retained across a server restart; the run is not repeated.";
const ERROR_NOT_RETAINED = "Details: (error details not retained across restarts)";

const errResult = (text, structuredContent) => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
  isError: true,
});

/** A refusal list as an agent-readable tool error (never a JSON-RPC error: the call was well-formed). */
function refusedResult(refusals) {
  const lines = [
    `This workflow cannot run on this server as written: ${refusals.length} problem${refusals.length === 1 ? "" : "s"}. Nothing was quoted or charged.`,
    ...refusals.map((r) => `- ${r.message}`),
    "",
    "Fix the graph and check it for free with price_noodle; noodle_guide lists the allowed node types and priced models.",
  ];
  return errResult(lines.join("\n"), { refusals: refusals.map((r) => ({ ...r })) });
}

/** Exact USD (9 decimals) for a yocto amount at a locked rate, floor. */
function yoctoToUsd(yocto, usdNano, rateYocto) {
  const nano = (yocto * usdNano) / rateYocto;
  const whole = nano / 1_000_000_000n;
  const frac = (nano % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function strip(res) {
  const out = { ...res };
  for (const k of SIDE_CARS) delete out[k];
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.merchantId   account that receives payments and signs refunds
 * @param {"testnet"|"mainnet"} opts.network
 * @param {object} opts.rpc          createNearRpc()
 * @param {object} opts.ledger       openNearLedger()
 * @param {object} opts.rate         createNearUsdRate()
 * @param {object} opts.refunder     createRefunder()
 * @param {object} [opts.limits]     custom-workflow caps, incl. maxDepositUsd
 * @param {string} [opts.baseUrl]    NanoGPT base for the public model catalogs
 * @param {number} [opts.quoteTtlMs] quote lifetime (30 min); the quote's rates stay locked for all of it
 * @param {"wallet"|"api_key"|null} [opts.modelPayment]  how this server pays NanoGPT for runs:
 *                                   from its Nano wallet (XNO) or its API key's balance; shown in receipts
 * @param {number} [opts.skewMs]     tolerated clock skew between the chain and this server
 * @param {(line: string) => void} [opts.log]
 * @param {(event: string, fields: object) => void} [opts.usage]  payments ledger (money events only)
 * @param {number} [opts.txTimeoutMs]  bound on the FINAL `tx` lookup (default in readPaymentTransfer)
 * @param {(min: number, max: number) => number} [opts.randomInt]  dust source; tests pin it
 * @param {number} [opts.maxOpenQuotes]   unexpired unpaid quotes held at once (default 1000); more are refused as busy
 * @param {number} [opts.expiredRetainMs] how long an expired, unpaid quote is kept so a late transfer is still refunded (1 h)
 * @param {string|null} [opts.publicBase] public origin for wallet pay pages and payment monitoring
 */
export function createNearGate({
  merchantId,
  network,
  rpc,
  ledger,
  rate,
  refunder,
  limits = DEFAULT_LIMITS,
  baseUrl,
  quoteTtlMs = 30 * 60_000,
  modelPayment = null,
  skewMs = 120_000,
  log = () => {},
  usage = () => {},
  now = Date.now,
  fetch = globalThis.fetch,
  txTimeoutMs,
  randomInt,
  maxOpenQuotes = 1000,
  expiredRetainMs = 3_600_000,
  publicBase = null,
  usdcToken = null,
  usdcEnabled = false,
  authorPayouts = null,
}) {
  if (!isNearAccountId(merchantId)) throw new TypeError("createNearGate needs a valid merchant account id");
  if (network !== "testnet" && network !== "mainnet") throw new TypeError('network must be "testnet" or "mainnet"');
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  if (usdcEnabled && !isNearAccountId(usdcToken)) throw new TypeError("USDC needs a verified token contract");
  const assetOf = (q) => q.asset === "usdc" ? "usdc" : "near";
  const symbol = (q) => assetOf(q) === "usdc" ? "USDC" : "NEAR";
  const amountText = (q, amount) => assetOf(q) === "usdc" ? formatUsdc(amount) : formatYoctoAsNear(amount);
  const amountFields = (q, amount) => assetOf(q) === "usdc"
    ? { asset: "USDC", amountAtomic: String(amount), amount: formatUsdc(amount), tokenContract: q.tokenContract, decimals: 6 }
    : { yocto: String(amount), near: formatYoctoAsNear(amount) };
  const refundAsset = (q) => assetOf(q) === "usdc" ? { asset: "usdc", tokenContract: q.tokenContract } : {};
  const rateView = (q) => assetOf(q) === "usdc"
    ? { usdcUsd: "1", source: q.rate.source, at: q.rate.at, ...rateExtras(q.rate) }
    : { nearUsd: q.rate.nearUsd, source: q.rate.source, at: q.rate.at, ...rateExtras(q.rate) };
  const ev = (event, fields) => {
    try { usage(event, { rail: "near", ...fields }); } catch { /* the ledger sink never breaks a call */ }
  };

  /** Full results (incl. text) of finished calls in this process, by payment id. */
  const results = new Map();
  // Safe execution snapshots only, in memory like paid output. Never persist prompts.
  const workflows = new Map();
  /** Per-payment-id serialization: one paying call at a time per id. */
  const locks = new Map();
  const waiters = new Map();
  function changed(id) {
    for (const wake of waiters.get(id) || []) wake();
  }
  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chained) locks.delete(key);
      changed(key);
    }
  }

  /* ---------------- receipts ---------------- */

  /**
   * What this server paid NanoGPT for the run, in USD and (wallet-funded) XNO.
   * The XNO figure is derived from the settled USD cost at the quote's locked
   * XNO/USD rate; the wallet's actual invoice blocks are not attributed to a
   * run. Unknown stays null, never zero.
   */
  function modelSpend(q) {
    const s = q.settlement;
    const ran = q.outcome === "succeeded" || q.outcome === "run_failed" || q.outcome === "interrupted";
    const usd = s && s.costUsd != null ? exactUsd(s.costUsd) : null;
    let xno = null;
    if (usd != null && modelPayment === "wallet" && q.rate && q.rate.xnoUsd) {
      try {
        const xnoNano = parseUsdNano(q.rate.xnoUsd);
        if (xnoNano > 0n) xno = ratioXno(parseUsdNano(usd), xnoNano);
      } catch { xno = null; }
    }
    return { ran, usd, xno };
  }

  /** The three money legs of a receipt, each with its own honest status. */
  function receiptLegs(q, r) {
    const m = modelSpend(q);
    const caller = {
      leg: "caller payment", asset: symbol(q),
      amount: amountText(q, r.deposit.amountAtomic ?? r.deposit.yocto),
      ...(assetOf(q) === "usdc" ? { amountAtomic: r.deposit.amountAtomic, tokenContract: q.tokenContract } : { yocto: r.deposit.yocto }),
      txHash: r.deposit.txHash, explorerUrl: r.deposit.explorerUrl,
      status: q.payTx ? "final" : "none",
    };
    let model;
    if (!m.ran) {
      model = { leg: "model payment", status: "none", usd: "0", xno: null, basis: "nothing ran", fundedBy: modelPayment };
    } else if (m.usd == null) {
      model = { leg: "model payment", status: "unknown", usd: null, xno: null, basis: q.outcome === "succeeded" ? "the provider reported no cost" : "the run did not complete; any provider cost is unknown and the operator's", fundedBy: modelPayment };
    } else {
      model = {
        leg: "model payment", status: "paid", usd: m.usd,
        xno: m.xno,
        basis: modelPayment === "wallet"
          ? (m.xno != null ? "XNO derived from the reported cost at the locked XNO/USD rate" : "paid in XNO from the operator's Nano wallet; XNO amount unknown (no XNO/USD rate was locked)")
          : modelPayment === "api_key" ? "paid from the operator's NanoGPT balance" : "paid by the operator",
        fundedBy: modelPayment,
      };
    }
    const refund = {
      leg: "refund", asset: symbol(q),
      amount: amountText(q, r.refund.amountAtomic ?? r.refund.yocto),
      ...(assetOf(q) === "usdc" ? { amountAtomic: r.refund.amountAtomic, tokenContract: q.tokenContract } : { yocto: r.refund.yocto }),
      to: r.refund.to, txHash: r.refund.txHash, explorerUrl: r.refund.explorerUrl,
      status: r.refund.status,
    };
    return [caller, model, refund, ...(r.authorPayout ? [{ leg: "author payout", ...r.authorPayout }] : [])];
  }

  function payoutView(q) {
    const intent = q.settlement?.authorPayout;
    if (!intent) return null;
    const rec = ledger.getPayout(q.id);
    return { asset: "XNO", to: intent.to, amountRaw: intent.amountRaw, amount: rawToXno(intent.amountRaw, 30),
      status: rec?.status === "sent" ? "sent" : "pending", txHash: rec?.txHash || null,
      explorerUrl: rec?.txHash ? `https://nanexplorer.com/nano/block/${rec.txHash}` : null };
  }

  function ensureAuthorPayout(q) {
    const intent = q.settlement?.authorPayout;
    if (!intent) return;
    if (ledger.getPayout(q.id)?.status === "sent") return;
    if (!authorPayouts) throw new Error("A Nano creator payout is owed; configure the original Nano wallet to recover it");
    authorPayouts.enqueue({ paymentId: q.id, ...intent });
    // Independent of customer delivery and same-asset change. The durable
    // outbox retains a failed send even after this quote is pruned.
    authorPayouts.tick().catch(() => log("Nano creator payout retry is pending"));
  }

  function refundView(q) {
    if (!q.refundId) return { status: "none", txHash: null };
    const r = ledger.getRefund(q.refundId);
    if (!r) return { status: "none", txHash: null };
    const status = r.status === "sent" ? "sent" : r.status === "failed_permanent" ? "failed_permanent" : "pending";
    return { status, txHash: r.txHash || null, amountYocto: r.amountYocto, to: r.to };
  }

  /** The receipt for a quote as the ledger has it now (refund status included). */
  function receiptFor(q) {
    const paid = BigInt(q.paidYocto || "0");
    const usdNano = BigInt(q.rate.usdNano), rateYocto = BigInt(q.rate.yocto);
    const s = q.settlement;
    let chargedYocto = 0n, refundYocto = paid;
    if (s) { chargedYocto = BigInt(s.chargedYocto); refundYocto = BigInt(s.refundYocto); }
    const rv = refundView(q);
    // A refund below the minimum is not sent; it counts toward the charge.
    if (!q.refundId && refundYocto > 0n && !s) { chargedYocto += refundYocto; refundYocto = 0n; }
    const costKnown = !!(s && s.costUsd != null);
    const capped = !!(s && costKnown && BigInt(s.chargedYocto) < BigInt(s.costYocto) + BigInt(s.feeYocto));
    const receipt = {
      rail: "near",
      network,
      paymentId: q.id,
      ...(assetOf(q) === "usdc" ? { asset: "USDC", tokenContract: q.tokenContract } : {}),
      deposit: {
        ...amountFields(q, paid),
        // What was actually sent, at the locked rate (the quote's USD deposit plus the dust).
        usd: yoctoToUsd(paid, usdNano, rateYocto),
        quotedUsd: q.depositUsd,
        txHash: q.payTx,
        explorerUrl: q.payTx ? explorerTxUrl(network, q.payTx) : null,
      },
      actualCost: {
        usd: costKnown ? exactUsd(s.costUsd) : null,
        exact: costKnown ? s.exact !== false : false,
        billedAs: costKnown ? s.billedAs || "reported" : null,
        reportedUsd: s && s.reportedUsd != null ? exactUsd(s.reportedUsd) : null,
      },
      serviceFee: { usd: costKnown ? assetOf(q) === "usdc" ? yoctoToUsd(BigInt(s.feeYocto), usdNano, rateYocto) : exactUsd(s.costUsd * 0.2) : "0" },
      charged: {
        ...amountFields(q, chargedYocto),
        usd: assetOf(q) === "near" && costKnown && !capped ? exactUsd(s.costUsd * 1.2) : yoctoToUsd(chargedYocto, usdNano, rateYocto),
        capped,
      },
      refund: {
        ...amountFields(q, refundYocto),
        usd: yoctoToUsd(refundYocto, usdNano, rateYocto),
        to: q.payer,
        status: refundYocto === 0n ? "none" : rv.status,
        txHash: rv.txHash,
        explorerUrl: rv.txHash ? explorerTxUrl(network, rv.txHash) : null,
      },
      rate: rateView(q),
      outcome: q.outcome,
      ...(payoutView(q) ? { authorPayout: payoutView(q) } : {}),
    };
    receipt.legs = receiptLegs(q, receipt);
    return formatReceipt(receipt);
  }

  /**
   * Result + receipt for a settled quote. `body` is the stripped tool result.
   * The engine's "cost: $X" line (model cost only) is replaced by what was
   * charged, so the result never shows two different "cost" figures.
   */
  function withReceipt(q, body, extraNote = null) {
    const rc = receiptFor(q);
    const r = rc.structured.receipt;
    const charged = `charged: $${r.charged.usd} (${shortNear(r.charged.amount ?? r.charged.near)} ${symbol(q)}): model cost $${r.actualCost.usd ?? "0"} + 20% service fee; ` +
      `refund ${shortNear(r.refund.amount ?? r.refund.near)} ${symbol(q)} ${r.refund.status}`;
    const content = (body.content || []).map((c) => (c && c.type === "text" && /^cost: \$/.test(c.text) ? { type: "text", text: charged } : c));
    if (extraNote) content.push({ type: "text", text: extraNote });
    content.push({ type: "text", text: rc.text });
    return { ...body, content, structuredContent: { ...(body.structuredContent || {}), ...rc.structured } };
  }

  /** The stored outcome of a finished quote. Never runs, charges or refunds. */
  function replay(q) {
    if (q.status === "settled") {
      const mem = results.get(q.id);
      if (mem) return withReceipt(q, mem);
      if (q.result) return withReceipt(q, q.result);
      return withReceipt(q, { content: [] }, TEXT_NOT_RETAINED);
    }
    // failed or rejected: a gate-authored sentence + the receipt
    const rc = receiptFor(q);
    const details = results.get(q.id)?.details;
    const head = q.error || "Nothing ran and nothing was charged.";
    const tail = q.outcome === "run_failed" ? `\n\n${details || ERROR_NOT_RETAINED}` : "";
    return errResult(`${head}\n\n${rc.text}${tail}`, rc.structured);
  }

  /**
   * Operator accounting fields for the settle event: the locked rates, NEAR in
   * and out, the USD model cost and (wallet-funded) the XNO it spent, derived.
   * Each asset keeps its own unit; nothing is netted across assets, and no
   * conversion here is an executed swap.
   */
  function accounting(q) {
    const s = q.settlement || {};
    const m = modelSpend(q);
    const charged = BigInt(s.chargedYocto || "0"), refunded = BigInt(s.refundYocto || "0");
    return {
      paidYocto: q.paidYocto,
      ...(assetOf(q) === "usdc" ? { asset: "USDC", chargedUsdc: formatUsdc(charged), refundUsdc: formatUsdc(refunded) }
        : { chargedNear: formatYoctoAsNear(charged), refundNear: formatYoctoAsNear(refunded) }),
      modelUsd: m.usd, modelPayment, modelXno: m.xno, modelXnoBasis: m.xno != null ? "derived" : null,
      rate: rateView(q),
    };
  }

  /* ---------------- refunds ---------------- */

  async function refundFor(q, to, amountYocto, reason) {
    const r = await refunder.refund({ paymentId: q.id, to, amountYocto, reason, ...refundAsset(q) });
    ev("refund", { paymentId: q.id, tool: q.tool, reason, to, amountYocto: amountYocto.toString(), status: r.status, hash: r.txHash || null });
    return r;
  }

  /* ---------------- quote ---------------- */

  /** Deposit amounts of unpaid quotes still held (open, or expired within expiredRetainMs). */
  function openAmounts(asset = "near") {
    const t = now();
    const taken = new Set();
    for (const q of ledger.quotes()) {
      if (assetOf(q) === asset && (q.status === "pending" || q.status === "expired") && t <= q.expiresAt + expiredRetainMs) taken.add(q.amountYocto);
    }
    return taken;
  }

  function openQuoteCount() {
    const t = now();
    let n = 0;
    for (const q of ledger.quotes()) if (q.status === "pending" && t <= q.expiresAt) n++;
    return n;
  }

  /** Drop unpaid quotes past retention and finished ones past a day, at most once a minute. */
  let lastPrune = 0;
  function maybePrune() {
    const t = now();
    if (t - lastPrune < 60_000) return;
    lastPrune = t;
    try { ledger.prune({ unpaidRetainMs: expiredRetainMs }); } catch (e) { log(`NEAR state prune failed: ${(e && e.message) || e}`); }
  }

  async function catalogsFor(graph) {
    return fetchCatalogs(graphModelKinds(graph), { baseUrl: baseUrl || undefined, fetch, log, consequence: ", so graphs using it cannot be quoted" });
  }

  /**
   * Everything a paid call is checked for before a quote (and again before a
   * paid run): argument shapes, graph safety, inputs, prices, caps. Returns
   * the pricing and the exact call to run: the bound graph and its inputs.
   * Throws GraphArgsError / ParamsError / GraphRefusedError.
   */
  async function prepare(registry, name, args, tool) {
    let graph, inputs, catalogs, metadata;
    if (name === RUN_NOODLE) {
      const read = await readGraphArgs(args, { allowShortLinks: false, fetch, limits: L });
      assertGraphSafe(read.graph, { inputs: read.inputs, limits: L });
      const prep = await registry.prepareRunNoodle(args, { read, allowShortLinks: false });
      graph = prep.workflowGraph;
      inputs = read.inputs;
      catalogs = prep.catalogs;
      metadata = read.graph.x402;
    } else {
      assertGraphSafe(tool.wf.graph, { inputs: args, limits: L });
      await registry.prepareCall({ name, arguments: args });
      graph = tool.wf.graph;
      inputs = args;
      catalogs = await catalogsFor(graph);
      metadata = tool.x402;
    }
    const pricing = priceGraph(graph, catalogs, { inputs });
    const refusals = refusalsForQuote(pricing, { maxDepositUsd: L.maxDepositUsd });
    if (refusals.length) throw new GraphRefusedError(refusals);
    // The run executes exactly the priced graph, through run_noodle, for saved tools too.
    let author;
    try { author = authorAddress(metadata); } catch (e) { throw new GraphArgsError(e.message); }
    return { pricing, author, run: { name: RUN_NOODLE, arguments: { graph: pricing.boundGraph, inputs } } };
  }

  async function quote(registry, name, args, tool, asset = "near", resumeTool = null) {
    if (asset === "usdc" && !usdcEnabled) throw new GraphArgsError("USDC payments are not enabled on this server. Request a NEAR quote instead.");
    const { pricing, author } = await prepare(registry, name, args, tool);
    if (author && !authorPayouts) return errResult("This workflow names a Nano author but the server has no Nano payout wallet configured. Nothing was quoted or charged.");
    maybePrune();
    if (openQuoteCount() >= maxOpenQuotes) {
      return errResult("This server is holding too many open quotes right now; try again in a few minutes. Nothing was charged.");
    }

    let r;
    try {
      r = asset === "usdc" ? await rate.currentUsdc() : await rate.current();
    } catch (e) {
      if (e instanceof NearError && e.code === "RATE_UNAVAILABLE") {
        const pair = (e.data && e.data.pair) || "NEAR/USD";
        const why = pair === "XNO/USD" ? " (this server pays its model provider in XNO, so the NEAR to XNO swap rate is unknown)" : "";
        return errResult(`Cannot quote in ${asset === "usdc" ? "USDC" : "NEAR"} right now: no current ${pair} rate${why}; try again shortly. Nothing was charged.`);
      }
      throw e;
    }
    if (author && !(r.xnoUsd != null && parseUsdNano(r.xnoUsd) > 0n)) return errResult("Cannot quote this authored workflow without a current XNO/USD rate for its Nano creator payout. Try again shortly. Nothing was charged.");
    const taken = openAmounts(asset);
    let amountYocto;
    try {
      const makeDeposit = asset === "usdc" ? usdcDeposit : depositYocto;
      amountYocto = asset === "usdc"
        ? makeDeposit(pricing.depositUsd, (y) => taken.has(y.toString()), ...(randomInt ? [randomInt] : []))
        : makeDeposit(pricing.depositUsd, r, (y) => taken.has(y.toString()), ...(randomInt ? [randomInt] : []));
    } catch (e) {
      if (e instanceof NearError && e.code === "NO_UNIQUE_AMOUNT") {
        return errResult("This server is holding too many open quotes at this price right now; try again in a few minutes. Nothing was charged.");
      }
      throw e;
    }
    const id = "nq_" + randomBytes(9).toString("base64url");
    const createdAt = now();
    const expiresAt = createdAt + quoteTtlMs;
    // Only what payment and settlement need is stored; the itemized pricing is in the answer.
    const record = {
      id, tool: name, ...(resumeTool ? { resumeTool } : {}), argsHash: hashArgs(name, args), status: "pending", author,
      ...(asset === "usdc" ? { asset, tokenContract: usdcToken } : {}),
      amountYocto: amountYocto.toString(),
      depositUsd: exactUsd(pricing.depositUsd),
      estimatedCostUsd: exactUsd(pricing.estimatedCostUsd),
      rate: { usdNano: r.usdNano.toString(), yocto: r.yocto.toString(),
        ...(asset === "usdc" ? { usdcUsd: "1" } : { nearUsd: r.nearUsd }), source: r.source, at: r.at, ...rateExtras(r) },
      createdAt, expiresAt,
      payTx: null, payer: null, paidYocto: null, paidAtBlockMs: null,
      settlement: null, refundId: null, result: null, error: null, outcome: null, finishedAt: null,
    };
    ledger.putQuote(record);
    ev("quote", { paymentId: id, tool: name, depositUsd: record.depositUsd, amountYocto: record.amountYocto, nearUsd: r.nearUsd, rateSource: r.source, ...rateExtras(r) });
    const likelyCharge = usdToYocto(pricing.likelyChargeUsd, r, "ceil");
    const baseYocto = asset === "usdc" ? usdToYocto(pricing.depositUsd, r, "ceil") : stepUp(usdToYocto(pricing.depositUsd, r, "ceil"));
    const q = formatQuote({
      pricing,
      now: createdAt,
      payment: {
        network, paymentId: id, payTo: merchantId,
        ...(asset === "usdc"
          ? { asset: "USDC", amountAtomic: record.amountYocto, amount: formatUsdc(amountYocto), tokenContract: usdcToken, decimals: 6,
              dustAmount: formatUsdc(amountYocto - baseYocto), likelyCharge: formatUsdc(likelyCharge) }
          : { amountYocto: record.amountYocto, amountNear: formatYoctoAsNear(amountYocto), dustNear: formatYoctoAsNear(amountYocto - baseYocto),
              likelyChargeNear: formatYoctoAsNear(likelyCharge, { maxDecimals: 6 }) }),
        depositUsd: record.depositUsd,
        ...(author ? { authorPayout: { asset: "XNO", to: author, basis: "the collected 20% markup, paid in Nano at the locked XNO/USD rate" } } : {}),
        depositUsdSent: estUsd(Number(yoctoToUsd(amountYocto, r.usdNano, r.yocto))),
        rate: rateView(record),
        expiresAt: new Date(expiresAt).toISOString(),
        ...(publicBase ? {
          payUrl: `${publicBase}/pay/${id}`,
          watchUrl: `${publicBase}/near/watch/${id}`,
          statusUrl: `${publicBase}/near/status/${id}`,
        } : {}),
      },
    });
    return { content: [{ type: "text", text: q.text }], structuredContent: q.structured };
  }

  /* ---------------- price_noodle with NEAR figures ---------------- */

  async function priceNear(args) {
    const { _pay_with = "near", ...priceArgs } = args;
    if (!["near", "usdc"].includes(_pay_with)) throw new GraphArgsError("_pay_with must be near or usdc");
    if (_pay_with === "usdc" && !usdcEnabled) throw new GraphArgsError("USDC payments are not enabled on this server");
    // computePrice also reports what stops a quote: live-priced or unpriced models, a deposit over the cap.
    const computed = await computePrice(priceArgs, { baseUrl, fetch, log, allowShortLinks: false, limits: L });
    if (_pay_with === "usdc") {
      const result = priceNoodleResult(computed, { note: "Request a USDC quote with _pay_with: usdc. Amounts use six decimal places; unused USDC returns on NEAR." });
      result.structuredContent.usdc = { network, tokenContract: usdcToken, decimals: 6, usdcUsd: "1", pricingBasis: "USDC denomination" };
      return result;
    }
    let note = null, near = null;
    if (computed.pricing) {
      try {
        const r = await rate.current();
        near = {
          network,
          nearUsd: r.nearUsd, rateSource: r.source, rateAt: r.at, rateExtras: rateExtras(r),
          likelyChargeNear: formatYoctoAsNear(usdToYocto(computed.pricing.likelyChargeUsd, r, "ceil"), { maxDecimals: 6 }),
          depositNear: formatYoctoAsNear(stepUp(usdToYocto(computed.pricing.depositUsd, r, "ceil")), { maxDecimals: 6 }),
          depositApprox: true,
        };
        note = `This server is paid in NEAR on ${network}. Call run_noodle with the same arguments for a quote; nothing is charged until you send the transfer.`;
      } catch (e) {
        if (!(e instanceof NearError && e.code === "RATE_UNAVAILABLE")) throw e;
        const pair = (e.data && e.data.pair) || "NEAR/USD";
        note = `No current ${pair} rate is available, so the figures are in USD only; a quote needs a rate and will fail until one is available.`;
      }
    }
    return priceNoodleResult(computed, { near, note });
  }

  /** XNO amount (9 decimals, half-up) of a USD amount; both in nano-USD. */
  const ratioXno = (usdNano, xnoUsdNano) => {
    const scale = 10n ** 9n;
    const q = (usdNano * scale * 2n + xnoUsdNano) / (2n * xnoUsdNano);
    const frac = (q % scale).toString().padStart(9, "0").replace(/0+$/, "");
    return frac ? `${q / scale}.${frac}` : `${q / scale}`;
  };

  const stepUp = (y) => ((y + DUST_STEP_YOCTO - 1n) / DUST_STEP_YOCTO) * DUST_STEP_YOCTO;

  /* ---------------- pay → run → settle ---------------- */

  async function acceptPayment(q0, tx, sender, ctx = null) {
    if (q0.status === "paid" || q0.status === "running" || FINAL.has(q0.status)) return null;
    if (typeof tx !== "string" || !tx.trim() || typeof sender !== "string" || !sender.trim()) {
      throw new GraphArgsError("the paying call needs _payment_tx (your transfer's transaction hash) and _payment_sender (the account you paid from) together with _payment_id");
    }
    const txHash = tx.trim(), senderId = sender.trim();
    try { base58Decode(txHash, 32); } catch { throw new GraphArgsError("_payment_tx must be a NEAR transaction hash (base58, 32 bytes)"); }
    if (!isNearAccountId(senderId)) throw new GraphArgsError("_payment_sender must be a NEAR account id, e.g. alice.testnet");

    const consumed = ledger.consumedBy(txHash);
    if (consumed && consumed !== q0.id) {
      return errResult("This transaction was already used for another payment. Send a new transfer for this quote, or ask for a new quote.");
    }

    const note = (s) => {
      if (ctx && typeof ctx.announce === "function") ctx.announce(s);
      else if (ctx && typeof ctx.report === "function") ctx.report(s);
    };
    note(`checking payment ${q0.id} on NEAR ${network}`);
    let t;
    try {
      t = await readPaymentTransfer({ rpc, txHash, senderId, merchantId,
        ...(assetOf(q0) === "usdc" ? { tokenContract: q0.tokenContract } : {}), ...(txTimeoutMs ? { txTimeoutMs } : {}) });
    } catch (e) {
      if (!(e instanceof NearError)) throw e;
      const why = {
        TX_NOT_FOUND: `Transaction ${txHash} was not found as final on ${network}. If you just sent it, wait 3 seconds and call again (finality takes about 2-3 s; retry for up to 30 s). If it still fails, check that _payment_tx is the hash your wallet printed, that _payment_sender is the account that signed it, and that you paid on ${network}. Nothing was consumed.`,
        TX_NOT_FINAL: `Transaction ${txHash} is not final on ${network} yet — wait a few seconds and call again. Nothing was consumed.`,
        TX_FAILED: `Transaction ${txHash} did not prove a successful ${symbol(q0)} payment. Send a new transfer of exactly the quoted amount.`,
        NOT_A_SINGLE_TRANSFER: assetOf(q0) === "usdc" ? `Transaction ${txHash} must contain exactly one ft_transfer on the quoted USDC contract with the exact recipient and amount.`
          : `Transaction ${txHash} is not exactly one native NEAR transfer (one Transfer action, nothing else). Send a plain transfer of exactly the quoted amount.`,
        WRONG_RECEIVER: `Transaction ${txHash} does not pay ${merchantId}. Send exactly the quoted amount to ${merchantId}.`,
        TX_MISMATCH: "The NEAR RPC returned a different transaction than the one asked for; try again.",
        RPC_UNAVAILABLE: "The NEAR RPC could not be reached to check the payment; try again shortly. Nothing was consumed.",
      }[e.code] || `The payment could not be checked (${e.code}); try again. Nothing was consumed.`;
      return errResult(why);
    }
    if (t.blockTimeMs < q0.createdAt - skewMs) {
      return errResult(`Transaction ${txHash} is older than this quote, so it cannot pay for it. Send a new transfer of exactly the quoted amount.`);
    }

    const wrongAmount = t.amountYocto !== BigInt(q0.amountYocto);
    if (wrongAmount && openAmounts(assetOf(q0)).has(t.amountYocto.toString())) {
      // The transfer carries the exact amount of ANOTHER open quote: it belongs to
      // that quote's payer. Consuming it here would let anyone who sees a payment
      // on chain burn it against a free quote of their own, so it is left untouched.
      return errResult(`Transaction ${txHash} sent ${amountText(q0, t.amountYocto)} ${symbol(q0)}, the exact amount of a different quote, ` +
        `so it was not used for this one (which asks for ${amountText(q0, q0.amountYocto)} ${symbol(q0)}). Nothing was consumed.`);
    }

    // From here to updateQuote there is no await: the consume and the status
    // change cannot interleave with another call.
    if (!ledger.getQuote(q0.id)) {
      return errResult("This quote expired while the transfer was being checked. Nothing was consumed; contact the operator if you already paid.");
    }
    if (consumed !== q0.id && !ledger.consumeTx(txHash, q0.id)) {
      return errResult("This transaction was already used for another payment. Send a new transfer for this quote, or ask for a new quote.");
    }
    const paidFields = { payTx: txHash, payer: t.payer, paidYocto: t.amountYocto.toString(), paidAtBlockMs: t.blockTimeMs };
    const reject = wrongAmount ? "wrong_amount" : t.blockTimeMs > q0.expiresAt ? "late_payment" : null;
    if (reject) {
      const error = reject === "wrong_amount"
        ? `The quote asked for exactly ${amountText(q0, q0.amountYocto)} ${symbol(q0)}.`
        : `The quote expired at ${new Date(q0.expiresAt).toISOString()}.`;
      let q = ledger.updateQuote(q0.id, { ...paidFields, status: "rejected", outcome: reject, error, finishedAt: now() });
      ev("paid", { paymentId: q.id, tool: q.tool, ok: false, outcome: reject, from: t.payer, amountYocto: paidFields.paidYocto, hash: txHash });
      const rf = await refundFor(q, t.payer, t.amountYocto, reject);
      q = ledger.updateQuote(q.id, { refundId: rf.refundId });
      return replay(q);
    }
    const q = ledger.updateQuote(q0.id, { ...paidFields, status: "paid" });
    ev("paid", { paymentId: q.id, tool: q.tool, ok: true, from: t.payer, amountYocto: paidFields.paidYocto, hash: txHash });
    return null;
  }

  /** Public payment state contains no workflow inputs or result text. */
  function paymentView(id) {
    const q = ledger.getQuote(id);
    if (!q) return null;
    const status = q.status === "pending" && now() > q.expiresAt ? "expired" : q.status;
    const paid = status === "paid" || status === "running" || status === "settled";
    return {
      paymentId: q.id, tool: q.resumeTool || q.tool, network, payTo: merchantId,
      ...(assetOf(q) === "usdc" ? amountFields(q, q.amountYocto) : { amountYocto: q.amountYocto, amountNear: formatYoctoAsNear(BigInt(q.amountYocto)) }),
      depositUsd: q.depositUsd, expiresAt: new Date(q.expiresAt).toISOString(), status,
      done: status !== "pending",
      ...(workflows.has(id) ? { workflow: workflows.get(id) } : {}),
      next: paid
        ? `Payment confirmed. Call ${q.resumeTool || q.tool} now with the original arguments plus _payment_id: "${q.id}" to receive the result. Do not pay again.`
        : status === "pending" ? "Pay this deposit in your wallet; keep monitoring until payment is confirmed."
        : "Ask your agent for a fresh quote. Do not pay this quote again.",
      ...(q.payTx ? { txHash: q.payTx } : {}),
      ...(FINAL.has(status) ? { receipt: receiptFor(q).structured.receipt } : {}),
    };
  }

  /** A wallet confirms a deposit; only the original bound MCP call can run it. */
  async function confirmPayment(id, tx, sender) {
    return withLock(id, async () => {
      const q = ledger.getQuote(id);
      if (!q) return { error: "Unknown payment id. Ask your agent for a fresh quote." };
      try {
        const refused = await acceptPayment(q, tx, sender);
        const view = paymentView(id);
        return refused?.isError
          ? { ...view, error: refused.content.map((c) => c.text || "").join("\n") }
          : view;
      } catch (e) {
        if (e instanceof GraphArgsError) return { ...paymentView(id), error: e.message };
        throw e;
      }
    });
  }

  function pendingQuotes() {
    const t = now();
    return ledger.quotes().filter((q) => ["pending", "expired"].includes(q.status) && t <= q.expiresAt + expiredRetainMs);
  }

  /** Discovered receipts are only hints: verify FINAL, then match an exact quote. */
  async function observeTransfer(txHash, senderId) {
    if (ledger.consumedBy(txHash)) return;
    let transfer;
    try {
      transfer = await readPaymentTransfer({ rpc, txHash, senderId, merchantId, ...(txTimeoutMs ? { txTimeoutMs } : {}) });
    } catch (e) {
      if (["NOT_A_SINGLE_TRANSFER", "WRONG_RECEIVER"].includes(e.code)) {
        if (!usdcToken || !pendingQuotes().some((q) => q.asset === "usdc")) return;
        try { transfer = await readPaymentTransfer({ rpc, txHash, senderId, merchantId, tokenContract: usdcToken, ...(txTimeoutMs ? { txTimeoutMs } : {}) }); }
        catch (ftError) {
          if (["NOT_A_SINGLE_TRANSFER", "WRONG_RECEIVER", "TX_FAILED"].includes(ftError.code)) return;
          throw ftError;
        }
      } else if (e.code === "TX_FAILED") return;
      else throw e;
    }
    const q = pendingQuotes().find((q) => assetOf(q) === (transfer.asset || "near") && q.amountYocto === transfer.amountYocto.toString()
      && transfer.blockTimeMs >= q.createdAt);
    if (q) {
      const result = await confirmPayment(q.id, txHash, senderId);
      if (result.error && result.status === "pending") throw new NearError("WATCH_CONFIRM_FAILED", "The discovered payment could not yet be confirmed");
    }
  }

  function waitForPayment(id, timeoutMs = 25_000, { signal } = {}) {
    if (signal?.aborted || paymentView(id)?.status !== "pending") return Promise.resolve();
    return waitForUpdate(id, timeoutMs, { signal });
  }

  function waitForUpdate(id, timeoutMs = 25_000, { signal, previous } = {}) {
    if (signal?.aborted || previous != null && JSON.stringify(paymentView(id)) !== previous) return Promise.resolve();
    return new Promise((resolve) => {
      const set = waiters.get(id) || new Set();
      waiters.set(id, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        set.delete(done);
        if (!set.size) waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  async function pay(registry, { name, args, argsHash, paymentId, tx, sender, ctx, tool }) {
    const q0 = ledger.getQuote(paymentId);
    if (!q0) return errResult(`Unknown or expired payment id "${paymentId}" — call again without _payment_id for a fresh quote.`);
    if (q0.tool !== name || q0.argsHash !== argsHash) {
      return errResult(`payment ${q0.id} was issued for a different call (tool/arguments changed) — ` +
        "call again without _payment_id to get a quote for these arguments.");
    }
    if (FINAL.has(q0.status)) return replay(q0);
    if (q0.status === "running") {
      return errResult(`payment ${q0.id} is still being processed — call again in a moment with the same arguments.`);
    }

    const refused = await acceptPayment(q0, tx, sender, ctx);
    if (refused) return refused;
    let q = ledger.getQuote(q0.id);
    if (FINAL.has(q.status)) return replay(q);
    // The payment page accepts the deposit without executing or retaining inputs.
    // The bound MCP call is still checked before any model work can begin.
    let prepared = null, prepError = null;
    try { prepared = await prepare(registry, name, args, tool); } catch (e) { prepError = e; }
    q = ledger.updateQuote(q.id, { status: "running" });
    if (ctx?.announce) ctx.announce(`payment verified — running ${name}`);

    let res;
    try {
      if (prepError) throw prepError;
      res = await registry.callTool(prepared.run, {
        ...ctx,
        workflow(state) { workflows.set(q.id, state); changed(q.id); ctx?.workflow?.(state); },
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const error = "The run did not complete. Provider costs already incurred are the operator's, not yours; you can try again with a new quote.";
      // Persist the failure before the refund goes out, so a restart never re-runs it.
      q = ledger.updateQuote(q.id, { status: "failed", outcome: "run_failed", error, finishedAt: now() });
      results.set(q.id, { details: `Details: ${msg}` });
      const rf = await refundFor(q, q.payer, BigInt(q.paidYocto), "run_failed");
      q = ledger.updateQuote(q.id, { refundId: rf.refundId });
      return replay(q);
    }

    const body = strip(res);
    // The provider's reported cost settles the run. When it reported only part
    // of it (costExact false) or nothing, the caller is charged the estimated
    // cost instead of a lower bound: strangers choose the models here.
    const reportedUsd = knownUsd(res.costUsd);
    const estimatedUsd = knownUsd(q.estimatedCostUsd);
    let settleUsd = res.costUsd, billedAs = "reported";
    if ((res.costExact === false || reportedUsd == null) && estimatedUsd != null && estimatedUsd > (reportedUsd ?? 0)) {
      settleUsd = q.estimatedCostUsd;
      billedAs = "estimate";
    }
    const s = settleYocto({
      depositYocto: BigInt(q.paidYocto),
      costUsd: settleUsd,
      rate: { usdNano: BigInt(q.rate.usdNano), yocto: BigInt(q.rate.yocto) },
      ...(assetOf(q) === "usdc" ? { minRefundYocto: 1n } : {}),
    });
    const costUsd = s.known ? knownUsd(settleUsd) : null;
    const authorRaw = q.author ? authorPayoutRaw(s, q.rate, parseUsdNano(q.rate.xnoUsd)) : 0n;
    // The settlement is on disk before the refund intent: a restart in between
    // finishes this settlement instead of refunding the whole deposit.
    q = ledger.updateQuote(q.id, {
      settlement: {
        costUsd, exact: s.known ? res.costExact !== false && billedAs === "reported" : false,
        billedAs, reportedUsd: reportedUsd ?? null,
        costYocto: s.costYocto.toString(), feeYocto: s.feeYocto.toString(),
        chargedYocto: s.chargedYocto.toString(), refundYocto: s.refundYocto.toString(),
        ...(authorRaw > 0n ? { authorPayout: { to: q.author, amountRaw: authorRaw.toString() } } : {}),
      },
    });
    ensureAuthorPayout(q);
    results.set(q.id, body);
    const rf = await refunder.refund({ paymentId: q.id, to: q.payer, amountYocto: s.refundYocto, reason: "change", ...refundAsset(q) });
    // Media-only results (links) may be kept; text output is the caller's paid content and stays in memory.
    const persisted = res.textOutput ? null : { content: (body.content || []).filter((c) => c && c.type === "text") };
    q = ledger.updateQuote(q.id, { status: "settled", outcome: "succeeded", refundId: rf.refundId, result: persisted, finishedAt: now() });
    ev("change", {
      paymentId: q.id, tool: name, to: q.payer, costUsd,
      chargedYocto: s.chargedYocto.toString(), refundYocto: s.refundYocto.toString(), status: rf.status, hash: rf.txHash || null,
      ...accounting(q),
    });
    return withReceipt(q, body);
  }

  /* ---------------- startup recovery ---------------- */

  async function resume() {
    if (!authorPayouts && ledger.payouts().some(p => p.status !== "sent")) throw new Error("Nano creator payouts are owed; configure the original Nano wallet before resuming");
    const t = now();
    for (const q of ledger.quotes()) {
      if (q.asset != null && !["near", "usdc"].includes(q.asset)) throw new NearError("STATE_UNREADABLE", "A stored quote has an unknown asset");
      if (q.asset === "usdc" && q.tokenContract !== usdcToken) throw new NearError("STATE_MISMATCH", "A stored USDC quote belongs to a different token contract");
      if (q.status === "running") {
        if (q.settlement) {
          ensureAuthorPayout(q);
          // The run finished and was settled; only the refund intent may be missing.
          const rf = await refunder.refund({ paymentId: q.id, to: q.payer, amountYocto: BigInt(q.settlement.refundYocto), reason: "change", ...refundAsset(q) });
          ledger.updateQuote(q.id, { status: "settled", outcome: "succeeded", refundId: rf.refundId, result: null, finishedAt: t });
          log(`NEAR payment ${q.id}: settled after a restart (the result text was not kept)`);
        } else {
          const error = "The server restarted while this run was in progress.";
          const done = ledger.updateQuote(q.id, { status: "failed", outcome: "interrupted", error, finishedAt: t });
          const rf = await refundFor(done, q.payer, BigInt(q.paidYocto), "interrupted");
          ledger.updateQuote(q.id, { refundId: rf.refundId });
          log(`NEAR payment ${q.id}: interrupted by a restart — whole deposit refunded (${rf.status}), not re-run`);
        }
      } else if ((q.status === "failed" || q.status === "rejected") && q.paidYocto && !q.refundId) {
        // Stopped between recording the outcome and recording the refund: owe it now.
        const reason = q.outcome === "wrong_amount" || q.outcome === "late_payment" || q.outcome === "interrupted" ? q.outcome : "run_failed";
        const rf = await refundFor(q, q.payer, BigInt(q.paidYocto), reason);
        if (rf.refundId) ledger.updateQuote(q.id, { refundId: rf.refundId });
      } else if (q.status === "pending" && t > q.expiresAt) {
        ledger.updateQuote(q.id, { status: "expired" });
      }
      if (q.status === "settled") ensureAuthorPayout(q);
    }
    await refunder.resume();
    await authorPayouts?.resume();
    ledger.prune({ unpaidRetainMs: expiredRetainMs });
  }

  /* ---------------- registry wrapper ---------------- */

  /** run_noodle / price_noodle argument descriptions as this paid server applies them. */
  function nearGraphProps(props) {
    const out = { ...props };
    if (usdcEnabled) out._pay_with = { type: "string", enum: ["near", "usdc"], description: "Payment asset on NEAR. Default near; choose usdc for a USDC quote. The quoted asset also determines the refund asset." };
    if (out.url) out.url = { ...out.url, description: "A full nanoodle share link with its #g=, #j= or #a= fragment (short links are refused here). Pass url OR graph." };
    if (out.inputs) {
      out.inputs = {
        ...out.inputs,
        description: 'Text inputs keyed by input name, e.g. { "Idea": "a lighthouse at dawn" }; this paid server accepts no media inputs. Omit to use the graph\'s saved text.',
      };
    }
    return out;
  }

  function wrapRegistry(registry) {
    const paidSaved = [];
    for (const t of registry.tools) {
      if (!t.wf || t.builtin || t.humanize) continue;
      const c = checkGraphSafety(t.wf.graph, { limits: L });
      if (c.ok) paidSaved.push(t.name);
      else log(`NEAR mode: not offering ${t.name}: ${c.refusals[0].message}`);
    }
    const savedSet = new Set(paidSaved);
    const paidNames = new Set([RUN_NOODLE, ...paidSaved]);
    const offeredNames = new Set([...paidNames, PRICE_NOODLE_NAME, NOODLE_GUIDE_NAME]);
    const paidLine = `paid in ${usdcEnabled ? "NEAR or USDC" : "NEAR"} on ${network}: a deposit is held up front, you are charged the actual model cost + 20% service fee, ` +
      "and the rest is refunded automatically — call price_noodle first for the itemized estimate";

    const listTools = () => registry.listTools()
      .filter((t) => offeredNames.has(t.name))
      .map((t) => {
        if (t.name === PRICE_NOODLE_NAME) return { ...t, inputSchema: { ...t.inputSchema, properties: nearGraphProps(t.inputSchema.properties || {}) } };
        if (!paidNames.has(t.name)) return t;
        let description = t.description.replace(/every call spends real credit from [^;.]+/, paidLine);
        let props = { ...(t.inputSchema.properties || {}) };
        if (t.name === RUN_NOODLE) {
          description = description.replace(/ Direct share links decode locally;.*$/, "").replace(", or a da.gd/TinyURL short link to one", "") +
            " This paid server refuses short links, media inputs and node types it cannot price (see noodle_guide).";
          props = nearGraphProps(props);
        }
        return {
          ...t,
          description,
          inputSchema: {
            ...t.inputSchema,
            properties: {
              ...props,
              ...(usdcEnabled ? { _pay_with: { type: "string", enum: ["near", "usdc"], description: "Choose the payment asset. Default near; usdc pays and refunds Circle-issued USDC on NEAR." } } : {}),
              _payment_id: {
                type: "string",
                description: "The paymentId from this tool's quote. After the pay page confirms payment, repeat the original arguments plus this id. Agents paying directly also supply _payment_tx and _payment_sender.",
              },
              _payment_tx: {
                type: "string",
                description: "Hash (base58) of the exact quoted payment: one native Transfer for NEAR, or one ft_transfer on the quoted token contract for USDC.",
              },
              _payment_sender: {
                type: "string",
                description: "The NEAR account you paid from. It locates the transaction; the refund goes to the transaction's signer.",
              },
            },
          },
        };
      });

    async function callTool(params, ctx = null) {
      if (params == null || typeof params !== "object" || Array.isArray(params)) return registry.callTool(params);
      const name = params.name;
      if (name === NOODLE_GUIDE_NAME) return registry.callTool(params);
      const rawArgs = params.arguments == null ? {} : params.arguments;
      if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new ParamsError("tools/call arguments must be an object");
      try {
        if (name === PRICE_NOODLE_NAME) return await priceNear(rawArgs);
        if (!paidNames.has(name)) {
          throw new ParamsError(`unknown tool "${name}" — available: ${[...offeredNames].join(", ")}`);
        }
        const { _payment_id, _payment_tx, _payment_sender, _pay_with, ...args } = rawArgs;
        if (_pay_with != null && !["near", "usdc"].includes(_pay_with)) throw new GraphArgsError("_pay_with must be near or usdc");
        const tool = savedSet.has(name) ? registry.tools.find((x) => x.name === name) : null;
        if (_payment_id == null) {
          if (_payment_tx != null || _payment_sender != null) {
            throw new GraphArgsError("_payment_tx and _payment_sender go with _payment_id: call without all three to get a quote first");
          }
          return await quote(registry, name, args, tool, _pay_with || "near", /^[a-zA-Z0-9_-]{1,64}$/.test(ctx?.paymentTool || "") ? ctx.paymentTool : null);
        }
        const paymentId = String(_payment_id);
        const existing = ledger.getQuote(paymentId);
        if (_pay_with != null && existing && _pay_with !== assetOf(existing)) throw new GraphArgsError("The payment asset cannot change after quoting. Resume with the quoted asset or omit _pay_with.");
        return await withLock(paymentId, () => pay(registry, {
          name, args, argsHash: hashArgs(name, args), paymentId, tx: _payment_tx, sender: _payment_sender, ctx, tool,
        }));
      } catch (e) {
        if (e instanceof GraphRefusedError) return refusedResult(e.refusals);
        throw e;
      }
    }

    // Which names this gate sells and which only it offers (the dual-rail router reads these).
    return { listTools, callTool, sells: (n) => paidNames.has(n), nearOnly: new Set([RUN_NOODLE, PRICE_NOODLE_NAME, NOODLE_GUIDE_NAME]),
      assets: new Set(["near", ...(usdcEnabled ? ["usdc"] : [])]) };
  }

  return { wrapRegistry, resume, authorPayouts, quote: paymentView, confirmPayment, waitForPayment, waitForUpdate, pendingQuotes, observeTransfer,
    // The private payment URL is also the capability to read this paid result.
    // This getter never runs a workflow, accepts payment or changes settlement.
    result(id) { const q = ledger.getQuote(id); return q && FINAL.has(q.status) ? replay(q) : null; },
  };
}
