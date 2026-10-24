/**
 * posed-game-character — one sentence to a textured, symmetric, quad mesh.
 *
 * GLM 5.3 Flash writes the image prompt, FLUX.3 Klein paints an A-pose,
 * Bria removes the background, Hyper3D Rodin 2.5 (standard tier) builds the
 * model. The deposit is a cap: worst-case provider cost × 1.2, plus a small
 * margin. A stage whose settled cost does not fit the remaining deposit is
 * skipped and not billed. Settlement is min(metered × 1.2, the quote).
 *
 * The SFW safety checker stays on. NSFW is off; there is no switch to turn it on.
 * Keyless 402s are settled here so a cancel after the invoice read, or inside
 * the queued payment callback, never sends.
 */
import { MediaRef, parseNanoInvoice, strictUsd } from "nanoodle";
import { ParamsError } from "./tools.mjs";
import {
  SETTLE_MARKUP, depositFromCharge, chatCallUsd, beginPayment, callPayment, openBudget,
  reserveInvoice, releaseInvoice, noteUncertainPayment,
} from "./pay-guard.mjs";

export const POSED_TOOL = "posed-game-character";
/** One sentence, in Unicode code points. Worst-case bytes are this times 4. */
export const POSED_SENTENCE_CAP = 400;

export const GLM_MODEL = "z-ai/glm-5.3-flash";
export const FLUX_MODEL = "blackforestlabs/flux-3/klein/text-to-image";
export const BRIA_MODEL = "bria/remove-background-guided";
export const RODIN_MODEL = "hyper3d/rodin-v2.5";

const FALLBACK_CHAT = [0.1, 0.3];
const FALLBACK_FLUX = 0.009;
const FALLBACK_BRIA = 0.03;
const FALLBACK_RODIN = 0.48;

const SAFETY_OFF = ["disable_safety_checker", "disable_safety", "allow_nsfw", "uncensored", "nsfw"];

function catalogRows(catalogs, kind) {
  const rows = catalogs && catalogs[kind];
  return Array.isArray(rows) ? rows : [];
}

function catalogModel(catalogs, kind, id) {
  return catalogRows(catalogs, kind).find((m) => m && (m.id === id || m.model === id)) || null;
}

function chatRates(catalogs) {
  const row = catalogModel(catalogs, "chat", GLM_MODEL);
  const p = row && row.pricing;
  const pin = strictUsd(p && p.prompt);
  const pout = strictUsd(p && p.completion);
  if (pin != null && pout != null && pin > 0 && pout > 0) return [pin, pout];
  return FALLBACK_CHAT;
}

function perImage(catalogs, id, size, fallback) {
  const row = catalogModel(catalogs, "image", id);
  const per = row && row.pricing && row.pricing.per_image;
  if (per && typeof per === "object") {
    const exact = strictUsd(per[size]);
    if (exact != null && exact > 0) return exact;
    const short = String(size).split("x")[0];
    const shortUsd = short ? strictUsd(per[short]) : null;
    if (shortUsd != null && shortUsd > 0) return shortUsd;
    const auto = strictUsd(per.auto);
    if (size === "auto" && auto != null && auto > 0) return auto;
  }
  return fallback;
}

/**
 * Rodin price for the locked graph options: tier Gen-2.5-Medium and no HighPack.
 * That is the catalog's `standard` variant. `per_run` on this model is that same
 * standard price; the higher variants are Extreme High and HighPack, which this
 * graph does not send. A catalog that only publishes `per_run` still bills standard.
 */
function rodinUsd(catalogs) {
  const row = catalogModel(catalogs, "model3d", RODIN_MODEL);
  const by = row && row.pricing && row.pricing.per_run_by_variant;
  const standard = by && strictUsd(by.standard);
  if (standard != null && standard > 0) return standard;
  const perRun = row && row.pricing && strictUsd(row.pricing.per_run);
  if (perRun != null && perRun > 0) return perRun;
  return FALLBACK_RODIN;
}

function writerNode(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
  return nodes.find((n) => n && n.type === "llm" && n.fields && n.fields.model === GLM_MODEL) || null;
}

/** Worst-case provider USD for each billed stage. Catalog numbers win when the row is present. */
export function posedStageUsd(graph, catalogs) {
  const writer = writerNode(graph);
  const system = writer && writer.fields ? String(writer.fields.system || "") : "";
  const maxTokens = writer && writer.fields && Number(writer.fields.maxTokens) > 0 ? Number(writer.fields.maxTokens) : 200;
  const inputBytes = Buffer.byteLength(system) + POSED_SENTENCE_CAP * 4;
  return {
    llm: chatCallUsd(chatRates(catalogs), inputBytes, 2, maxTokens),
    image: perImage(catalogs, FLUX_MODEL, "1024x1024", FALLBACK_FLUX),
    cut: perImage(catalogs, BRIA_MODEL, "auto", FALLBACK_BRIA),
    mesh: rodinUsd(catalogs),
  };
}

export function posedWorstUsd(graph, catalogs) {
  const s = posedStageUsd(graph, catalogs);
  return s.llm + s.image + s.cut + s.mesh;
}

/** Deposit cap: worst-case provider cost × 1.2, plus the small margin. */
export function posedQuoteUsd(graph, catalogs) {
  return depositFromCharge(posedWorstUsd(graph, catalogs) * SETTLE_MARKUP);
}

/** Refuse a blank or over-long sentence before any money moves. Omitted uses the graph default. */
export function checkPosedInputs(args) {
  if (!args || typeof args !== "object") return;
  for (const [key, value] of Object.entries(args)) {
    if (String(key).trim().toLowerCase() !== "character") continue;
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text) throw new ParamsError("Character must be one sentence");
    const n = [...text].length;
    if (n > POSED_SENTENCE_CAP) {
      throw new ParamsError(`Character must be at most ${POSED_SENTENCE_CAP} characters (got ${n})`);
    }
  }
}

/**
 * Safety stays on. A body that already turned a checker off, or asked for NSFW,
 * is corrected. Absent keys stay absent — image routes reject unknown fields,
 * so this does not invent enable_safety_checker.
 */
export function enforceSfwBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (body.enable_safety_checker === false) body.enable_safety_checker = true;
  if (body.safety_checker === false) body.safety_checker = true;
  for (const key of SAFETY_OFF) if (body[key] === true) body[key] = false;
  return body;
}

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return hit ? hit[1] : null;
}

function usdOf(j) {
  if (!j || typeof j !== "object") return null;
  const p = j.x_nanogpt_pricing;
  const pUsd = p && (p.costUsd != null ? p.costUsd : p.cost != null ? p.cost : p.amount);
  if (typeof j.cost === "number" && j.cost > 0) return strictUsd(j.cost);
  if (pUsd != null) return strictUsd(pUsd);
  const mUsd = j.metadata && j.metadata.cost;
  if (mUsd != null) return strictUsd(mUsd);
  if (typeof j.cost === "number") return strictUsd(j.cost);
  return null;
}

function stageOf(url, body) {
  const u = String(url);
  const model = body && body.model;
  if (/\/api\/v1\/chat\/completions(\?|$)/.test(u) && model === GLM_MODEL) return "llm";
  if (/\/v1\/images\/generations(\?|$)/.test(u) && model === FLUX_MODEL) return "image";
  if (/\/v1\/images\/generations(\?|$)/.test(u) && model === BRIA_MODEL) return "cut";
  if (/\/api\/generate-video(\?|$)/.test(u) && model === RODIN_MODEL) return "mesh";
  return null;
}

const STAGE_LABEL = { llm: "the prompt", image: "the A-pose", cut: "the cutout", mesh: "the mesh" };

function budgetSkip(stage) {
  const e = new Error(`remaining deposit cannot cover ${STAGE_LABEL[stage] || stage}`);
  e.code = "budget-skip";
  return e;
}

function jsonResponse(j, status = 200) {
  return new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
}

/**
 * Per-run fetch for posed-game-character. Skips a stage the remaining deposit
 * cannot cover, corrects a poisoned safety body, and settles keyless 402s
 * itself. The client then sees 200 and does not pay a second time.
 */
export function posedFetch({ stages, budget, fetch = globalThis.fetch, payment = null, baseUrl = "https://nano-gpt.com" }) {
  const book = budget || openBudget(0);
  const ledger = {
    paidIds: new Set(),
    bodies: new Map(),
    reconcile: [],
    costUnknown: false,
    unreportedUsd: 0,
  };
  const fn = async (url, init = {}) => {
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "POST" || !init || typeof init.body !== "string") return fetch(url, init);
    const retryId = header(init.headers, "x-x402-payment-id");
    if (retryId && ledger.bodies.has(String(retryId))) {
      return fetch(url, { ...init, body: ledger.bodies.get(String(retryId)) });
    }
    let body;
    try { body = JSON.parse(init.body); } catch { return fetch(url, init); }
    enforceSfwBody(body);
    const stage = stageOf(url, body);
    const next = { ...init, body: JSON.stringify(body) };
    const forecast = stage ? Number(stages && stages[stage]) : 0;
    if (stage && !book.fits(forecast * SETTLE_MARKUP)) throw budgetSkip(stage);
    const signal = init.signal;
    const r = await fetch(url, next);
    const x402 = !!payment && String(header(init.headers, "x-x402")) === "true" && !header(init.headers, "authorization");
    if (stage && r.status === 402 && x402) {
      return settle402({ r, signal, payment, fetch, url, init: next, baseUrl, budget: book, ledger, stage });
    }
    if (stage && r.ok) {
      let j = null;
      try { j = await r.clone().json(); } catch { j = null; }
      const usd = usdOf(j);
      if (usd != null) book.add(usd);
    }
    return r;
  };
  fn.ledger = ledger;
  return fn;
}

async function settle402({ r, signal, payment, fetch, url, init, baseUrl, budget, ledger, stage }) {
  const raw = await r.text();
  // Parsed out here so every error and cancel path below can still name the invoice.
  let inv = null;
  try { inv = parseNanoInvoice(JSON.parse(raw), baseUrl); } catch { inv = null; }
  if (signal && signal.aborted) throw signal.reason;
  if (!inv || !inv.paymentId || !inv.completeUrl) {
    const e = new Error("payment required, but the 402 response offered no usable Nano option");
    e.code = "x402";
    e.paymentNotSent = true;
    throw e;
  }
  const stageLabel = STAGE_LABEL[stage] || stage;
  let reserved = null;
  try {
    // After the invoice read, and again inside the queued callback before reserveInvoice pays.
    // callPayment turns a synchronous throw into the same rejection as an async one,
    // so a paymentNotSent failure releases the commit either way.
    await beginPayment(signal, () => {
      reserved = reserveInvoice({
        signal, inv, bodyStr: init.body, paidIds: ledger.paidIds, bodies: ledger.bodies,
        budget, stageLabel,
      });
      return callPayment(payment, inv).then((v) => v, (e) => {
        if (e && e.paymentNotSent === true && reserved) {
          releaseInvoice({ id: reserved.id, usd: reserved.committed, paidIds: ledger.paidIds, budget });
          reserved = null;
        }
        throw e;
      });
    });
  } catch (e) {
    // Nothing was reserved, or the wallet proved it did not send: not an uncertain payment.
    if (!reserved || (e && e.paymentNotSent === true)) {
      if (reserved) releaseInvoice({ id: reserved.id, usd: reserved.committed, paidIds: ledger.paidIds, budget });
      throw e;
    }
    const status = signal && signal.aborted ? "aborted after payment" : "payment outcome uncertain";
    noteUncertainPayment(ledger, inv, status);
    throw e;
  }
  try {
    const cr = await fetch(inv.completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-x402": "true" },
      body: "{}",
      signal,
    });
    let cj = null;
    if (cr.ok) {
      try { cj = await cr.clone().json(); } catch { cj = null; }
    }
    const replayed = cj && typeof cj === "object" && (cj.choices || cj.data || cj.runId || cj.output);
    let result = replayed ? cj : null;
    if (!result) {
      const again = await fetch(url, {
        ...init,
        body: reserved.body,
        headers: { ...(init.headers || {}), "x-x402-payment-id": inv.paymentId },
      });
      if (!again.ok) {
        const err = new Error(`payment ${inv.paymentId} settled, but the replay was not accepted`);
        err.code = "x402";
        throw err;
      }
      try { result = await again.json(); } catch {
        const err = new Error(`payment ${inv.paymentId} settled, but the replay was not JSON`);
        err.code = "x402";
        throw err;
      }
    }
    if (result && typeof result === "object" && usdOf(result) == null && reserved.usd > 0) {
      result = { ...result, x_nanogpt_pricing: { ...(result.x_nanogpt_pricing || {}), costUsd: reserved.usd } };
    }
    const metered = usdOf(result);
    if (metered != null && reserved.committed > 0) {
      budget.release(reserved.committed);
      budget.add(metered);
    }
    return jsonResponse(result || {});
  } catch (e) {
    // payment() already returned. A later error keeps the reservation even when
    // it carries paymentNotSent: the wallet call completed, so the spend is uncertain.
    const status = signal && signal.aborted ? "aborted after payment" : "payment outcome uncertain";
    noteUncertainPayment(ledger, inv, status);
    throw e;
  }
}

function isBudgetSkip(e) {
  return !!(e && (e.code === "budget-skip" || /remaining deposit cannot cover/.test(e.message || "")));
}

/** Downstream of a skipped stage: nothing was billed for these. */
const CASCADE = /^(?:upstream failed: |no image input$|Connect an image first\.?$|all inputs were skipped|no prompt$|no edit instruction$|Add a prompt)/;

/**
 * True when the run's only failures are a stage the deposit could not cover,
 * or a later stage that had nothing left to run. A real API error is not one
 * of these, so the caller still throws and the gate refunds.
 */
export function posedBudgetPartial(result) {
  const errs = result && Array.isArray(result.errors) ? result.errors : [];
  if (!errs.length || !errs.some(isBudgetSkip)) return false;
  return errs.every((e) => isBudgetSkip(e) || CASCADE.test(e.message || ""));
}

export function posedSkipNotes(result) {
  const errs = result && Array.isArray(result.errors) ? result.errors : [];
  return errs.filter(isBudgetSkip).map((e) =>
    `note: skipped "${e.name}" — remaining deposit cannot cover this stage, so it was not billed.`);
}

/** Done images and models that are not the sink, so a skipped mesh still returns what was paid for. */
export function harvestPosedOutputs(wf, result) {
  const nodes = wf && wf.graph && Array.isArray(wf.graph.nodes) ? wf.graph.nodes : [];
  const sinks = new Set((wf.outputs || []).map((o) => o.nodeId));
  const fetchImpl = wf.client && wf.client.fetch;
  const extras = [];
  for (const n of nodes) {
    if (sinks.has(n.id)) continue;
    const rec = result.nodes && result.nodes[n.id];
    if (!rec || rec.status !== "done" || !rec.out) continue;
    const key = n.name || n.id;
    if (typeof rec.out.model === "string" && rec.out.model) {
      extras.push({ key, value: new MediaRef(rec.out.model, { fetch: fetchImpl, mime: "model/gltf-binary" }) });
    } else if (typeof rec.out.image === "string" && rec.out.image) {
      extras.push({ key, value: new MediaRef(rec.out.image, { fetch: fetchImpl }) });
    }
  }
  if (extras.length) result.extraOutputs = extras;
}
