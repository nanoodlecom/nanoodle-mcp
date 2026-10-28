/**
 * Per-request deposit for humanize-comment.
 *
 * On a hosted payment the quote caps what the customer pays for this request.
 * Settlement charges the customer the lesser of the metered cost plus 20% and
 * this deposit, and the difference is returned. A provider can still meter
 * more. The operator absorbs any overrun, including on a call that was already
 * in flight. A hosted run also stops before the next paid step, and refuses an
 * invoice, when that step would pass the deposit. This refund and cap apply
 * to hosted payments. Direct-wallet spending has no cap and is not refunded.
 *
 * The priced worst case is only a little above a typical run: one call per
 * writer, one extra retry, the decider, and a second decider pass when a
 * protected span can be repaired or the call can ask the decider to confirm
 * one fitting rewrite (a title, a maxChars cap, or a required ending).
 * When Cydonia fails and the Starry Ocean fallback runs, both calls are charged.
 * Output tokens are sized from the request (maxChars,
 * or the draft length) plus a small slack, not from the model's output cap.
 * The decider's cap adds the ranking JSON and GLM reasoning tokens, which
 * share max_tokens. A caller that already chose writer and judge caps
 * (subnano_comment sizes them from the original draft) is priced at those
 * caps, so a shorter refined draft cannot shrink the hold below the request
 * that will actually be sent. Token counts are a realistic estimate, bytes /
 * 3.5. The deposit is that
 * charge times HUMANIZE_DEPOSIT_MARGIN, at least the floor, rounded up, and
 * never below the charge. Prices are USD per million tokens: the public
 * catalog when it has a rate, otherwise the table below (NanoGPT, 20 Oct 2026).
 */
import {
  HUMANIZE_FALLBACKS, HUMANIZE_INPUT_CAPS, HUMANIZE_PRICED_REASKS, HUMANIZE_SETTLE_MARKUP,
  MAX_CHARS_LIMIT, ONE_THREAD_PREFIX, REASK_TEXT, candidateByteCap, collectSpans,
  estimateTokensFromBytes, guardRetryPrompt, judgeOutputTokenCap, requestOutputTokenCap, tokenUpperBound, writerForwardByteCap, writerNote,
} from "./humanize.mjs";
import { knownUsd } from "./usd.mjs";

export { HUMANIZE_SETTLE_MARKUP };

/** USD per million tokens, [input, output]. Catalog rates override these when present. */
export const HUMANIZE_MODEL_PRICES = Object.freeze({
  "qwen/qwen3.8-27b-novelist": [0.1, 0.6],
  "deepseek/deepseek-v4.1-flash-1017": [0.1, 0.6],
  "TheDrummer/Cydonia-24B-v4.3": [0.12, 0.15],
  "gemma-4-12b-it-starry-ocean": [0.05, 0.25],
  "qwen/qwen3.8-27b-antislop": [0.1, 0.6],
  "inception/mercury-3": [0.1, 0.35],
  "z-ai/glm-5.3": [0.6, 1.1],
});

/** Extra hold above the maximum charge. 12% sits inside the 10–15% band. */
export const HUMANIZE_DEPOSIT_MARGIN = 0.12;
/** Smallest deposit, in USD. A request whose charge is already above this is unaffected. */
export const HUMANIZE_DEPOSIT_FLOOR_USD = 0.001;

const bytes = (s) => tokenUpperBound(s);

/**
 * Bytes per token for caller text (draft, context, guidance) on the decider.
 * The decider (GLM) is the most expensive model per token, and it reads every
 * caller byte plus five rewrites. Real tokenizers can come in well under 3.5
 * bytes per token on long technical context (code, numbers, URLs), so a long
 * call that the writers already metered a little high left no room for the
 * decider. Caller bytes on the decider are priced at this denser rate, so the
 * reserve grows with context length and stays small for a short call.
 */
export const HUMANIZE_DECIDER_CALLER_BYTES_PER_TOKEN = 2.5;

/** Decider input tokens: fixed prompt text at the usual rate, caller text at the dense rate. */
function deciderInTokens(fixedBytes, callerBytes) {
  return estimateTokensFromBytes(fixedBytes) + Math.ceil(Math.max(0, callerBytes) / HUMANIZE_DECIDER_CALLER_BYTES_PER_TOKEN);
}

function findArg(args, name) {
  if (!args || typeof args !== "object") return undefined;
  const k = Object.keys(args).find((x) => String(x).trim().toLowerCase() === name);
  return k == null ? undefined : args[k];
}

function nodeById(graph, id) {
  const n = (graph.nodes || []).find((x) => x.id === id) || null;
  return n;
}

function nodeText(graph, id) {
  const n = nodeById(graph, id);
  return n && n.fields && n.fields.text != null ? String(n.fields.text) : "";
}

/** Catalog chat rows win when both rates are positive. Anything else keeps the known rate. */
export function humanizePriceTable(catalogs) {
  const table = { ...HUMANIZE_MODEL_PRICES };
  const rows = catalogs && catalogs.chat;
  if (!Array.isArray(rows)) return table;
  for (const row of rows) {
    const id = row && row.id;
    const p = row && row.pricing;
    if (!id || !p) continue;
    const pin = knownUsd(p.prompt);
    const pout = knownUsd(p.completion);
    if (pin == null || pout == null || !(pin > 0) || !(pout > 0)) continue;
    table[id] = [pin, pout];
  }
  return table;
}

function rate(table, model) {
  const r = table[model];
  if (!r || !(r[0] > 0) || !(r[1] > 0)) return null;
  return r;
}

/** Round a deposit up to 1e-8 USD without bumping a value that is already on the grid. */
export function ceilUsd(n) {
  const scale = 1e8;
  const x = n * scale;
  const nearest = Math.round(x);
  if (Math.abs(x - nearest) <= 1e-4) return nearest / scale;
  return Math.ceil(x - 1e-6) / scale;
}

/**
 * Deposit for a known maximum charge. Floor, then the margin, rounded up.
 * The result is always >= the charge.
 */
export function depositFromCharge(chargeUsd) {
  const charge = knownUsd(chargeUsd);
  if (charge == null) throw new Error("charge must be a non-negative number");
  const target = Math.max(HUMANIZE_DEPOSIT_FLOOR_USD, charge * (1 + HUMANIZE_DEPOSIT_MARGIN));
  let deposit = ceilUsd(target);
  if (deposit + 1e-12 < charge) deposit = ceilUsd(charge);
  return deposit;
}

/** What the caller pays: the lesser of metered cost + 20% and the quoted deposit. */
export function settledChargeUsd(meteredUsd, depositUsd) {
  const metered = knownUsd(meteredUsd);
  if (metered == null || metered <= 0) return 0;
  const marked = metered * HUMANIZE_SETTLE_MARKUP;
  if (depositUsd == null) return marked;
  const deposit = knownUsd(depositUsd);
  if (deposit == null) throw new Error("deposit is not a usable USD amount");
  return Math.min(marked, deposit);
}

function longestRetry(spans, maxChars, ending, title) {
  const opts = { spans, maxChars };
  const options = [REASK_TEXT, guardRetryPrompt(["echo"], opts)];
  if (spans && spans.length) options.push(guardRetryPrompt(["keep"], opts));
  if (title) options.push(guardRetryPrompt(["title"], opts));
  if (maxChars) options.push(guardRetryPrompt(["max"], opts));
  if (ending === "question") options.push(guardRetryPrompt(["question"], opts));
  return options.reduce((a, b) => bytes(a) >= bytes(b) ? a : b);
}

/**
 * Worst-case metered cost (USD, before the 20% markup) for one fully specified
 * request shape.
 */
function providerUsd(graph, spec, prices) {
  const built = stageCalls(graph, spec, prices);
  if (!built) return null;
  return built.units / 1e6;
}

function stageCalls(graph, spec, prices) {
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const judge = byId.get("judge");
  const jin = byId.get("j-in");
  if (!judge || !jin) throw new Error("humanize graph is missing the decider or the writer input");
  const judgeRate = rate(prices, judge.fields.model);
  if (!judgeRate) return null;
  const sep = bytes(jin.fields.sep);
  const { writerOut, judgeOut } = outputCaps(spec);
  const calls = [];
  const retries = [];
  for (const id of ["w-a", "w-b", "w-c", "w-d", "w-e"]) {
    const n = byId.get(id);
    if (!n) throw new Error(`humanize graph is missing writer ${id}`);
    const primary = rate(prices, n.fields.model);
    if (!primary) return null;
    const baseBytes = bytes(n.fields.system) + spec.writerBytes + spec.contextBytes + spec.guidanceBytes + 2 * sep + spec.noteExtraBytes;
    const inTok = estimateTokensFromBytes(baseBytes);
    const retryTok = estimateTokensFromBytes(baseBytes + writerForwardByteCap(writerOut) + bytes(spec.retryText));
    const fbModel = HUMANIZE_FALLBACKS[n.fields.model];
    const fb = fbModel ? rate(prices, fbModel) : null;
    if (fbModel && !fb) return null;
    const priced = (model, pc, input) => ({ model, inTokens: input, outTokens: writerOut, rate: pc });
    const primaryCall = priced(n.fields.model, primary, inTok);
    const primaryRetry = priced(n.fields.model, primary, retryTok);
    if (fb) {
      // The quote reserves the larger of these two rates. When Cydonia fails and
      // Starry runs, both calls are charged. A hosted run refuses an invoice that
      // does not fit the remaining deposit. Direct-wallet spending has no cap.
      const fbCall = priced(fbModel, fb, inTok);
      const fbRetry = priced(fbModel, fb, retryTok);
      calls.push(callUsd(fbCall) > callUsd(primaryCall) ? fbCall : primaryCall);
      retries.push(callUsd(fbRetry) > callUsd(primaryRetry) ? fbRetry : primaryRetry);
    } else {
      calls.push(primaryCall);
      retries.push(primaryRetry);
    }
  }
  retries.sort((a, b) => callUsd(b) - callUsd(a));
  calls.push(...retries.slice(0, HUMANIZE_PRICED_REASKS));
  const seps = ["k1", "k2", "k3", "k4", "k5", "k6", "j-cg"].reduce((a, id) => {
    const n = byId.get(id);
    return a + (n ? bytes(n.fields.sep) : 0);
  }, 0);
  const candidateBytes = Array.isArray(spec.spans)
    ? candidateByteCap(writerOut, spec.spans, { ending: spec.ending, draft: spec.draftText })
    : writerForwardByteCap(writerOut) + (spec.spanBytes || 0) + (spec.endingExtra || 0);
  const callerBytes = spec.draftBytes + spec.contextBytes + spec.guidanceBytes;
  const judgeFixed = bytes(judge.fields.system) + seps + 5 * candidateBytes;
  calls.push({ model: judge.fields.model, kind: "decider", inTokens: deciderInTokens(judgeFixed, callerBytes), outTokens: judgeOut, rate: judgeRate });
  if (needsSecondDecider(spec)) {
    const longLabel = Math.max(...["k2", "k3", "k4", "k5", "k6"].map((id) => bytes(byId.get(id).fields.sep)));
    const reviewFixed = bytes(judge.fields.system)
      + bytes(byId.get("j-cg").fields.sep) + bytes(byId.get("k1").fields.sep) + longLabel
      + candidateBytes;
    calls.push({ model: judge.fields.model, kind: "review", inTokens: deciderInTokens(reviewFixed, callerBytes), outTokens: judgeOut, rate: judgeRate });
  }
  const units = calls.reduce((a, c) => a + c.inTokens * c.rate[0] + c.outTokens * c.rate[1], 0);
  return { calls, units, candidateBytes };
}

function callUsd(call) {
  return call.inTokens * call.rate[0] + call.outTokens * call.rate[1];
}

/**
 * Writer and decider max_tokens for this quote. Explicit caps win: they are
 * the request that will be sent. A writer cap with no judge cap still reserves
 * the ranking JSON and the reasoning headroom on top of that writer cap.
 */
function outputCaps(spec) {
  const writerGiven = Math.floor(Number(spec.writerOutTokens) || 0);
  const judgeGiven = Math.floor(Number(spec.judgeOutTokens) || 0);
  const writerOut = writerGiven > 0
    ? writerGiven
    : requestOutputTokenCap(spec.maxChars, spec.draftText || "");
  const judgeOut = judgeGiven > 0
    ? judgeGiven
    : writerGiven > 0
      ? judgeOutputTokenCap(writerOut)
      : requestOutputTokenCap(spec.maxChars, spec.draftText || "", { judge: true });
  return { writerOut, judgeOut };
}

function withOutputCaps(spec, opts) {
  const writer = Math.floor(Number(opts && opts.writerOutTokens) || 0);
  const judge = Math.floor(Number(opts && opts.judgeOutTokens) || 0);
  if (writer > 0) spec.writerOutTokens = writer;
  if (judge > 0) spec.judgeOutTokens = judge;
  return spec;
}

/**
 * A second decider call. Span repair uses it when every rewrite drops a
 * protected phrase. A title, a maxChars cap, or a required ending uses it
 * when the first ranking is unusable and one rewrite still fits: that check
 * is a paid call, so the quote reserves it up front.
 */
function needsSecondDecider(spec) {
  return !!(spec.repair || spec.title || spec.maxChars != null || spec.ending === "question" || spec.ending === "keep_last");
}

/**
 * The shapes a legal request can take at the input caps. The ceiling is the
 * most expensive of them. Output tokens follow the draft's bytes, or maxChars
 * when that cap is set. A protected draft adds the restored phrases and a
 * repair review.
 */
export function humanizeCeilingSpecs() {
  const { Draft, Context, Guidance } = HUMANIZE_INPUT_CAPS;
  const emoji = "😀";
  const draft = emoji.repeat(Draft);
  const context = emoji.repeat(Context);
  const guidance = ONE_THREAD_PREFIX + emoji.repeat(Guidance);
  const contextBytes = bytes(context);
  const guidanceBytes = bytes(guidance);
  const draftBytes = bytes(draft);
  const { writerDraft, spans } = collectSpans(draft, [draft]);
  const shared = { contextBytes, guidanceBytes, draftBytes, draftText: draft };
  const plainNote = writerNote([], "keep_last", null);
  const keepNote = writerNote(spans, "any", null);
  const capNote = writerNote([], "question", MAX_CHARS_LIMIT);
  return [
    {
      ...shared,
      maxChars: null,
      writerBytes: draftBytes,
      noteExtraBytes: plainNote ? 2 + bytes(plainNote) : 0,
      retryText: longestRetry([], null, "keep_last", true),
      repair: true,
      spans: [],
      ending: "keep_last",
    },
    {
      ...shared,
      maxChars: null,
      writerBytes: bytes(writerDraft),
      noteExtraBytes: keepNote ? 2 + bytes(keepNote) : 0,
      retryText: longestRetry(spans, null, "any", true),
      repair: true,
      spans,
      ending: "any",
    },
    {
      ...shared,
      maxChars: MAX_CHARS_LIMIT,
      writerBytes: draftBytes,
      noteExtraBytes: capNote ? 2 + bytes(capNote) : 0,
      retryText: longestRetry([], MAX_CHARS_LIMIT, "question", true),
      repair: true,
      spans: [],
      ending: "question",
    },
  ];
}

/** The published extreme: the more expensive of the capped shapes above. */
export function humanizeCeilingSpec(graph = null, prices = HUMANIZE_MODEL_PRICES) {
  const specs = humanizeCeilingSpecs();
  if (!graph) return specs[specs.length - 1];
  let best = specs[0];
  let bestUsd = -1;
  for (const spec of specs) {
    const usd = providerUsd(graph, spec, prices);
    if (usd != null && usd > bestUsd) { bestUsd = usd; best = spec; }
  }
  return best;
}

function specFromArgs(graph, args) {
  const draft = findArg(args, "draft");
  const context = findArg(args, "context");
  const guidanceArg = findArg(args, "guidance");
  const draftText = draft == null ? "" : String(draft);
  const contextText = context == null ? "" : String(context);
  const guidanceText = guidanceArg === undefined ? nodeText(graph, "guidance") : (guidanceArg == null ? "" : String(guidanceArg));
  const maxRaw = findArg(args, "maxchars");
  const maxChars = typeof maxRaw === "number" && Number.isFinite(maxRaw) ? maxRaw : null;
  const endingRaw = findArg(args, "ending");
  const ending = endingRaw == null || endingRaw === "" ? "any" : String(endingRaw).trim();
  const keepRaw = findArg(args, "keep");
  const keep = Array.isArray(keepRaw) ? keepRaw.filter((s) => typeof s === "string") : [];
  const title = findArg(args, "title") === true;
  const { cleanDraft, writerDraft, spans } = collectSpans(draftText, keep);
  const note = writerNote(spans, ending, maxChars);
  return {
    contextBytes: bytes(contextText),
    guidanceBytes: bytes(guidanceText),
    draftBytes: bytes(cleanDraft),
    writerBytes: bytes(writerDraft),
    draftText,
    noteExtraBytes: note ? 2 + bytes(note) : 0,
    maxChars,
    retryText: longestRetry(spans, maxChars, ending, title),
    repair: spans.length > 0,
    title,
    spans,
    ending,
  };
}

/**
 * Maximum USD the gate can retain for this request (metered worst case + 20%).
 * Null when a model has no price — the caller then keeps the pinned ceiling.
 */
export function humanizeChargeUsd(graph, args, { prices = HUMANIZE_MODEL_PRICES, ceiling = false, writerOutTokens = 0, judgeOutTokens = 0 } = {}) {
  if (!ceiling) {
    const provider = providerUsd(graph, withOutputCaps(specFromArgs(graph, args), { writerOutTokens, judgeOutTokens }), prices);
    if (provider == null) return null;
    return provider * HUMANIZE_SETTLE_MARKUP;
  }
  let best = null;
  for (const spec of humanizeCeilingSpecs()) {
    const provider = providerUsd(graph, spec, prices);
    if (provider == null) return null;
    const charge = provider * HUMANIZE_SETTLE_MARKUP;
    if (best == null || charge > best) best = charge;
  }
  return best;
}

/** Per-call token caps for a request. Tests recompute the charge from these. */
export function humanizeStageBudget(graph, args, opts = {}) {
  const prices = opts.prices || HUMANIZE_MODEL_PRICES;
  const spec = opts.ceiling ? humanizeCeilingSpec(graph, prices) : withOutputCaps(specFromArgs(graph, args), opts);
  const built = stageCalls(graph, spec, prices);
  if (!built) return null;
  return {
    calls: built.calls.map((c) => ({ model: c.model, kind: c.kind || "writer", inTokens: c.inTokens, outTokens: c.outTokens, rate: c.rate })),
    candidateBytes: built.candidateBytes,
    providerUsd: built.units / 1e6,
    chargeUsd: built.units / 1e6 * HUMANIZE_SETTLE_MARKUP,
  };
}

/**
 * Estimated provider USD for the decider (and its second pass), used as
 * headroom in the run's admission checks: until the decider starts, a writer,
 * fallback, or re-ask is admitted only if it fits with this estimate counted.
 * It is not money set aside and does not guarantee the decider runs; actual
 * metered costs can still exceed it. Null when a model has no price.
 */
export function humanizeDeciderReserveUsd(graph, args, opts = {}) {
  const prices = opts.prices || HUMANIZE_MODEL_PRICES;
  const built = stageCalls(graph, withOutputCaps(specFromArgs(graph, args), opts), prices);
  if (!built) return null;
  return built.calls.filter((c) => c.kind === "decider" || c.kind === "review").reduce((a, c) => a + callUsd(c), 0) / 1e6;
}

/** Deposit for one call. Never below humanizeChargeUsd for the same arguments. */
export function humanizeDepositUsd(graph, args, opts = {}) {
  const charge = humanizeChargeUsd(graph, args, opts);
  if (charge == null) return null;
  return depositFromCharge(charge);
}

/** Deposit for the longest legal request. Recorded on the graph as the cold ceiling. */
export function humanizeCeilingDepositUsd(graph, opts = {}) {
  const charge = humanizeChargeUsd(graph, null, { ...opts, ceiling: true });
  if (charge == null) return null;
  return depositFromCharge(charge);
}
