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
 *      as nothing was paid for the primary. The model that actually answered is
 *      credited in ranked[]; if the fallback fails too, the note says so.
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
 *    - x402 (keyless wallet mode): writer 402 invoices are settled here, not by the
 *      nanoodle client, so the dash fix, re-asks and fallback credit apply to paid
 *      calls too. One invoice per attempt, paid at most once, replayed only with the
 *      body it was issued for; no fallback after a primary's payment STARTED (it is
 *      marked before the wallet call, since a wallet can send and still throw), unless
 *      the wallet error carries paymentNotSent === true. An unconfirmed payment goes to
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
 */
import { ParamsError } from "./tools.mjs";
import { parseNanoInvoice } from "nanoodle";

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
/** A re-ask must finish within this long of its writer call starting (writer node timeout is 60 s), or the first answer is kept. */
export const REASK_END_MS = 55000;
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
 * state.fallback[letter] = { from, to, reason, ok, failed? }, state.reasked[letter] = { ratio, after, failed? },
 * state.dashes[letter] = true when a dash was replaced, state.paidFailed[letter] = { model, status },
 * state.unreportedUsd / state.costUnknown = cost of attempts whose answer never reached the engine
 * (added to the run's total in tools.mjs so refund and payout math sees every billed attempt).
 *
 * x402 (keyless, `payment` callback): the nanoodle client's _paidFetch settles a 402 through the
 * invoice's complete URL, and that replayed result never passes back through a chat-completions
 * fetch. So for writer calls this wrapper settles the 402 itself, with the same callback, and hands
 * the client a finished 200 (the client then has nothing to pay). Every attempt (primary, fallback,
 * re-ask) is its own logical call with its own invoice, paid at most once, and replayed only with the
 * exact body that invoice was issued for. Once a primary's invoice is paid there is no fallback: a
 * paid call that then fails is reported as failed, never re-sent to another model and paid again.
 */
export function humanizeFetch({ record, draft, fetch = globalThis.fetch, payment = null, baseUrl = "https://nano-gpt.com", pollMs = 3000, now = Date.now, primaryTimeoutMs = PRIMARY_TIMEOUT_MS, reaskDeadlineMs = REASK_DEADLINE_MS, reaskEndMs = REASK_END_MS, maxReasks = MAX_REASKS }) {
  const state = { answered: {}, fallback: {}, reasked: {}, dashes: {}, skippedReask: {}, paidFailed: {}, attempts: [], paidIds: new Set(), reconcile: [], unreportedUsd: 0, costUnknown: false };
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
  const jsonResponse = (j, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });

  const wrapped = async (url, init = {}) => {
    if (!/\/api\/v1\/chat\/completions(\?|$)/.test(String(url)) || !init || typeof init.body !== "string") return fetch(url, init);
    let body;
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    const letter = body && byModel.get(body.model);
    if (!letter) return fetch(url, init);
    const t0 = now();
    const x402 = !!payment && String(hdr(init.headers, "x-x402")) === "true" && !hdr(init.headers, "authorization");
    let usd = 0, usdKnown = true; // this logical call: every attempt's cost
    const addCost = (v) => { if (v == null || !isFinite(v)) usdKnown = false; else usd += Number(v); };

    /**
     * One attempt = one request body, sent once and (under x402) paid at most once.
     * Returns { r, j, paid, rec }. `commit` runs just before a payment (the caller stops its fallback timer).
     */
    const mine = []; // this writer call's own attempts; concurrent writers never read each other's
    const lastMine = () => mine[mine.length - 1];
    const attempt = async (b, kind, signal, commit) => {
      const bodyStr = JSON.stringify(b);
      const rec = { letter, kind, model: b.model, status: null, paymentStarted: false, paid: false, paymentAmbiguous: false, paymentId: null, usd: null };
      mine.push(rec);
      state.attempts.push(rec);
      const req = { ...init, signal, body: bodyStr };
      let r = await fetch(url, req);
      if (r.status === 402 && x402) {
        const raw = await r.text();
        let inv = null;
        try { inv = parseNanoInvoice(JSON.parse(raw), baseUrl); } catch { inv = null; }
        if (!inv || !inv.paymentId || !inv.completeUrl || state.paidIds.has(inv.paymentId)) {
          rec.status = 402;
          const e = new Error(inv && state.paidIds.has(inv.paymentId) ? `x402 invoice ${inv.paymentId} was already paid; not paying it again` : "payment required, but the 402 response offered no usable Nano option");
          e.code = "x402"; throw e;
        }
        if (commit) commit();
        rec.paymentId = inv.paymentId;
        state.paidIds.add(inv.paymentId);
        // marked BEFORE the wallet call: a wallet can send and still throw, so from here on this
        // attempt counts as possibly paid and is never followed by a fallback, unless the wallet
        // proves nothing was sent (an error carrying paymentNotSent === true)
        rec.paymentStarted = true;
        try {
          await raceAbort(Promise.resolve().then(() => payment(inv)), signal);
        } catch (e) {
          if (e && e.paymentNotSent === true) { rec.paymentStarted = false; rec.status = "payment not sent"; throw e; }
          rec.paymentAmbiguous = true;
          rec.status = signal && signal.aborted ? "payment still pending at the deadline" : "payment call failed";
          state.reconcile.push({ letter, kind, model: b.model, paymentId: inv.paymentId, amountUsd: inv.amountUsd, ambiguous: true, status: rec.status });
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
            // settle-only receipt: replay THIS attempt's exact body, stamped with its own payment id
            r = await fetch(url, { ...req, headers: { ...(init.headers || {}), "x-x402-payment-id": inv.paymentId } });
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
    try {
      const fb = record[letter].fallbackModel;
      if (fb) {
        let reason = null;
        const ac = new AbortController();
        const timer = setTimeout(() => { const e = new Error("primary timed out"); e.name = "TimeoutError"; ac.abort(e); }, primaryTimeoutMs);
        const onOuter = () => ac.abort(init.signal.reason);
        if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
        try {
          res = await attempt(body, "primary", ac.signal, () => clearTimeout(timer));
          addCost(res.rec.usd);
          if (res.r.status === 429 || res.r.status >= 500) reason = `HTTP ${res.r.status}`;
        } catch (e) {
          const rec = lastMine();
          if (rec && (rec.paid || rec.paymentStarted)) {
            addCost(rec.paid ? rec.usd : null); // ambiguous: not charged, total marked as a lower bound
            state.paidFailed[letter] = { model: body.model, status: rec.status, paymentId: rec.paymentId, ambiguous: !rec.paid };
            throw e;
          }
          if (init.signal && init.signal.aborted) throw e;
          if (e && e.code && /^x402/.test(e.code)) throw e;
          reason = ac.signal.aborted ? `no answer in ${Math.round(primaryTimeoutMs / 1000)} s` : "request error";
          if (ac.signal.aborted && !x402) usdKnown = false; // an abandoned keyed request may still be billed
        } finally {
          clearTimeout(timer);
          if (init.signal) init.signal.removeEventListener("abort", onOuter);
        }
        if (reason && res && (res.rec.paid || res.rec.paymentStarted)) {
          // paid for the primary and it still failed: no fallback, so one logical call is never paid twice
          state.paidFailed[letter] = { model: body.model, status: res.r.status };
          reason = null;
        } else if (reason) {
          model = fb;
          state.fallback[letter] = { from: body.model, to: fb, reason, ok: false };
          try {
            res = await attempt({ ...body, model: fb }, "fallback", init.signal);
          } catch (e) {
            const rec = lastMine();
            if (rec) addCost(rec.paymentStarted && !rec.paid ? null : rec.usd);
            state.fallback[letter].failed = "request error";
            throw e;
          }
          addCost(res.rec.usd);
          if (res.r.ok) state.fallback[letter].ok = true; else state.fallback[letter].failed = `HTTP ${res.r.status}`;
        }
      } else {
        try { res = await attempt(body, "primary", init.signal); }
        catch (e) { const rec = lastMine(); if (rec) addCost(rec.paymentStarted && !rec.paid ? null : rec.usd); throw e; }
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
      const own = res.rec.usd || 0;
      if (usd - own > 0) state.unreportedUsd += usd - own;
      if (!usdKnown) state.costUnknown = true;
      return r;
    }
    state.answered[letter] = model;
    let text = normalizeDashes(msg.content);
    if (text !== msg.content) state.dashes[letter] = true;
    const ratio = copyRatio(text, draft);
    if (ratio > NEAR_COPY_RATIO && (reasksLeft <= 0 || now() - t0 >= reaskDeadlineMs)) {
      state.skippedReask[letter] = { ratio, why: reasksLeft <= 0 ? `the ${maxReasks}-re-ask limit for this run was reached` : "too late in the writer's time budget" };
    } else if (ratio > NEAR_COPY_RATIO) {
      reasksLeft--;
      // its own deadline: the re-ask must finish by reaskEndMs after the writer call began, or the
      // first answer is kept (so the writer's 60 s node timeout never eats a usable rewrite)
      const left = Math.max(0, t0 + reaskEndMs - now());
      const ac = new AbortController();
      const timer = setTimeout(() => { const e = new Error("re-ask timed out"); e.name = "TimeoutError"; ac.abort(e); }, left);
      const onOuter = () => ac.abort(init.signal.reason);
      if (init.signal) { if (init.signal.aborted) onOuter(); else init.signal.addEventListener("abort", onOuter, { once: true }); }
      try {
        const r2 = await attempt({ ...body, model, messages: [...(body.messages || []), { role: "assistant", content: msg.content }, { role: "user", content: REASK_TEXT }] }, "reask", ac.signal);
        addCost(r2.rec.usd);
        const m2 = r2.j && r2.j.choices && r2.j.choices[0] && r2.j.choices[0].message;
        if (r2.r.ok && m2 && typeof m2.content === "string" && m2.content.trim()) {
          const t2 = normalizeDashes(m2.content);
          state.reasked[letter] = { ratio, after: copyRatio(t2, draft) };
          text = t2;
        } else state.reasked[letter] = { ratio, after: null, failed: r2.r.ok ? "no text in the answer" : `HTTP ${r2.r.status}` };
      } catch (e) {
        if (init.signal && init.signal.aborted) { lose(); throw e; }
        const rec = lastMine();
        if (rec && rec.kind === "reask") {
          if (rec.paid) addCost(rec.usd);
          else if (rec.paymentStarted) usdKnown = false; // ambiguous payment: lower bound
          else if (ac.signal.aborted && !x402) usdKnown = false;
        }
        state.reasked[letter] = { ratio, after: null, failed: ac.signal.aborted ? `no answer within ${Math.round(reaskEndMs / 1000)} s of the writer call` : "request error" };
      } finally {
        clearTimeout(timer);
        if (init.signal) init.signal.removeEventListener("abort", onOuter);
      }
    }
    const out = { ...j, choices: [{ ...j.choices[0], message: { ...msg, content: text } }] };
    delete out.cost; delete out.metadata;
    if (usdKnown) out.x_nanogpt_pricing = { costUsd: usd };
    else { delete out.x_nanogpt_pricing; state.unreportedUsd += usd; state.costUnknown = true; }
    return jsonResponse(out);
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
