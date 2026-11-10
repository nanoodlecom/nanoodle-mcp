/**
 * NEAR Agent Market worker: poll assignments, read each job brief's workflow
 * request, check and price it with the NEAR gate's rules, decline what cannot
 * run or would exceed the per-job budget, and otherwise start, run the priced
 * graph once on the operator's NanoGPT key, upload the outputs and submit a
 * Markdown deliverable with the itemized cost.
 *
 * Exactly once. Each assignment has a durable record (src/market/state.mjs);
 * every phase is on disk before the remote call it leads to:
 *
 *   new ──price──> declining ──decline──> declined
 *    │
 *    └──> starting ──start (200)──> started ──> running ──run──> delivering ──upload──> submitting ──submit──> submitted
 *                                                  │                                                       │
 *                                                  └── run failed / found "running" after a restart ──> declining (failed)
 *                                                                                    request changes ──> reworking ──> submitting
 *
 * - The paid workflow runs only after `start` answered 200, and only from the
 *   "started" phase. "running" is written (fsync) before the first NanoGPT
 *   call. A record found in "running" when the worker starts was interrupted:
 *   it is handed back with a full buyer refund (decline, reason "failed"), and
 *   never run again.
 * - `start` is idempotent on the market, so an uncertain start is retried.
 * - Before every submit the record is marked uncertain on disk. An attempt
 *   after an uncertain one first reads the assignment back; if the earlier
 *   submit landed, it is recorded and nothing is sent again. Otherwise the
 *   same Markdown and files are sent again (the market treats an identical
 *   resubmission as a no-op).
 * - Outputs are uploaded before the deliverable is written, and the
 *   deliverable is on disk before the first submit, so an interrupted submit
 *   resumes without re-running anything.
 * - A decline that may have landed is checked by reading the assignment back.
 * - A row this state directory has no record of is run only when it is a
 *   fresh hire (startedAt null, no message from the worker's side). A row that
 *   was already started elsewhere (another worker, a lost or different state
 *   directory) is recorded as "stuck" (NEEDS OPERATOR) and never run.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrief, BriefError } from "./brief.mjs";
import { MarketApiError } from "./client.mjs";
import {
  pricingSummary, buildDeliverable, textOutputsFile, briefDeclineDetail, refusalDeclineDetail, failureDeclineDetail,
  startedMessage, REWORK_MESSAGE, MAX_INLINE_TEXT_BYTES, MAX_DELIVERABLE_BYTES, MAX_LISTED_FILES,
} from "./deliverable.mjs";

/** Phases after which the worker does nothing more for an assignment (unless the buyer sends it back). */
export const TERMINAL = new Set(["declined", "gone", "ignored", "stuck", "submitted"]);
const NEEDS_ROW = new Set(["new", "started"]);
const PROGRESS_MIN_MS = 30_000;

const short = (id) => String(id).slice(0, 8);
const errText = (e) => String((e && e.message) || e).slice(0, 500);
/**
 * Make one log line safe for a terminal: buyer-controlled text (job titles,
 * provider messages that quote a prompt) must not start a new, forged log line
 * or carry escape sequences. Control and bidi characters become \xNN / \uNNNN.
 */
export const logSafe = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
  (c) => { const n = c.charCodeAt(0); return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`; });
const tag = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

/**
 * @param {object} o
 * @param {object} o.client       createMarketClient()
 * @param {object} o.store        openMarketState()
 * @param {object} o.runner       createWorkflowRunner()
 * @param {number} o.budgetUsd    per-job budget (also the runner's deposit cap)
 * @param {number|null} [o.listingPriceUsd]  shown in the deliverable when set
 * @param {{graph: object, inputName: string, label: string}|null} [o.defaultWorkflow]
 *        when set, a brief with no workflow block runs this graph with the brief text as
 *        its `inputName` input (a buyer can hire in plain words)
 * @param {number} [o.concurrency]  assignments advanced at once (default 2)
 * @param {number} [o.backoffMs]    first retry delay after a transient error (default 30 s, doubling to 10 min)
 * @param {number} [o.retainMs]     keep finished records this long (default 30 days)
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createMarketWorker({
  client, store, runner, budgetUsd, listingPriceUsd = null, defaultWorkflow = null,
  concurrency = 2, backoffMs = 30_000, maxBackoffMs = 600_000, retainMs = 30 * 86_400_000,
  log: rawLog = () => {}, now = Date.now,
}) {
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) throw new TypeError("createMarketWorker needs a positive budgetUsd");
  const log = (line) => rawLog(logSafe(line));
  const inflight = new Map();
  /** Priced requests from this process, by assignment id: { pricing, inputs } (the bound graph is not persisted). */
  const prepared = new Map();
  const lastProgress = new Map();
  let active = 0;
  const waiters = [];
  const acquire = () => (active < concurrency ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
  const release = () => { const w = waiters.shift(); if (w) w(); else active--; };

  const set = (id, fields) => store.update(id, fields);
  // A (re)start is a natural retry point: whatever was waiting on a backoff is due now.
  for (const r of store.all()) if (!TERMINAL.has(r.phase) && r.nextAttemptAt) store.update(r.id, { nextAttemptAt: 0 });

  function backoff(rec, e) {
    const attempts = (rec.attempts || 0) + 1;
    const ra = e instanceof MarketApiError && e.retryAfter != null ? e.retryAfter * 1000 : 0;
    const wait = Math.max(ra, Math.min(maxBackoffMs, backoffMs * 2 ** (attempts - 1)));
    log(`assignment ${short(rec.id)}: ${rec.phase} will retry in ${Math.round(wait / 1000)} s (${errText(e)})`);
    return set(rec.id, { attempts, nextAttemptAt: now() + wait, lastError: errText(e) });
  }
  const ok = (fields) => ({ attempts: 0, nextAttemptAt: 0, lastError: null, ...fields });

  async function progress(id, message, percent) {
    const t = now();
    if (t - (lastProgress.get(id) || 0) < PROGRESS_MIN_MS) return;
    lastProgress.set(id, t);
    try { await client.progress(id, { message, percent }); } catch (e) {
      log(`assignment ${short(id)}: progress report skipped (${errText(e)})`);
    }
  }
  async function say(id, body, clientRequestId) {
    try { await client.message(id, { body, clientRequestId }); } catch (e) {
      log(`assignment ${short(id)}: message not sent (${errText(e)})`);
    }
  }

  /** Read one assignment back (any status). null when the market no longer lists it. */
  const lookup = (id) => client.findAssignment(id);

  /* ------------------------------ phases ------------------------------ */

  async function priceFromRow(rec, row) {
    let args;
    let usedDefault = false;
    try { args = parseBrief(row.job && row.job.description); } catch (e) {
      if (!(e instanceof BriefError)) throw e;
      // A brief in plain words (no workflow block at all) runs the operator's default
      // workflow, with the brief as its input. A block that is there but broken is still
      // refused: the buyer meant a specific workflow, and guessing would spend their hire.
      const plain = String((row.job && row.job.description) || "").trim() || String((row.job && row.job.title) || "").trim();
      if (!(defaultWorkflow && e.code === "NO_REQUEST" && plain)) {
        log(`assignment ${short(rec.id)}: brief refused (${e.code})`);
        return { decline: { reason: "rejected", code: e.code, detail: briefDeclineDetail(e.message) } };
      }
      args = { graph: defaultWorkflow.graph, inputs: { [defaultWorkflow.inputName]: plain } };
      usedDefault = true;
      log(`assignment ${short(rec.id)}: plain brief (${plain.length} characters) → default workflow ${JSON.stringify(defaultWorkflow.label)}`);
    }
    const priced = await runner.price(args);
    if (!priced.ok) {
      const transient = priced.refusals.some((r) => r.code === "CATALOG_UNAVAILABLE");
      if (transient) return { transient: new Error("the NanoGPT model catalog is unavailable") };
      const codes = [...new Set(priced.refusals.map((r) => r.code))];
      log(`assignment ${short(rec.id)}: workflow refused (${codes.join(", ")})`);
      return { decline: { reason: "rejected", code: codes.join(","), detail: refusalDeclineDetail(priced.refusals, { budgetUsd }) } };
    }
    return { pricing: priced.pricing, inputs: priced.inputs, usedDefault };
  }

  async function phaseNew(rec, row) {
    const r = await priceFromRow(rec, row);
    if (r.transient) return backoff(rec, r.transient);
    if (r.decline) return set(rec.id, ok({ phase: "declining", decline: r.decline }));
    prepared.set(rec.id, { pricing: r.pricing, inputs: r.inputs, usedDefault: r.usedDefault });
    log(`assignment ${short(rec.id)}: accepted — estimated cost $${r.pricing.estimatedCostUsd.toFixed(6)}, deposit $${r.pricing.depositUsd} within budget $${budgetUsd}`);
    return set(rec.id, ok({ phase: "starting", pricing: pricingSummary(r.pricing), defaultWorkflow: r.usedDefault ? defaultWorkflow.label : null }));
  }

  async function phaseDeclining(rec) {
    try {
      await client.decline(rec.id, { reason: rec.decline.reason, detail: rec.decline.detail });
    } catch (e) {
      if (!(e instanceof MarketApiError)) throw e;
      if (e.retryable) return backoff(rec, e);
      // A definite refusal: maybe an earlier decline landed, or the buyer cancelled first.
      const row = await lookup(rec.id).catch(() => undefined);
      if (row === undefined) return backoff(rec, e);
      const st = row && row.assignment.status;
      if (!row || st === "cancelled") return set(rec.id, ok({ phase: "declined", finishedAt: now(), note: "already cancelled on the market" }));
      log(`assignment ${short(rec.id)}: NEEDS OPERATOR — decline refused (${errText(e)}); status ${st}`);
      return set(rec.id, ok({ phase: "stuck", lastError: errText(e), finishedAt: now() }));
    }
    log(`assignment ${short(rec.id)}: declined (${rec.decline.reason}${rec.decline.code ? `, ${rec.decline.code}` : ""}); the buyer is refunded in full`);
    return set(rec.id, ok({ phase: "declined", finishedAt: now() }));
  }

  async function phaseStarting(rec) {
    try {
      const r = await client.start(rec.id);
      return set(rec.id, ok({ phase: "started", startedAt: (r && r.startedAt) || new Date(now()).toISOString() }));
    } catch (e) {
      if (!(e instanceof MarketApiError)) throw e;
      if (e.retryable) return backoff(rec, e); // start is idempotent: retrying an uncertain start is safe
      if (e.status === 400 || e.status === 404) {
        log(`assignment ${short(rec.id)}: no longer startable (${errText(e)}); nothing was run`);
        return set(rec.id, ok({ phase: "gone", finishedAt: now(), lastError: errText(e) }));
      }
      log(`assignment ${short(rec.id)}: NEEDS OPERATOR — start refused (${errText(e)})`);
      return set(rec.id, ok({ phase: "stuck", lastError: errText(e), finishedAt: now() }));
    }
  }

  async function phaseStarted(rec, row) {
    let prep = prepared.get(rec.id);
    if (!prep) {
      // Restarted between start and run: nothing ran yet. Price again from the brief.
      const r = await priceFromRow(rec, row);
      if (r.transient) return backoff(rec, r.transient);
      if (r.decline) return set(rec.id, ok({ phase: "declining", decline: r.decline }));
      prep = { pricing: r.pricing, inputs: r.inputs, usedDefault: r.usedDefault };
    }
    prepared.delete(rec.id);
    await say(rec.id, startedMessage(prep.pricing, { budgetUsd, defaultLabel: prep.usedDefault ? defaultWorkflow.label : null }), `nanoodle-start-${rec.id}`);
    // Durable BEFORE the first paid call: a crash from here on is never re-run.
    rec = set(rec.id, ok({ phase: "running", pricing: pricingSummary(prep.pricing), runStartedAt: now() }));
    await progress(rec.id, `Running the workflow once (${prep.pricing.items.length} paid step${prep.pricing.items.length === 1 ? "" : "s"})`, 10);
    log(`assignment ${short(rec.id)}: running the workflow`);
    let run;
    try {
      run = await runner.run({ pricing: prep.pricing, inputs: prep.inputs, outDir: store.outDir(rec.id) });
    } catch (e) {
      log(`assignment ${short(rec.id)}: run failed (${errText(e)}); handing it back`);
      // Only the provider's own per-step message (runner.mjs marks it buyerMessage) goes to the
      // buyer. Anything else (a local file-system error, a bug) can name this machine's paths:
      // the buyer gets a generic sentence and the operator keeps the full error in the log.
      const forBuyer = e && typeof e.buyerMessage === "string" ? e.buyerMessage.slice(0, 600) : "";
      return set(rec.id, ok({
        phase: "declining", outcome: "run_failed", runFinishedAt: now(), run: { error: errText(e) },
        decline: { reason: "failed", code: "RUN_FAILED", detail: failureDeclineDetail("failed", forBuyer) },
      }));
    }
    log(`assignment ${short(rec.id)}: run finished — actual cost ${run.costUsd == null ? "not reported" : `$${run.costUsd}`}${run.costExact ? "" : " (lower bound)"}`);
    return set(rec.id, ok({ phase: "delivering", outcome: "ran", runFinishedAt: now(), run, uploads: {} }));
  }

  function phaseInterrupted(rec) {
    log(`assignment ${short(rec.id)}: found mid-run after a restart; it is NOT run again — handing it back with a full refund`);
    return set(rec.id, ok({
      phase: "declining", outcome: "interrupted",
      decline: { reason: "failed", code: "INTERRUPTED", detail: failureDeclineDetail("interrupted") },
    }));
  }

  async function uploadOne(rec, key, { path, filename, byteSize }) {
    const prev = (rec.uploads || {})[key];
    if (prev && prev.completed) return rec;
    if (prev && prev.fileId) {
      // A reservation from an interrupted attempt: free it and start over.
      try { await client.deleteFile(prev.fileId); } catch { /* the daily sweep reclaims it */ }
    }
    const bytes = readFileSync(path);
    if (bytes.length !== byteSize) throw new Error(`output file ${filename} changed on disk`);
    const res = await client.reserveFile({ filename, byteSize });
    rec = set(rec.id, { uploads: { ...(rec.uploads || {}), [key]: { fileId: res.fileId, fileUrl: res.fileUrl || null, filename, completed: false } } });
    await client.uploadBytes(res, bytes);
    await client.completeFile(res.fileId);
    return set(rec.id, { uploads: { ...(rec.uploads || {}), [key]: { ...rec.uploads[key], completed: true } } });
  }

  async function phaseDelivering(rec) {
    await progress(rec.id, "Uploading the outputs", 80);
    const run = rec.run;
    const files = run.outputs.filter((o) => o.kind === "file");
    const textBytes = run.outputs.filter((o) => o.kind === "text").reduce((n, o) => n + Buffer.byteLength(o.text), 0);
    const jobs = files.map((o, i) => ({ key: `f${i}`, out: o, path: o.path, filename: o.filename, byteSize: o.byteSize }));
    if (textBytes > MAX_INLINE_TEXT_BYTES) {
      const path = join(store.outDir(rec.id), "text-outputs.md");
      let size;
      try { size = readFileSync(path).length; } catch {
        const body = textOutputsFile(run);
        writeFileSync(path, body, { mode: 0o600 });
        size = Buffer.byteLength(body);
      }
      jobs.push({ key: "text", path, filename: "text-outputs.md", byteSize: size });
    }
    for (const j of jobs) {
      try {
        rec = await uploadOne(rec, j.key, j);
      } catch (e) {
        if (e instanceof MarketApiError && e.retryable) return backoff(rec, e);
        if (e instanceof MarketApiError) {
          log(`assignment ${short(rec.id)}: output ${j.filename} could not be uploaded (${errText(e)}); delivering without it`);
          rec = set(rec.id, { uploads: { ...(rec.uploads || {}), [j.key]: { filename: j.filename, completed: false, skipped: errText(e) } } });
          continue;
        }
        return backoff(rec, e);
      }
    }
    const up = rec.uploads || {};
    const delivered = jobs.filter((j) => j.out && up[j.key] && up[j.key].completed)
      .map((j) => ({ key: j.out.key, filename: j.filename, fileUrl: up[j.key].fileUrl || up[j.key].fileId }));
    const textFileUrl = up.text && up.text.completed ? up.text.fileUrl || up.text.fileId : null;
    let markdown = buildDeliverable({ record: rec, files: delivered, budgetUsd, listingPriceUsd, textFileUrl });
    if (Buffer.byteLength(markdown) > MAX_DELIVERABLE_BYTES) {
      markdown = markdown.slice(0, MAX_DELIVERABLE_BYTES / 2) + "\n\n(The deliverable was cut to fit the market's 256 KiB limit.)\n";
    }
    const listed = [...delivered.map((f) => f.fileUrl), ...(textFileUrl ? [textFileUrl] : [])].slice(0, MAX_LISTED_FILES);
    return set(rec.id, ok({ phase: "submitting", deliverable: { markdown, files: listed }, submitBaseline: null, submitUncertain: false }));
  }

  const landed = (row, baseline) => {
    if (!row) return false;
    const a = row.assignment;
    if (a.status === "submitted" || a.status === "accepted" || a.status === "disputed" || a.status === "dispute_resolved") return true;
    return !!(a.submittedAt && a.submittedAt !== baseline);
  };

  async function phaseSubmitting(rec) {
    if (rec.submitUncertain) {
      let row;
      try { row = await lookup(rec.id); } catch (e) { return backoff(rec, e); }
      if (landed(row, rec.submitBaseline)) {
        log(`assignment ${short(rec.id)}: the earlier submit landed (its answer was lost); not sending it again`);
        return set(rec.id, ok({ phase: "submitted", submitUncertain: false, submittedAt: row.assignment.submittedAt || null, finishedAt: now() }));
      }
      if (row && row.assignment.status === "cancelled") {
        log(`assignment ${short(rec.id)}: NEEDS OPERATOR — cancelled on the market before the delivery landed`);
        return set(rec.id, ok({ phase: "stuck", submitUncertain: false, lastError: "cancelled before delivery", finishedAt: now() }));
      }
    }
    rec = set(rec.id, { submitUncertain: true, submitAttempts: (rec.submitAttempts || 0) + 1 });
    let res;
    try {
      res = await client.submit(rec.id, { deliverableMarkdown: rec.deliverable.markdown, files: rec.deliverable.files });
    } catch (e) {
      if (!(e instanceof MarketApiError)) throw e;
      if (e.uncertain || e.retryable) return backoff(rec, e);
      // A definite 4xx stores nothing.
      rec = set(rec.id, { submitUncertain: false });
      if (e.code === "invalid_state_transition") {
        let row;
        try { row = await lookup(rec.id); } catch (e2) { return backoff(rec, e2); }
        if (landed(row, rec.submitBaseline)) {
          return set(rec.id, ok({ phase: "submitted", submittedAt: row.assignment.submittedAt || null, finishedAt: now() }));
        }
      }
      log(`assignment ${short(rec.id)}: NEEDS OPERATOR — finished work could not be submitted (${errText(e)}); the deliverable is kept in the state file`);
      return set(rec.id, ok({ phase: "stuck", lastError: errText(e), finishedAt: now() }));
    }
    log(`assignment ${short(rec.id)}: delivered`);
    return set(rec.id, ok({ phase: "submitted", submitUncertain: false, submittedAt: (res && res.submittedAt) || null, finishedAt: now() }));
  }

  async function phaseReworking(rec, row) {
    if (!rec.deliverable) {
      await say(rec.id, REWORK_MESSAGE.replace(" The delivered result is submitted again unchanged.", ""), `nanoodle-rework-${rec.id}-${tag(rec.reworkEpoch)}`);
      return set(rec.id, ok({ phase: "stuck", lastError: "change request after the deliverable was pruned", finishedAt: now() }));
    }
    await say(rec.id, REWORK_MESSAGE, `nanoodle-rework-${rec.id}-${tag(rec.reworkEpoch)}`);
    const note = `\n---\n\nSubmitted again unchanged after a change request (${new Date(now()).toISOString()}): this agent runs a workflow once per hire. Hire it again to run a changed workflow.\n`;
    const markdown = rec.deliverable.markdown.split("\n---\n\nSubmitted again unchanged")[0] + note;
    return set(rec.id, ok({
      phase: "submitting", deliverable: { ...rec.deliverable, markdown },
      submitBaseline: (row && row.assignment.submittedAt) || rec.submittedAt || null, submitUncertain: false,
    }));
  }

  async function advance(id, row) {
    let rec = store.get(id);
    for (let step = 0; step < 12 && rec && !TERMINAL.has(rec.phase) && (rec.nextAttemptAt || 0) <= now(); step++) {
      const before = rec.updatedAt + rec.phase;
      switch (rec.phase) {
        case "new": rec = await phaseNew(rec, row); break;
        case "declining": rec = await phaseDeclining(rec); break;
        case "starting": rec = await phaseStarting(rec); break;
        case "started": rec = await phaseStarted(rec, row); break;
        case "running": rec = phaseInterrupted(rec); break;
        case "delivering": rec = await phaseDelivering(rec); break;
        case "submitting": rec = await phaseSubmitting(rec); break;
        case "reworking": rec = await phaseReworking(rec, row); break;
        default:
          log(`assignment ${short(id)}: unknown phase ${rec.phase}`);
          return;
      }
      if (rec && rec.updatedAt + rec.phase === before) break;
    }
  }

  function launch(id, row) {
    if (inflight.has(id)) return;
    const p = (async () => {
      await acquire();
      try { await advance(id, row); } catch (e) {
        const rec = store.get(id);
        if (rec) try { backoff(rec, e); } catch { /* state closed */ }
        else log(`assignment ${short(id)}: ${errText(e)}`);
      } finally {
        release();
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
  }

  /** One poll: list actionable assignments, record new ones, and advance everything that is due. */
  async function tick() {
    let rows = null;
    try { rows = await client.listActionable(); } catch (e) {
      log(`poll failed: ${errText(e)}`);
      if (e instanceof MarketApiError && e.status === 401) throw new Error("the market rejected the agent token (HTTP 401); check MARKET_AGENT_TOKEN");
    }
    const byId = new Map();
    for (const row of rows || []) {
      const a = row && row.assignment;
      if (!a || typeof a.assignmentId !== "string") continue;
      byId.set(a.assignmentId, row);
      const rec = store.get(a.assignmentId);
      if (!rec) {
        if (row.job && row.job.jobKind === "competition") {
          store.create(a.assignmentId, { phase: "ignored", jobId: a.jobId, note: "competition entry", finishedAt: now() });
        } else if (a.submittedAt || a.deliverableUrl) {
          log(`assignment ${short(a.assignmentId)}: delivered before this worker knew it; leaving it to the operator`);
          store.create(a.assignmentId, { phase: "ignored", jobId: a.jobId, note: "delivered outside this worker", finishedAt: now() });
        } else if (a.startedAt || (row.latestMessage && row.latestMessage.senderSide === "worker")) {
          // A fresh hire has startedAt null and no message from our side. This one was already
          // started (by another worker on another state directory, or by this worker before its
          // state was lost): its workflow may have run and been paid for. Never run it again.
          log(`assignment ${short(a.assignmentId)}: NEEDS OPERATOR — already started before this worker knew it ` +
            `(another worker, or a lost or different --state-dir); it is NOT run. Deliver or decline it on the market by hand.`);
          store.create(a.assignmentId, {
            phase: "stuck", jobId: a.jobId, note: "started outside this state directory",
            lastError: "already started when first seen; not run", finishedAt: now(),
          });
        } else {
          log(`assignment ${short(a.assignmentId)}: new hire ${JSON.stringify(String((row.job && row.job.title) || "").slice(0, 60))}` +
            (a.escrowAmount != null ? ` for ${String(a.escrowAmount).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} ${a.escrowToken || ""}`.trimEnd() : ""));
          store.create(a.assignmentId, { phase: "new", jobId: a.jobId, epoch: String(a.slaDeadlineAt || "") });
        }
      } else if (rec.phase === "submitted" && a.status === "in_progress" && !inflight.has(a.assignmentId)) {
        // Sent back: delivered before (submittedAt kept on request-changes, deliverableUrl kept on a
        // dispute redo) and re-armed (slaDeadlineAt changes on every re-entry into in_progress). A row
        // listed just before our own submit landed has neither, so it is not mistaken for one.
        const epoch = String(a.slaDeadlineAt || "");
        if ((a.submittedAt || a.deliverableUrl) && epoch !== rec.epoch && !(rec.reworks || []).includes(epoch)) {
          log(`assignment ${short(a.assignmentId)}: sent back by the buyer (or a dispute redo)`);
          store.update(a.assignmentId, ok({ phase: "reworking", reworkEpoch: epoch, epoch, reworks: [...(rec.reworks || []), epoch] }));
        }
      }
    }
    for (const rec of store.all()) {
      if (TERMINAL.has(rec.phase) || inflight.has(rec.id) || (rec.nextAttemptAt || 0) > now()) continue;
      const row = byId.get(rec.id);
      if (NEEDS_ROW.has(rec.phase) && !row) {
        if (rows === null) continue; // the poll failed: do not mistake that for a cancelled hire
        let found;
        try { found = await lookup(rec.id); } catch (e) { backoff(rec, e); continue; }
        if (found && found.assignment.status === "in_progress") { launch(rec.id, found); continue; }
        log(`assignment ${short(rec.id)}: no longer in progress (${found ? found.assignment.status : "not listed"}); nothing was run`);
        store.update(rec.id, ok({ phase: "gone", finishedAt: now() }));
        continue;
      }
      launch(rec.id, row);
    }
    try { store.prune(now() - retainMs, (r) => r.phase === "declined" || r.phase === "gone" || r.phase === "ignored" || r.phase === "submitted"); } catch { /* next time */ }
  }

  /** Wait for every assignment being advanced right now. */
  async function drain() {
    while (inflight.size) await Promise.allSettled([...inflight.values()]);
  }

  return { tick, drain, inflight: () => inflight.size };
}
