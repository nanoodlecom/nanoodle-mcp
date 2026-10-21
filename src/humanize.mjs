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
 *      request errors, or it has not answered within PRIMARY_TIMEOUT_MS. The
 *      model that actually answered is credited in ranked[].
 *    - Dashes: " — ", " – " and " - " become ", " and any other em/en dash
 *      becomes ", " in every writer output, before the decider sees it.
 *    - Near-copy: if the share of the rewrite's word trigrams that also occur in
 *      the draft is above NEAR_COPY_RATIO, the same model is re-asked once (the
 *      same messages plus its own answer and REASK_TEXT) and the second answer
 *      replaces the first. No re-ask after REASK_DEADLINE_MS, so the writer's
 *      60 s node timeout is not put at risk, and at most MAX_REASKS (3) re-asks
 *      happen per run, first come first served. Both calls' costs are reported.
 *    Texts in the result are these post-processed writer outputs, exactly what
 *    the decider read.
 */
import { ParamsError } from "./tools.mjs";

export const HUMANIZE_TOOL = "humanize-comment";
/** Hard caps in Unicode code points ([...s].length). */
export const HUMANIZE_INPUT_CAPS = { Draft: 1500, Context: 3500, Guidance: 300 };
const LETTERS = ["A", "B", "C", "D", "E"];
/** Writer fallbacks by primary model (mcp only; the graph itself has no fallback). */
export const HUMANIZE_FALLBACKS = Object.freeze({ "TheDrummer/Cydonia-24B-v4.3": "gemma-4-12b-it-starry-ocean" });
export const NEAR_COPY_RATIO = 0.6;
export const PRIMARY_TIMEOUT_MS = 30000;
export const REASK_DEADLINE_MS = 35000;
/** At most this many near-copy re-asks per run (first come, first served); keeps the cost estimate under the pin. */
export const MAX_REASKS = 3;
export const REASK_TEXT = "Your last attempt copied the draft. Rewrite it in your own words: same facts, same meaning, but your own sentences, and never more than five words in a row from the draft. Output only the rewritten comment text.";

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
const usdOf = (j, r) => {
  const p = j && j.x_nanogpt_pricing;
  const pUsd = p && (p.costUsd != null ? p.costUsd : p.cost != null ? p.cost : p.amount);
  const mUsd = j && j.metadata && j.metadata.cost;
  if (j && typeof j.cost === "number" && j.cost > 0) return j.cost;
  if (pUsd != null && isFinite(Number(pUsd))) return Number(pUsd);
  if (mUsd != null && isFinite(Number(mUsd))) return Number(mUsd);
  if (j && typeof j.cost === "number") return j.cost;
  const h = r && r.headers && r.headers.get ? parseFloat(r.headers.get("x-cost") || r.headers.get("x-nano-cost") || "") : NaN;
  return isNaN(h) ? null : h;
};

/**
 * Per-run fetch wrapper for humanize-comment writer calls (see 4. above).
 * Returns { fetch, state }: state.answered[letter] = model that answered,
 * state.fallback[letter] = { from, to, reason }, state.reasked[letter] = { ratio, after },
 * state.dashes[letter] = true when a dash was replaced.
 */
export function humanizeFetch({ record, draft, fetch = globalThis.fetch, now = Date.now, primaryTimeoutMs = PRIMARY_TIMEOUT_MS, reaskDeadlineMs = REASK_DEADLINE_MS, maxReasks = MAX_REASKS }) {
  const state = { answered: {}, fallback: {}, reasked: {}, dashes: {}, skippedReask: {} };
  let reasksLeft = maxReasks;
  const byModel = new Map();
  const dupes = new Set();
  for (const l of LETTERS) {
    const m = record[l].model;
    if (byModel.has(m)) dupes.add(m); else byModel.set(m, l);
  }
  for (const m of dupes) byModel.delete(m); // two writers on one model can't be told apart: leave them alone
  const wrapped = async (url, init = {}) => {
    if (!/\/api\/v1\/chat\/completions(\?|$)/.test(String(url)) || !init || typeof init.body !== "string") return fetch(url, init);
    let body;
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    const letter = body && byModel.get(body.model);
    if (!letter) return fetch(url, init);
    const t0 = now();
    const send = (b, signal = init.signal) => fetch(url, { ...init, signal, body: JSON.stringify(b) });
    let model = body.model;
    let r;
    const fb = record[letter].fallbackModel;
    if (fb) {
      let reason = null;
      // a ref'd timer (AbortSignal.timeout is unref'd), cleared as soon as the primary settles
      const ac = new AbortController();
      const timer = setTimeout(() => { const e = new Error("primary timed out"); e.name = "TimeoutError"; ac.abort(e); }, primaryTimeoutMs);
      const onOuter = () => ac.abort(init.signal.reason);
      if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
      try {
        r = await send(body, ac.signal);
        if (r.status === 429 || r.status >= 500) reason = `HTTP ${r.status}`;
      } catch (e) {
        if (init.signal && init.signal.aborted) throw e;
        reason = ac.signal.aborted ? `no answer in ${Math.round(primaryTimeoutMs / 1000)} s` : "request error";
      } finally {
        clearTimeout(timer);
        if (init.signal) init.signal.removeEventListener("abort", onOuter);
      }
      if (reason) {
        model = fb;
        state.fallback[letter] = { from: body.model, to: fb, reason };
        r = await send({ ...body, model: fb });
      }
    } else {
      r = await send(body);
    }
    if (!r.ok) return r;
    let j;
    try { j = await r.clone().json(); } catch { return r; }
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!msg || typeof msg.content !== "string") return r;
    state.answered[letter] = model;
    let text = normalizeDashes(msg.content);
    if (text !== msg.content) state.dashes[letter] = true;
    let usd = usdOf(j, r);
    const ratio = copyRatio(text, draft);
    if (ratio > NEAR_COPY_RATIO && (reasksLeft <= 0 || now() - t0 >= reaskDeadlineMs)) {
      state.skippedReask[letter] = { ratio, why: reasksLeft <= 0 ? `the ${maxReasks}-re-ask limit for this run was reached` : "too late in the writer's time budget" };
    } else if (ratio > NEAR_COPY_RATIO) {
      reasksLeft--;
      try {
        const r2 = await send({ ...body, model, messages: [...(body.messages || []), { role: "assistant", content: msg.content }, { role: "user", content: REASK_TEXT }] });
        if (r2.ok) {
          const j2 = await r2.json();
          const m2 = j2 && j2.choices && j2.choices[0] && j2.choices[0].message;
          const u2 = usdOf(j2, r2);
          usd = usd != null && u2 != null ? usd + u2 : null;
          if (m2 && typeof m2.content === "string" && m2.content.trim()) {
            const t2 = normalizeDashes(m2.content);
            state.reasked[letter] = { ratio, after: copyRatio(t2, draft) };
            text = t2;
          } else state.reasked[letter] = { ratio, after: null };
        } else {
          state.reasked[letter] = { ratio, after: null, failed: `HTTP ${r2.status}` };
        }
      } catch (e) {
        if (init.signal && init.signal.aborted) throw e;
        state.reasked[letter] = { ratio, after: null, failed: "request error" };
      }
    }
    if (text === msg.content && model === body.model && !state.reasked[letter]) return r;
    const out = { ...j, choices: [{ ...j.choices[0], message: { ...msg, content: text } }] };
    delete out.cost; delete out.metadata;
    if (usd != null) out.x_nanogpt_pricing = { costUsd: usd }; else delete out.x_nanogpt_pricing;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: wrapped, state };
}

/** Notes for the tool result about fallbacks and re-asks this run. */
export function humanizeRunNotes(state) {
  const notes = [];
  for (const [l, f] of Object.entries(state.fallback)) notes.push(`note: writer ${l} (${f.from}) did not answer (${f.reason}), so ${f.to} wrote ${l}'s rewrite and is credited for it.`);
  for (const [l, r] of Object.entries(state.reasked)) notes.push(`note: writer ${l}'s first rewrite copied the draft (trigram overlap ${r.ratio.toFixed(2)}), so it was re-asked once` + (r.failed ? ` (the re-ask failed: ${r.failed}; its first rewrite was kept)` : r.after != null ? ` (overlap now ${r.after.toFixed(2)})` : "") + ".");
  for (const [l, r] of Object.entries(state.skippedReask)) notes.push(`note: writer ${l}'s rewrite copied the draft (trigram overlap ${r.ratio.toFixed(2)}) but was not re-asked (${r.why}); the decider judged it as is.`);
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

/** Throws ParamsError when a capped input is over its limit. `args` are the raw tool arguments. */
export function checkHumanizeInputs(args) {
  for (const [k, v] of Object.entries(args || {})) {
    const name = Object.keys(HUMANIZE_INPUT_CAPS).find((c) => c.toLowerCase() === String(k).trim().toLowerCase());
    if (!name || typeof v !== "string") continue;
    const len = [...v].length;
    if (len > HUMANIZE_INPUT_CAPS[name]) {
      throw new ParamsError(`input "${name}" is ${len} characters; humanize-comment accepts at most ${HUMANIZE_INPUT_CAPS[name]} (Draft ${HUMANIZE_INPUT_CAPS.Draft}, Context ${HUMANIZE_INPUT_CAPS.Context}, Guidance ${HUMANIZE_INPUT_CAPS.Guidance}). Shorten it and call again; nothing was charged.`);
    }
  }
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
 *  - winner: the decider's pick if it is ORIGINAL or an eligible entry (faithful, not disqualified,
 *    has text); otherwise the first eligible entry in ranked order (why then says so);
 *    otherwise ORIGINAL.
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
  if (winner !== "ORIGINAL" && !eligible(ranked.find((r) => r.writer === winner))) {
    const best = ranked.find(eligible);
    winner = best ? best.writer : "ORIGINAL";
    why = `The decider picked ${picked || "no winner"}, which is not eligible (unfaithful, disqualified, missing or unknown), so ${best ? "the best faithful, non-disqualified rewrite, " + winner + "," : "the original draft"} is used instead.`;
  }
  const text = winner === "ORIGINAL" ? draft : ranked.find((r) => r.writer === winner).text;
  result.outputs[out.key] = JSON.stringify({ winner, text, why, ranked });
  return null;
}
