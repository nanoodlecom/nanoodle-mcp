/**
 * The job brief a buyer (or a buying agent) writes to hire the nanoodle
 * workflow agent on NEAR Agent Market, and the parser that reads it.
 *
 * The brief is the job's `description`. It is data, never instructions: the
 * only thing read from it is one JSON workflow request.
 *
 * Accepted format (docs/near-agent-market.md#the-job-brief):
 *
 *   ```nanoodle
 *   { "graph": { "nodes": [...], "links": [...] }, "inputs": { "Idea": "a lighthouse at dawn" } }
 *   ```
 *
 * - The request is the body of ONE fenced code block (``` or ~~~) whose info
 *   string contains the word `nanoodle`. When no block says `nanoodle`, exactly
 *   one block whose info string starts with `json` is used instead. A brief
 *   that is nothing but the JSON object (no fence) is accepted too.
 * - The JSON object has exactly one of `graph` (a nanoodle graph object) or
 *   `url` (a full nanoodle share link carrying its #g=, #j= or #a= fragment),
 *   and optionally `inputs` (input name -> string). No other keys.
 * - Text outside the block is ignored. Attachments are not read.
 */

import { createHash } from "node:crypto";

export const BRIEF_KEYS = Object.freeze(["graph", "url", "inputs"]);

/** The shortest correct brief, for decline messages and the listing description. */
export const BRIEF_TEMPLATE = [
  "```nanoodle",
  '{ "graph": { "v": 1, "nodes": [ { "id": "n1", "type": "text", "name": "Idea", "fields": { "text": "" } }, { "id": "n2", "type": "llm", "fields": { "model": "z-ai/glm-5.3-flash", "reasoningEffort": "low", "maxTokens": 400 } } ], "links": [ { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } } ] },',
  '  "inputs": { "Idea": "a lighthouse at dawn" } }',
  "```",
].join("\n");

/**
 * Split a brief in plain words into its main text and the listing workflow's other
 * named inputs, given as lines of the form "Name: value" (for example "Style: slow
 * country ballad"). Only the names passed in are recognised, case-insensitively; the
 * first line for a name wins (later ones are dropped); a line with nothing after the
 * colon is ordinary text. Recognised lines are taken out of the main text.
 * @param {string} text
 * @param {string[]} [fieldNames]
 * @returns {{ main: string, fields: Record<string, string> }}
 */
export function splitPlainBrief(text, fieldNames = []) {
  const fields = {};
  const raw = String(text || "");
  if (!fieldNames.length) return { main: raw.trim(), fields };
  const byLower = new Map(fieldNames.map((n) => [String(n).trim().toLowerCase(), n]));
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    // "Style: x", "- Style: x", "**Style:** x", "Style： x" (full-width colon)
    const m = /^\s*(?:[-*•]\s+)?\**\s*([^:：*\n]{1,60}?)\s*\**\s*[:：]\s*\**\s*(.*)$/.exec(line);
    const name = m ? byLower.get(m[1].trim().toLowerCase()) : undefined;
    const value = m ? m[2].trim() : "";
    if (name !== undefined && value) { if (!(name in fields)) fields[name] = value; continue; }
    kept.push(line);
  }
  return { main: kept.join("\n").trim(), fields };
}

/**
 * A length a buyer wrote, in seconds: "90", "90s", "90 seconds", "2 min", "2m30s",
 * "2:30", "about 3 minutes", "1.5 minutes". A bare number up to 10 is minutes
 * ("Duration: 3"), above that seconds. Null when no length can be read.
 * @param {string} text
 * @returns {number|null} whole seconds, at least 1
 */
export function parseSeconds(text) {
  const t = String(text || "").toLowerCase().replace(/,/g, ".");
  let m = /(\d{1,3}):([0-5]\d)\b/.exec(t);
  if (m) return Math.max(1, Number(m[1]) * 60 + Number(m[2]));
  let total = 0, found = false;
  const re = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/g;
  while ((m = re.exec(t))) {
    found = true;
    total += Number(m[1]) * (m[2][0] === "m" ? 60 : 1);
  }
  if (found) return Math.max(1, Math.round(total));
  m = /(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.max(1, Math.round(n <= 10 ? n * 60 : n));
}

/**
 * Turn the fields a buyer wrote into the texts sent to the workflow, for the fields the
 * listing gives a type. One type exists: `{ seconds: { min, max, defaultMin, defaultMax } }`.
 * A readable length is clamped to [min, max]; a missing or unreadable one is picked
 * between defaultMin and defaultMax, the same every time for the same `seed` (a job is
 * priced more than once and must get the same value). Untyped fields pass through.
 * @param {Record<string,string>} fields  from splitPlainBrief
 * @param {Record<string,object>} [specs]
 * @param {string} [seed]  the assignment id
 * @returns {{ inputs: Record<string,string>, set: string[], notes: string[] }}
 *   set: the names the buyer set and that were used; notes: sentences for the buyer
 */
export function resolveFields(fields, specs = {}, seed = "") {
  const inputs = {}, set = [], notes = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (specs[name]) continue;
    inputs[name] = value;
    set.push(name);
  }
  for (const [name, spec] of Object.entries(specs || {})) {
    const s = spec && spec.seconds;
    if (!s) continue;
    const asked = name in (fields || {}) ? parseSeconds(fields[name]) : null;
    if (asked != null) {
      const n = Math.min(s.max, Math.max(s.min, asked));
      inputs[name] = `${n} seconds`;
      set.push(name);
      notes.push(n === asked
        ? `${name}: aiming for about ${n} seconds, as you asked.`
        : `${name}: you asked for ${asked} seconds; this listing does ${s.min} to ${s.max}, so it aims for about ${n} seconds.`);
    } else {
      const span = s.defaultMax - s.defaultMin + 1;
      const n = s.defaultMin + (parseInt(createHash("sha256").update(`${name}\u0000${seed}`).digest("hex").slice(0, 8), 16) % span);
      inputs[name] = `${n} seconds`;
      notes.push(name in (fields || {})
        ? `${name}: "${String(fields[name]).slice(0, 40)}" could not be read as a length, so it aims for about ${n} seconds (picked between ${s.defaultMin} and ${s.defaultMax}).`
        : `${name}: none given, so it aims for about ${n} seconds (picked between ${s.defaultMin} and ${s.defaultMax}).`);
    }
  }
  return { inputs, set, notes };
}

const HOW = "Put ONE fenced code block tagged nanoodle in the brief, holding a JSON object with \"graph\" (a nanoodle graph) or \"url\" (a full nanoodle share link with its #g= fragment), plus \"inputs\" (name -> text).";

export class BriefError extends Error {
  /** @param {"NO_REQUEST"|"AMBIGUOUS"|"BAD_JSON"|"BAD_REQUEST"} code */
  constructor(code, message) {
    super(message);
    this.name = "BriefError";
    this.code = code;
  }
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

/** Fenced code blocks of a Markdown text: [{ info, body }]. CommonMark-style fences, unclosed blocks run to the end. */
export function fencedBlocks(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m) continue;
    const fence = m[2];
    const info = m[3].trim();
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) break;
      body.push(lines[j]);
    }
    out.push({ info, body: body.join("\n") });
    i = j;
  }
  return out;
}

const words = (info) => info.toLowerCase().split(/[\s,{}.]+/).filter(Boolean);

/**
 * Read the workflow request out of a job brief.
 * @returns {{ graph?: any, url?: string, inputs?: object }} tool arguments for computePrice / run
 * @throws {BriefError}
 */
export function parseBrief(description) {
  const text = String(description ?? "");
  const blocks = fencedBlocks(text);
  let candidates = blocks.filter((b) => words(b.info).includes("nanoodle"));
  if (!candidates.length) candidates = blocks.filter((b) => words(b.info)[0] === "json");
  let raw;
  if (candidates.length === 1) {
    raw = candidates[0].body;
  } else if (candidates.length > 1) {
    throw new BriefError("AMBIGUOUS", `The brief has ${candidates.length} JSON code blocks and none is the only one tagged nanoodle, so it is not clear which workflow to run. ${HOW}`);
  } else if (text.trim().startsWith("{")) {
    raw = text.trim();
  } else {
    throw new BriefError("NO_REQUEST", `The brief has no workflow request. ${HOW}`);
  }
  let req;
  try { req = JSON.parse(raw); } catch (e) {
    throw new BriefError("BAD_JSON", `The workflow request is not valid JSON (${String((e && e.message) || e).slice(0, 120)}). ${HOW}`);
  }
  if (req == null || typeof req !== "object" || Array.isArray(req)) {
    throw new BriefError("BAD_REQUEST", `The workflow request must be a JSON object. ${HOW}`);
  }
  const extra = Object.keys(req).filter((k) => !BRIEF_KEYS.includes(k));
  if (extra.length) {
    throw new BriefError("BAD_REQUEST", `The workflow request has unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => JSON.stringify(k)).join(", ")}; allowed: "graph" or "url", and "inputs".`);
  }
  const args = {};
  for (const k of BRIEF_KEYS) if (req[k] !== undefined) args[k] = req[k];
  return args;
}
