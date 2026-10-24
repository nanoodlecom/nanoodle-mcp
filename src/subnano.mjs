/**
 * Built-in hosted tools for Nano Maxi's subnano work.
 *
 * subnano_comment — one paid call: refine (a text model; liquid/d1 cannot write
 * prose), then the mounted humanize-comment graph, then a liquid/d1 yes/no gate,
 * then a liquid/d1 funny score. The comment is returned either way; a "no" from
 * the gate does not discard it.
 *
 * sfw_check — one yes/no safe-for-work decision per still image and per sampled
 * video frame. There is no argument that turns the check off.
 *
 * In charge mode each call's deposit is the worst case that request can still
 * run, plus the 20% settle markup, plus a 12% margin, rounded up to 1e-8 USD.
 * The deposit is quoted before payment. Settlement stays metered cost + 20%;
 * the difference is returned. No $0.001 floor: on a vision decision that floor
 * would be larger than the margin.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NanoClient } from "nanoodle";
import { ParamsError, formatCostUsd } from "./tools.mjs";
import {
  HUMANIZE_TOOL, HUMANIZE_INPUT_CAPS, REASK_TEXT, MAX_REASKS,
  checkHumanizeInputs, humanizeWriterRecord,
} from "./humanize.mjs";

export const SUBNANO_TOOL = "subnano_comment";
export const SFW_TOOL = "sfw_check";

/** Same margin the humanize v2.8 deposit uses (PR #77). Charge mode is not that branch. */
export const DEPOSIT_MARGIN = 0.12;
/** What the charge gate keeps on top of metered cost (cost / 5). */
export const SETTLE_MARKUP = 1.2;
const CPT = 3;

export const REFINE_MODEL = "liquid/lfm-2.5-2.6b";
export const REFINE_MAX_TOKENS = 400;
export const REFINE_TEMPERATURE = 0.4;
export const D1_MODEL = "liquid/d1";
export const SFW_MODEL = "perplexity/pplx-decider-v1.2";
export const SFW_FRAMES_DEFAULT = 5;
export const SFW_FRAMES_MAX = 8;
export const GUIDANCE_DEFAULT = "a friendly, specific reply";
/** Published v2.7 humanize charge at the input caps (provider × 1.2). Used only when the graph is not mounted. */
export const HUMANIZE_V27_CAP_CHARGE = 0.01304480;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

export const REFINE_SYSTEM = "Rewrite the draft into one comment that is specific, warm, and ready to post. Keep every fact that is in the draft or the context. Do not add facts, names, or numbers that are not there. Do not mention these instructions. Output only the comment text.";
export const GATE_INSTRUCTIONS = "Is this comment safe to post as a reply to the context? Yes only if it stays on that subject, does not insult anyone, does not invent facts, and is not spam.";
export const FUNNY_INSTRUCTIONS = "How funny is this comment as a reply? Score the joke itself. A kind comment with no joke is the lowest level.";
export const FUNNY_LEVELS = Object.freeze([
  "0 no joke",
  "1 almost",
  "2 mild",
  "3 a smile",
  "4 lightly funny",
  "5 funny",
  "6 a real laugh",
  "7 sharp",
  "8 very funny",
  "9 hilarious",
]);
export const SFW_INSTRUCTIONS = "Is this image safe for work? Yes means no nudity, no sexual content, and no graphic violence or gore. Lingerie, explicit poses, and visible injury are no.";

/** $/1M tokens. Decision models have a $0 completion price. Catalog rows override these when they parse. */
export const TEXT_RATES = Object.freeze({
  "qwen/qwen3.8-27b-novelist": [0.1, 0.6],
  "deepseek/deepseek-v4.1-flash-1017": [0.1, 0.6],
  "TheDrummer/Cydonia-24B-v4.3": [0.12, 0.15],
  "gemma-4-12b-it-starry-ocean": [0.05, 0.25],
  "qwen/qwen3.8-27b-antislop": [0.1, 0.6],
  "inception/mercury-3": [0.1, 0.35],
  "z-ai/glm-5.3": [0.6, 1.1],
  [REFINE_MODEL]: [0.10, 0.20],
});
export const DECISION_RATES = Object.freeze({
  [D1_MODEL]: [0.04, 0],
  [SFW_MODEL]: [0.02, 0],
});

const SUBNANO_KEYS = new Set(["draft", "context", "guidance"]);
const SFW_KEYS = new Set(["image", "video", "frames"]);

export function ceilUsd(n) {
  if (!(n > 0) || !Number.isFinite(n)) return 0;
  // Subtract a hair so a value that is already on a 1e-8 boundary is not bumped by float noise.
  return Math.ceil(n * 1e8 - 1e-6) / 1e8;
}

export function depositFromCharge(charge) {
  if (!(charge > 0) || !Number.isFinite(charge)) throw new Error("cannot price a call with no cost");
  return ceilUsd(charge * (1 + DEPOSIT_MARGIN));
}

export function exactUsd(n) {
  const s = Number(n).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + s;
}

const codePoints = (s) => [...String(s ?? "")].length;
const bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

export function refineUser(context, guidance, draft) {
  return `Context:\n${context}\n\nGuidance:\n${guidance}\n\nDraft:\n${draft}`;
}
export function commentState(context, comment) {
  return `Context:\n${context}\n\nComment:\n${comment}`;
}
const REFINE_OVERHEAD = codePoints(refineUser("", "", ""));
const STATE_OVERHEAD = codePoints(commentState("", ""));

function pick(args, name) {
  if (!args || typeof args !== "object") return undefined;
  const key = Object.keys(args).find((k) => String(k).trim().toLowerCase() === name);
  return key == null ? undefined : args[key];
}

function rejectNsfw(args, tool) {
  if (args && Object.prototype.hasOwnProperty.call(args, "nsfw") || (args && Object.keys(args).some((k) => String(k).trim().toLowerCase() === "nsfw"))) {
    throw new ParamsError(`${tool} cannot be turned off and has no NSFW switch. Remove "nsfw" and call again; nothing was charged.`);
  }
}

function unknownKeys(args, allowed, tool) {
  rejectNsfw(args, tool);
  for (const k of Object.keys(args || {})) {
    if (!allowed.has(String(k).trim().toLowerCase())) {
      throw new ParamsError(`unknown input "${k}" for ${tool}. Nothing was charged.`);
    }
  }
}

/**
 * Chat or decision $/1M [prompt, completion]. A catalog row wins when prompt is
 * > 0. Decision rows may have a 0 completion price; chat rows need both > 0.
 */
export function chatRates(catalogs, model, fallback) {
  const rows = catalogs && catalogs.chat;
  const decision = !!(fallback && fallback[1] === 0);
  if (Array.isArray(rows)) {
    const row = rows.find((m) => m && (m.id === model || m.model === model));
    const p = row && row.pricing;
    const pin = p && Number(p.prompt);
    const pout = p && Number(p.completion);
    if (pin > 0 && (decision || pout > 0)) return [pin, decision ? (Number.isFinite(pout) && pout > 0 ? pout : 0) : pout];
  }
  if (!fallback) throw new Error(`no price for ${model}`);
  return fallback;
}

/**
 * Provider USD (no settle markup) for one humanize-comment run at the given
 * input lengths. Draft length is a character count, not the draft text: the
 * hosted quote always passes the Draft cap, because refine may expand.
 * Same arithmetic as the v2.7 estimate locked in tests/workflow-examples.test.mjs.
 */
export function humanizeProviderUsd(graph, { draftChars, contextChars, guidanceChars }, catalogs) {
  const record = humanizeWriterRecord(graph);
  if (!record) throw new Error("humanize-comment graph cannot be priced");
  const nodes = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const jin = nodes.get("j-in");
  const judge = nodes.get("judge");
  if (!jin || !judge) throw new Error("humanize-comment graph cannot be priced");
  const rates = (model) => chatRates(catalogs, model, TEXT_RATES[model]);
  let base = 0;
  const reasks = [];
  let writerOut = 0;
  for (const letter of ["A", "B", "C", "D", "E"]) {
    const rec = record[letter];
    const n = nodes.get(rec.nodeId);
    const W = Number(n && n.fields && n.fields.maxTokens) || 600;
    writerOut += W;
    const P = rates(rec.model);
    const inTok = (bytes(n.fields.system) + draftChars + contextChars + guidanceChars + 2 * bytes(jin.fields && jin.fields.sep)) / CPT;
    const call = (pc, extra = 0) => (inTok + extra) * pc[0] + W * pc[1];
    const re = (pc) => call(pc, W + bytes(REASK_TEXT) / CPT);
    if (rec.fallbackModel) {
      const FP = rates(rec.fallbackModel);
      base += Math.max(call(P), call(P) + call(FP));
      reasks.push(Math.max(re(P), re(FP)));
    } else {
      base += call(P);
      reasks.push(re(P));
    }
  }
  const reask = reasks.sort((a, b) => b - a).slice(0, MAX_REASKS).reduce((a, b) => a + b, 0);
  let seps = 0;
  for (const n of graph.nodes || []) {
    if (n.type === "join" && n.id !== "j-in" && n.fields && n.fields.sep != null) seps += bytes(n.fields.sep);
  }
  const JP = rates(judge.fields.model);
  const judgeUsd = ((bytes(judge.fields.system) + draftChars + contextChars + guidanceChars + seps) / CPT + writerOut) * JP[0]
    + Number(judge.fields.maxTokens) * JP[1];
  return (base + reask + judgeUsd) / 1e6;
}

export function refineProviderUsd({ draftChars, contextChars, guidanceChars }, catalogs) {
  const [pin, pout] = chatRates(catalogs, REFINE_MODEL, TEXT_RATES[REFINE_MODEL]);
  const inTok = Math.ceil((bytes(REFINE_SYSTEM) + REFINE_OVERHEAD + draftChars + contextChars + guidanceChars) / CPT);
  return (inTok * pin + REFINE_MAX_TOKENS * pout) / 1e6;
}

/** Input-token estimate for one decision. Image tokens are 800, twice the library's 400, so the ceiling sits above its forecast. */
export function decideProviderUsd({ model, question, levels = "", options = "", stateChars = 0, images = 0 }, catalogs) {
  const [pin] = chatRates(catalogs, model, DECISION_RATES[model]);
  const inTok = 120 + Math.round((String(question).length + String(options).length + String(levels).length) / 4) + 250
    + images * 800 + Math.ceil(stateChars / CPT);
  return inTok * pin / 1e6;
}

function worstCommentChars(graph) {
  let maxW = 600;
  try {
    const record = graph && humanizeWriterRecord(graph);
    if (record) {
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      maxW = 0;
      for (const letter of ["A", "B", "C", "D", "E"]) {
        const n = nodes.get(record[letter].nodeId);
        maxW = Math.max(maxW, Number(n && n.fields && n.fields.maxTokens) || 600);
      }
    }
  } catch { /* a graph that cannot be read keeps the published 600-token writer cap */ }
  return Math.max(HUMANIZE_INPUT_CAPS.Draft, maxW * 4);
}

function guidanceOf(args, humanize) {
  const raw = pick(args, "guidance");
  if (typeof raw === "string" && raw.length) return raw;
  const inputs = humanize && humanize.wf && humanize.wf.inputs;
  const inp = Array.isArray(inputs) ? inputs.find((i) => String(i.key).toLowerCase() === "guidance") : null;
  if (inp && inp.def != null && String(inp.def) !== "") return String(inp.def);
  return GUIDANCE_DEFAULT;
}

function subnanoLengths(args, humanize) {
  const draft = pick(args, "draft");
  const context = pick(args, "context");
  const guidance = guidanceOf(args, humanize);
  return {
    draftChars: codePoints(draft),
    contextChars: codePoints(context),
    guidanceChars: codePoints(guidance),
  };
}

/**
 * Metered cost × 1.2 for one subnano_comment request. Humanize is priced at the
 * Draft cap (refine may grow the draft). Refine input uses the real draft length.
 */
export function subnanoChargeUsd({ graph, draftChars, contextChars, guidanceChars, catalogs }) {
  const humanize = graph
    ? humanizeProviderUsd(graph, { draftChars: HUMANIZE_INPUT_CAPS.Draft, contextChars, guidanceChars }, catalogs)
    : HUMANIZE_V27_CAP_CHARGE / SETTLE_MARKUP;
  const refine = refineProviderUsd({ draftChars, contextChars, guidanceChars }, catalogs);
  const stateChars = STATE_OVERHEAD + contextChars + worstCommentChars(graph);
  const gate = decideProviderUsd({ model: D1_MODEL, question: GATE_INSTRUCTIONS, stateChars }, catalogs);
  const funny = decideProviderUsd({
    model: D1_MODEL, question: FUNNY_INSTRUCTIONS, levels: FUNNY_LEVELS.join("\n"), stateChars,
  }, catalogs);
  return (humanize + refine + gate + funny) * SETTLE_MARKUP;
}

export function sfwChargeUsd({ images = 0, frames = 0 }, catalogs) {
  const n = images + frames;
  if (!(n > 0)) throw new Error("nothing to check");
  const one = decideProviderUsd({ model: SFW_MODEL, question: SFW_INSTRUCTIONS, images: 1 }, catalogs);
  return one * n * SETTLE_MARKUP;
}

function humanizeGraph(humanize) {
  return humanize && humanize.humanize && humanize.wf && humanize.wf.graph;
}

function requireArgs(args, tool) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new ParamsError(`${tool} arguments must be an object. Nothing was charged.`);
  }
}

function prepareSubnano(args, humanize) {
  requireArgs(args, SUBNANO_TOOL);
  unknownKeys(args, SUBNANO_KEYS, SUBNANO_TOOL);
  for (const name of ["draft", "context", "guidance"]) {
    const v = pick(args, name);
    if (v == null) continue;
    if (typeof v !== "string") throw new ParamsError(`input "${name}" must be a string. Nothing was charged.`);
  }
  const draft = pick(args, "draft");
  const context = pick(args, "context");
  if (typeof draft !== "string" || !draft.trim()) {
    throw new ParamsError(`missing required input "Draft" for ${SUBNANO_TOOL}. Nothing was charged.`);
  }
  if (typeof context !== "string" || !context.trim()) {
    throw new ParamsError(`missing required input "Context" for ${SUBNANO_TOOL}. Nothing was charged.`);
  }
  try {
    checkHumanizeInputs({ Draft: draft, Context: context, ...(pick(args, "guidance") != null ? { Guidance: String(pick(args, "guidance")) } : {}) });
  } catch (e) {
    throw new ParamsError(String(e.message).replaceAll(HUMANIZE_TOOL, SUBNANO_TOOL));
  }
  if (!humanizeGraph(humanize)) {
    throw new ParamsError(`${SUBNANO_TOOL} needs the ${HUMANIZE_TOOL} graph mounted in --graphs. Nothing was charged.`);
  }
}

export function parseSfw(args) {
  requireArgs(args, SFW_TOOL);
  unknownKeys(args, SFW_KEYS, SFW_TOOL);
  const image = checkMedia(pick(args, "image"), "image");
  const video = checkMedia(pick(args, "video"), "video");
  if (!image && !video) throw new ParamsError(`${SFW_TOOL} needs an image, a video, or both. Nothing was charged.`);
  let frames = 0;
  if (video) {
    const raw = pick(args, "frames");
    if (raw == null || raw === "") frames = SFW_FRAMES_DEFAULT;
    else frames = parseFrameCount(raw);
  } else if (pick(args, "frames") != null && pick(args, "frames") !== "") {
    parseFrameCount(pick(args, "frames")); // still reject a bad value on an image-only call
  }
  return { image, video, frames, images: image ? 1 : 0 };
}

function parseFrameCount(raw) {
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > SFW_FRAMES_MAX) {
    throw new ParamsError(`frames must be an integer from 1 to ${SFW_FRAMES_MAX}. Nothing was charged.`);
  }
  return n;
}

function checkMedia(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ParamsError(`${label} must be a file path, an https URL, or a data URL. Nothing was charged.`);
  const v = value.trim();
  if (/^data:/i.test(v)) {
    const n = dataUrlSize(v);
    if (!(n >= 0)) throw new ParamsError(`${label} data URL is not valid. Nothing was charged.`);
    if (n > MAX_MEDIA_BYTES) throw new ParamsError(`${label} is over 4 MB. Nothing was charged.`);
    return v;
  }
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    throw new ParamsError(`${label} must be a file path, an https URL, or a data URL. Nothing was charged.`);
  }
  if (!existsSync(v)) throw new ParamsError(`${label} file was not found. Nothing was charged.`);
  const st = statSync(v);
  if (!st.isFile()) throw new ParamsError(`${label} is not a file. Nothing was charged.`);
  if (st.size > MAX_MEDIA_BYTES) throw new ParamsError(`${label} is over 4 MB. Nothing was charged.`);
  return v;
}

function dataUrlSize(url) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(url);
  if (!m) return -1;
  try {
    if (/;base64/i.test(m[1])) return Buffer.from(m[2], "base64").length;
    return Buffer.byteLength(decodeURIComponent(m[2]));
  } catch {
    return -1;
  }
}

function clipCodePoints(s, n) {
  const chars = [...String(s)];
  return chars.length > n ? chars.slice(0, n).join("") : chars.join("");
}

function stepFail(step, e) {
  const err = new Error(`${step} failed: ${e && e.message ? e.message : e}`);
  err.cause = e;
  return err;
}

function takeCost() {
  const box = { usd: null };
  box.onCost = (c) => {
    const usd = c && typeof c === "object" ? c.usd : c;
    if (typeof usd === "number" && Number.isFinite(usd)) box.usd = (box.usd || 0) + usd;
  };
  return box;
}

function clientFor(ctx) {
  return new NanoClient({
    apiKey: ctx.apiKey || undefined,
    payment: ctx.apiKey ? null : (ctx.payment || null),
    baseUrl: ctx.baseUrl || undefined,
    fetch: ctx.fetch || globalThis.fetch,
  });
}

async function loadDecide() {
  return import("../node_modules/nanoodle/src/decide.mjs");
}

function commentFromHumanize(result) {
  const notes = [];
  let parsed = null;
  for (const block of (result && result.content) || []) {
    if (!block || block.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text;
    if (text.startsWith("cost:")) continue;
    if (text.startsWith("note:") || text.startsWith("gated:")) { notes.push(text); continue; }
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && typeof j.text === "string" && j.winner) parsed = j;
    } catch { /* a notice that is not the rebuilt JSON */ }
  }
  if (!parsed) throw new Error("humanize-comment returned no comment");
  return { text: parsed.text, notes, usd: result.costUsd, exact: result.costExact !== false };
}

async function runSubnano(args, ctx) {
  const humanize = ctx.humanize;
  prepareSubnano(args, humanize);
  const draft = String(pick(args, "draft"));
  const context = String(pick(args, "context"));
  const guidance = guidanceOf(args, humanize);
  const client = clientFor(ctx);
  const steps = {};
  let refined;
  try {
    const cost = takeCost();
    refined = await client.chat(
      [
        { role: "system", content: REFINE_SYSTEM },
        { role: "user", content: refineUser(context, guidance, draft) },
      ],
      REFINE_MODEL,
      { temperature: REFINE_TEMPERATURE, max_tokens: REFINE_MAX_TOKENS },
      { onCost: cost.onCost },
    );
    steps.refine = { usd: cost.usd, model: REFINE_MODEL };
  } catch (e) {
    throw stepFail("refine", e);
  }
  refined = clipCodePoints(String(refined).trim(), HUMANIZE_INPUT_CAPS.Draft);
  if (!refined) throw new Error("refine returned an empty comment");

  let human;
  try {
    const sent = { Draft: refined, Context: context };
    if (pick(args, "guidance") != null) sent.Guidance = String(pick(args, "guidance"));
    human = commentFromHumanize(await ctx.registry.callTool({ name: HUMANIZE_TOOL, arguments: sent }));
    steps.humanize = { usd: typeof human.usd === "number" ? human.usd : null, exact: human.exact };
  } catch (e) {
    throw stepFail("humanize", e);
  }

  const state = commentState(context, human.text);
  let gate;
  let funny;
  try {
    const { decideRun } = await loadDecide();
    const send = (bucket) => async (body) => {
      const cost = takeCost();
      const j = await client.decide(body, { onCost: cost.onCost });
      bucket.usd = cost.usd;
      return j;
    };
    const gateCost = { usd: null };
    const gateOut = await decideRun(
      { mode: "yesno", question: GATE_INSTRUCTIONS },
      D1_MODEL,
      state,
      [],
      null,
      send(gateCost),
      async () => { throw new Error("text decision"); },
    );
    const yes = gateOut.decision.yes;
    gate = { verdict: yes >= 0.5 ? "yes" : "no", yes };
    steps.gate = { usd: gateCost.usd, model: D1_MODEL, verdict: gate.verdict };

    const funnyCost = { usd: null };
    const funnyOut = await decideRun(
      { mode: "score", question: FUNNY_INSTRUCTIONS, levels: FUNNY_LEVELS.join("\n") },
      D1_MODEL,
      state,
      [],
      null,
      send(funnyCost),
      async () => { throw new Error("text decision"); },
    );
    const rows = funnyOut.decision.rows || [];
    // An all-zero probability vector leaves the library's win flag on level 0.
    // The model's own score is the winner in that case. score on the decision
    // is 1-based; the tool returns the 0-based level.
    const ranked = rows.some((r) => r.p > 0);
    const win = ranked ? rows.findIndex((r) => r.win) : -1;
    const score = win >= 0 ? win : Math.max(0, Math.round(Number(funnyOut.decision.score) || 1) - 1);
    const idx = Math.max(0, Math.min(FUNNY_LEVELS.length - 1, score));
    funny = { score: idx, max: FUNNY_LEVELS.length - 1, label: FUNNY_LEVELS[idx] };
    steps.funny = { usd: funnyCost.usd, model: D1_MODEL, score: idx };
  } catch (e) {
    throw stepFail(steps.gate ? "funny" : "gate", e);
  }

  return finishResult({
    comment: human.text,
    gate,
    funny,
    steps,
    ...(human.notes.length ? { notes: human.notes } : {}),
  }, [steps.refine, steps.humanize, steps.gate, steps.funny]);
}

async function runSfw(args, ctx) {
  const parsed = parseSfw(args);
  const { decideRun, DECIDE_IMG_FALLBACK } = await loadDecide();
  const client = clientFor(ctx);
  const fit = ctx.fit || defaultFit;
  const sample = ctx.sampleFrames || sampleVideoFrames;
  const pictures = [];
  if (parsed.image) pictures.push({ source: "image", index: 0, url: parsed.image });
  if (parsed.video) {
    let frames;
    try {
      frames = await sample(parsed.video, parsed.frames, { fetch: ctx.fetch || globalThis.fetch });
    } catch (e) {
      throw stepFail("video", e);
    }
    if (!Array.isArray(frames) || frames.length !== parsed.frames) {
      throw new Error(`video sampling returned ${Array.isArray(frames) ? frames.length : 0} frame(s); expected ${parsed.frames}`);
    }
    frames.forEach((url, index) => pictures.push({ source: "video", index, url }));
  }
  const outFrames = [];
  for (const pic of pictures) {
    try {
      const cost = { usd: null };
      const out = await decideRun(
        { mode: "yesno", question: SFW_INSTRUCTIONS },
        SFW_MODEL,
        "",
        [pic.url],
        DECIDE_IMG_FALLBACK,
        async (body) => {
          const box = takeCost();
          const j = await client.decide(body, { onCost: box.onCost });
          cost.usd = box.usd;
          return j;
        },
        (url, maxDim, budget) => fit(url, maxDim, budget, { fetch: ctx.fetch || globalThis.fetch }),
      );
      const yes = out.decision.yes;
      outFrames.push({
        source: pic.source,
        index: pic.index,
        verdict: yes >= 0.5 ? "yes" : "no",
        yes,
        usd: cost.usd,
      });
    } catch (e) {
      throw stepFail(`${pic.source} ${pic.index}`, e);
    }
  }
  const sfw = outFrames.every((f) => f.verdict === "yes");
  return finishResult({
    sfw,
    verdict: sfw ? "yes" : "no",
    frames: outFrames,
  }, outFrames);
}

function finishResult(payload, parts) {
  let usd = 0;
  let any = false;
  let exact = true;
  for (const p of parts) {
    if (p && typeof p.usd === "number" && Number.isFinite(p.usd)) { usd += p.usd; any = true; }
    else exact = false;
    if (p && p.exact === false) exact = false;
  }
  const costUsd = any ? usd : null;
  const content = [{ type: "text", text: JSON.stringify(payload) }];
  if (costUsd != null) {
    content.push({
      type: "text",
      text: `cost: $${formatCostUsd(costUsd)}${exact ? "" : " (a lower bound — some calls did not report a price, so the actual cost may be higher)"}`,
    });
  }
  return { content, costUsd, costExact: exact && costUsd != null, textOutput: true };
}

async function defaultFit(url, maxDim, budget, opts) {
  const { fitImageJpeg } = await import("../node_modules/nanoodle/src/local-media.mjs");
  return fitImageJpeg(url, maxDim, budget, opts);
}

function runProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { if (err.length < 240) err += String(d); });
    child.on("error", (e) => {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        reject(new Error(`${cmd} is not on PATH. Video checks need ffmpeg; image checks do not.`));
      } else reject(e);
    });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim().slice(0, 200) || `${cmd} failed`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function mediaBytes(source, fetchFn) {
  if (/^data:/i.test(source)) {
    const m = /^data:([^,]*),([\s\S]*)$/i.exec(source);
    if (!m || !/;base64/i.test(m[1])) throw new Error("video data URL must be base64");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_MEDIA_BYTES) throw new Error("video is over 4 MB");
    return buf;
  }
  if (/^https?:\/\//i.test(source)) {
    const r = await fetchFn(source);
    if (!r.ok) throw new Error(`could not fetch video (HTTP ${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) throw new Error("video is over 4 MB");
    return buf;
  }
  const buf = await readFile(source);
  if (buf.length > MAX_MEDIA_BYTES) throw new Error("video is over 4 MB");
  return buf;
}

/** Evenly spaced JPEG data URLs. The library's extractVideoFrames clusters at one end, which is the wrong sample for an SFW check. */
export async function sampleVideoFrames(source, count, { fetch: fetchFn = globalThis.fetch } = {}) {
  const bytesIn = await mediaBytes(source, fetchFn);
  const dir = await mkdtemp(join(tmpdir(), "sfw-"));
  try {
    const inPath = join(dir, "in.bin");
    await writeFile(inPath, bytesIn);
    const probe = await runProc("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inPath]);
    const dur = Number(String(probe).trim());
    if (!(dur > 0)) throw new Error("could not read the video duration");
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(Math.max(0, dur - 0.05), Math.max(0, dur * (i + 0.5) / count));
      const outPath = join(dir, `f${i}.jpg`);
      await runProc("ffmpeg", ["-y", "-ss", t.toFixed(3), "-i", inPath, "-frames:v", "1", "-q:v", "5", outPath]);
      const jpg = await readFile(outPath);
      frames.push(`data:image/jpeg;base64,${jpg.toString("base64")}`);
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SUBNANO_NOTE = "a deposit is quoted for each request from its context and guidance and covers the most that request can cost, plus a small margin; it settles at the metered cost plus 20%, and the difference is returned";
const SFW_NOTE = "a deposit is quoted for each request from how many pictures it checks and covers the most that request can cost, plus a small margin; it settles at the metered cost plus 20%, and the difference is returned";

function spendLine(spendSource) {
  return `Runs on NanoGPT — every call spends real credit from ${spendSource}.`;
}

/**
 * The two built-ins. Registered only once some graph loaded, so an empty
 * --graphs directory still exits with "no runnable graphs".
 * `deps` is how tests replace the video sampler and the image fitter.
 */
export function builtinTools({ spendSource, humanize }) {
  const caps = HUMANIZE_INPUT_CAPS;
  const subnano = {
    name: SUBNANO_TOOL,
    builtin: true,
    pricedPerRequest: true,
    depositNote: SUBNANO_NOTE,
    file: "(built-in)",
    dir: "",
    x402: { usd: 0 },
    card: {
      intent: "Rewrite a comment, humanize it, then say if it is safe to post and how funny it is.",
      steps: [
        { kind: "llm", label: "refine", n: 1 },
        { kind: "llm", label: "humanize", n: 1 },
        { kind: "decide", label: "gate", n: 1 },
        { kind: "decide", label: "funny", n: 1 },
      ],
      sample: null,
    },
    description:
      `Rewrite a draft, run ${HUMANIZE_TOOL} on that rewrite, then ask whether the result is safe to post and how funny it is. ` +
      `Order is refine (${REFINE_MODEL}), then ${HUMANIZE_TOOL}, then a ${D1_MODEL} yes/no gate, then a ${D1_MODEL} funny score. ` +
      `Returns the comment, the gate verdict, the funny score, and the cost of each step. A "no" gate does not discard the comment. ` +
      `${spendLine(spendSource)} Needs the ${HUMANIZE_TOOL} graph mounted.`,
    inputSchema: {
      type: "object",
      properties: {
        Draft: { type: "string", maxLength: caps.Draft, description: `* required; the comment to rewrite, at most ${caps.Draft} characters` },
        Context: { type: "string", maxLength: caps.Context, description: `* required; the post or thread being replied to, at most ${caps.Context} characters` },
        Guidance: { type: "string", maxLength: caps.Guidance, description: `optional; what the comment should do, at most ${caps.Guidance} characters. default: ${JSON.stringify(GUIDANCE_DEFAULT)}` },
      },
      required: ["Draft", "Context"],
    },
    quote(args, ctx) {
      const h = (ctx && ctx.humanize) || humanize;
      prepareSubnano(args, h);
      const lens = subnanoLengths(args, h);
      const graph = humanizeGraph(h);
      return depositFromCharge(subnanoChargeUsd({ graph, ...lens, catalogs: ctx && ctx.catalogs }));
    },
    coldDeposit(ctx) {
      const h = (ctx && ctx.humanize) || humanize;
      const graph = humanizeGraph(h);
      return depositFromCharge(subnanoChargeUsd({
        graph,
        draftChars: caps.Draft,
        contextChars: caps.Context,
        guidanceChars: caps.Guidance,
        catalogs: ctx && ctx.catalogs,
      }));
    },
    prepare(args, ctx) {
      prepareSubnano(args, (ctx && ctx.humanize) || humanize);
    },
    run(args, ctx) {
      return runSubnano(args, { ...ctx, humanize: ctx.humanize || humanize });
    },
  };
  subnano.x402 = { usd: subnano.coldDeposit({ humanize }) };

  const sfw = {
    name: SFW_TOOL,
    builtin: true,
    pricedPerRequest: true,
    depositNote: SFW_NOTE,
    ffmpegFor: "video",
    file: "(built-in)",
    dir: "",
    deps: {},
    x402: { usd: 0 },
    card: {
      intent: "Say whether an image, or evenly sampled frames of a video, is safe for work.",
      steps: [
        { kind: "decide", label: "sfw", n: 1 },
      ],
      sample: null,
    },
    description:
      "Say whether an image, or evenly sampled frames of a video, is safe for work. One yes/no decision per picture " +
      `(${SFW_MODEL}). The check passes only when every picture is yes. Video sampling needs ffmpeg on the server; a still image does not. ` +
      `There is no switch to skip this check. ${spendLine(spendSource)}`,
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "optional; still image — file path, https URL, or data URL. At most 4 MB." },
        video: { type: "string", description: "optional; video — file path, https URL, or data URL. Frames are sampled evenly. At most 4 MB. Needs ffmpeg." },
        frames: { type: "integer", minimum: 1, maximum: SFW_FRAMES_MAX, description: `optional; how many video frames to check (1–${SFW_FRAMES_MAX}, default ${SFW_FRAMES_DEFAULT}). Ignored when there is no video.` },
      },
    },
    quote(args, ctx) {
      const parsed = parseSfw(args);
      return depositFromCharge(sfwChargeUsd({ images: parsed.images, frames: parsed.frames }, ctx && ctx.catalogs));
    },
    coldDeposit(ctx) {
      return depositFromCharge(sfwChargeUsd({ images: 1, frames: SFW_FRAMES_MAX }, ctx && ctx.catalogs));
    },
    prepare(args) {
      parseSfw(args);
    },
    run(args, ctx) {
      return runSfw(args, { ...ctx, fit: ctx.fit || this.deps.fit, sampleFrames: ctx.sampleFrames || this.deps.sampleFrames });
    },
  };
  sfw.x402 = { usd: sfw.coldDeposit({}) };

  return [subnano, sfw];
}

/** After a catalog refresh, re-pin each built-in's cold ceiling so a failed per-request quote still covers catalog prices. */
export function refreshBuiltinDeposits(registry) {
  const humanize = registry.tools.find((t) => t.name === HUMANIZE_TOOL);
  for (const t of registry.tools) {
    if (typeof t.coldDeposit !== "function") continue;
    try {
      const usd = t.coldDeposit({ catalogs: registry.catalogs, humanize });
      if (Number.isFinite(usd) && usd > 0) t.x402 = { ...(t.x402 || {}), usd };
    } catch { /* keep the deposit pinned when the tool was built */ }
  }
}
