/**
 * Graph directory → MCP tool registry.
 *
 * Each readable noodle-graph.json in the directory becomes one tool:
 *   - name        = filename minus .json, sanitized to [a-z0-9_-]
 *   - description = comment intent + node chain + output contract + last observed cost
 *                   ("Draft a tagline. text:Idea -> llm; returns text. Runs on NanoGPT …")
 *   - inputSchema = JSON Schema built from the workflow's derived inputs
 *   - call(args)  = wf.run(...) with media args resolved from file paths / URLs
 *
 * All heavy lifting (graph parsing, input derivation, execution, NanoGPT transport)
 * is the `nanoodle` library's; this file only adapts it to the MCP tool shape.
 */
import { readdir, readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Workflow, MediaRef, mediaFromFile, decodeShareUrl } from "nanoodle";

/** Input kinds whose values are media (file path or URL), mirroring the library's MEDIA_KINDS. */
const MEDIA_KINDS = new Set(["image", "audio", "video", "inpaint"]);

/** Best-effort file extension for a media MIME type (the library doesn't export its own map). */
const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac",
  "audio/flac": "flac", "audio/mp4": "m4a",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
function extForMime(mime) {
  return MIME_EXT[String(mime || "").split(";")[0].trim().toLowerCase()] || "bin";
}

/** Extension from mime, falling back to magic bytes — hosted media often arrives as octet-stream. */
export function extForMedia(bytes, mime) {
  const byMime = extForMime(mime);
  if (byMime !== "bin") return byMime;
  const b = bytes || [];
  const ascii = (o, n) => String.fromCharCode(...Array.from(b.slice(o, o + n)));
  if (b.length > 12 && ascii(4, 4) === "ftyp") return "mp4";
  if (ascii(0, 4) === "RIFF") return ascii(8, 4) === "WAVE" ? "wav" : ascii(8, 4) === "WEBP" ? "webp" : "bin";
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 3) === "ID3") return "mp3";
  return "bin";
}

/** Error the server maps to JSON-RPC -32602 (invalid params) instead of a tool-result error. */
export class ParamsError extends Error {
  constructor(message) { super(message); this.mcpCode = -32602; }
}

function sanitizeName(file) {
  const stem = basename(file).replace(/\.json$/i, "");
  const name = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "graph";
}

/** Chain label for one node: bare type, or type:Name when the author named it. */
function nodeLabel(n) {
  const name = typeof n.name === "string" ? n.name.trim() : "";
  return name ? `${n.type}:${name}` : n.type;
}

/** Node-label chain in dependency order (local Kahn sort — keeps us on the library's public API). */
function typeChain(graph) {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const l of graph.links) {
    indeg.set(l.to.node, (indeg.get(l.to.node) || 0) + 1);
    if (out.has(l.from.node)) out.get(l.from.node).push(l.to.node);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const next of out.get(id) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  const nodes = order.length === graph.nodes.length ? order : graph.nodes; // cyclic → raw order
  // Adjacent identical labels collapse to label×N — named nodes rarely collapse (labels differ).
  const runs = [];
  for (const label of nodes.filter((n) => n.type !== "comment").map(nodeLabel)) {
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.n++;
    else runs.push({ label, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.label}×${r.n}` : r.label)).join(" -> ");
}

/** "org/model" → "model": the org prefix is noise in a one-line description. */
function shortModel(model) {
  return String(model).split("/").pop();
}

/**
 * The first comment node's text doubles as the tool's stated intent — the
 * author's own words lead the description. One line, capped, sentence-final.
 */
function graphIntent(graph) {
  const c = graph.nodes.find((n) => n.type === "comment" && String((n.fields || {}).text || "").trim());
  if (!c) return "";
  let text = String(c.fields.text).replace(/\s+/g, " ").trim();
  if (text.length > 200) {
    let cut = text.slice(0, 197);
    // A cut landing mid-surrogate-pair leaves a lone surrogate — strict-UTF-8 JSON
    // parsers (Rust MCP clients) then reject the whole tools/list response.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    text = cut + "…";
  }
  return /[.!?…]$/.test(text) ? text : text + ".";
}

/**
 * "returns …" segment from wf.outputs: text plainly; media with the sink's model /
 * size, plus the on-disk contract (media never rides inline in the result).
 * One file per media sink — the run keeps only a sink's primary output, so
 * variations never multiply what the caller receives.
 */
function describeOutputs(wf) {
  const byId = new Map(wf.graph.nodes.map((n) => [n.id, n]));
  let mediaFiles = 0;
  const parts = wf.outputs.map((o) => {
    const kind = (o.ports && o.ports[0] && o.ports[0].type) || o.type; // odd types may declare no ports
    if (kind === "text") return "text";
    const f = (byId.get(o.nodeId) || {}).fields || {};
    const details = [];
    if (f.model) details.push(shortModel(f.model));
    if (kind === "image" && f.size && f.size !== "auto") details.push(String(f.size).replace("x", "×"));
    mediaFiles += 1;
    return `${kind}${details.length ? ` (${details.join(", ")})` : ""}`;
  });
  if (!parts.length) return "";
  const joined = parts.join(" + ");
  if (!mediaFiles) return `returns ${joined}`;
  const pathNote = `(file path${mediaFiles > 1 ? "s" : ""} in result)`;
  return parts.every((p) => p !== "text")
    ? `returns ${joined} saved to disk ${pathNote}`
    : `returns ${joined}; media saved to disk ${pathNote}`;
}

/**
 * One place assembles the whole description so it can be re-run when pieces change.
 * `cost` (last observed run) is an optional segment wired in separately — pass it
 * pre-rendered. A comment-only graph has no chain — the intent stands alone.
 */
function buildDescription(wf, spendSource, { cost } = {}) {
  const intent = graphIntent(wf.graph);
  const chain = typeChain(wf.graph);
  const returns = describeOutputs(wf);
  return `${intent ? `${intent} ` : ""}${chain ? `${chain}${returns ? `; ${returns}` : ""}. ` : ""}` +
    `Runs on NanoGPT — every call spends real credit from ${spendSource}${cost ? `; ${cost}` : ""}.`;
}

/**
 * "last run $X" from the cost sidecar record — the only description segment that
 * changes at runtime. Trailing zeros trimmed but never past cents; a run whose
 * calls didn't all report a price renders "+" (it cost at least X) — that rules
 * out the "<$0.0001" claim too, since the recorded figure is only a floor.
 */
function renderCost(rec) {
  if (!rec || typeof rec.usd !== "number" || !Number.isFinite(rec.usd)) return "";
  if (rec.usd < 0.0001 && rec.exact !== false) return "last run <$0.0001";
  const usd = rec.usd.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, "$1");
  return `last run $${usd}${rec.exact === false ? "+" : ""}`;
}

/** Clamp an input key to the property-key charset MCP clients enforce (^[a-zA-Z0-9_.-]{1,64}$). */
function schemaKey(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return safe || "input";
}

/**
 * Author-marked optional node (the editor's "optional input" checkbox, saved as
 * fields.optional). Read off the graph itself so it holds even when the installed
 * nanoodle library predates optional-aware deriveInputs (< 0.6.0).
 */
function authorOptional(wf, inp) {
  const nodes = (wf.graph && wf.graph.nodes) || [];
  const n = nodes.find((x) => x.id === inp.nodeId);
  const v = n && n.fields && n.fields.optional;
  return v === true || v === "true";
}

/** Derived inputs paired with schema-safe keys ("System prompt" → "System_prompt"), deduped. */
function keyedInputs(wf) {
  const used = new Map();
  return wf.inputs.map((inp) => {
    let safe = schemaKey(inp.key);
    const count = (used.get(safe) || 0) + 1;
    used.set(safe, count);
    if (count > 1) safe = `${safe.slice(0, 61)}_${count}`;
    return {
      inp, safe,
      optional: !!inp.optional || authorOptional(wf, inp),
      hasDef: inp.def != null && String(inp.def) !== "",
    };
  });
}

function buildInputSchema(wf) {
  const properties = {};
  const required = [];
  for (const { inp, safe, optional, hasDef } of keyedInputs(wf)) {
    const prop = { type: "string" };
    const bits = [];
    if (MEDIA_KINDS.has(inp.kind)) bits.push(`${inp.kind === "inpaint" ? "image" : inp.kind} — file path or https URL`);
    else if (inp.label && inp.label !== safe) bits.push(inp.label);
    else if (safe !== inp.key) bits.push(inp.key);
    if (inp.options) prop.enum = inp.options.map(String);
    if (hasDef && !MEDIA_KINDS.has(inp.kind)) {
      const d = String(inp.def);
      bits.push(`default: ${JSON.stringify(d.length > 120 ? d.slice(0, 117) + "..." : d)}`);
    }
    // A non-optional input with a baked-in default still runs when omitted (the library
    // backfills it), so only inputs that would actually fail are marked required — and
    // starred, so the designation survives clients that don't render `required`.
    if (!optional && !hasDef) {
      required.push(safe);
      bits.unshift("* required");
    } else {
      bits.push("optional");
    }
    if (bits.length) prop.description = bits.join("; ");
    properties[safe] = prop;
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

let saveSeq = 0;

/** Reserved name of the always-present share-link tool. */
const RUN_NOODLE_NAME = "run_noodle";

/**
 * The one tool that isn't tied to a saved file: it takes any nanoodle share
 * link and runs it, so every share link on the internet is a callable tool.
 */
const runNoodleTool = (spendSource) => ({
  name: RUN_NOODLE_NAME,
  description:
    "Run any nanoodle share link as a workflow: a nanoodle.com/#g=… workflow link, a " +
    "nanoodle.com/play.html#a=… app link, or a da.gd/TinyURL short link to one. Pass the link " +
    "as `url` and any workflow inputs as `inputs`. Runs on NanoGPT — every call spends real " +
    `credit from ${spendSource}. Direct share links decode locally; only fragment-less ` +
    "short links trigger a network read, and it carries no credentials.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "A nanoodle share link — a full URL (nanoodle.com/#g=…, /play.html#a=…, or a " +
          "da.gd/TinyURL short link) or a bare #g=/#j=/#a= fragment.",
      },
      inputs: {
        type: "object",
        description:
          'Workflow inputs keyed by their friendly names — the same keys the graph would take, ' +
          'e.g. { "Text": "a lighthouse at dawn" }. Media inputs take a file path or https URL. ' +
          "Omit to run the graph with its saved defaults.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["url"],
  },
});

/**
 * Map friendly-keyed tool arguments onto a workflow's derived inputs, resolving
 * local media paths to inline data via the library. Throws ParamsError (→ -32602)
 * for unknown keys, non-string values, or a missing required input.
 */
async function resolveInputs(wf, args, label) {
  const keyed = keyedInputs(wf);
  // Both spellings resolve: the schema-safe key the tool advertises and the graph's own key.
  const inputsByKey = new Map();
  for (const { inp, safe } of keyed) {
    inputsByKey.set(safe.toLowerCase(), inp);
    inputsByKey.set(inp.key.toLowerCase(), inp);
  }
  const inputs = {};
  for (const [k, v] of Object.entries(args)) {
    const entry = inputsByKey.get(String(k).trim().toLowerCase());
    if (!entry) {
      throw new ParamsError(`unknown input "${k}" for ${label} — inputs: ${keyed.map(({ safe }) => `"${safe}"`).join(", ") || "(none)"}`);
    }
    if (typeof v !== "string") {
      throw new ParamsError(`input "${k}" must be a string`);
    }
    if (MEDIA_KINDS.has(entry.kind) && !/^(data:|https?:)/i.test(v) && existsSync(v)) {
      inputs[entry.key] = await mediaFromFile(v);
    } else {
      inputs[entry.key] = v;
    }
  }
  const missing = keyed.filter(({ inp, optional, hasDef }) => !optional && !hasDef && inputs[inp.key] === undefined);
  if (missing.length) {
    throw new ParamsError(`missing required input${missing.length > 1 ? "s" : ""} for ${label}: ${missing.map(({ safe }) => `"${safe}"`).join(", ")}`);
  }
  return inputs;
}

/**
 * Make a failed run's error lead with the node that actually broke.
 *
 * The library's RunError message names the failed *sink* ("Image→Video":
 * upstream failed: Image), which buries the real failure when it happened
 * nodes earlier (a wallet cap refusal on an LLM read as an image failure).
 * The per-node record on e.result has the truth — surface it.
 */
export function describeRunFailure(e) {
  const errs = e && e.result && Array.isArray(e.result.errors) ? e.result.errors : null;
  if (!errs || !errs.length) return e;
  const isCascade = (m) => /^upstream failed: /.test(m || "");
  const roots = errs.filter((x) => !isCascade(x.message));
  if (!roots.length) return e;
  const cascaded = errs.filter((x) => isCascade(x.message)).map((x) => `"${x.name}"`);
  const out = new Error(
    `run failed at ${roots.map((x) => `"${x.name}": ${x.message}`).join("; ")}` +
    (cascaded.length ? ` — downstream never ran: ${cascaded.join(", ")}` : ""));
  out.cause = e;
  return out;
}

/** Turn a completed run into MCP tool-result content: media saved to disk, text inline, cost line. */
async function emitResult(wf, result, prefix, outDir) {
  const content = [];
  for (const o of wf.outputs) {
    const value = result.outputs[o.key];
    if (value === undefined) continue;
    if (value instanceof MediaRef) {
      await mkdir(outDir, { recursive: true });
      // bytes() before naming: for hosted media the mime is only known after the fetch
      const bytes = await value.bytes();
      const safeKey = o.key.replace(/[^\w.-]+/g, "_");
      const path = resolve(outDir, `${prefix}-${safeKey}-${Date.now()}-${++saveSeq}.${extForMedia(bytes, value.mime)}`);
      await writeFile(path, bytes);
      content.push({ type: "text", text: `${o.key}: saved ${path}` });
    } else {
      content.push({ type: "text", text: String(value) });
    }
  }
  if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd)) {
    content.push({ type: "text", text: `cost: $${result.costUsd.toFixed(4)}${result.costExact === false ? " (or more — some calls did not report a price)" : ""}` });
  }
  return { content };
}

/**
 * tools/call handler for run_noodle: decode a share link, build the workflow, run it.
 *
 * Argument-shape problems (missing url, wrong types, unknown input key) throw
 * ParamsError (→ -32602). Everything about the link's *contents* — a bad or
 * truncated link, the internal #ga= handoff, a graph needing browser-only or
 * unknown nodes, or a run failure — throws a plain error the server surfaces as
 * an isError tool result, so the agent gets a readable message, never a crash.
 */
async function runNoodle(params, { apiKey, payment, baseUrl, outDir }) {
  const args = params.arguments == null ? {} : params.arguments;
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ParamsError("tools/call arguments must be an object");
  }
  if (typeof args.url !== "string" || !args.url.trim()) {
    throw new ParamsError('run_noodle needs a "url" — a nanoodle share link (nanoodle.com/#g=…, /play.html#a=…, or a da.gd/TinyURL short link)');
  }
  const inputArgs = args.inputs == null ? {} : args.inputs;
  if (typeof inputArgs !== "object" || Array.isArray(inputArgs)) {
    throw new ParamsError('run_noodle "inputs" must be an object of workflow inputs, e.g. { "Text": "a lighthouse" }');
  }

  // Decode: direct #g=/#j=/#a= links are offline; only fragment-less short links
  // fetch, and those are redirect-header reads with no credentials attached.
  const decoded = await decodeShareUrl(args.url.trim(), { fetch: globalThis.fetch });
  const wf = new Workflow(decoded.graph, { apiKey, payment, baseUrl, quiet: true });
  if (wf.warnings.length) {
    // unknown / browser-only node types: the graph decodes but run() would always refuse
    throw new Error(`this share link can't run headlessly — ${wf.warnings.join("; ")}`);
  }
  const inputs = await resolveInputs(wf, inputArgs, `run_noodle (${decoded.url})`);
  const result = await wf.run(inputs).catch((e) => { throw describeRunFailure(e); });
  return emitResult(wf, result, RUN_NOODLE_NAME, outDir);
}

/**
 * Scan `dir` for graphs and build the tool registry.
 * @returns {{ tools: Array, failures: Array<{file, reason}>, listTools(), callTool(params) }}
 */
export async function loadTools({ dir, apiKey, payment, baseUrl, outDir }) {
  // Wallet mode (payment callback, no key) changes only where money comes from.
  const spendSource = apiKey || !payment ? "your API key's balance" : "your x402 Nano wallet";
  // Last-observed-cost sidecar: purely informational, so it must never block startup.
  const costsPath = join(outDir, "costs.json");
  let costs = {};
  try {
    const parsed = JSON.parse(await readFile(costsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) costs = parsed;
  } catch { /* missing or corrupt → no cost segments yet */ }
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    throw new Error(`cannot read --graphs directory ${dir}: ${e.message}`);
  }
  const files = entries.filter((f) => f.toLowerCase().endsWith(".json")).sort();
  const tools = [];
  const failures = [];
  // Seed the reserved run_noodle name so a file that sanitizes to it gets suffixed, not shadowed.
  const usedNames = new Map([[RUN_NOODLE_NAME, 1]]);

  for (const file of files) {
    const path = join(dir, file);
    let wf;
    try {
      wf = Workflow.fromJSON(await readFile(path, "utf8"), { apiKey, payment, baseUrl, quiet: true });
    } catch (e) {
      failures.push({ file, reason: e.message });
      continue;
    }
    if (wf.warnings.length) {
      // unknown / browser-only node types: the graph loads but run() would always refuse
      failures.push({ file, reason: wf.warnings.join("; ") });
      continue;
    }
    let name = sanitizeName(file);
    const count = (usedNames.get(name) || 0) + 1;
    usedNames.set(name, count);
    if (count > 1) name = `${name}-${count}`;
    tools.push({
      name,
      file,
      wf,
      description: buildDescription(wf, spendSource, { cost: renderCost(costs[name]) }),
      inputSchema: buildInputSchema(wf),
    });
  }

  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Record a run's observed cost and refresh the tool's description. Best-effort — never throws. */
  async function recordCost(tool, result) {
    if (typeof result.costUsd !== "number" || !Number.isFinite(result.costUsd)) return;
    const rec = { usd: result.costUsd, at: new Date().toISOString() };
    if (result.costExact === false) rec.exact = false; // renders "$X+"
    costs[tool.name] = rec;
    try {
      await mkdir(outDir, { recursive: true });
      // write-then-rename: overlapping runs may record concurrently, and two
      // writeFile calls on the same path can interleave — rename is atomic.
      const tmp = `${costsPath}.${++saveSeq}.tmp`;
      await writeFile(tmp, JSON.stringify(costs, null, 2) + "\n");
      await rename(tmp, costsPath);
    } catch (e) {
      console.error(`nanoodle-mcp: cannot write ${costsPath}: ${e.message}`);
    }
    const description = buildDescription(tool.wf, spendSource, { cost: renderCost(rec) });
    if (description !== tool.description) {
      tool.description = description;
      if (registry.onToolsChanged) registry.onToolsChanged();
    }
  }

  const registry = {
    tools,
    failures,
    /** Set by the host to hear about description changes (→ notifications/tools/list_changed). */
    onToolsChanged: null,

    listTools() {
      // run_noodle is always available, alongside one tool per saved graph.
      return [
        ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        runNoodleTool(spendSource),
      ];
    },

    /** tools/call handler. Throws ParamsError for malformed params; other errors mean the run failed. */
    async callTool(params) {
      if (params == null || typeof params !== "object" || Array.isArray(params)) {
        throw new ParamsError("tools/call expects a params object with { name, arguments }");
      }
      if (params.name === RUN_NOODLE_NAME) {
        return runNoodle(params, { apiKey, payment, baseUrl, outDir });
      }
      const tool = byName.get(params.name);
      if (!tool) {
        const available = [...tools.map((t) => t.name), RUN_NOODLE_NAME].join(", ");
        throw new ParamsError(`unknown tool "${params.name}" — available: ${available}`);
      }
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== "object" || Array.isArray(args)) {
        throw new ParamsError("tools/call arguments must be an object");
      }
      const inputs = await resolveInputs(tool.wf, args, `tool "${tool.name}"`);

      // Everything past this point is a run failure, not a protocol error → isError content.
      const result = await tool.wf.run(inputs).catch((e) => { throw describeRunFailure(e); });
      await recordCost(tool, result); // run_noodle never reaches here — its costs aren't tracked
      return emitResult(tool.wf, result, tool.name, outDir);
    },
  };
  return registry;
}
