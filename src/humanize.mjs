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
 */
import { ParamsError } from "./tools.mjs";

export const HUMANIZE_TOOL = "humanize-comment";
/** Hard caps in Unicode code points ([...s].length). */
export const HUMANIZE_INPUT_CAPS = { Draft: 1500, Context: 3500, Guidance: 300 };
const LETTERS = ["A", "B", "C", "D", "E"];

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
    record[m[1]] = { writer: m[1], nodeId: w.id, model: w.fields.model };
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
 *  - ranked lists A..E exactly once each; model always from the writer record, text always the
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
export function rebuildHumanizeResult(wf, result, record) {
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
      return { writer: letter, model: record[letter].model, text: text ?? "", faithful: false, disqualified: true, reason: text == null ? "missing" : "not judged: decider reply unusable" };
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
    if (text == null) { ranked.push({ writer: letter, model: record[letter].model, text: "", faithful: false, disqualified: true, reason: "missing" }); continue; }
    const faithful = r.faithful === true;
    const reason = String(r.reason ?? "");
    ranked.push({
      writer: letter, model: record[letter].model, text, faithful,
      disqualified: !faithful || r.disqualified !== false,
      reason: !faithful && r.disqualified === false ? `unfaithful${reason ? ": " + reason : ""}` : reason,
    });
  }
  for (const letter of LETTERS) if (!seen.has(letter)) {
    const text = textOf(letter);
    ranked.push({ writer: letter, model: record[letter].model, text: text ?? "", faithful: false, disqualified: true, reason: text == null ? "missing" : "not ranked by the decider" });
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
