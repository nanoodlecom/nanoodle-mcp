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

export const BRIEF_KEYS = Object.freeze(["graph", "url", "inputs"]);

/** The shortest correct brief, for decline messages and the listing description. */
export const BRIEF_TEMPLATE = [
  "```nanoodle",
  '{ "graph": { "v": 1, "nodes": [ { "id": "n1", "type": "text", "name": "Idea", "fields": { "text": "" } }, { "id": "n2", "type": "llm", "fields": { "model": "z-ai/glm-5.3-flash", "maxTokens": 400 } } ], "links": [ { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } } ] },',
  '  "inputs": { "Idea": "a lighthouse at dawn" } }',
  "```",
].join("\n");

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
