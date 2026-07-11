/**
 * Graph directory → MCP tool registry.
 *
 * Each readable noodle-graph.json in the directory becomes one tool:
 *   - name        = filename minus .json, sanitized to [a-z0-9_-]
 *   - description = the graph's node-type chain ("text -> llm -> image; runs on NanoGPT …")
 *   - inputSchema = JSON Schema built from the workflow's derived inputs
 *   - call(args)  = wf.run(...) with media args resolved from file paths / URLs
 *
 * All heavy lifting (graph parsing, input derivation, execution, NanoGPT transport)
 * is the `nanoodle` library's; this file only adapts it to the MCP tool shape.
 */
import { readdir, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Workflow, MediaRef, mediaFromFile } from "nanoodle";

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

/** Error the server maps to JSON-RPC -32602 (invalid params) instead of a tool-result error. */
export class ParamsError extends Error {
  constructor(message) { super(message); this.mcpCode = -32602; }
}

function sanitizeName(file) {
  const stem = basename(file).replace(/\.json$/i, "");
  const name = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "graph";
}

/** Node-type chain in dependency order (local Kahn sort — keeps us on the library's public API). */
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
  return nodes.filter((n) => n.type !== "comment").map((n) => n.type).join(" -> ");
}

function buildInputSchema(wf) {
  const properties = {};
  const required = [];
  for (const inp of wf.inputs) {
    const prop = { type: "string" };
    const bits = [];
    if (MEDIA_KINDS.has(inp.kind)) bits.push(`${inp.kind === "inpaint" ? "image" : inp.kind} — file path or https URL`);
    else if (inp.label && inp.label !== inp.key) bits.push(inp.label);
    if (inp.options) prop.enum = inp.options.map(String);
    const hasDef = inp.def != null && String(inp.def) !== "";
    if (hasDef && !MEDIA_KINDS.has(inp.kind)) {
      const d = String(inp.def);
      bits.push(`default: ${JSON.stringify(d.length > 120 ? d.slice(0, 117) + "..." : d)}`);
    }
    if (bits.length) prop.description = bits.join("; ");
    properties[inp.key] = prop;
    // A non-optional input with a baked-in default still runs when omitted (the library
    // backfills it), so only inputs that would actually fail are marked required.
    if (!inp.optional && !hasDef) required.push(inp.key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

let saveSeq = 0;

/**
 * Scan `dir` for graphs and build the tool registry.
 * @returns {{ tools: Array, failures: Array<{file, reason}>, listTools(), callTool(params) }}
 */
export async function loadTools({ dir, apiKey, baseUrl, outDir }) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    throw new Error(`cannot read --graphs directory ${dir}: ${e.message}`);
  }
  const files = entries.filter((f) => f.toLowerCase().endsWith(".json")).sort();
  const tools = [];
  const failures = [];
  const usedNames = new Map();

  for (const file of files) {
    const path = join(dir, file);
    let wf;
    try {
      wf = Workflow.fromJSON(await readFile(path, "utf8"), { apiKey, baseUrl, quiet: true });
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
      description: `${typeChain(wf.graph)}; runs on NanoGPT — every call spends real credit from your API key's balance`,
      inputSchema: buildInputSchema(wf),
    });
  }

  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    failures,

    listTools() {
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },

    /** tools/call handler. Throws ParamsError for malformed params; other errors mean the run failed. */
    async callTool(params) {
      if (params == null || typeof params !== "object" || Array.isArray(params)) {
        throw new ParamsError("tools/call expects a params object with { name, arguments }");
      }
      const tool = byName.get(params.name);
      if (!tool) {
        throw new ParamsError(`unknown tool "${params.name}" — available: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
      }
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== "object" || Array.isArray(args)) {
        throw new ParamsError("tools/call arguments must be an object");
      }

      const inputsByKey = new Map(tool.wf.inputs.map((i) => [i.key.toLowerCase(), i]));
      const inputs = {};
      for (const [k, v] of Object.entries(args)) {
        const entry = inputsByKey.get(String(k).trim().toLowerCase());
        if (!entry) {
          throw new ParamsError(`unknown argument "${k}" for tool "${tool.name}" — inputs: ${tool.wf.inputs.map((i) => `"${i.key}"`).join(", ") || "(none)"}`);
        }
        if (typeof v !== "string") {
          throw new ParamsError(`argument "${k}" must be a string`);
        }
        if (MEDIA_KINDS.has(entry.kind) && !/^(data:|https?:)/i.test(v) && existsSync(v)) {
          inputs[entry.key] = await mediaFromFile(v);
        } else {
          inputs[entry.key] = v;
        }
      }
      const missing = (tool.inputSchema.required || []).filter((k) => inputs[k] === undefined);
      if (missing.length) {
        throw new ParamsError(`missing required argument${missing.length > 1 ? "s" : ""}: ${missing.map((k) => `"${k}"`).join(", ")}`);
      }

      // Everything past this point is a run failure, not a protocol error → isError content.
      const result = await tool.wf.run(inputs);

      const content = [];
      for (const o of tool.wf.outputs) {
        const value = result.outputs[o.key];
        if (value === undefined) continue;
        if (value instanceof MediaRef) {
          await mkdir(outDir, { recursive: true });
          const safeKey = o.key.replace(/[^\w.-]+/g, "_");
          const path = resolve(outDir, `${tool.name}-${safeKey}-${Date.now()}-${++saveSeq}.${extForMime(value.mime)}`);
          await value.save(path);
          content.push({ type: "text", text: `${o.key}: saved ${path}` });
        } else {
          content.push({ type: "text", text: String(value) });
        }
      }
      if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd)) {
        content.push({ type: "text", text: `cost: $${result.costUsd.toFixed(4)}${result.costExact === false ? " (or more — some calls did not report a price)" : ""}` });
      }
      return { content };
    },
  };
}
