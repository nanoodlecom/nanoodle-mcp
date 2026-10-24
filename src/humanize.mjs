/**
 * humanize-comment post-processing (nanoodle-mcp side, not in the graph).
 *
 * 1. Hard input caps. Draft, Context and Guidance are capped in Unicode code
 *    points before any money moves (prepareCall → quote time), so an over-limit
 *    call is refused with a clear error instead of running.
 * 2. A fixed writer record A..E → {nodeId, model}, read from the graph's own
 *    config (each judge join's "[X] <model>" separator plus the writer node wired
 *    into it). It does not depend on which labelled blocks reached the decider,
 *    so a skipped or failed writer can never shift model credit.
 * 3. Exact ranked text. After the decider, every ranked entry's model and text
 *    (and the top-level text) are rebuilt from the writers' own outputs by id;
 *    the decider's copy is discarded. A writer with no output gets text "" and is
 *    forced to disqualified/missing. The decider proposes winner, why, order,
 *    faithful, disqualified and reason; rebuildHumanizeResult below lists the
 *    exact rules that override it.
 * 4. Writer calls (v2.7), via a fetch wrapper handed to the per-run Workflow
 *    (humanizeFetch): the engine still makes one call per writer node, and the
 *    wrapper only touches chat calls whose model is a writer's.
 *    - Fallback: a writer with a fallback model (C: Cydonia → Starry Ocean) is
 *      retried once on the fallback when the primary answers 429 or 5xx, the
 *      request errors, or it has not answered within PRIMARY_TIMEOUT_MS, as long
 *      as nothing was paid for the primary. When Cydonia fails and the Starry
 *      Ocean fallback runs, both calls are charged. The model that actually
 *      answered is credited in ranked[]; if the fallback fails too, the note says so.
 *    - Dashes: " — ", " – " and " - " become ", " and any other em/en dash
 *      becomes ", " in every writer output, before the decider sees it.
 *    - Near-copy: if the share of the rewrite's word trigrams that also occur in
 *      the draft is above NEAR_COPY_RATIO, the same model is re-asked once (the
 *      same messages plus its own answer and REASK_TEXT) and the second answer
 *      replaces the first. No re-ask after REASK_DEADLINE_MS, so the writer's
 *      60 s node timeout is not put at risk, and at most MAX_REASKS (3) re-asks
 *      happen per run, first come first served. A re-ask has its own deadline: it
 *      must finish within REASK_END_MS (55 s) of the writer call starting, or it is
 *      abandoned and the first answer is kept. Both calls' costs are reported.
 *    - x402 (keyless wallet mode): writer 402 invoices, the decider's 402, and the
 *      repair review are settled here, not by the nanoodle client, so the dash fix,
 *      re-asks and fallback credit apply to paid calls too. A cancel during the
 *      invoice read never starts a payment, and the queued callback checks again
 *      before the wallet runs. One invoice per attempt, paid at most once, replayed
 *      only with the body it was issued for; no fallback after a primary's payment
 *      STARTED (it is marked before the wallet call, since a wallet can send and
 *      still throw), unless the wallet error carries paymentNotSent === true. An
 *      unconfirmed payment goes to
 *      state.reconcile (invoice id, ambiguous) and the run notes, and its amount is left
 *      out of the cost, which is then flagged as a lower bound. Each writer call keeps
 *      its own attempt records, so concurrent writers never read each other's state.
 *      The re-ask's payment wait is bounded by the same 55 s deadline.
 *    - Cost: every attempt's cost is kept. Attempts whose answer never reaches the
 *      engine (a failed fallback, a paid call that failed, an abandoned re-ask) go
 *      into state.unreportedUsd, which tools.mjs adds to the run's total before the
 *      gate's refund and payout math.
 *    Texts in the result are these post-processed writer outputs, exactly what
 *    the decider read.
 * 5. Verbatim spans (v2.8). Optional `keep` (and a [[joke]]…[[/joke]] mark in
 *    the draft) is swapped for a [[kN]] placeholder before any writer sees the
 *    draft, then put back after. A rewrite that drops, duplicates, or changes a
 *    placeholder or span is dropped before the decider sees it. Each such writer
 *    is asked once more, and that retry counts toward the same MAX_REASKS budget
 *    as a near-copy re-ask. If every rewrite is still rejected, the closest one
 *    is repaired and the spans are put back, then the decider's faithfulness and
 *    safety check runs on that repaired text. Repair and question-moving keep
 *    each protected span byte for byte. The check uses the run's abort signal
 *    and the same deadline as a writer retry, so a cancel or a timeout stops it
 *    before another paid call. A failed check throws. The charge gate refunds
 *    the deposit. A caller on their own key or wallet has already paid for the
 *    model calls, and the error says so.
 * 6. `ending` (v2.8): "question" makes the rewrite end with a question,
 *    "keep_last" makes it end with the last keep span or, when there is no keep
 *    span, the draft's final sentence, and "any" (the default) leaves the ending
 *    alone. Omitted, it changes nothing.
 * 7. Guidance cap is 600 characters. A leading one-thread prefix
 *    (ONE_THREAD_PREFIX) is the server's own line and is not counted. `maxChars`,
 *    when set, is a hard output cap: over-length rewrites are dropped and that
 *    writer is asked once more.
 * 8. Writer echo (v2.8). A rewrite that contains the one-thread prefix, a
 *    <comment> wrapper, or a long overlap with the guidance or the instructions
 *    is dropped before the decider sees it (one retry first, inside the same
 *    MAX_REASKS budget). Paragraph-length rewrites are dropped only when the
 *    caller passes title: true. Callers who omit keep, ending, maxChars, and
 *    title keep the previous result shape, the same six paid calls, and the
 *    previous price.
 * 9. Deposit. max_tokens on every call is sized from maxChars, or from the
 *    draft length when maxChars is omitted, plus a small slack. On a hosted
 *    payment the quote caps what the customer pays: settlement charges the
 *    lesser of the metered cost plus 20% and that deposit, and the difference
 *    is returned. A provider can still meter more, and the operator absorbs
 *    any overrun. A hosted run skips a paid step, and refuses an invoice,
 *    that would pass the deposit. Direct-wallet spending has no cap and is
 *    not refunded. The run finishes with a partial result or with no charge
 *    when a hosted step is skipped.
 */
import { ParamsError } from "./tools.mjs";
import { budgetCap, knownUsd } from "./usd.mjs";
import { parseNanoInvoice } from "nanoodle";

export const HUMANIZE_TOOL = "humanize-comment";
/** Hard caps in Unicode code points ([...s].length). */
export const HUMANIZE_INPUT_CAPS = { Draft: 1500, Context: 3500, Guidance: 600 };
/**
 * Server-owned guidance prefix. It does not count toward the Guidance cap when
 * it is the exact start of the Guidance string (callers may include it; the
 * 600 characters are theirs).
 */
export const ONE_THREAD_PREFIX = "One thread: ONE main point, each sentence follows the last, 2-4 sentences <450 chars, <=1 hash/address, <=1 question at end, no 'Catch:' labels. ";
/** A title rewrite (only when the caller passes title: true) longer than this, plus any protected spans, is a paragraph and is dropped. */
export const TITLE_OUTPUT_MAX = 220;
export const KEEP_MAX_ITEMS = 8;
export const KEEP_MAX_CHARS = 500;
export const MAX_CHARS_LIMIT = 5000;
const ENDINGS = new Set(["question", "keep_last", "any"]);
const COMMENT_TAG = /<\s*\/?\s*comment\b/i;
const LETTERS = ["A", "B", "C", "D", "E"];
/** Writer fallbacks by primary model (mcp only; the graph itself has no fallback). */
export const HUMANIZE_FALLBACKS = Object.freeze({ "TheDrummer/Cydonia-24B-v4.3": "gemma-4-12b-it-starry-ocean" });
export const NEAR_COPY_RATIO = 0.6;
export const PRIMARY_TIMEOUT_MS = 30000;
export const REASK_DEADLINE_MS = 35000;
/** At most this many near-copy re-asks per run (first come, first served); keeps the cost estimate under the pin. */
export const MAX_REASKS = 3;
/** A re-ask must finish within this long of its writer call starting (writer node timeout is 60 s), or the first answer is kept. */
export const REASK_END_MS = 55000;
export const REASK_TEXT = "Your last attempt copied the draft. Rewrite it in your own words: same facts, same meaning, but your own sentences, and never more than five words in a row from the draft. Output only the rewritten comment text.";

export const codePoints = (s) => [...String(s ?? "")].length;

/**
 * Realistic token estimate: about 3.5 bytes per token. The quote caps what the
 * customer pays (the gate keeps the lesser of metered cost + 20% and the
 * deposit). A provider can still meter more; the operator absorbs that overrun.
 * The estimate does not have to be a tokenizer proof.
 */
export const HUMANIZE_BYTES_PER_TOKEN = 3.5;
/** The gate keeps metered cost times this. A later paid step must fit inside the deposit at this markup. */
export const HUMANIZE_SETTLE_MARKUP = 1.2;
/**
 * Output tokens added on top of the request length. Small next to a model cap:
 * enough for a rewrite to run a little long, not enough to price the model's
 * own 600- or 1600-token ceiling.
 */
export const HUMANIZE_OUTPUT_SLACK = 48;
/**
 * Extra output tokens for the decider only. Its reply is the winning rewrite
 * plus a short ranking JSON, so the rewrite-sized cap needs this much more
 * room. It is not the model's output cap.
 */
export const HUMANIZE_JUDGE_JSON_TOKENS = 256;
/**
 * Retries the deposit prices, on top of one call per writer. The run may still
 * attempt up to MAX_REASKS; a further call that would pass the deposit is skipped.
 */
export const HUMANIZE_PRICED_REASKS = 1;

/** Bytes of a string. Used for the token estimate and for span sizes. */
export function tokenUpperBound(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/** Token estimate for a known byte length. Empty text is zero tokens. */
export function estimateTokensFromBytes(byteLength) {
  const n = Math.max(0, Math.floor(Number(byteLength) || 0));
  if (n === 0) return 0;
  return Math.ceil(n / HUMANIZE_BYTES_PER_TOKEN);
}

/**
 * max_tokens for one call, taken from the request rather than the model's
 * output cap. maxChars, when set, is that many characters (priced as one byte
 * each). Otherwise the basis is the draft's byte length. A small slack is
 * added. The decider also gets room for its ranking JSON.
 */
export function requestOutputTokenCap(maxChars, inputText, { judge = false } = {}) {
  const limit = Number(maxChars);
  const basis = Number.isFinite(limit) && limit > 0
    ? Math.max(1, Math.ceil(limit))
    : Math.max(1, tokenUpperBound(inputText));
  const slack = HUMANIZE_OUTPUT_SLACK + (judge ? HUMANIZE_JUDGE_JSON_TOKENS : 0);
  return Math.max(1, estimateTokensFromBytes(basis) + slack);
}

/**
 * Bytes of writer text forwarded into a later call. Floor of tokens × 3.5, so
 * re-estimating those bytes does not come out above the max_tokens that produced them.
 */
export function writerForwardByteCap(tokenCap) {
  const n = Math.max(1, Math.floor(Number(tokenCap) || 1));
  return Math.max(1, Math.floor(n * HUMANIZE_BYTES_PER_TOKEN));
}

/**
 * Bytes an ending can append that are not already inside a protected phrase.
 * keep_last with spans only moves the last phrase. Otherwise at most the
 * draft's final sentence is appended, and only when that sentence is not
 * already inside a phrase.
 */
export function endingAppendBytes(draft, ending, spans) {
  if (ending !== "keep_last" && ending !== "question") return 0;
  if (ending === "keep_last" && spans && spans.length) return 0;
  const sentence = finalSentence(draft);
  if (!sentence) return 0;
  if (ending === "question" && !isQuestion(sentence)) return 0;
  if (spans && spans.some((s) => s && s.text && s.text.includes(sentence))) return 0;
  return tokenUpperBound(sentence);
}

/**
 * Bytes of one candidate after placeholders are restored and an ending is applied.
 * The raw completion is at most writerForwardByteCap. Each protected phrase can
 * be written back in full, and the ending can append one more sentence.
 */
export function candidateByteCap(tokenCap, spans, { ending = "any", draft = "" } = {}) {
  let n = writerForwardByteCap(tokenCap);
  for (const s of spans || []) n += tokenUpperBound(s && s.text);
  n += endingAppendBytes(draft, ending, spans);
  return n;
}

/** Cut `text` to at most `maxBytes` without splitting a UTF-8 code point. */
export function capUtf8(text, maxBytes) {
  const s = String(text ?? "");
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (tokenUpperBound(s) <= limit) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    const b = tokenUpperBound(ch);
    if (n + b > limit) break;
    out += ch;
    n += b;
  }
  return out;
}

/**
 * Shorten `text` to `maxBytes` without cutting a protected phrase. Phrases are
 * lifted first, so the cut only removes bytes outside them. `liftSpans` is
 * defined below; this runs only after a model reply, so the binding exists.
 */
function capPreservingSpans(text, spans, maxBytes) {
  const s = String(text ?? "");
  if (tokenUpperBound(s) <= maxBytes) return s;
  const lifted = liftSpans(s, spans);
  const kept = lifted.holes.reduce((n, h) => n + tokenUpperBound(h), 0);
  const room = maxBytes - kept;
  if (room < 0) return s;
  return lifted.restore(capUtf8(lifted.masked, room));
}

/** Guidance length toward the cap: a leading ONE_THREAD_PREFIX is not counted. */
export function guidanceUnits(s) {
  const t = String(s ?? "");
  const body = t.startsWith(ONE_THREAD_PREFIX) ? t.slice(ONE_THREAD_PREFIX.length) : t;
  return codePoints(body);
}

const tokenOf = (id) => `[[k${id}]]`;

/**
 * The most [[kN]] placeholders that can be sent without passing the draft cap.
 * Occurrences are packed back to back (`[[k1]][[k2]]…`); one more token would
 * make the placeholder draft longer than Draft, which is refused before quoting.
 */
export function maxPlaceholderSpans() {
  const spans = [];
  let used = 0;
  const cap = HUMANIZE_INPUT_CAPS.Draft;
  for (let id = 1; ; id++) {
    const tok = tokenOf(id);
    if (used + codePoints(tok) > cap) break;
    used += codePoints(tok);
    spans.push({ id, text: "x", source: "keep" });
  }
  return spans;
}

/** Writer note and guard retry at that occurrence cap (keep_last + maxChars, the longer pair). */
export function placeholderBudget() {
  const spans = maxPlaceholderSpans();
  return {
    spans,
    count: spans.length,
    writerDraftChars: spans.reduce((n, s) => n + codePoints(tokenOf(s.id)), 0),
    note: writerNote(spans, "keep_last", MAX_CHARS_LIMIT),
    guard: guardRetryPrompt(["keep"], { spans }),
  };
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/** Joke marks come out as their trimmed inner text. The same rule builds cleanDraft and span text. */
function unwrapJokes(s) {
  return String(s ?? "").replace(/\[\[joke\]\]([\s\S]*?)\[\[\/joke\]\]/gi, (_, inner) => String(inner).trim());
}

/** Union ranges that cross or overlap. Ranges that only touch stay separate. */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const cur = out[out.length - 1];
    if (cur && overlaps(cur, r)) cur.end = Math.max(cur.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * Pull protected spans out of a draft. [[joke]]…[[/joke]] marks (inner text) and
 * each `keep` string become [[kN]] placeholders in `writerDraft`. `cleanDraft`
 * is the draft writers' faithfulness is judged against: joke marks unwrapped,
 * keep text left as written.
 *
 * Every keep match is taken from the original draft, before any placeholder
 * exists. Overlapping or crossing matches merge into one span. The span's text
 * is that slice with joke marks unwrapped, so a keep inside [[joke]]…[[/joke]]
 * protects the plain words and the markers never come back. Placeholders are
 * written in one left-to-right pass. This span list is what protection,
 * restore, and the maxChars check all use.
 */
export function collectSpans(draft, keep) {
  const raw = String(draft ?? "");
  const jokePattern = () => /\[\[joke\]\]([\s\S]*?)\[\[\/joke\]\]/gi;
  const cleanDraft = unwrapJokes(raw);
  const jokes = [];
  for (const m of raw.matchAll(jokePattern())) {
    const text = String(m[1]).trim();
    jokes.push({ start: m.index, end: m.index + m[0].length, text, source: text ? "joke" : "blank" });
  }
  const keeps = [];
  for (const rawSpan of keep || []) {
    const text = String(rawSpan);
    if (!text.trim()) continue;
    let from = 0;
    while (from < raw.length) {
      const i = raw.indexOf(text, from);
      if (i < 0) break;
      keeps.push({ start: i, end: i + text.length });
      from = i + 1;
    }
  }
  let merged = mergeRanges(keeps);
  const absorbed = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of jokes) {
      if (absorbed.has(j)) continue;
      const hit = merged.find((m) => overlaps(m, j));
      if (!hit) continue;
      hit.start = Math.min(hit.start, j.start);
      hit.end = Math.max(hit.end, j.end);
      absorbed.add(j);
      grew = true;
    }
    if (grew) merged = mergeRanges(merged);
  }
  const chosen = [
    ...merged.map((m) => {
      const text = unwrapJokes(raw.slice(m.start, m.end));
      return { start: m.start, end: m.end, text, source: text ? "keep" : "blank" };
    }),
    ...jokes.filter((j) => !absorbed.has(j)),
  ];
  chosen.sort((a, b) => a.start - b.start || a.end - b.end);
  const spans = [];
  let writerDraft = "";
  let cursor = 0;
  for (const r of chosen) {
    writerDraft += raw.slice(cursor, r.start);
    if (r.source === "blank") writerDraft += " ";
    else {
      const id = spans.length + 1;
      spans.push({ id, text: r.text, source: r.source });
      writerDraft += tokenOf(id);
    }
    cursor = r.end;
  }
  writerDraft += raw.slice(cursor);
  return { cleanDraft, writerDraft, spans };
}

/** Problems with placeholders in a writer reply. Empty when every span is present once and unaltered. */
export function spanProblems(raw, spans) {
  if (!spans || !spans.length) return [];
  const text = String(raw ?? "");
  const expected = new Map(spans.map((s) => [tokenOf(s.id), s]));
  const counts = new Map();
  for (const m of text.matchAll(/\[\[k\d+\]\]/g)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
  const problems = [];
  for (const tok of expected.keys()) {
    const n = counts.get(tok) || 0;
    if (n === 0) problems.push(`dropped ${tok}`);
    else if (n > 1) problems.push(`duplicated ${tok}`);
  }
  for (const tok of counts.keys()) if (!expected.has(tok)) problems.push(`altered ${tok}`);
  for (const m of text.matchAll(/\[\[[^\]]*\]\]/g)) if (!expected.has(m[0])) problems.push(`altered ${m[0]}`);
  let stripped = text;
  for (const tok of expected.keys()) stripped = stripped.split(tok).join("\u0000");
  for (const s of spans) if (s.text && stripped.includes(s.text)) problems.push(`duplicated span ${s.id}`);
  return [...new Set(problems)];
}

/**
 * Put the protected text back in one pass. A span's own text may itself look
 * like [[kN]]; a second scan would replace that restored text.
 */
export function reinsertSpans(raw, spans) {
  const map = new Map((spans || []).map((s) => [tokenOf(s.id), s.text]));
  return String(raw ?? "").replace(/\[\[k\d+\]\]/g, (tok) => (map.has(tok) ? map.get(tok) : tok));
}

/**
 * Markers whose code points occur in neither `parts` nor each other, so a kept
 * phrase such as "0" cannot match inside one. Substitution restores only a
 * whole marker (opener, digits, closer), never a piece of it.
 */
function markerCodec(parts) {
  const used = new Set();
  for (const p of parts) for (const ch of String(p ?? "")) used.add(ch.codePointAt(0));
  const reserved = [];
  const ranges = [[0xE000, 0xF8FF], [0xF0000, 0xFFFFD], [0x100000, 0x10FFFD]];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; reserved.length < 16 && cp <= hi; cp++) if (!used.has(cp)) reserved.push(cp);
    if (reserved.length >= 16) break;
  }
  if (reserved.length < 3) throw new Error("humanize: no room for a collision-proof marker");
  const open = reserved[0];
  const close = reserved[1];
  const digits = reserved.slice(2);
  const base = digits.length;
  const mark = (i) => {
    const pcs = [open];
    if (base === 1) {
      for (let k = 0; k <= i; k++) pcs.push(digits[0]);
    } else if (i === 0) pcs.push(digits[0]);
    else {
      const rev = [];
      let n = i;
      while (n > 0) { rev.push(digits[n % base]); n = Math.floor(n / base); }
      for (let k = rev.length - 1; k >= 0; k--) pcs.push(rev[k]);
    }
    pcs.push(close);
    return String.fromCodePoint(...pcs);
  };
  const restore = (text, holes) => {
    const s = String(text ?? "");
    const digitAt = new Map(digits.map((cp, n) => [cp, n]));
    let out = "";
    for (let i = 0; i < s.length; ) {
      const cp = s.codePointAt(i);
      const w = cp > 0xFFFF ? 2 : 1;
      if (cp !== open) { out += s.slice(i, i + w); i += w; continue; }
      let j = i + w;
      const pcs = [];
      let closed = false;
      while (j < s.length) {
        const c2 = s.codePointAt(j);
        const w2 = c2 > 0xFFFF ? 2 : 1;
        if (c2 === close) { closed = pcs.length > 0; j += w2; break; }
        if (!digitAt.has(c2)) break;
        pcs.push(c2);
        j += w2;
      }
      if (!closed) { out += s.slice(i, i + w); i += w; continue; }
      let idx = 0;
      if (base === 1) idx = pcs.length - 1;
      else for (const d of pcs) idx = idx * base + digitAt.get(d);
      // Whole marker only. An index we did not issue is left untouched.
      if (idx >= 0 && idx < holes.length && holes[idx] != null) out += holes[idx];
      else out += s.slice(i, j);
      i = j;
    }
    return out;
  };
  return { mark, restore };
}

function uniqueSpanTexts(spans) {
  const unique = [];
  const seen = new Set();
  for (const s of spans || []) {
    const span = s && s.text;
    if (!span || seen.has(span)) continue;
    seen.add(span);
    unique.push(span);
  }
  unique.sort((a, b) => b.length - a.length);
  return unique;
}

/** Lift every protected phrase into a whole marker, longest first. */
function liftSpans(text, spans) {
  const unique = uniqueSpanTexts(spans);
  const codec = markerCodec([text, ...unique]);
  const holes = [];
  let masked = String(text ?? "");
  for (const span of unique) {
    let out = "";
    let rest = masked;
    while (rest.length) {
      const i = rest.indexOf(span);
      if (i < 0) { out += rest; break; }
      holes.push(span);
      out += rest.slice(0, i) + codec.mark(holes.length - 1);
      rest = rest.slice(i + span.length);
    }
    masked = out;
  }
  return {
    masked,
    holes,
    mark: codec.mark,
    restore: (next) => (holes.length ? codec.restore(next, holes) : String(next ?? "")),
  };
}

/**
 * Run `fn` on `text` with every protected span lifted out, then put those bytes
 * back unchanged. Longest spans are lifted first so a shorter one cannot eat
 * part of a longer one. A kept phrase cannot match inside a marker, and only
 * a whole marker is substituted back. Whitespace normalization inside `fn`
 * only sees the rest.
 */
function protectingSpans(text, spans, fn) {
  const lifted = liftSpans(text, spans);
  return lifted.restore(fn(lifted.masked));
}

/** Drop extra copies of a protected phrase without eating a copy that sits inside a longer one. */
function omitExtraSpans(text, spans) {
  const want = new Map();
  for (const s of spans || []) if (s && s.text) want.set(s.text, (want.get(s.text) || 0) + 1);
  const unique = [...want.keys()].sort((a, b) => b.length - a.length);
  if (!unique.length) return String(text ?? "");
  const codec = markerCodec([text, ...unique]);
  const holes = [];
  let masked = String(text ?? "");
  for (const span of unique) {
    const n = want.get(span);
    let seen = 0;
    let out = "";
    let rest = masked;
    while (rest.length) {
      const i = rest.indexOf(span);
      if (i < 0) { out += rest; break; }
      out += rest.slice(0, i);
      seen++;
      if (seen <= n) {
        holes.push(span);
        out += codec.mark(holes.length - 1);
      }
      rest = rest.slice(i + span.length);
    }
    masked = out;
  }
  return codec.restore(masked, holes);
}

/** Last-resort repair: restore every span once, even if the reply mangled its placeholder.
 *  Span text is kept byte for byte. Only whitespace outside those spans is collapsed. */
export function forceRepair(raw, spans) {
  const list = spans || [];
  const codec = markerCodec([raw, ...list.map((s) => s && s.text)]);
  const map = new Map(list.map((s) => [tokenOf(s.id), s]));
  const used = new Set();
  const holes = [];
  let t = String(raw ?? "").replace(/\[\[k\d+\]\]/g, (tok) => {
    if (!map.has(tok) || used.has(tok)) return "";
    used.add(tok);
    holes.push(map.get(tok).text);
    return codec.mark(holes.length - 1);
  });
  t = t.replace(/\[\[[^\]]*\]\]/g, "");
  t = codec.restore(t, holes);
  for (const s of list) {
    if (used.has(tokenOf(s.id))) continue;
    if (!s.text || t.includes(s.text)) continue;
    // The restored text may already be a protected span. Trimming it here would
    // eat that span's own spaces before the later collapse can lift it out.
    t = t ? `${t} ${s.text}` : s.text;
  }
  t = omitExtraSpans(t, list);
  return protectingSpans(t, list, (masked) => masked.replace(/[ \t]{2,}/g, " ").trim());
}

/** Trim only the whitespace outside protected spans. Span bytes stay as they are. */
function trimOutsideSpans(text, spans) {
  return protectingSpans(text, spans, (masked) => String(masked ?? "").trim());
}

const CLOSING_QUOTE = new Set(['"', "'", "\u201D", "\u2019"]);
const WORD_CHAR = /[\p{L}\p{N}]/u;
const isWordChar = (c) => WORD_CHAR.test(c || "");

/**
 * True when `quote` (the next character) closes an opener still open in `before`.
 * Straight quotes toggle. An apostrophe between letters (`Don't`) is not a quote.
 * Curly quotes pair opener to closer.
 */
function closesUnmatchedQuote(before, quote) {
  if (quote === '"') {
    let open = false;
    for (const c of before) if (c === '"') open = !open;
    return open;
  }
  if (quote === "'") {
    let open = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== "'") continue;
      if (isWordChar(before[i - 1]) && isWordChar(before[i + 1])) continue;
      open = !open;
    }
    return open;
  }
  if (quote === "\u201D") {
    let n = 0;
    for (const c of before) {
      if (c === "\u201C") n++;
      else if (c === "\u201D" && n > 0) n--;
    }
    return n > 0;
  }
  if (quote === "\u2019") {
    let n = 0;
    for (let i = 0; i < before.length; i++) {
      const c = before[i];
      if (c === "\u2018") n++;
      else if (c === "\u2019") {
        if (isWordChar(before[i - 1]) && isWordChar(before[i + 1])) continue;
        if (n > 0) n--;
      }
    }
    return n > 0;
  }
  return false;
}

/**
 * Split on . ! ? . A closing quote stays with the sentence it finishes, including
 * when the next sentence is capitalized (`He asked "Ready?" Then shipped.`).
 * A quote with no matching opener stays attached only at the end of the text or
 * when what follows is not a new sentence (`here."`, `?'`). A quote that opens
 * the next sentence (`He left. "Hello`) stays with that sentence.
 * A dot before a digit is a decimal, not a boundary. An apostrophe between
 * letters is not a quote.
 */
export function sentencesOf(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const parts = [];
  let i = 0;
  let start = 0;
  while (i < t.length) {
    const ch = t[i];
    const decimal = ch === "." && i + 1 < t.length && t[i + 1] >= "0" && t[i + 1] <= "9";
    if ((ch === "." || ch === "!" || ch === "?") && !decimal) {
      let end = i + 1;
      while (end < t.length && (t[end] === "." || t[end] === "!" || t[end] === "?")) end++;
      let q = end;
      while (q < t.length && CLOSING_QUOTE.has(t[q]) && closesUnmatchedQuote(t.slice(start, q), t[q])) q++;
      let q2 = q;
      while (q2 < t.length && CLOSING_QUOTE.has(t[q2])) q2++;
      if (q2 > q) {
        const after = t.slice(q2).trimStart();
        if (!after || !/^[A-Z]/.test(after)) q = q2;
      }
      end = q;
      const sentence = t.slice(start, end).trim();
      if (sentence) parts.push(sentence);
      start = end;
      i = end;
      continue;
    }
    i++;
  }
  const rest = t.slice(start).trim();
  if (rest) parts.push(rest);
  return parts.length ? parts : [t];
}

/** A sentence is a question when its terminator is ?, ignoring a closing quote after it. */
export function isQuestion(text) {
  return /\?["'\u201D\u2019]*$/.test(String(text ?? "").trim());
}

export function finalSentence(text) {
  const s = sentencesOf(text);
  return s.length ? s[s.length - 1] : "";
}

/**
 * Move the last question sentence to the end. Text with no question is returned
 * trimmed, joined the same way. Protected spans stay byte for byte, including
 * spaces and a question mark inside the span, so sentence splitting cannot
 * rewrite them.
 */
export function moveQuestionToEnd(text, spans) {
  return protectingSpans(text, spans, (masked) => {
    const s = sentencesOf(masked);
    let last = -1;
    for (let i = 0; i < s.length; i++) if (isQuestion(s[i])) last = i;
    if (last < 0) return String(masked ?? "").trim();
    if (last === s.length - 1) return s.join(" ");
    const q = s.splice(last, 1)[0];
    s.push(q);
    return s.join(" ");
  });
}

function endWith(text, span, spans) {
  const raw = String(text ?? "");
  const pieces = [];
  const seen = new Set();
  for (const s of spans || []) {
    if (!s || !s.text || seen.has(s.text)) continue;
    seen.add(s.text);
    pieces.push({ text: s.text });
  }
  if (span && !seen.has(span)) pieces.push({ text: span });
  // No ending phrase, or the phrase is already the ending: drop whitespace
  // outside the spans only. A full-string trim would eat a protected prefix.
  if (!span) return trimOutsideSpans(raw, pieces);
  const kept = trimOutsideSpans(raw, pieces);
  if (kept.endsWith(span)) return kept;
  const lifted = liftSpans(raw, pieces);
  const idxs = [];
  lifted.holes.forEach((h, i) => { if (h === span) idxs.push(i); });
  if (!idxs.length) {
    const body = lifted.restore(lifted.masked.replace(/\s+/g, " ").trim());
    return body ? `${body} ${span}` : span;
  }
  // Move the last whole marker to the end. Collapse only the text outside markers.
  const written = lifted.mark(idxs[idxs.length - 1]);
  const pos = lifted.masked.lastIndexOf(written);
  const masked = pos < 0 ? lifted.masked : lifted.masked.slice(0, pos) + " " + lifted.masked.slice(pos + written.length);
  const body = masked.replace(/\s+/g, " ").trim();
  return lifted.restore(body ? `${body} ${written}` : written);
}

/**
 * ending "any" returns `text` unchanged (including its whitespace).
 * "keep_last" ends with the last keep span, or the draft's final sentence.
 * "question" ends with a question: an existing one is moved to the end, otherwise
 * the draft's final sentence is appended when that sentence is a question.
 */
export function ensureEnding(text, ending, spans, draft) {
  if (!ending || ending === "any") return text;
  if (ending === "keep_last") {
    const last = spans && spans.length ? spans[spans.length - 1].text : finalSentence(draft);
    return last ? endWith(text, last, spans) : trimOutsideSpans(String(text ?? ""), spans);
  }
  if (ending === "question") {
    const moved = moveQuestionToEnd(text, spans);
    if (isQuestion(moved)) return moved;
    const q = finalSentence(draft);
    if (isQuestion(q)) return endWith(moved, q, spans);
    return moved;
  }
  return text;
}

function windowsOverlap(text, ref, n) {
  const b = String(ref || "").replace(/\s+/g, " ").trim();
  const a = String(text || "").replace(/\s+/g, " ").trim();
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i + n <= a.length; i += 8) if (b.includes(a.slice(i, i + n))) return true;
  return false;
}

/**
 * True when a writer reply echoes the guidance wrapper, the one-thread prefix,
 * a <comment> tag, or a long stretch of the guidance or the instruction text.
 */
export function echoesInstruction(text, guidance, system) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (COMMENT_TAG.test(t)) return true;
  const prefix = ONE_THREAD_PREFIX.trim();
  if (t.includes(prefix) || t.includes(prefix.slice(0, 32))) return true;
  if (windowsOverlap(t, guidance, 40)) return true;
  if (windowsOverlap(t, system, 80)) return true;
  const g = String(guidance || "").trim();
  if (codePoints(g) >= 80 && copyRatio(t, g) >= 0.6) return true;
  return false;
}

export function isParagraphOutput(text, spans) {
  const body = String(text ?? "").replace(/\n+$/, "");
  if (body.includes("\n")) return true;
  const allowance = (spans || []).reduce((n, s) => n + codePoints(s.text), 0);
  return codePoints(body) > TITLE_OUTPUT_MAX + allowance;
}

/** Decide whether a dashed writer reply may be shown to the decider. */
export function assessWriterOutput(raw, { spans = [], ending = "any", draft = "", guidance = "", system = "", maxChars = null, title = false } = {}) {
  const reasons = [];
  if (echoesInstruction(raw, guidance, system)) reasons.push("echo");
  const problems = spanProblems(raw, spans);
  if (problems.length) reasons.push("keep");
  let text = problems.length ? null : reinsertSpans(raw, spans);
  if (text != null && ending && ending !== "any") {
    text = ensureEnding(text, ending, spans, draft);
    if (ending === "question" && !isQuestion(text)) reasons.push("question");
  }
  const shown = text != null ? text : String(raw ?? "");
  if (title && isParagraphOutput(shown, spans)) reasons.push("title");
  if (maxChars && text != null && codePoints(shown) > maxChars) reasons.push("max");
  return { ok: reasons.length === 0, reasons, text: reasons.length === 0 ? text : null, problems };
}

export function guardRetryPrompt(reasons, { spans = [], maxChars = null } = {}) {
  if (reasons.includes("echo")) return "Your last attempt echoed the guidance or the instructions. Output only the rewritten comment, with no guidance text, no one-thread prefix, and no comment tags.";
  if (reasons.includes("keep")) {
    const toks = spans.map((s) => tokenOf(s.id)).join(", ");
    return `Your last attempt dropped, duplicated, or changed a placeholder. Copy each of these exactly once, unchanged: ${toks}. Output only the rewritten comment.`;
  }
  if (reasons.includes("title")) return "Your last attempt was a paragraph. Reply with one short line only, and nothing else.";
  if (reasons.includes("max")) return `Your last attempt was too long. Rewrite it in under ${maxChars} characters. Output only the rewritten comment.`;
  if (reasons.includes("question")) return "Your last attempt did not end with a question. End with one question. Output only the rewritten comment.";
  return "Output only the rewritten comment.";
}

const DROP_WHY = {
  echo: "it echoed the guidance or the instructions",
  keep: "it dropped, duplicated, or changed a protected span",
  title: "it was paragraph-length for a title",
  max: "it was over the length cap",
  question: "it did not end with a question",
};

/** Extra input-schema properties for keep, ending, and maxChars. Not graph inputs. */
export function humanizeExtraProperties() {
  return {
    keep: {
      type: "array",
      items: { type: "string", minLength: 1 },
      maxItems: KEEP_MAX_ITEMS,
      description: `optional; verbatim spans (a joke, a closing line) that must survive exactly. Each span is swapped for a placeholder before the rewrite and put back after. Every match in the draft counts, and the placeholder draft must stay within the draft cap. Overlapping keeps are protected together so each one survives. A rewrite that drops, duplicates, or changes a span is rejected. At most ${KEEP_MAX_ITEMS} spans, each at most ${KEEP_MAX_CHARS} characters.`,
    },
    ending: {
      type: "string",
      enum: ["question", "keep_last", "any"],
      default: "any",
      description: "optional; where the rewrite must end. \"question\" ends with a question. \"keep_last\" ends with the last keep span, or with the draft's final sentence when keep is omitted. \"any\" leaves the ending free. default: \"any\"",
    },
    maxChars: {
      type: "integer",
      minimum: 1,
      maximum: MAX_CHARS_LIMIT,
      description: `optional; hard cap on the rewrite length in characters (1 to ${MAX_CHARS_LIMIT}). Every copy of a keep span counts toward the cap. Over-length rewrites are rejected and that writer is asked once more.`,
    },
    title: {
      type: "boolean",
      default: false,
      description: "optional; when true, a paragraph-length rewrite is rejected and that writer is asked once more. Default false: a short draft is not treated as a title on its own.",
    },
  };
}

const HUMANIZE_EXTRA_KEYS = new Set(["keep", "ending", "maxchars", "title"]);

/** Tool arguments with the humanize-only keys removed, so the graph resolver does not see them. */
export function humanizeGraphArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (HUMANIZE_EXTRA_KEYS.has(String(k).trim().toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/** Parsed keep / ending / maxChars / guidance / draft from a tool call. Invalid shapes are reported by checkHumanizeInputs. */
export function humanizeCallOpts(args) {
  const find = (name) => {
    const k = Object.keys(args || {}).find((x) => String(x).trim().toLowerCase() === name);
    return k == null ? undefined : args[k];
  };
  const endingRaw = find("ending");
  const ending = endingRaw == null || endingRaw === "" ? "any" : String(endingRaw).trim();
  const keepRaw = find("keep");
  const keep = Array.isArray(keepRaw) ? keepRaw.filter((s) => typeof s === "string") : [];
  const maxRaw = find("maxchars");
  const maxChars = typeof maxRaw === "number" ? maxRaw : null;
  const guidance = find("guidance");
  const draft = find("draft");
  const title = find("title") === true;
  return {
    ending,
    keep,
    maxChars,
    title,
    guidance: guidance == null ? "" : String(guidance),
    draft: draft == null ? "" : String(draft),
  };
}

export function writerNote(spans, ending, maxChars) {
  const bits = [];
  if (spans && spans.length) {
    const toks = spans.map((s) => tokenOf(s.id)).join(", ");
    bits.push(`Protected placeholders: ${toks}. Copy each one exactly once, unchanged. Do not drop, duplicate, or edit them.`);
  }
  if (ending === "question") bits.push("The rewrite must end with a question.");
  if (ending === "keep_last") bits.push(spans && spans.length ? "The rewrite must end with the last placeholder." : "The rewrite must end with the draft's final sentence, unchanged.");
  if (maxChars) bits.push(`Stay under ${maxChars} characters.`);
  return bits.join(" ");
}

const BLOCK_SEP = "\n\n=====\n\n";

function swapDraftBlock(content, draft, writerDraft, note) {
  const idx = String(content).lastIndexOf(BLOCK_SEP);
  const extra = note ? `\n\n${note}` : "";
  const next = `${writerDraft}${extra}`;
  if (idx < 0) {
    if (String(content).endsWith(draft)) return String(content).slice(0, -draft.length) + next;
    return content;
  }
  const tail = String(content).slice(idx + BLOCK_SEP.length);
  if (tail.trim() !== String(draft).trim()) return content;
  return String(content).slice(0, idx) + BLOCK_SEP + next;
}

function annotateWriterBody(body, draft, writerDraft, note) {
  if (!note && writerDraft === draft) return body;
  const messages = (body.messages || []).map((m) => ({ ...m }));
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") {
      messages[i] = { ...messages[i], content: swapDraftBlock(messages[i].content, draft, writerDraft, note) };
      break;
    }
  }
  return { ...body, messages };
}

function spanScore(raw, spans) {
  const text = String(raw ?? "");
  let n = 0;
  for (const s of spans || []) {
    const c = text.split(tokenOf(s.id)).length - 1;
    if (c === 1) n += 2;
    else if (s.text && text.includes(s.text)) n += 1;
  }
  return n;
}

/** Every hard constraint a rewrite must still meet before it can be delivered. */
function acceptableDelivery(text, state) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (state.maxChars && codePoints(t) > state.maxChars) return false;
  if (state.title && isParagraphOutput(t, state.spans)) return false;
  if (state.ending === "question" && !isQuestion(t)) return false;
  if (state.ending === "keep_last") {
    const last = state.spans && state.spans.length ? state.spans[state.spans.length - 1].text : finalSentence(state.draft);
    const ended = trimOutsideSpans(t, state.spans && state.spans.length ? state.spans : [{ text: last }]);
    if (last && !ended.endsWith(last)) return false;
  }
  if (state.spans && state.spans.length) {
    const want = new Map();
    for (const s of state.spans) want.set(s.text, (want.get(s.text) || 0) + 1);
    for (const [span, n] of want) if (span && t.split(span).length - 1 < n) return false;
  }
  if (echoesInstruction(t, state.guidance, "")) return false;
  return true;
}

/** True when this run already paid for a model call on the caller's key or wallet. */
function incurredSpend(state) {
  if (!state) return false;
  if (state.costUnknown || state.unreportedUsd > 0 || state.reviewUsd > 0) return true;
  for (const a of state.attempts || []) {
    if (!a) continue;
    if (a.paid || a.paymentStarted || (typeof a.usd === "number" && a.usd > 0)) return true;
    if (state.billing !== "wallet" && a.status === 200) return true;
  }
  return false;
}

/**
 * Why a constrained run is not delivered. A run that already paid model calls
 * does not say the caller was not charged: a key was billed, or a wallet
 * payment already stands. The charge gate adds its own refund sentence when
 * it returns the deposit. No spend yet says nothing was charged.
 */
export function failureMessage(state, why) {
  const reason = why || (
    state && state.spans && state.spans.length && state.maxChars ? "the protected text would not fit the length cap."
    : state && state.spans && state.spans.length ? "the protected text did not survive."
    : state && state.maxChars ? `no rewrite fit within ${state.maxChars} characters.`
    : state && state.ending === "question" ? "no rewrite ended with a question."
    : "no rewrite could be delivered."
  );
  const money = !incurredSpend(state)
    ? "Nothing was charged."
    : state && state.billing === "wallet"
      ? "The model calls already paid from your wallet stand and are not refunded by this error. Direct-wallet spending has no cap."
      : "The model calls already made were billed to the API key funding this run.";
  return `humanize-comment could not return a rewrite: ${reason} ${money}`;
}

/** Deterministic dash fix applied to writer outputs before judging. */
export function normalizeDashes(text) {
  return String(text).replace(/[ \t]+[\u2014\u2013-][ \t]+/g, ", ").replace(/[\u2014\u2013]/g, ", ");
}
const trigrams = (t) => {
  const w = String(t || "").toLowerCase().match(/[\p{L}\p{N}#$.%'@]+/gu) || [];
  const o = new Set();
  for (let i = 0; i + 2 < w.length; i++) o.add(w.slice(i, i + 3).join(" "));
  return o;
};
/** Share of the rewrite's word trigrams that also occur in the draft (0 when the rewrite has none). */
export function copyRatio(text, draft) {
  const r = trigrams(text);
  if (!r.size) return 0;
  const d = trigrams(draft);
  let hit = 0;
  for (const t of r) if (d.has(t)) hit++;
  return hit / r.size;
}
/**
 * The raw USD field on a 402, in the same order the invoice parser reads it.
 * The value is returned unchanged so a later check can reject it by type.
 * A missing field is undefined. Null falls through to the next field.
 */
function invoiceUsdRaw(body) {
  const pay = body && body.payment;
  const pool = [
    ...(Array.isArray(body && body.accepts) ? body.accepts : []),
    ...(Array.isArray(pay && pay.accepted) ? pay.accepted : []),
  ];
  const nano = pool.find((a) => a && a.scheme === "nano" && /^nano_[a-z0-9]+$/.test(String(a.payTo || "")));
  if (nano && nano.maxAmountRequiredUSD != null) return nano.maxAmountRequiredUSD;
  if (nano && nano.amountUsd != null) return nano.amountUsd;
  if (pay && pay.amountUsd != null) return pay.amountUsd;
  return undefined;
}

/**
 * Parsed invoice whose USD price is the raw field, checked by type before any
 * Number() conversion. The library parser coerces "", whitespace, false, and
 * [] to 0; that coerced 0 is discarded here.
 */
function parsePricedInvoice(body, baseUrl) {
  const inv = parseNanoInvoice(body, baseUrl);
  if (!inv) return null;
  return { ...inv, amountUsd: knownUsd(invoiceUsdRaw(body)) };
}

const usdOf = (j, r) => {
  const p = j && j.x_nanogpt_pricing;
  const pUsd = p && (p.costUsd != null ? p.costUsd : p.cost != null ? p.cost : p.amount);
  const mUsd = j && j.metadata && j.metadata.cost;
  const top = j && j.cost != null ? knownUsd(j.cost) : null;
  if (top != null && top > 0) return top;
  if (pUsd != null) {
    const n = knownUsd(pUsd);
    if (n != null) return n;
  }
  if (mUsd != null) {
    const n = knownUsd(mUsd);
    if (n != null) return n;
  }
  if (top != null) return top;
  const header = r && r.headers && r.headers.get ? (r.headers.get("x-cost") || r.headers.get("x-nano-cost")) : null;
  return header == null ? null : knownUsd(header);
};

/**
 * Price of one decider re-check. A reported price, including an explicit 0, is exact.
 * A missing price is unknown on that call (usd null, not 0) and on the run: costUnknown
 * so the total is not exact. A paid invoice is added only as a lower bound, never as
 * a stand-in that keeps the total exact.
 */
export function recordReviewPrice(state, rec, result) {
  const reported = result && result.known ? knownUsd(result.usd) : null;
  if (reported == null) {
    state.costUnknown = true;
    rec.priceKnown = false;
    rec.usd = null;
    const paid = knownUsd(result && result.paidUsd);
    if (paid != null && paid > 0) state.reviewUsd += paid;
    return;
  }
  rec.priceKnown = true;
  rec.usd = reported;
  state.reviewUsd += rec.usd;
}

/** A request error that provably happened before the request was written (so nothing was billed). */
const BEFORE_SEND = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "ECONNREFUSED", "ERR_INVALID_URL", "UND_ERR_INVALID_ARG"]);
export function failedBeforeSend(e, signal) {
  if (signal && signal.aborted && e === signal.reason && e && e.beforeSend === true) return true;
  for (let x = e, i = 0; x && i < 4; x = x.cause, i++) if (x.code && BEFORE_SEND.has(x.code)) return true;
  return false;
}

/**
 * Per-run fetch wrapper for humanize-comment writer calls (see 4. above).
 * Returns { fetch, state }: state.answered[letter] = model that answered,
 * state.fallback[letter] = { from, to, reason, ok, failed? }, state.reasked[letter] = { ratio, after, failed? },
 * state.dashes[letter] = true when a dash was replaced, state.paidFailed[letter] = { model, status },
 * state.unreportedUsd / state.costUnknown = cost of attempts whose answer never reached the engine
 * (added to the run's total in tools.mjs so refund and payout math sees every billed attempt).
 *
 * x402 (keyless, `payment` callback): the nanoodle client's _paidFetch settles a 402 through the
 * invoice's complete URL, and that replayed result never passes back through a chat-completions
 * fetch. So this wrapper settles writer attempts (primary, fallback, re-ask, guard), the decider,
 * and the repair review itself, with the same callback, and hands the client a finished 200 (the
 * client then has nothing to pay). Every one of those goes through queueInvoicePayment: a cancel
 * after the invoice is read, and again inside the queued callback, never calls payment(). An
 * invoice whose USD price is missing is refused there too, before payment(). The payment id is
 * checked and reserved in that same queued step, and only the reservation stores the request
 * body, so a second caller can neither pay the id nor replace the body. Each attempt is its own
 * logical call with its own invoice, paid at most once, and replayed only with the exact body
 * that invoice was issued for. Once a primary's invoice is paid there is no fallback:
 * a paid call that then fails is reported as failed, never re-sent to another model and paid again.
 */
export function humanizeFetch({ record, draft, fetch = globalThis.fetch, payment = null, baseUrl = "https://nano-gpt.com", pollMs = 3000, now = Date.now, primaryTimeoutMs = PRIMARY_TIMEOUT_MS, reaskDeadlineMs = REASK_DEADLINE_MS, reaskEndMs = REASK_END_MS, maxReasks = MAX_REASKS, spans = [], writerDraft = null, ending = "any", maxChars = null, guidance = "", title = false, budgetUsd = null, prices = null }) {
  // null is "no cap". An explicit amount, including 0, stays that amount.
  // A value that does not parse throws here, so it cannot become "no cap".
  const budget = budgetCap(budgetUsd);
  const state = { answered: {}, fallback: {}, reasked: {}, dashes: {}, skippedReask: {}, skippedGuard: {}, paidFailed: {}, attempts: [], paidIds: new Set(), reconcile: [], unreportedUsd: 0, reviewUsd: 0, costUnknown: false, spans: spans || [], ending: ending || "any", maxChars: maxChars || null, guidance: guidance || "", draft: draft || "", title: !!title, billing: payment ? "wallet" : "key", stash: [], dropped: {}, judgeReq: null, budgetUsd: budget, meteredUsd: 0, reservedUsd: 0, committedUsd: 0, skippedForBudget: [] };
  // paymentId → the exact request string that invoice was issued for. A paid retry,
  // including one that re-enters this wrapper with the caller's original body, sends this string.
  const billedBodies = new Map();
  let reasksLeft = maxReasks;
  const byModel = new Map();
  const dupes = new Set();
  for (const l of LETTERS) {
    const m = record[l].model;
    if (byModel.has(m)) dupes.add(m); else byModel.set(m, l);
  }
  for (const m of dupes) byModel.delete(m); // two writers on one model can't be told apart: leave them alone
  const hdr = (h, k) => { if (!h) return null; if (typeof h.get === "function") return h.get(k); const e = Object.entries(h).find(([n]) => n.toLowerCase() === k); return e ? e[1] : null; };
  const wait = (ms, signal) => new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(signal.reason);
    const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", on); res(); }, ms);
    const on = () => { clearTimeout(t); rej(signal.reason); };
    if (signal) signal.addEventListener("abort", on, { once: true });
  });
  // a wallet call that ignores signals still can't hold the writer past its deadline
  const raceAbort = (p, signal) => !signal ? p : new Promise((res, rej) => {
    if (signal.aborted) return rej(signal.reason);
    const on = () => rej(signal.reason);
    signal.addEventListener("abort", on, { once: true });
    p.then((v) => { signal.removeEventListener("abort", on); res(v); }, (e) => { signal.removeEventListener("abort", on); rej(e); });
  });
  /**
   * A known USD price is a finite number >= 0, or strict decimal text.
   * "", whitespace, false, [], null, and a missing field are unknown.
   */
  const invoiceUsd = knownUsd;
  /** Keep the first body stored for an id. A later request must not replace it. */
  const rememberBody = (id, bodyStr) => {
    if (id == null || typeof bodyStr !== "string") return;
    const key = String(id);
    if (!billedBodies.has(key)) billedBodies.set(key, bodyStr);
  };
  /** Parse a 402. Paying does not store the body here; the claim inside queueInvoicePayment does. */
  const note402 = async (response) => {
    if (!response || response.status !== 402) return null;
    try { return parsePricedInvoice(await response.clone().json(), baseUrl); } catch { return null; }
  };
  /**
   * A 402 this run is handing back unpaid (the caller pays, or the request was keyed).
   * Keep the first body for that id so the caller's retry sends those exact bytes.
   */
  const rememberUnpaid = async (response, bodyStr) => {
    const noted = await note402(response);
    if (noted && noted.paymentId) rememberBody(noted.paymentId, bodyStr);
  };
  const undoCommit = (rec, held) => {
    if (!rec || rec.invoiceCommitted == null) return;
    const committed = knownUsd(rec.invoiceCommitted);
    if (committed == null) return;
    state.committedUsd = Math.max(0, state.committedUsd - committed);
    const heldUsd = knownUsd(held);
    if (rec.holdReleased && heldUsd != null) state.reservedUsd += heldUsd;
    rec.invoiceCommitted = null;
    rec.holdReleased = false;
  };
  /**
   * True when this invoice still fits the deposit at the 20% markup.
   * This call's own reservation is left out, so it is not counted twice.
   * An unknown amount does not fit a capped run. A null budget is uncapped.
   */
  const invoiceFits = (amount, held) => {
    if (state.budgetUsd == null) return true;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
    const heldUsd = knownUsd(held);
    const reservedOther = Math.max(0, state.reservedUsd - (heldUsd == null ? 0 : heldUsd));
    const spent = state.meteredUsd + state.committedUsd + reservedOther + amount;
    return spent * HUMANIZE_SETTLE_MARKUP <= state.budgetUsd + 1e-9;
  };
  const commitSpend = (rec, held, amount) => {
    if (state.budgetUsd == null) return;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return;
    const heldUsd = knownUsd(held);
    state.reservedUsd = Math.max(0, state.reservedUsd - (heldUsd == null ? 0 : heldUsd));
    state.committedUsd += amount;
    rec.invoiceCommitted = amount;
    rec.holdReleased = true;
  };
  /**
   * Pay one parsed invoice, or refuse when the run is already cancelled, the
   * USD price is unknown, or the invoice does not fit the remaining budget.
   * The check after the invoice read and the check inside the queued callback
   * are the same: a cancel in either gap never calls payment(). Unknown USD is
   * refused before payment on every path. The id is checked and reserved in
   * one step inside that queued callback, and only the winner stores its body.
   * An id that was reserved is kept when the outcome is uncertain. `commit`
   * stops a fallback timer in the gap before the wallet call.
   */
  const queueInvoicePayment = (inv, rec, signal, lateStatus, commit, onBook, held, bodyStr) => {
    const notSent = (kind) => {
      const reason = signal && signal.reason;
      const err = new Error(kind === "budget" ? "invoice exceeds the remaining budget"
        : kind === "price" ? "invoice has no USD price"
        : kind === "duplicate" ? `x402 invoice ${inv && inv.paymentId} was already reserved; not paying it again`
        : (reason && reason.message ? reason.message : "cancelled"));
      if (kind === "cancel" && reason && reason.name) err.name = reason.name;
      err.paymentNotSent = true;
      if (kind === "budget") err.budgetRefused = true;
      if (kind === "price") err.priceUnknown = true;
      if (kind === "duplicate") { err.duplicatePayment = true; err.code = "x402"; }
      return err;
    };
    if (signal && signal.aborted) {
      rec.paymentStarted = false;
      rec.status = "payment not sent";
      throw notSent("cancel");
    }
    const usd = invoiceUsd(inv && inv.amountUsd);
    if (usd == null) {
      rec.paymentStarted = false;
      rec.status = "payment not sent";
      rec.priceUnknown = true;
      throw notSent("price");
    }
    if (!invoiceFits(usd, held)) {
      rec.paymentStarted = false;
      rec.status = "payment not sent";
      rec.budgetRefused = true;
      state.skippedForBudget.push({ kind: rec.kind, letter: rec.letter || null, model: rec.model || null });
      throw notSent("budget");
    }
    if (commit) commit();
    rec.paymentId = inv.paymentId;
    const paying = Promise.resolve().then(() => {
      if (signal && signal.aborted) throw notSent("cancel");
      // The synchronous budget check can race another invoice that commits
      // before this step. Check again here, still before the id is reserved.
      if (!invoiceFits(usd, held)) {
        rec.paymentStarted = false;
        rec.status = "payment not sent";
        rec.budgetRefused = true;
        state.skippedForBudget.push({ kind: rec.kind, letter: rec.letter || null, model: rec.model || null });
        throw notSent("budget");
      }
      const id = String(inv.paymentId);
      // Check and reserve together. A second caller queued behind this one
      // sees the id and does not pay, and does not replace the stored body.
      if (state.paidIds.has(id)) throw notSent("duplicate");
      state.paidIds.add(id);
      rememberBody(id, bodyStr);
      // Count the invoice before the wallet runs. A response meter of 0 must not
      // erase it, or a repair charge can follow a paid check of the draft.
      commitSpend(rec, held, usd);
      rec.paymentStarted = true;
      // A throw inside payment() happens while the argument to Promise.resolve
      // is evaluated, before a rejection handler exists. Release a confirmed
      // not-sent failure here and on a returned rejection. An error that does
      // not say paymentNotSent leaves the commit, the hold, and the id in place.
      const releaseIfNotSent = (e) => {
        if (e && e.paymentNotSent === true) undoCommit(rec, held);
        throw e;
      };
      let wallet;
      try {
        wallet = payment(inv);
      } catch (e) {
        releaseIfNotSent(e);
      }
      return Promise.resolve(wallet).then((v) => v, releaseIfNotSent);
    });
    paying.then(() => {
      if (rec.paid || !rec.paymentAmbiguous || rec.counted) return;
      rec.paid = true; rec.paymentAmbiguous = false; rec.usd = inv.amountUsd; rec.counted = true;
      const lateUsd = knownUsd(inv.amountUsd);
      if (lateUsd != null) state.unreportedUsd += lateUsd; else state.costUnknown = true;
      const c = state.reconcile.find((x) => x.paymentId === inv.paymentId);
      if (c) { c.ambiguous = false; c.status = lateStatus; c.late = true; }
      if (onBook) onBook(c);
      if (typeof state.onLate === "function") state.onLate(c || { letter: rec.letter, kind: rec.kind, paymentId: inv.paymentId, amountUsd: inv.amountUsd });
    }, () => {});
    return paying;
  };
  /**
   * Cost of an attempt that ended without a usable answer: a known payment counts; a started but
   * unconfirmed payment is unknown; an x402 request that was never paid is free; a keyed request
   * is free only when it provably failed before being sent, otherwise it may have been billed (unknown).
   */
  const failCost = (rec, x402) => {
    if (!rec) return 0;
    if (rec.paid) { rec.counted = true; return rec.usd; }
    if (rec.paymentStarted) return null;
    if (rec.status !== "request error" && rec.status != null && rec.usd != null) return rec.usd;
    if (x402) return 0;
    return rec.beforeSend ? 0 : null;
  };
  const jsonResponse = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const messageBytes = (messages) => {
    let n = 0;
    for (const m of messages || []) if (m && typeof m.content === "string") n += tokenUpperBound(m.content);
    return n;
  };
  /**
   * Reserve the estimate of one paid call, or return null when starting it
   * would push metered spend (including calls already in flight) past the
   * deposit at the 20% markup. Null budget means this run is not capping.
   * The reservation is synchronous, so parallel writers cannot all pass on
   * the same remaining room.
   */
  const hold = (kind, letter, model, messages, outTokens) => {
    if (state.budgetUsd == null) return 0;
    const rate = prices && prices[model];
    let provider = null;
    if (rate && rate[0] > 0 && rate[1] > 0) {
      const inT = estimateTokensFromBytes(messageBytes(messages));
      const outT = Math.max(1, Math.floor(Number(outTokens) || 1));
      provider = (inT * rate[0] + outT * rate[1]) / 1e6;
    }
    const room = provider == null ? Infinity : (state.meteredUsd + state.committedUsd + state.reservedUsd + provider) * HUMANIZE_SETTLE_MARKUP;
    if (provider == null || room > state.budgetUsd + 1e-9) {
      state.skippedForBudget.push({ kind, letter: letter || null, model: model || null });
      return null;
    }
    state.reservedUsd += provider;
    return provider;
  };
  /**
   * Swap a reservation for the metered cost. An unknown meter stays reserved so
   * the next call cannot spend it. A committed invoice is already out of the
   * reservation: the budget keeps at least that amount when the response meter
   * is smaller or missing.
   */
  const finishPaid = (held, actualUsd, committedUsd = null) => {
    if (state.budgetUsd == null) return;
    const committed = knownUsd(committedUsd);
    if (committed != null) {
      state.committedUsd = Math.max(0, state.committedUsd - committed);
      const actual = knownUsd(actualUsd);
      state.meteredUsd += actual == null ? committed : Math.max(committed, actual);
      return;
    }
    const reserved = knownUsd(held);
    const holdUsd = reserved == null ? 0 : reserved;
    state.reservedUsd = Math.max(0, state.reservedUsd - holdUsd);
    const actual = knownUsd(actualUsd);
    if (actual == null) {
      state.reservedUsd += holdUsd;
      return;
    }
    state.meteredUsd += actual;
  };
  const skippedResponse = () => jsonResponse({ choices: [{ message: { content: "" } }], x_nanogpt_pricing: { costUsd: 0 } });

  const wrapped = async (url, init = {}) => {
    if (!/\/api\/v1\/chat\/completions(\?|$)/.test(String(url))) return fetch(url, init);
    // A paid retry carries the invoice id and the caller's original body. Send the
    // exact string that was billed, including its max_tokens, and do not rebuild it.
    const retryId = hdr(init && init.headers, "x-x402-payment-id");
    if (retryId && billedBodies.has(String(retryId))) {
      return fetch(url, { ...init, body: billedBodies.get(String(retryId)) });
    }
    if (!init || typeof init.body !== "string") return fetch(url, init);
    let body;
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    const letter = body && byModel.get(body.model);
    if (!letter) {
      if (body && body.model === "z-ai/glm-5.3" && !state.judgeReq) {
        const user = (body.messages || []).filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content).join("\n");
        const outCap = requestOutputTokenCap(state.maxChars, state.draft, { judge: true });
        body = { ...body, max_tokens: outCap };
        const held = hold("decider", null, body.model, body.messages, body.max_tokens);
        if (held == null) return skippedResponse();
        state.judgeReq = { url: String(url), headers: init.headers, body, user, signal: init.signal || null };
        const sentBody = JSON.stringify(body);
        let r;
        try { r = await fetch(url, { ...init, body: sentBody }); }
        catch (e) {
          finishPaid(held, failedBeforeSend(e, init.signal) ? 0 : null);
          throw e;
        }
        const x402Judge = !!payment && String(hdr(init.headers, "x-x402")) === "true" && !hdr(init.headers, "authorization");
        if (r.status === 402 && !x402Judge) await rememberUnpaid(r, sentBody);
        if (r.status === 402 && x402Judge) {
          const rec = { letter: null, kind: "decider", model: body.model, status: null, paymentStarted: false, paid: false, paymentAmbiguous: false, paymentId: null, usd: null };
          state.attempts.push(rec);
          // The catch records this invoice. It has to live outside the try: a
          // payment rejection or a cancel while the wallet call is in flight
          // used to throw ReferenceError before the reconcile entry was written.
          let inv = null;
          try {
            const raw = await r.text();
            try { inv = parsePricedInvoice(JSON.parse(raw), baseUrl); } catch { inv = null; }
            if (!inv || !inv.paymentId || !inv.completeUrl) {
              rec.status = 402;
              const e = new Error("payment required, but the 402 response offered no usable Nano option");
              e.code = "x402";
              throw e;
            }
            const paying = queueInvoicePayment(inv, rec, init.signal, "paid after the decider stopped waiting; its result was not used", null, null, held, sentBody);
            await raceAbort(paying, init.signal);
            rec.paid = true;
            rec.usd = inv.amountUsd;
            const deadline = inv.expiresAt || now() + 15 * 60 * 1000;
            const replayBody = billedBodies.get(String(inv.paymentId)) || sentBody;
            let settled = null;
            for (;;) {
              let cr;
              try {
                cr = await fetch(inv.completeUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-x402": "true" }, body: "{}", signal: init.signal });
              } catch (e) {
                rec.status = "aborted after payment";
                state.reconcile.push({ letter: null, kind: "decider", model: body.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: false, status: rec.status });
                throw e;
              }
              if (cr.ok) {
                let cj = null;
                try { cj = await cr.clone().json(); } catch { cj = null; }
                if (cj && typeof cj === "object" && (cj.choices || cj.error == null && cj.data)) { settled = jsonResponse(cj); break; }
                settled = await fetch(url, { ...init, body: replayBody, headers: { ...(init.headers || {}), "x-x402-payment-id": inv.paymentId } });
                if (settled.status === 402) {
                  rec.status = 402;
                  const e = new Error(`payment ${inv.paymentId} settled, but the API still answered 402 on replay; not paying again`);
                  e.code = "x402";
                  throw e;
                }
                break;
              }
              if (cr.status !== 402) { settled = cr; break; }
              await cr.text().catch(() => {});
              if (now() >= deadline) {
                rec.status = "x402 expired";
                const e = new Error(`payment window expired for ${inv.paymentId}`);
                e.code = "x402-expired";
                throw e;
              }
              try { await wait(pollMs, init.signal); }
              catch (e) {
                rec.status = "aborted after payment";
                state.reconcile.push({ letter: null, kind: "decider", model: body.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: false, status: rec.status });
                throw e;
              }
            }
            rec.status = settled.status;
            let judged = null;
            try { judged = await settled.clone().json(); } catch { judged = null; }
            const reported = usdOf(judged, settled);
            if (reported != null) rec.usd = reported;
            else if (rec.paid) state.costUnknown = true;
            finishPaid(held, reported == null ? (settled.ok ? null : rec.usd) : reported, rec.invoiceCommitted);
            return settled;
          } catch (e) {
            if (e && (e.budgetRefused || e.priceUnknown)) {
              rec.paymentStarted = false;
              rec.status = "payment not sent";
              finishPaid(held, 0, rec.invoiceCommitted);
              return skippedResponse();
            }
            if ((e && e.paymentNotSent === true) || (!rec.paymentStarted && init.signal && init.signal.aborted)) {
              rec.paymentStarted = false;
              rec.status = "payment not sent";
              finishPaid(held, 0, rec.invoiceCommitted);
              throw e;
            }
            if (!rec.paid && rec.paymentStarted) {
              rec.paymentAmbiguous = true;
              rec.status = init.signal && init.signal.aborted ? "payment still pending at the deadline" : "payment call failed";
              state.reconcile.push({ letter: null, kind: "decider", model: body.model, paymentId: inv && inv.paymentId, amountUsd: inv && inv.amountUsd, ambiguous: true, status: rec.status });
              state.costUnknown = true;
            }
            const c = failCost(rec, true);
            finishPaid(held, c, rec.invoiceCommitted);
            if (c == null) state.costUnknown = true;
            else if (c > 0) state.unreportedUsd += c;
            throw e;
          }
        }
        let judged = null;
        try { judged = await r.clone().json(); } catch { judged = null; }
        const reported = usdOf(judged, r);
        finishPaid(held, reported == null ? (r.ok ? null : 0) : reported);
        return r;
      }
      return fetch(url, init);
    }
    const note = writerNote(state.spans, state.ending, state.maxChars);
    const seenDraft = writerDraft || draft;
    if (note || (writerDraft && writerDraft !== draft)) body = annotateWriterBody(body, draft, seenDraft, note);
    // max_tokens follows the request (maxChars, or the draft length) plus a small
    // slack. The model's own output cap is not what this call can spend.
    const tokenCap = requestOutputTokenCap(state.maxChars, state.draft);
    body = { ...body, max_tokens: tokenCap };
    const forwardCap = writerForwardByteCap(tokenCap);
    const t0 = now();
    const x402 = !!payment && String(hdr(init.headers, "x-x402")) === "true" && !hdr(init.headers, "authorization");
    let usd = 0, usdKnown = true; // this logical call: every attempt's cost
    const addCost = (v) => { const n = knownUsd(v); if (n == null) usdKnown = false; else usd += n; };

    /**
     * One attempt = one request body, sent once and (under x402) paid at most once.
     * Returns { r, j, paid, rec }. `commit` runs just before a payment (the caller stops its fallback timer).
     */
    const mine = []; // this writer call's own attempts; concurrent writers never read each other's
    const lastMine = () => mine[mine.length - 1];
    const attempt = async (b, kind, signal, commit, held) => {
      const bodyStr = JSON.stringify(b);
      const rec = { letter, kind, model: b.model, status: null, paymentStarted: false, paid: false, paymentAmbiguous: false, paymentId: null, usd: null };
      mine.push(rec);
      state.attempts.push(rec);
      const req = { ...init, signal, body: bodyStr };
      let r;
      if (signal && signal.aborted) { rec.status = "request error"; rec.beforeSend = true; throw signal.reason; } // never sent
      try { r = await fetch(url, req); }
      catch (e) { rec.status = "request error"; rec.beforeSend = failedBeforeSend(e, signal); throw e; }
      if (r.status === 402 && !x402) await rememberUnpaid(r, bodyStr);
      if (r.status === 402 && x402) {
        const raw = await r.text();
        let inv = null;
        try { inv = parsePricedInvoice(JSON.parse(raw), baseUrl); } catch { inv = null; }
        if (!inv || !inv.paymentId || !inv.completeUrl) {
          rec.status = 402;
          const e = new Error("payment required, but the 402 response offered no usable Nano option");
          e.code = "x402"; throw e;
        }
        // Cancel during the invoice read, and again inside the queued callback.
        // The id is reserved in that callback, in the same step that stores this
        // body. A wallet can send and still throw, so from there on this attempt
        // counts as possibly paid and is never followed by a fallback, unless
        // the wallet error carries paymentNotSent === true.
        try {
          const paying = queueInvoicePayment(inv, rec, signal, "paid after the writer stopped waiting; its result was not used", commit, () => {
            if (state.paidFailed[letter] && state.paidFailed[letter].paymentId === inv.paymentId) state.paidFailed[letter].ambiguous = false;
          }, held, bodyStr);
          await raceAbort(paying, signal);
        } catch (e) {
          if (e && e.paymentNotSent === true) { rec.paymentStarted = false; rec.status = "payment not sent"; throw e; }
          // The abort can win the race before the microtask marks the attempt.
          // Nothing was sent, so this is not an ambiguous payment.
          if (!rec.paymentStarted && signal && signal.aborted) { rec.status = "payment not sent"; throw e; }
          rec.paymentAmbiguous = true;
          rec.status = signal && signal.aborted ? "payment still pending at the deadline" : "payment call failed";
          state.reconcile.push({ letter, kind, model: b.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: true, status: rec.status });
          state.costUnknown = true;
          throw e;
        }
        rec.paid = true;
        rec.usd = inv.amountUsd;
        const deadline = inv.expiresAt || now() + 15 * 60 * 1000;
        for (;;) {
          let cr;
          try {
            cr = await fetch(inv.completeUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-x402": "true" }, body: "{}", signal });
          } catch (e) {
            rec.status = "aborted after payment";
            state.reconcile.push({ letter, kind, model: b.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: false, status: rec.status });
            throw e;
          }
          if (cr.ok) {
            let cj = null;
            try { cj = await cr.json(); } catch { cj = null; }
            if (cj && typeof cj === "object" && (cj.choices || cj.error == null && cj.data)) { r = jsonResponse(cj); break; }
            // settle-only receipt: replay THIS attempt's exact billed body, stamped with its own payment id
            const replayBody = billedBodies.get(String(inv.paymentId)) || bodyStr;
            r = await fetch(url, { ...req, body: replayBody, headers: { ...(init.headers || {}), "x-x402-payment-id": inv.paymentId } });
            if (r.status === 402) {
              rec.status = 402;
              const e = new Error(`payment ${inv.paymentId} settled, but the API still answered 402 on replay; not paying again`);
              e.code = "x402"; throw e;
            }
            break;
          }
          if (cr.status !== 402) { r = cr; break; }
          await cr.text().catch(() => {});
          if (now() >= deadline) { rec.status = "x402 expired"; const e = new Error(`payment window expired for ${inv.paymentId}`); e.code = "x402-expired"; throw e; }
          try { await wait(pollMs, signal); } catch (e) {
            rec.status = "aborted after payment";
            state.reconcile.push({ letter, kind, model: b.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: false, status: rec.status });
            throw e;
          }
        }
      }
      rec.status = r.status;
      let j = null;
      try { j = await r.clone().json(); } catch { j = null; }
      const reported = usdOf(j, r); // error answers can carry a price too (kept, not dropped)
      if (reported != null) rec.usd = reported;
      else if (!rec.paid) rec.usd = r.ok ? null : 0; // an error answer with no price is not billed
      if (!r.ok) j = null;
      return { r, j, rec };
    };
    const lose = () => { // the logical call ends without an answer for the engine: keep its cost
      if (usdKnown) state.unreportedUsd += usd; else { state.unreportedUsd += usd; state.costUnknown = true; }
    };

    let model = body.model;
    let res;
    const heldPrimary = hold("primary", letter, body.model, body.messages, body.max_tokens);
    if (heldPrimary == null) return skippedResponse();
    try {
      const fb = record[letter].fallbackModel;
      if (fb) {
        let reason = null;
        const ac = new AbortController();
        const timer = setTimeout(() => { const e = new Error("primary timed out"); e.name = "TimeoutError"; ac.abort(e); }, primaryTimeoutMs);
        const onOuter = () => ac.abort(init.signal.reason);
        if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
        try {
          res = await attempt(body, "primary", ac.signal, () => clearTimeout(timer), heldPrimary);
          finishPaid(heldPrimary, res.rec.usd, res.rec.invoiceCommitted);
          addCost(res.rec.usd);
          if (res.r.status === 429 || res.r.status >= 500) reason = `HTTP ${res.r.status}`;
        } catch (e) {
          const rec = lastMine();
          if (e && (e.budgetRefused || e.priceUnknown)) {
            finishPaid(heldPrimary, 0, rec && rec.invoiceCommitted);
            reason = e.priceUnknown ? "the invoice had no USD price" : "the invoice was more than the remaining budget";
          } else {
            const failed = failCost(rec, x402);
            finishPaid(heldPrimary, failed, rec && rec.invoiceCommitted);
            addCost(failed); // unknown (lower bound) unless provably free or a known payment
            if (rec && (rec.paid || rec.paymentStarted)) {
              state.paidFailed[letter] = { model: body.model, status: rec.status, paymentId: rec.paymentId, ambiguous: !rec.paid };
              throw e;
            }
            if (init.signal && init.signal.aborted) throw e;
            if (e && e.code && /^x402/.test(e.code)) throw e;
            reason = ac.signal.aborted ? `no answer in ${Math.round(primaryTimeoutMs / 1000)} s` : "request error";
          }
        } finally {
          clearTimeout(timer);
          if (init.signal) init.signal.removeEventListener("abort", onOuter);
        }
        if (reason && res && (res.rec.paid || res.rec.paymentStarted)) {
          // paid for the primary and it still failed: no fallback, so one logical call is never paid twice
          state.paidFailed[letter] = { model: body.model, status: res.r.status };
          reason = null;
        } else if (reason) {
          const fbBody = { ...body, model: fb };
          const heldFb = hold("fallback", letter, fb, fbBody.messages, fbBody.max_tokens);
          state.fallback[letter] = { from: body.model, to: fb, reason, ok: false };
          if (heldFb == null) {
            state.fallback[letter].failed = "skipped so the deposit would not be exceeded";
            if (!res) { lose(); return skippedResponse(); }
          } else {
            let fbRes = null;
            try {
              fbRes = await attempt(fbBody, "fallback", init.signal, undefined, heldFb);
              finishPaid(heldFb, fbRes.rec.usd, fbRes.rec.invoiceCommitted);
            } catch (e) {
              const rec = lastMine();
              if (e && (e.budgetRefused || e.priceUnknown)) {
                finishPaid(heldFb, 0, rec && rec.invoiceCommitted);
                state.fallback[letter].failed = e.priceUnknown ? "the invoice had no USD price" : "skipped so the deposit would not be exceeded";
                if (!res) { lose(); return skippedResponse(); }
              } else {
                const failed = failCost(rec, x402);
                finishPaid(heldFb, failed, rec && rec.invoiceCommitted);
                addCost(failed);
                state.fallback[letter].failed = "request error";
                throw e;
              }
            }
            if (fbRes) {
              res = fbRes;
              model = fb;
              addCost(res.rec.usd);
              if (res.r.ok) state.fallback[letter].ok = true; else state.fallback[letter].failed = `HTTP ${res.r.status}`;
            }
          }
        }
      } else {
        try {
          res = await attempt(body, "primary", init.signal, undefined, heldPrimary);
          finishPaid(heldPrimary, res.rec.usd, res.rec.invoiceCommitted);
        } catch (e) {
          const rec = lastMine();
          if (e && (e.budgetRefused || e.priceUnknown)) {
            finishPaid(heldPrimary, 0, rec && rec.invoiceCommitted);
            lose();
            return skippedResponse();
          }
          const failed = failCost(rec, x402);
          finishPaid(heldPrimary, failed, rec && rec.invoiceCommitted);
          addCost(failed);
          throw e;
        }
        addCost(res.rec.usd);
      }
    } catch (e) { lose(); throw e; }

    const { r, j } = res;
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!r.ok || !msg || typeof msg.content !== "string") {
      if (state.fallback[letter] && !state.fallback[letter].failed && !(msg && typeof msg.content === "string")) state.fallback[letter].failed = r.ok ? "no text in the answer" : `HTTP ${r.status}`;
      if (state.fallback[letter] && state.fallback[letter].failed) state.fallback[letter].ok = false;
      if (!r.ok) { lose(); return r; } // the engine reads no cost from an error answer
      // ok but unreadable: the engine reports r's own price; earlier attempts are carried here
      const own = knownUsd(res.rec.usd) ?? 0;
      if (usd - own > 0) state.unreportedUsd += usd - own;
      if (!usdKnown) state.costUnknown = true;
      return r;
    }
    const normalized = normalizeDashes(msg.content);
    if (normalized !== msg.content) state.dashes[letter] = true;
    // Judge the model's full reply. Capping first would shorten a paragraph or
    // an over-length rewrite until the guard no longer saw it. The reply that
    // is kept is cut to the priced size before a later call sees it.
    let text = normalized;
    // With protected spans, "copied the draft" means the placeholder draft the writer was shown.
    const copySource = state.spans.length && writerDraft ? writerDraft : draft;
    const ratio = copyRatio(text, copySource);
    if (ratio > NEAR_COPY_RATIO && (reasksLeft <= 0 || now() - t0 >= reaskDeadlineMs)) {
      state.skippedReask[letter] = { ratio, why: reasksLeft <= 0 ? `the ${maxReasks}-re-ask limit for this run was reached` : "too late in the writer's time budget" };
    } else if (ratio > NEAR_COPY_RATIO) {
      // its own deadline: the re-ask must finish by reaskEndMs after the writer call began, or the
      // first answer is kept (so the writer's 60 s node timeout never eats a usable rewrite)
      const reBody = { ...body, model, messages: [...(body.messages || []), { role: "assistant", content: capUtf8(text, forwardCap) }, { role: "user", content: REASK_TEXT }] };
      const heldRe = hold("reask", letter, model, reBody.messages, reBody.max_tokens);
      if (heldRe == null) {
        state.skippedReask[letter] = { ratio, why: "it would have cost more than this request's deposit" };
      } else {
        reasksLeft--;
        const left = Math.max(0, t0 + reaskEndMs - now());
        const ac = new AbortController();
        const timer = setTimeout(() => { const e = new Error("re-ask timed out"); e.name = "TimeoutError"; ac.abort(e); }, left);
        const onOuter = () => ac.abort(init.signal.reason);
        if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
        try {
          const r2 = await attempt(reBody, "reask", ac.signal, undefined, heldRe);
          finishPaid(heldRe, r2.rec.usd, r2.rec.invoiceCommitted);
          addCost(r2.rec.usd);
          const m2 = r2.j && r2.j.choices && r2.j.choices[0] && r2.j.choices[0].message;
          if (r2.r.ok && m2 && typeof m2.content === "string" && m2.content.trim()) {
            const t2 = capUtf8(normalizeDashes(m2.content), forwardCap);
            state.reasked[letter] = { ratio, after: copyRatio(t2, copySource) };
            text = t2;
          } else state.reasked[letter] = { ratio, after: null, failed: r2.r.ok ? "no text in the answer" : `HTTP ${r2.r.status}` };
        } catch (e) {
          const rec = lastMine();
          // cost first, on every exit (outer cancel included): known payments stay in the totals,
          // unconfirmed ones flag the total as a lower bound and stay in state.reconcile
          const failed = rec && rec.kind === "reask" ? failCost(rec, x402) : 0;
          finishPaid(heldRe, failed, rec && rec.invoiceCommitted);
          if (rec && rec.kind === "reask") addCost(failed);
          if (init.signal && init.signal.aborted) {
            state.reasked[letter] = { ratio, after: null, failed: "cancelled" };
            lose(); throw e;
          }
          state.reasked[letter] = { ratio, after: null, failed: ac.signal.aborted ? `no answer within ${Math.round(reaskEndMs / 1000)} s of the writer call` : "request error" };
        } finally {
          clearTimeout(timer);
          if (init.signal) init.signal.removeEventListener("abort", onOuter);
        }
      }
    }
    const system = (body.messages || []).filter((m) => m.role === "system" && typeof m.content === "string").map((m) => m.content).join("\n");
    const guardOpts = { spans: state.spans, ending: state.ending, draft, guidance: state.guidance, system, maxChars: state.maxChars, title: state.title };
    let assessment = assessWriterOutput(text, guardOpts);
    // Guard retries share the near-copy budget, so a run cannot pay for more than maxReasks extra writer calls.
    const guardAllowed = !assessment.ok && reasksLeft > 0 && now() - t0 < reaskDeadlineMs;
    if (!assessment.ok && !guardAllowed) {
      state.skippedGuard[letter] = reasksLeft <= 0 ? `the ${maxReasks}-re-ask limit for this run was reached` : "too late in the writer's time budget";
    }
    if (guardAllowed) {
      const prompt = guardRetryPrompt(assessment.reasons, guardOpts);
      const guardBody = { ...body, model, messages: [...(body.messages || []), { role: "assistant", content: capUtf8(text, forwardCap) }, { role: "user", content: prompt }] };
      const heldGuard = hold("guard", letter, model, guardBody.messages, guardBody.max_tokens);
      if (heldGuard == null) {
        state.skippedGuard[letter] = "it would have cost more than this request's deposit";
      } else {
        reasksLeft--;
        const left = Math.max(0, t0 + reaskEndMs - now());
        const ac = new AbortController();
        const timer = setTimeout(() => { const e = new Error("guard retry timed out"); e.name = "TimeoutError"; ac.abort(e); }, left);
        const onOuter = () => ac.abort(init.signal.reason);
        if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
        try {
          const r2 = await attempt(guardBody, "guard", ac.signal, undefined, heldGuard);
          finishPaid(heldGuard, r2.rec.usd, r2.rec.invoiceCommitted);
          addCost(r2.rec.usd);
          const m2 = r2.j && r2.j.choices && r2.j.choices[0] && r2.j.choices[0].message;
          if (r2.r.ok && m2 && typeof m2.content === "string" && m2.content.trim()) {
            text = normalizeDashes(m2.content);
            assessment = assessWriterOutput(text, guardOpts);
            state.guarded = state.guarded || {};
            state.guarded[letter] = { reasons: assessment.ok ? [] : assessment.reasons, ok: assessment.ok };
          }
        } catch (e) {
          const rec = lastMine();
          const failed = rec && rec.kind === "guard" ? failCost(rec, x402) : 0;
          finishPaid(heldGuard, failed, rec && rec.invoiceCommitted);
          if (rec && rec.kind === "guard") addCost(failed);
          if (init.signal && init.signal.aborted) { lose(); throw e; }
        } finally {
          clearTimeout(timer);
          if (init.signal) init.signal.removeEventListener("abort", onOuter);
        }
      }
    }
    if (!assessment.ok) {
      // Dropped before the decider. The billed attempts stay on this response's price.
      // The raw reply is stashed so a span can be repaired if every writer is rejected.
      const reasons = assessment.reasons.length ? assessment.reasons : ["keep"];
      state.dropped[letter] = { reasons, why: reasons.map((k) => DROP_WHY[k] || k).join("; ") };
      const prev = state.stash.find((s) => s.letter === letter);
      const score = spanScore(text, state.spans);
      if (!prev || score >= prev.score) {
        if (prev) state.stash.splice(state.stash.indexOf(prev), 1);
        state.stash.push({ letter, model, raw: text, score });
      }
      text = "";
    } else {
      text = capPreservingSpans(assessment.text, state.spans, candidateByteCap(tokenCap, state.spans, { ending: state.ending, draft: state.draft }));
      if (text) state.answered[letter] = model;
    }
    const out = { ...j, choices: [{ ...j.choices[0], message: { ...msg, content: text } }] };
    delete out.cost; delete out.metadata;
    if (usdKnown) out.x_nanogpt_pricing = { costUsd: usd };
    else { delete out.x_nanogpt_pricing; state.unreportedUsd += usd; state.costUnknown = true; }
    return jsonResponse(out);
  };

  const headerCopy = (h) => {
    const o = {};
    if (!h) return o;
    if (typeof h.forEach === "function") { h.forEach((v, k) => { o[k] = v; }); return o; }
    return { ...h };
  };
  const hget = (h, k) => {
    if (!h) return null;
    if (typeof h.get === "function") return h.get(k);
    const e = Object.entries(h).find(([n]) => n.toLowerCase() === k);
    return e ? e[1] : null;
  };

  const reviewReconcile = (rec, inv, status) => {
    rec.status = status;
    state.reconcile.push({ letter: rec.letter, kind: rec.kind, model: rec.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: !rec.paid, status });
  };

  /**
   * One chat call for the decider re-check, settled the same way as a writer call
   * when the run is on a wallet. `signal` is the retry-style controller: it fires
   * on cancel and when the review deadline passes, and it is passed to the chat
   * request, the wallet call, the complete poll, and the wait between polls.
   */
  const paidChat = async (url, headers, body, rec, signal, held) => {
    const sentBody = JSON.stringify(body);
    const init = { method: "POST", headers: headerCopy(headers), body: sentBody, signal };
    const chatPrice = (j, r, paidUsd) => {
      const usd = usdOf(j, r);
      const n = knownUsd(usd);
      const paid = knownUsd(paidUsd);
      if (n == null) return { known: false, usd: null, paidUsd: paid };
      return { known: true, usd: n, paidUsd: paid };
    };
    if (signal && signal.aborted) { rec.status = "request error"; rec.beforeSend = true; throw signal.reason; }
    let r;
    try { r = await fetch(url, init); }
    catch (e) { rec.status = "request error"; rec.beforeSend = failedBeforeSend(e, signal); throw e; }
    let paidUsd = null;
    const x402 = !!payment && String(hget(init.headers, "x-x402")) === "true" && !hget(init.headers, "authorization");
    if (r.status === 402 && !x402) await rememberUnpaid(r, sentBody);
    if (r.status === 402 && x402) {
      const raw = await r.text();
      let inv = null;
      try { inv = parsePricedInvoice(JSON.parse(raw), baseUrl); } catch { inv = null; }
      if (!inv || !inv.paymentId || !inv.completeUrl) {
        rec.status = 402;
        throw new Error("decider review could not be paid");
      }
      try {
        const paying = queueInvoicePayment(inv, rec, signal, "paid after the review stopped waiting; its result was not used", null, null, held, sentBody);
        await raceAbort(paying, signal);
      } catch (e) {
        if (e && e.paymentNotSent === true) { rec.paymentStarted = false; rec.status = "payment not sent"; throw e; }
        if (!rec.paymentStarted && signal && signal.aborted) { rec.status = "payment not sent"; throw e; }
        rec.paymentAmbiguous = true;
        reviewReconcile(rec, inv, signal && signal.aborted ? "payment still pending at the deadline" : "payment call failed");
        state.costUnknown = true;
        throw e;
      }
      rec.paid = true;
      rec.usd = inv.amountUsd;
      paidUsd = inv.amountUsd;
      const deadline = inv.expiresAt || now() + 15 * 60 * 1000;
      for (;;) {
        let cr;
        try {
          cr = await fetch(inv.completeUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-x402": "true" }, body: "{}", signal });
        } catch (e) {
          reviewReconcile(rec, inv, "aborted after payment");
          throw e;
        }
        if (cr.ok) {
          let cj = null;
          try { cj = await cr.json(); } catch { cj = null; }
          if (cj && typeof cj === "object" && cj.choices) {
            const content = cj.choices[0] && cj.choices[0].message && cj.choices[0].message.content;
            return { status: 200, content: typeof content === "string" ? content : "", ...chatPrice(cj, cr, paidUsd) };
          }
          const replayBody = billedBodies.get(String(inv.paymentId)) || sentBody;
          r = await fetch(url, { ...init, body: replayBody, headers: { ...init.headers, "x-x402-payment-id": inv.paymentId } });
          break;
        }
        if (cr.status !== 402) { r = cr; break; }
        await cr.text().catch(() => {});
        if (now() >= deadline) throw new Error("decider review payment window expired");
        try { await wait(pollMs, signal); }
        catch (e) {
          reviewReconcile(rec, inv, "aborted after payment");
          throw e;
        }
      }
    }
    rec.status = r.status;
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { status: r.status, content: typeof content === "string" ? content : "", ...chatPrice(j, r, paidUsd) };
  };

  /**
   * Ask the same decider whether a repaired rewrite is faithful and safe.
   * Returns { ok }. A missing decider call, an unusable reply, or a rejection is not ok.
   * The decider's abort signal and a deadline of reaskEndMs (the same bound as a
   * writer retry) are combined into one signal and passed through paidChat.
   * Cancel throws. A deadline with no answer throws, so nothing else is paid.
   */
  state.reviewRepair = async (candidate, letter, modelName) => {
    const req = state.judgeReq;
    if (!req) return { ok: false };
    const model = modelName || (record[letter] && record[letter].model) || "";
    const tokenCap = requestOutputTokenCap(state.maxChars, state.draft);
    const cappedCandidate = capPreservingSpans(candidate, state.spans, candidateByteCap(tokenCap, state.spans, { ending: state.ending, draft: state.draft }));
    const user = reviewUserMessage(req.user, letter, model, cappedCandidate);
    const messages = Array.isArray(req.body.messages) ? req.body.messages.map((m) => ({ ...m })) : [];
    let replaced = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && typeof messages[i].content === "string") {
        messages[i] = { ...messages[i], content: user };
        replaced = true;
        break;
      }
    }
    if (!replaced) return { ok: false };
    const judgeCap = requestOutputTokenCap(state.maxChars, state.draft, { judge: true });
    const body = { ...req.body, messages, max_tokens: judgeCap };
    const held = hold("review", letter, body.model, body.messages, body.max_tokens);
    if (held == null) return { ok: false };
    const rec = { letter, kind: "review", model: body.model, status: null, paid: false, paymentStarted: false, usd: null };
    state.attempts.push(rec);
    const outer = req.signal || null;
    const t0 = now();
    const left = Math.max(0, t0 + reaskEndMs - now());
    const ac = new AbortController();
    const timer = setTimeout(() => {
      const e = new Error("repair review timed out");
      e.name = "TimeoutError";
      ac.abort(e);
    }, left);
    const onOuter = () => ac.abort(outer.reason);
    if (outer) { if (outer.aborted) onOuter(); else outer.addEventListener("abort", onOuter, { once: true }); }
    try {
      const result = await paidChat(req.url, req.headers, body, rec, ac.signal, held);
      const metered = result && result.known && knownUsd(result.usd) != null
        ? knownUsd(result.usd)
        : knownUsd(result && result.paidUsd);
      finishPaid(held, metered, rec.invoiceCommitted);
      recordReviewPrice(state, rec, result);
      if (!result.status || result.status !== 200 || !result.content) return { ok: false };
      return parseRepairVerdict(result.content, letter);
    } catch (e) {
      if (e && (e.budgetRefused || e.priceUnknown)) {
        finishPaid(held, 0, rec.invoiceCommitted);
        return { ok: false };
      }
      const x402 = !!payment && String(hget(req.headers, "x-x402")) === "true" && !hget(req.headers, "authorization");
      const c = failCost(rec, x402);
      finishPaid(held, c, rec.invoiceCommitted);
      if (c == null) state.costUnknown = true;
      else state.unreportedUsd += c;
      throw e;
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onOuter);
    }
  };

  return { fetch: wrapped, state };
}

/** Notes for the tool result about fallbacks and re-asks this run. */
export function humanizeRunNotes(state) {
  const notes = [];
  for (const [l, f] of Object.entries(state.fallback)) notes.push(f.ok
    ? `note: writer ${l} (${f.from}) did not answer (${f.reason}), so ${f.to} wrote ${l}'s rewrite and is credited for it.`
    : `note: writer ${l} (${f.from}) did not answer (${f.reason}), and the fallback ${f.to} also failed (${f.failed || "no answer"}), so writer ${l} has no rewrite this run.`);
  for (const [l, p] of Object.entries(state.paidFailed)) notes.push(p.ambiguous
    ? `note: writer ${l} (${p.model}): the payment for invoice ${p.paymentId} was started but not confirmed (${p.status}); no fallback was tried, so the call cannot have been paid twice. Reconcile that invoice; its amount is not in the cost.`
    : `note: writer ${l} (${p.model}) was paid for but did not return a rewrite (${p.status}); no fallback was tried, so the call was not paid twice.`);
  for (const c of state.reconcile) if (!(state.paidFailed[c.letter] && state.paidFailed[c.letter].paymentId === c.paymentId)) notes.push(`note: writer ${c.letter}'s ${c.kind} payment ${c.paymentId} needs reconciling (${c.status}${c.ambiguous ? ", may or may not have been sent" : ""}).`);
  for (const [l, r] of Object.entries(state.reasked)) notes.push(`note: writer ${l}'s first rewrite copied the draft (trigram overlap ${r.ratio.toFixed(2)}), so it was re-asked once` + (r.failed ? ` (the re-ask failed: ${r.failed}; its first rewrite was kept)` : r.after != null ? ` (overlap now ${r.after.toFixed(2)})` : "") + ".");
  for (const [l, r] of Object.entries(state.skippedReask)) notes.push(`note: writer ${l}'s rewrite copied the draft (trigram overlap ${r.ratio.toFixed(2)}) but was not re-asked (${r.why}); the decider judged it as is.`);
  for (const [l, d] of Object.entries(state.dropped || {})) {
    const again = state.guarded && state.guarded[l] ? " It was asked once more, and that reply was dropped too."
      : state.skippedGuard && state.skippedGuard[l] ? ` It was not asked again (${state.skippedGuard[l]}).` : "";
    notes.push(`note: writer ${l}'s rewrite was dropped before the decider (${d.why}).${again}`);
  }
  if (state.skippedForBudget && state.skippedForBudget.length) {
    notes.push("note: a later step was skipped because it would have cost more than this request's deposit.");
  }
  return notes;
}

/** Fixed writer-id → model record from graph config, or null if the graph isn't shaped like humanize-comment. */
export function humanizeWriterRecord(graph) {
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const record = {};
  for (const n of graph.nodes || []) {
    if (n.type !== "join" || !n.fields || typeof n.fields.sep !== "string") continue;
    const m = n.fields.sep.match(/\[([A-E])\] (\S+)\n$/);
    if (!m) continue;
    const link = (graph.links || []).find((l) => l.to.node === n.id && l.to.port === "b");
    const w = link && nodes.get(link.from.node);
    if (!w || w.type !== "llm") return null;
    if (w.fields.model !== m[2]) throw new Error(`humanize-comment: join ${n.id} labels [${m[1]}] ${m[2]} but its writer ${w.id} runs ${w.fields.model}`);
    record[m[1]] = Object.freeze({ writer: m[1], nodeId: w.id, model: w.fields.model, fallbackModel: HUMANIZE_FALLBACKS[w.fields.model] || null });
  }
  return LETTERS.every((l) => record[l]) && nodes.has("judge") && nodes.has("draft") ? Object.freeze(record) : null;
}

/** Throws ParamsError when a capped input is over its limit, or keep / ending / maxChars is malformed. `args` are the raw tool arguments. Nothing is charged. */
export function checkHumanizeInputs(args) {
  for (const [k, v] of Object.entries(args || {})) {
    const name = Object.keys(HUMANIZE_INPUT_CAPS).find((c) => c.toLowerCase() === String(k).trim().toLowerCase());
    if (!name || typeof v !== "string") continue;
    const len = name === "Guidance" ? guidanceUnits(v) : codePoints(v);
    if (len > HUMANIZE_INPUT_CAPS[name]) {
      const prefix = name === "Guidance" ? " A leading one-thread prefix is not counted." : "";
      throw new ParamsError(`input "${name}" is ${len} characters; humanize-comment accepts at most ${HUMANIZE_INPUT_CAPS[name]} (Draft ${HUMANIZE_INPUT_CAPS.Draft}, Context ${HUMANIZE_INPUT_CAPS.Context}, Guidance ${HUMANIZE_INPUT_CAPS.Guidance}).${prefix} Shorten it and call again; nothing was charged.`);
    }
  }
  const opts = humanizeCallOpts(args || {});
  const find = (name) => Object.keys(args || {}).find((x) => String(x).trim().toLowerCase() === name);
  if (find("ending") != null && !ENDINGS.has(opts.ending)) {
    throw new ParamsError(`input "ending" must be "question", "keep_last", or "any". Nothing was charged.`);
  }
  if (find("keep") != null) {
    const raw = args[find("keep")];
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string" || !String(s).trim())) {
      throw new ParamsError(`input "keep" must be an array of non-empty strings. Nothing was charged.`);
    }
    if (raw.length > KEEP_MAX_ITEMS) throw new ParamsError(`input "keep" accepts at most ${KEEP_MAX_ITEMS} spans. Nothing was charged.`);
    for (const s of raw) if (codePoints(s) > KEEP_MAX_CHARS) throw new ParamsError(`input "keep" spans must be at most ${KEEP_MAX_CHARS} characters. Nothing was charged.`);
  }
  if (find("maxchars") != null) {
    const raw = args[find("maxchars")];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CHARS_LIMIT) {
      throw new ParamsError(`input "maxChars" must be an integer from 1 to ${MAX_CHARS_LIMIT}. Nothing was charged.`);
    }
  }
  if (find("title") != null && typeof args[find("title")] !== "boolean") {
    throw new ParamsError(`input "title" must be a boolean. Nothing was charged.`);
  }
  assertKeepPossible(opts.draft, opts.keep, opts.maxChars);
}

/**
 * Reject a keep span that is not in the draft, a maxChars smaller than the
 * merged protected text, or a repeat that blows the placeholder draft past the
 * draft cap. Length is the unwrapped span list from collectSpans, the same list
 * the run protects and restores. Runs from prepareCall, before a quote and
 * before any model call.
 */
function placeholderMarker(s) {
  const m = String(s ?? "").match(/\[\[k\d+\]\]/);
  return m ? m[0] : "";
}

function assertKeepPossible(draft, keep, maxChars) {
  const raw = String(draft ?? "");
  const draftMarker = placeholderMarker(raw);
  if (draftMarker) throw new ParamsError(`input "Draft" contains the placeholder marker ${draftMarker}. Nothing was charged.`);
  for (const s of keep || []) {
    const marker = placeholderMarker(s);
    if (marker) throw new ParamsError(`input "keep" contains the placeholder marker ${marker}. Nothing was charged.`);
  }
  for (const s of keep || []) {
    if (!raw.includes(s)) throw new ParamsError(`input "keep" has a span that is not in the draft. Nothing was charged.`);
  }
  const { writerDraft, spans } = collectSpans(raw, keep);
  const cap = HUMANIZE_INPUT_CAPS.Draft;
  const expanded = codePoints(writerDraft);
  const protectedChars = spans.reduce((n, s) => n + codePoints(s.text), 0);
  if (expanded > cap || protectedChars > cap) {
    const n = Math.max(expanded, protectedChars);
    throw new ParamsError(`input "keep" repeats in the draft until the placeholders are ${n} characters, above the ${cap}-character cap. Nothing was charged.`);
  }
  if (maxChars != null && protectedChars > maxChars) {
    throw new ParamsError(`input "maxChars" is ${maxChars}, smaller than the protected text (${protectedChars} characters). Nothing was charged.`);
  }
}

/** The decider's verdict on one repaired rewrite. Faithful and not disqualified, and the winner is that rewrite. */
export function parseRepairVerdict(content, letter) {
  const raw = String(content ?? "").trim();
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false };
  const want = String(letter || "").toUpperCase();
  const winner = typeof j.winner === "string" ? j.winner.trim().toUpperCase() : "";
  const row = Array.isArray(j.ranked) ? j.ranked.find((r) => r && typeof r.writer === "string" && r.writer.trim().toUpperCase() === want) : null;
  if (j.safe === false || (row && row.safe === false)) return { ok: false };
  const ok = !!(row && row.faithful === true && row.disqualified === false && winner === want);
  return { ok };
}

/** Context, guidance, and the original draft, then the one repaired candidate. */
function reviewUserMessage(user, letter, model, text) {
  const mark = "\n\n=====\n\n[ORIGINAL]\n";
  const src = String(user || "");
  const i = src.indexOf(mark);
  let head = src;
  if (i >= 0) {
    const after = i + mark.length;
    const next = src.indexOf("\n\n=====\n\n[", after);
    head = next < 0 ? src : src.slice(0, next);
  }
  return `${head}\n\n=====\n\n[${letter}] ${model}\n${text}`;
}

/**
 * Rewrite the decider's JSON in result.outputs in place. Returns a notice string or null.
 *
 * Guarantees of the rebuilt object {winner, text, why, ranked}:
 *  - ranked lists A..E exactly once each; model from the writer record (with a fallback, the model that answered), text always the
 *    writer's own output ("" when it produced none). Eligible entries first, decider order kept.
 *  - a writer with no output: faithful false, disqualified true, reason "missing".
 *  - an entry with faithful !== true is forced to disqualified true, so it can never win.
 *  - a writer the decider left out is added as disqualified.
 *  - winner: the decider's pick if it is an eligible entry (faithful, not disqualified, has text);
 *    otherwise (including a decider pick of ORIGINAL) the first eligible entry in ranked order
 *    (why then says so); ORIGINAL only when every rewrite is ineligible.
 *    text is the winner's exact output, or the draft for ORIGINAL.
 *  - if the decider's reply is not valid JSON or has no ranked array, nothing of it is passed
 *    through: winner ORIGINAL with the draft as text, every writer listed with its real text as
 *    disqualified ("not judged: decider reply unusable", or "missing"), and a notice says so.
 */
export function rebuildHumanizeResult(wf, result, record, answered = {}) {
  const modelOf = (letter) => answered[letter] || record[letter].model;
  const out = wf.outputs.find((o) => o.nodeId === "judge");
  if (!out || typeof result.outputs[out.key] !== "string") return null;
  const textOf = (letter) => {
    const rec = result.nodes && result.nodes[record[letter].nodeId];
    const t = rec && rec.status === "done" && rec.out ? rec.out.text : undefined;
    return typeof t === "string" && t.trim() ? t : null;
  };
  const draftRec = result.nodes && result.nodes.draft && result.nodes.draft.out;
  const draft = draftRec && typeof draftRec.text === "string" ? draftRec.text : "";
  let j = null;
  try { j = JSON.parse(result.outputs[out.key]); } catch { j = null; }
  if (!j || typeof j !== "object" || Array.isArray(j) || !Array.isArray(j.ranked)) {
    const ranked = LETTERS.map((letter) => {
      const text = textOf(letter);
      return { writer: letter, model: modelOf(letter), text: text ?? "", faithful: false, disqualified: true, reason: text == null ? "missing" : "not judged: decider reply unusable" };
    });
    result.outputs[out.key] = JSON.stringify({ winner: "ORIGINAL", text: draft, why: "The decider's reply was not usable, so the original draft is returned unchanged.", ranked });
    return "note: the decider's reply was not valid JSON with a ranked list, so humanize-comment returned the original draft as the winner; the five rewrites are listed with their real texts, unjudged.";
  }
  const seen = new Set();
  const ranked = [];
  for (const r of j.ranked) {
    const letter = r && typeof r.writer === "string" ? r.writer.trim().toUpperCase() : "";
    if (!record[letter] || seen.has(letter)) continue;
    seen.add(letter);
    const text = textOf(letter);
    if (text == null) { ranked.push({ writer: letter, model: modelOf(letter), text: "", faithful: false, disqualified: true, reason: "missing" }); continue; }
    const faithful = r.faithful === true;
    const reason = String(r.reason ?? "");
    ranked.push({
      writer: letter, model: modelOf(letter), text, faithful,
      disqualified: !faithful || r.disqualified !== false,
      reason: !faithful && r.disqualified === false ? `unfaithful${reason ? ": " + reason : ""}` : reason,
    });
  }
  for (const letter of LETTERS) if (!seen.has(letter)) {
    const text = textOf(letter);
    ranked.push({ writer: letter, model: modelOf(letter), text: text ?? "", faithful: false, disqualified: true, reason: text == null ? "missing" : "not ranked by the decider" });
  }
  ranked.sort((a, b) => Number(a.disqualified) - Number(b.disqualified));
  const eligible = (r) => r && r.faithful && !r.disqualified && r.text !== "";
  const picked = typeof j.winner === "string" ? j.winner.trim().toUpperCase() : "";
  let winner = picked;
  let why = String(j.why ?? "");
  const best = ranked.find(eligible);
  if (winner === "ORIGINAL") {
    if (best) {
      winner = best.writer;
      why = `The decider chose the original; overridden to the first eligible rewrite, ${winner}, because a rewrite has to survive while any is eligible.${why ? " Decider's reason: " + why : ""}`;
    }
  } else if (!eligible(ranked.find((r) => r.writer === winner))) {
    winner = best ? best.writer : "ORIGINAL";
    why = `The decider picked ${picked || "no winner"}, which is not eligible (unfaithful, disqualified, missing or unknown), so ${best ? "the best faithful, non-disqualified rewrite, " + winner + "," : "the original draft, since every rewrite is ruled out,"} is used instead.`;
  }
  const text = winner === "ORIGINAL" ? draft : ranked.find((r) => r.writer === winner).text;
  result.outputs[out.key] = JSON.stringify({ winner, text, why, ranked });
  return null;
}

/**
 * After rebuildHumanizeResult. Repairs a run where every rewrite was rejected
 * for a protected span, and refuses a delivery that misses a hard constraint
 * (maxChars, a required question, a protected span). A returned `error` must be
 * thrown by the caller. On the charge gate that refunds the deposit. A key or
 * wallet that already paid keeps that spend, and the error says so.
 * `note` is a user-facing line. Returns null when the rebuilt result already stands.
 */
export async function applyHumanizeFallback(wf, result, record, state) {
  if (!state) return null;
  const out = wf.outputs.find((o) => o.nodeId === "judge");
  if (!out || typeof result.outputs[out.key] !== "string") return null;
  let parsed = null;
  try { parsed = JSON.parse(result.outputs[out.key]); } catch { parsed = null; }
  if (parsed && Array.isArray(parsed.ranked) && state.dropped) {
    let changed = false;
    for (const row of parsed.ranked) {
      const d = state.dropped[row.writer];
      if (d && !row.text) {
        row.reason = d.why;
        row.disqualified = true;
        row.faithful = false;
        changed = true;
      }
    }
    if (changed) result.outputs[out.key] = JSON.stringify(parsed);
  }
  const answered = LETTERS.some((l) => state.answered && state.answered[l]);
  if (!answered && state.spans && state.spans.length && state.stash && state.stash.length) {
    const best = [...state.stash].sort((a, b) => b.score - a.score || a.letter.charCodeAt(0) - b.letter.charCodeAt(0))[0];
    const text = ensureEnding(forceRepair(best.raw, state.spans), state.ending, state.spans, state.draft);
    if (!acceptableDelivery(text, state)) return { error: failureMessage(state) };
    let verdict = { ok: false };
    try {
      verdict = typeof state.reviewRepair === "function" ? await state.reviewRepair(text, best.letter, best.model) : { ok: false };
    } catch {
      return { error: failureMessage(state, "the decider could not check the repaired text.") };
    }
    if (!verdict.ok) return { error: failureMessage(state, "the repaired text failed the decider's faithfulness and safety check.") };
    if (!acceptableDelivery(text, state)) return { error: failureMessage(state) };
    const ranked = LETTERS.map((letter) => {
      if (letter === best.letter) {
        return { writer: letter, model: best.model || record[letter].model, text, faithful: true, disqualified: false, reason: "protected spans restored; decider confirmed faithful" };
      }
      const d = state.dropped && state.dropped[letter];
      return { writer: letter, model: record[letter].model, text: "", faithful: false, disqualified: true, reason: d ? d.why : "missing" };
    });
    result.outputs[out.key] = JSON.stringify({
      winner: best.letter,
      text,
      why: "Every rewrite dropped or changed a protected span, so the closest one was repaired, the spans were put back, and the decider confirmed it is faithful.",
      ranked,
    });
    return { note: "note: every rewrite dropped or changed a protected span, so the closest one was repaired, the spans were put back, and the decider confirmed it is faithful." };
  }
  try { parsed = JSON.parse(result.outputs[out.key]); } catch { parsed = null; }
  if (!parsed || typeof parsed.text !== "string") return null;
  let text = parsed.text;
  if (state.ending === "keep_last" || state.ending === "question") {
    const fixed = ensureEnding(text, state.ending, state.spans || [], state.draft);
    if (fixed !== text) {
      text = fixed;
      parsed.text = text;
      if (Array.isArray(parsed.ranked)) {
        const row = parsed.ranked.find((r) => r.writer === parsed.winner);
        if (row) row.text = text;
      }
      result.outputs[out.key] = JSON.stringify(parsed);
    }
  }
  const constrained = !!(state.maxChars || state.title || state.ending === "question" || state.ending === "keep_last" || (state.spans && state.spans.length));
  if (constrained && !acceptableDelivery(text, state)) return { error: failureMessage(state) };
  return null;
}
