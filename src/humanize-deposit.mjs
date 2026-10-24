/**
 * Per-request deposit for humanize-comment.
 *
 * The quote is the most this request can be charged, plus a small margin.
 * "Charged" is the metered model cost of the worst case the code can still
 * run (every writer at its output cap, the billed fallback, the three
 * retries, the decider, and a repair review when a protected span can be
 * repaired) plus the 20% markup the gate retains. The deposit is that charge
 * times HUMANIZE_DEPOSIT_MARGIN, at least the floor, rounded up. It is never
 * below the charge, so the operator is not left covering a successful run.
 *
 * Token counts are a proven upper bound, not a guess. Each input is capped
 * and counted as one token per byte (a byte-level tokenizer cannot split a
 * byte). Each output is capped by the max_tokens actually sent. Writer text
 * is cut to HUMANIZE_MAX_BYTES_PER_TOKEN bytes per output token before a
 * later call sees it, and the judge reserve is the size of that text after
 * protected phrases are restored. Prices are USD per million tokens: the
 * public catalog when it has a rate, otherwise the table below (NanoGPT,
 * 20 Oct 2026).
 */
import {
  HUMANIZE_FALLBACKS, HUMANIZE_INPUT_CAPS, MAX_CHARS_LIMIT, MAX_REASKS,
  ONE_THREAD_PREFIX, REASK_TEXT, candidateByteCap, collectSpans, endingAppendBytes, guardRetryPrompt, placeholderBudget,
  tokenUpperBound, writerForwardByteCap, writerNote, writerOutputTokenCap,
} from "./humanize.mjs";

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

/** The gate keeps metered cost plus this markup. The deposit has to cover it. */
export const HUMANIZE_SETTLE_MARKUP = 1.2;
/** Extra hold above the maximum charge. 12% sits inside the 10–15% band. */
export const HUMANIZE_DEPOSIT_MARGIN = 0.12;
/** Smallest deposit, in USD. A request whose charge is already above this is unaffected. */
export const HUMANIZE_DEPOSIT_FLOOR_USD = 0.001;

const bytes = (s) => tokenUpperBound(s);

function findArg(args, name) {
  if (!args || typeof args !== "object") return undefined;
  const k = Object.keys(args).find((x) => String(x).trim().toLowerCase() === name);
  return k == null ? undefined : args[k];
}

function nodeById(graph, id) {
  return (graph.nodes || []).find((n) => n.id === id) || null;
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
    const pin = Number(p.prompt);
    const pout = Number(p.completion);
    if (!(pin > 0) || !(pout > 0)) continue;
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
  const charge = Number(chargeUsd);
  if (!Number.isFinite(charge) || charge < 0) throw new Error("charge must be a non-negative number");
  const target = Math.max(HUMANIZE_DEPOSIT_FLOOR_USD, charge * (1 + HUMANIZE_DEPOSIT_MARGIN));
  let deposit = ceilUsd(target);
  if (deposit + 1e-12 < charge) deposit = ceilUsd(charge);
  return deposit;
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
 * request shape. `spec` carries byte lengths, not the caller's raw strings.
 * Every input token count is a byte length. Every output token count is the
 * max_tokens that call sends. `candidateBytes` is the post-restore size.
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
  const judgeMax = Math.max(1, Math.floor(Number(judge.fields.maxTokens) || 1600));
  const calls = [];
  const retries = [];
  for (const id of ["w-a", "w-b", "w-c", "w-d", "w-e"]) {
    const n = byId.get(id);
    if (!n) throw new Error(`humanize graph is missing writer ${id}`);
    const primary = rate(prices, n.fields.model);
    if (!primary) return null;
    const outTok = writerOutputTokenCap(n.fields.maxTokens, spec.maxChars);
    const inTok = bytes(n.fields.system) + spec.writerBytes + spec.contextBytes + spec.guidanceBytes + 2 * sep + spec.noteExtraBytes;
    const echoed = writerForwardByteCap(outTok);
    const call = (model, pc, more = 0) => ({ model, inTokens: inTok + more, outTokens: outTok, rate: pc });
    const again = (model, pc) => call(model, pc, echoed + bytes(spec.retryText));
    const fbModel = HUMANIZE_FALLBACKS[n.fields.model];
    const fb = fbModel ? rate(prices, fbModel) : null;
    if (fbModel && !fb) return null;
    if (fb) {
      // A timed-out primary can still be billed, and then the fallback is billed too.
      calls.push(call(n.fields.model, primary), call(fbModel, fb));
      const rePrimary = again(n.fields.model, primary);
      const reFb = again(fbModel, fb);
      retries.push(callUsd(reFb) > callUsd(rePrimary) ? reFb : rePrimary);
    } else {
      calls.push(call(n.fields.model, primary));
      retries.push(again(n.fields.model, primary));
    }
  }
  retries.sort((a, b) => callUsd(b) - callUsd(a));
  calls.push(...retries.slice(0, MAX_REASKS));
  const seps = ["k1", "k2", "k3", "k4", "k5", "k6", "j-cg"].reduce((a, id) => {
    const n = byId.get(id);
    return a + (n ? bytes(n.fields.sep) : 0);
  }, 0);
  const writerOut = writerOutputTokenCap(byId.get("w-a").fields.maxTokens, spec.maxChars);
  // Same sum as candidateByteCap: forwarded completion, each protected phrase, and a final sentence when the ending can append one.
  const candidateBytes = spec.spans
    ? candidateByteCap(writerOut, spec.spans, { ending: spec.ending, draft: spec.draftText })
    : writerForwardByteCap(writerOut) + spec.spanBytes + spec.endingExtra;
  const judgeIn = bytes(judge.fields.system) + spec.draftBytes + spec.contextBytes + spec.guidanceBytes + seps + 5 * candidateBytes;
  calls.push({ model: judge.fields.model, inTokens: judgeIn, outTokens: judgeMax, rate: judgeRate });
  if (spec.repair) {
    const longLabel = Math.max(...["k2", "k3", "k4", "k5", "k6"].map((id) => bytes(byId.get(id).fields.sep)));
    const reviewIn = bytes(judge.fields.system) + spec.draftBytes + spec.contextBytes + spec.guidanceBytes
      + bytes(byId.get("j-cg").fields.sep) + bytes(byId.get("k1").fields.sep) + longLabel
      + candidateBytes;
    calls.push({ model: judge.fields.model, inTokens: reviewIn, outTokens: judgeMax, rate: judgeRate });
  }
  const units = calls.reduce((a, c) => a + c.inTokens * c.rate[0] + c.outTokens * c.rate[1], 0);
  return { calls, units, candidateBytes };
}

function callUsd(call) {
  return call.inTokens * call.rate[0] + call.outTokens * call.rate[1];
}

/** Code points at the input cap, each the longest UTF-8 sequence (4 bytes). */
function capBytes(codePoints) {
  return codePoints * 4;
}

/**
 * The shapes a legal request can take at the input caps. The ceiling is the
 * most expensive of them: dense text with no spans, and the same text with
 * every byte protected so the judge sees the restored size.
 */
export function humanizeCeilingSpecs() {
  const budget = placeholderBudget();
  const { Draft, Context, Guidance } = HUMANIZE_INPUT_CAPS;
  const guidanceBytes = bytes(ONE_THREAD_PREFIX) + capBytes(Guidance);
  const contextBytes = capBytes(Context);
  const draftBytes = capBytes(Draft);
  const plainRetry = longestRetry([], MAX_CHARS_LIMIT, "question", true);
  const keepRetry = bytes(budget.guard) > bytes(plainRetry) ? budget.guard : plainRetry;
  const plainNote = writerNote([], "keep_last", MAX_CHARS_LIMIT);
  const shared = { contextBytes, guidanceBytes, draftBytes, maxChars: MAX_CHARS_LIMIT };
  // Restored phrases and an appended final sentence partition the draft, so the
  // candidate grows by the draft's bytes once, not twice. The two shapes below
  // are that growth with and without a repair pass.
  return [
    {
      ...shared,
      writerBytes: draftBytes,
      noteExtraBytes: 2 + bytes(plainNote),
      retryText: plainRetry,
      repair: false,
      spanBytes: 0,
      endingExtra: draftBytes,
    },
    {
      ...shared,
      writerBytes: budget.writerDraftChars,
      noteExtraBytes: 2 + bytes(budget.note),
      retryText: keepRetry,
      repair: true,
      spanBytes: draftBytes,
      endingExtra: 0,
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
  const spanBytes = spans.reduce((n, s) => n + bytes(s.text), 0);
  const endingExtra = endingAppendBytes(draftText, ending, spans);
  return {
    contextBytes: bytes(contextText),
    guidanceBytes: bytes(guidanceText),
    draftBytes: bytes(cleanDraft),
    writerBytes: bytes(writerDraft),
    noteExtraBytes: note ? 2 + bytes(note) : 0,
    maxChars,
    retryText: longestRetry(spans, maxChars, ending, title),
    repair: spans.length > 0,
    spanBytes,
    endingExtra,
    spans,
    ending,
    draftText,
  };
}

/**
 * Maximum USD the gate can retain for this request (metered worst case + 20%).
 * Null when a model has no price — the caller then keeps the pinned ceiling.
 */
export function humanizeChargeUsd(graph, args, { prices = HUMANIZE_MODEL_PRICES, ceiling = false } = {}) {
  if (!ceiling) {
    const provider = providerUsd(graph, specFromArgs(graph, args), prices);
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
  const spec = opts.ceiling ? humanizeCeilingSpec(graph, prices) : specFromArgs(graph, args);
  const built = stageCalls(graph, spec, prices);
  if (!built) return null;
  return {
    calls: built.calls.map((c) => ({ model: c.model, inTokens: c.inTokens, outTokens: c.outTokens, rate: c.rate })),
    candidateBytes: built.candidateBytes,
    providerUsd: built.units / 1e6,
    chargeUsd: built.units / 1e6 * HUMANIZE_SETTLE_MARKUP,
  };
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

