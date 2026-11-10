// Custom workflows on a paid server: read the caller's graph arguments, decide
// whether a stranger's graph is safe to run, price it node by node, and say
// what it costs in words an agent can act on.
//
// Everything here is pure (no network, no disk) except readGraphArgs, which
// may resolve a share link through the injected fetch. The payment rails
// (Nano in src/gate.mjs, NEAR in src/near-gate.mjs) and src/tools.mjs build on
// these functions; this module imports neither of them.
//
// Vocabulary (the same words in every answer):
//   estimated cost  model cost the run is expected to have, itemized per paid node
//   service fee     20% of the ACTUAL model cost
//   deposit         the most you can be charged; held up front, the amount you send
//   refund          deposit minus what was actually charged, sent back automatically
//   rate            NEAR/USD used, with source and timestamp; when known also
//                   XNO/USD and the swap rate derived from the two ("1 NEAR = N
//                   XNO"), and the swap margin when non-zero; locked by a quote

import {
  Workflow, NODE_TYPES, displayName, topoSort, estimateGraphCost, graphModelKinds, decodeShareUrl,
} from "nanoodle";
import { gunzipSync, constants as zlibConstants } from "node:zlib";
import { knownUsd } from "./usd.mjs";

export const SERVICE_FEE_RATE = 0.2;
export const DEFAULT_LIMITS = Object.freeze({
  maxNodes: 40, maxGraphBytes: 200_000, maxInputKeys: 32, maxInputChars: 20_000, maxTotalInputChars: 50_000, maxDepositUsd: 2,
});
/** Output tokens assumed for a chat node that sets no positive maxTokens. */
export const DEFAULT_CHAT_OUTPUT_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Node allowlist. Deny by default: a type absent here (or unknown to the
// engine) is refused. One entry per engine node type; a test keeps it complete.
// ---------------------------------------------------------------------------

const WHY = {
  text: "Pure text logic.",
  comment: "A note; does nothing.",
  chat: "NanoGPT chat models. Any media they read must come from an upstream NanoGPT node (see wiring rules).",
  vision: "Its chat call carries no output limit, so its cost has no upper bound.",
  mediaLength: "Bills by the length of its input media, which is not known before the run, so its cost cannot be bounded up front.",
  image: "NanoGPT image models. `edit` sources must be upstream NanoGPT images.",
  video: "NanoGPT video models. Sources come only from upstream NanoGPT nodes. A LoRA URL is passed to the provider and never fetched by the server.",
  audio: "NanoGPT audio models; sources come only from upstream NanoGPT nodes.",
  model3d: "NanoGPT 3D models; any image comes from an upstream NanoGPT node.",
  upload: "Caller-supplied media. As a file path it reads the server's disk; as a URL the server fetches it; as inline data it can trigger local ffmpeg resizing.",
  inpaint: "Takes its image and mask straight from fields (any URL or inline data) and composites the mask locally.",
  lipsync: "May trim audio locally with ffmpeg.",
  local: "Local media processing (pure JS or ffmpeg) on the server.",
  endpoint: "POSTs to any URL written in the graph, which would let a caller reach internal addresses.",
};

const allow = (why) => Object.freeze({ allowed: true, why });
const deny = (why) => Object.freeze({ allowed: false, why });

export const NODE_POLICY = Object.freeze({
  text: allow(WHY.text), choice: allow(WHY.text), join: allow(WHY.text),
  comment: allow(WHY.comment),
  llm: allow(WHY.chat), decide: allow(WHY.chat),
  vision: deny(WHY.vision),
  image: allow(WHY.image), edit: allow(WHY.image),
  tvideo: allow(WHY.video), ivideo: allow(WHY.video),
  vedit: deny(WHY.mediaLength),
  music: allow(WHY.audio), tts: allow(WHY.audio),
  remix: deny(WHY.mediaLength), transcribe: deny(WHY.mediaLength), cleanvoice: deny(WHY.mediaLength),
  model3d: allow(WHY.model3d),
  upload: deny(WHY.upload), aupload: deny(WHY.upload), vupload: deny(WHY.upload), mupload: deny(WHY.upload),
  inpaint: deny(WHY.inpaint),
  lipsync: deny(WHY.lipsync),
  resize: deny(WHY.local), vframes: deny(WHY.local), combine: deny(WHY.local),
  soundtrack: deny(WHY.local), trim: deny(WHY.local), extractaudio: deny(WHY.local),
  endpoint: deny(WHY.endpoint),
});

/** What to do instead, per refused type. */
const INSTEAD = {
  upload: "generate the image with an image node instead",
  aupload: "generate the audio with a music or tts node instead",
  vupload: "generate the video with a tvideo or ivideo node instead",
  mupload: "generate the 3D model with a model3d node instead",
  inpaint: "use an edit node fed by an upstream image node instead",
  lipsync: "remove this node; lipsync is not offered on a paid server",
  endpoint: "remove this node; custom endpoints are not offered on a paid server",
  vision: "use an llm node with the image wired into img1 instead",
  vedit: "generate the video you want directly with tvideo or ivideo instead",
  remix: "generate the track directly with a music node instead",
  transcribe: "remove this node; transcription is not offered on a paid server",
  cleanvoice: "remove this node; voice cleanup is not offered on a paid server",
};
const insteadFor = (type) => INSTEAD[type] || "remove this node; local media processing is not offered on a paid server";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Malformed tool arguments. The server maps mcpCode to a JSON-RPC invalid-params error. */
export class GraphArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphArgsError";
    this.mcpCode = -32602;
  }
}

/** A well-formed graph this server will not run or price. Returned as an isError tool result. */
export class GraphRefusedError extends Error {
  constructor(refusals) {
    const list = Array.isArray(refusals) ? refusals : [];
    super(list.map((r) => r.message).join("; "));
    this.name = "GraphRefusedError";
    this.refusals = list;
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const SHARE_FRAGMENT_RE = /#[gja]=/;

const tooLarge = (what, max) => new GraphRefusedError([{
  code: "GRAPH_TOO_LARGE",
  message: `the ${what} is too large; this server accepts graphs of at most ${max} bytes of JSON`,
}]);

/**
 * Size-check a share link before the engine decodes it: the link itself, and
 * what its gzip payload inflates to (bounded, so a small link cannot expand to
 * gigabytes). Only runs when the caller passes limits (price_noodle and the
 * paid rails); a damaged payload is left to the engine's own salvage path.
 */
function assertShareLinkSize(url, maxGraphBytes) {
  if (url.length > maxGraphBytes * 2) throw tooLarge("share link", maxGraphBytes);
  const i = url.indexOf("#");
  const frag = i === -1 ? url : url.slice(i + 1);
  const m = /^(g|a)=([A-Za-z0-9_-]+)/.exec(frag);
  if (!m || (m[1] === "a" && m[2][0] === "u")) return; // #j= and #a=u are plain base64: the length cap covers them
  let buf;
  try { buf = Buffer.from(m[2], "base64url"); } catch { return; }
  try {
    gunzipSync(buf, { maxOutputLength: maxGraphBytes + 4096, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch (e) {
    if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError)) throw tooLarge("share link's graph", maxGraphBytes);
  }
}

/**
 * Read `graph` | `url` and `inputs` from tool arguments.
 * With `limits`, the graph's size is checked before it is parsed or inflated.
 * @returns {Promise<{graph: object, source: "graph"|"url", url: string|null, inputs: Record<string,string>}>}
 */
export async function readGraphArgs(args, { allowShortLinks = true, fetch = globalThis.fetch, limits = null } = {}) {
  const maxGraphBytes = limits ? { ...DEFAULT_LIMITS, ...limits }.maxGraphBytes : null;
  if (!isPlainObject(args)) throw new GraphArgsError("arguments must be an object");
  const hasGraph = args.graph != null && args.graph !== "";
  const hasUrl = args.url != null && args.url !== "";
  if (hasGraph === hasUrl) {
    throw new GraphArgsError('pass either "graph" (a nanoodle graph object) or "url" (a share link), not both');
  }

  let inputs = {};
  if (args.inputs != null) {
    if (!isPlainObject(args.inputs)) {
      throw new GraphArgsError('"inputs" must be an object mapping input names to string values');
    }
    for (const [k, v] of Object.entries(args.inputs)) {
      if (typeof v !== "string") {
        throw new GraphArgsError(`"inputs.${k}" must be a string (got ${Array.isArray(v) ? "an array" : v === null ? "null" : typeof v})`);
      }
    }
    inputs = { ...args.inputs };
  }

  if (hasGraph) {
    let graph = args.graph;
    if (typeof graph === "string") {
      if (maxGraphBytes != null && graph.length > maxGraphBytes) throw tooLarge("graph", maxGraphBytes);
      try { graph = JSON.parse(graph); } catch {
        throw new GraphArgsError('"graph" is a string but not valid JSON; pass the graph object itself');
      }
    }
    if (!isPlainObject(graph)) throw new GraphArgsError('"graph" must be a nanoodle graph object ({ "nodes": [...], "links": [...] })');
    return { graph, source: "graph", url: null, inputs };
  }

  if (typeof args.url !== "string" || !args.url.trim()) throw new GraphArgsError('"url" must be a non-empty string');
  const url = args.url.trim();
  if (!allowShortLinks && !SHARE_FRAGMENT_RE.test(url)) {
    throw new GraphRefusedError([{
      code: "SHORT_LINK",
      message: "this server does not follow short links; pass the full share link that carries its #g=, #j= or #a= fragment, or pass the graph itself as \"graph\"",
    }]);
  }
  if (maxGraphBytes != null) assertShareLinkSize(url, maxGraphBytes);
  let decoded;
  try { decoded = await decodeShareUrl(url, { fetch }); } catch (e) {
    throw new GraphRefusedError([{ code: "BAD_GRAPH", message: `could not read the share link: ${(e && e.message) || e}` }]);
  }
  if (!decoded || !isPlainObject(decoded.graph)) {
    throw new GraphRefusedError([{ code: "BAD_GRAPH", message: "the share link does not contain a workflow graph" }]);
  }
  return { graph: decoded.graph, source: "url", url, inputs };
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/** Ports whose value the engine treats as media (it may fetch or inline it). Same set as the engine's run loop. */
const MEDIA_PORT_RE = /^(?:image|mask|audio|video|model|endframe)$|^(?:img|image|ref|clip|vid|frame)\d+$/;
/** Engine rule: a wire on one of these ports is a data input; on any other port it overrides a field. */
const DYNAMIC_INPUT_NAMES = new Set(["audio", "endframe"]);
const DYNAMIC_INPUT_RES = [/^img\d+$/, /^image\d*$/, /^vid\d+$/, /^clip\d+$/, /^ref\d+$/];
const MEDIA_OUT_TYPES = new Set(["image", "audio", "video", "model3d"]);
const FORBIDDEN_TARGETS = new Set([
  "model", "size", "variations", "duration", "resolution", "maxTokens", "modelOpts",
  "loraUrl", "loras", "url", "image", "mask", "audio", "video",
]);
const UNSAFE_VALUE_RE = /^\s*(https?|data|file|blob):/i;
/** Free-form provider knobs merged into the request body unpriced (video/3D modelOpts, audio extraJson). */
const OPAQUE_FIELDS = ["modelOpts", "extraJson"];
const isEmptyOpaque = (v) => v == null || (typeof v === "string" && !v.trim())
  || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const WHOLE_RE = /^\d+$/;
const SECONDS_RE = /^\d+(?:\.\d+)?$/;
const DURATION_TYPES = new Set(["tvideo", "ivideo", "music"]);
const LORA_TYPES = new Set(["tvideo", "ivideo", "vedit"]);

function isInputPort(type, port) {
  const t = NODE_TYPES[type];
  if (t && (t.inputs || []).includes(port)) return true;
  if (DYNAMIC_INPUT_NAMES.has(port)) return true;
  return DYNAMIC_INPUT_RES.some((re) => re.test(port));
}

const isPaidNode = (n) => graphModelKinds({ nodes: [n] }).size > 0;
const label = (n) => `node "${displayName(n)}" (${n.type})`;

function isLoraUrlPath(type, path) {
  if (!LORA_TYPES.has(type)) return false;
  if (path.length === 1 && path[0] === "loraUrl") return true;
  return path.length === 3 && path[0] === "loras" && typeof path[1] === "number" && path[2] === "url";
}

function walkStrings(value, path, visit) {
  if (typeof value === "string") { visit(value, path); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkStrings(v, path.concat(i), visit)); return; }
  if (value && typeof value === "object") for (const k of Object.keys(value)) walkStrings(value[k], path.concat(k), visit);
}

const fieldPath = (path) => "fields" + path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");

/**
 * Check a caller's graph against the paid-server rules. Never throws; collects every refusal.
 * @returns {{ ok: boolean, refusals: Array, workflowGraph: object|null }}
 */
export function checkGraphSafety(graph, { inputs = {}, limits = DEFAULT_LIMITS } = {}) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const refusals = [];
  const done = (workflowGraph) => ({ ok: refusals.length === 0, refusals, workflowGraph });

  // 1. size
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(graph) ?? ""); } catch (e) {
    refusals.push({ code: "BAD_GRAPH", message: `the graph is not plain JSON: ${(e && e.message) || e}` });
    return done(null);
  }
  if (bytes > L.maxGraphBytes) {
    refusals.push({ code: "GRAPH_TOO_LARGE", message: `the graph is ${bytes} bytes of JSON; this server accepts at most ${L.maxGraphBytes}` });
    return done(null);
  }

  // 2. load with the engine
  let wf;
  try { wf = new Workflow(graph, { quiet: true }); } catch (e) {
    refusals.push({ code: "BAD_GRAPH", message: `not a usable nanoodle graph: ${(e && e.message) || e}` });
    return done(null);
  }
  const g = wf.graph;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  const seen = new Set();
  for (const n of g.nodes) {
    if (seen.has(n.id)) refusals.push({ code: "BAD_GRAPH", message: `two nodes share the id "${n.id}"; node ids must be unique`, nodeId: n.id, type: n.type });
    seen.add(n.id);
  }
  if (seen.size === g.nodes.length) {
    try { topoSort(g); } catch (e) { refusals.push({ code: "BAD_GRAPH", message: String((e && e.message) || e) }); }
  }

  for (const w of wf.warnings || []) {
    const m = /^unknown node type "([^"]*)" \(node ([^)]*)\)/.exec(w);
    if (m) {
      const n = byId.get(m[2]) || { id: m[2], type: m[1] };
      refusals.push({
        code: "UNKNOWN_NODE", nodeId: m[2], type: m[1],
        message: `node "${displayName(n)}" has unknown type "${m[1]}"; use one of the allowed types listed by noodle_guide`,
      });
    } else {
      // Media-field placeholder scrubbed by the loader. Media fields must be left empty.
      const fm = /^node ([^ ]+) \(/.exec(w);
      const n = fm && byId.get(fm[1]);
      refusals.push({
        code: "UNSAFE_FIELD", ...(n ? { nodeId: n.id, type: n.type } : {}),
        message: `${n ? label(n) : "a node"} has a media field holding something other than media; leave media fields empty and wire media from an upstream NanoGPT node`,
      });
    }
  }

  // 3. node count (raw array, so nodes the loader skipped still count)
  const rawCount = Array.isArray(graph && graph.nodes) ? graph.nodes.length : g.nodes.length;
  if (rawCount > L.maxNodes) {
    refusals.push({ code: "TOO_MANY_NODES", message: `the graph has ${rawCount} nodes (comments included); this server accepts at most ${L.maxNodes}` });
  }

  // 4. node types
  for (const n of g.nodes) {
    if (n.unknown) continue; // reported as UNKNOWN_NODE
    const p = NODE_POLICY[n.type];
    if (!p || !p.allowed) {
      const why = p ? p.why : "Not on this server's allowlist.";
      refusals.push({
        code: "NODE_NOT_ALLOWED", nodeId: n.id, type: n.type,
        message: `${label(n)} is not allowed on a paid server: ${why.replace(/\.$/, "")} — ${insteadFor(n.type)}`,
      });
    }
  }

  // 5. wiring
  const allowedNode = (n) => !!n && !n.unknown && !!(NODE_POLICY[n.type] && NODE_POLICY[n.type].allowed);
  for (const l of g.links) {
    const S = byId.get(l.from.node), D = byId.get(l.to.node);
    if (!allowedNode(S) || !allowedNode(D)) continue; // the node itself is already refused
    const port = l.to.port;
    const out = (NODE_TYPES[S.type].outputs || []).find((o) => o.name === l.from.port);
    const srcType = out ? out.type : null;
    const base = { code: "UNSAFE_WIRING", nodeId: D.id, type: D.type };
    if (MEDIA_PORT_RE.test(port)) {
      if (D.type === "llm" && port === "audio") {
        refusals.push({ ...base, message: `${label(D)}: audio wired into an llm node is billed by its length, which cannot be priced up front; remove the wire from ${label(S)}` });
      } else if (!isInputPort(D.type, port)) {
        refusals.push({ ...base, message: `${label(D)}: "${port}" is not a media input of this node, so a wire into it would overwrite a setting; remove the wire from ${label(S)}` });
      } else if (!srcType || !MEDIA_OUT_TYPES.has(srcType) || !isPaidNode(S)) {
        refusals.push({ ...base, message: `${label(D)}: its media port "${port}" is fed by the ${srcType || "unknown"} output "${l.from.port}" of ${label(S)}; media ports accept only media generated by an upstream NanoGPT node` });
      }
      continue;
    }
    if (FORBIDDEN_TARGETS.has(port)) {
      refusals.push({ ...base, message: `${label(D)}: a wire from ${label(S)} targets "${port}", a pricing or URL setting; set "${port}" in the node's fields instead` });
    } else if (srcType && MEDIA_OUT_TYPES.has(srcType)) {
      refusals.push({ ...base, message: `${label(D)}: its text field "${port}" is fed by the ${srcType} output of ${label(S)}; media can only feed a media port` });
    }
  }

  // 6a. settings whose value changes the price (they must be what was priced)
  for (const n of g.nodes) {
    const f = n.fields || {};
    for (const k of OPAQUE_FIELDS) {
      if (!isEmptyOpaque(f[k])) {
        refusals.push({
          code: "UNSAFE_FIELD", nodeId: n.id, type: n.type,
          message: `${label(n)}: fields.${k} is sent to the provider as-is and can change the model or the length billed, so a paid server does not accept it; remove it`,
        });
      }
    }
    if (n.type === "llm" && f.maxTokens != null && String(f.maxTokens).trim() !== "" && !(WHOLE_RE.test(String(f.maxTokens).trim()) && +f.maxTokens >= 1)) {
      refusals.push({
        code: "BAD_FIELD", nodeId: n.id, type: n.type,
        message: `${label(n)}: fields.maxTokens must be a whole number of tokens of at least 1 (or left out for ${DEFAULT_CHAT_OUTPUT_TOKENS}); got ${JSON.stringify(f.maxTokens)}`,
      });
    }
    if (DURATION_TYPES.has(n.type) && f.duration != null && String(f.duration).trim() !== "" && !SECONDS_RE.test(String(f.duration).trim())) {
      refusals.push({
        code: "BAD_FIELD", nodeId: n.id, type: n.type,
        message: `${label(n)}: fields.duration must be a number of seconds (e.g. "5"); got ${JSON.stringify(f.duration)}`,
      });
    }
  }

  // 6. field values
  for (const n of g.nodes) {
    walkStrings(n.fields || {}, [], (v, path) => {
      if (!UNSAFE_VALUE_RE.test(v)) return;
      if (isLoraUrlPath(n.type, path) && /^https:\/\//i.test(v.trim())) return;
      const scheme = /^\s*([a-z]+):/i.exec(v)[1].toLowerCase();
      const hint = isLoraUrlPath(n.type, path) ? "a LoRA URL must start with https://" : "fields may not hold URLs or inline data; media must come from an upstream NanoGPT node";
      refusals.push({
        code: "UNSAFE_FIELD", nodeId: n.id, type: n.type,
        message: `${label(n)}: ${fieldPath(path)} starts with "${scheme}:"; ${hint}`,
      });
    });
  }

  // 7. inputs
  const inp = inputs == null ? {} : inputs;
  if (!isPlainObject(inp)) {
    refusals.push({ code: "INPUTS_TOO_LARGE", message: "inputs must be an object mapping input names to string values" });
  } else {
    const keys = Object.keys(inp);
    if (keys.length > L.maxInputKeys) refusals.push({ code: "INPUTS_TOO_LARGE", message: `${keys.length} inputs given; this server accepts at most ${L.maxInputKeys}` });
    let total = 0;
    for (const k of keys) {
      const v = inp[k];
      if (typeof v !== "string") {
        refusals.push({ code: "INPUTS_TOO_LARGE", message: `input "${k}" must be a string (got ${v === null ? "null" : Array.isArray(v) ? "an array" : typeof v})` });
        continue;
      }
      total += v.length;
      if (v.length > L.maxInputChars) refusals.push({ code: "INPUTS_TOO_LARGE", message: `input "${k}" is ${v.length} characters; one input may be at most ${L.maxInputChars}` });
    }
    if (total > L.maxTotalInputChars) refusals.push({ code: "INPUTS_TOO_LARGE", message: `the inputs total ${total} characters; this server accepts at most ${L.maxTotalInputChars}` });
  }

  return done(g);
}

/** The engine's graph for a safe caller graph; throws GraphRefusedError listing every problem otherwise. */
export function assertGraphSafe(graph, opts) {
  const r = checkGraphSafety(graph, opts);
  if (!r.ok) throw new GraphRefusedError(r.refusals);
  return r.workflowGraph;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The tool-schema key for an input name (same rule as src/tools.mjs schemaKey). */
const schemaSafeKey = (key) => String(key).replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "input";

/**
 * Deep copy of the graph with each matching input written into its node field.
 * Keys resolve exactly as the run path resolves them (src/tools.mjs keyedInputs
 * + resolveInputs): the input's own name or its schema-safe key, with the
 * "_2", "_3" suffixes that de-duplicate colliding safe keys. Unknown keys are
 * ignored here (the run path refuses them).
 */
export function applyInputs(workflowGraph, inputs) {
  const g = structuredClone(workflowGraph);
  if (!inputs || typeof inputs !== "object" || !Object.keys(inputs).length) return g;
  const derived = new Workflow(workflowGraph, { quiet: true }).inputs;
  const byKey = new Map();
  const used = new Map();
  for (const inp of derived) {
    let safe = schemaSafeKey(inp.key);
    const count = (used.get(safe) || 0) + 1;
    used.set(safe, count);
    if (count > 1) safe = `${safe.slice(0, 61)}_${count}`;
    byKey.set(safe.toLowerCase(), inp);
    byKey.set(String(inp.key).toLowerCase(), inp);
  }
  const resolved = new Map();
  for (const [k, v] of Object.entries(inputs)) {
    const inp = byKey.get(String(k).trim().toLowerCase());
    if (inp) resolved.set(inp.key, v);
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const inp of derived) {
    if (!resolved.has(inp.key)) continue;
    const n = byId.get(inp.nodeId);
    if (!n) continue;
    n.fields = { ...(n.fields || {}), [inp.field]: resolved.get(inp.key) };
  }
  return g;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const KIND_OF = (n) => [...graphModelKinds({ nodes: [n] })][0] || null;
const num = (x) => (x != null && isFinite(+x) ? +x : null);

/** Same expression as the Nano rail's deposit (src/gate.mjs priceFor), so both rails quote alike. */
export function depositUsdFor(estimatedCostUsd, fixedPrice) {
  return Math.max(0.01, Math.ceil(estimatedCostUsd * 1.2 * (fixedPrice ? 1.25 : 2) * 100) / 100);
}

function catalogEntry(catalogs, kind, id) {
  const arr = catalogs && Array.isArray(catalogs[kind]) ? catalogs[kind] : null;
  if (!arr || !id) return null;
  return arr.find((m) => m && String(m.id) === id) || null;
}

function videoSeconds(pricing, fields) {
  const p = pricing || {}, raw = (p.raw && typeof p.raw === "object") ? p.raw : {};
  const f = parseFloat(fields && fields.duration);
  if (isFinite(f) && f > 0) return f;
  const d = num(p.default_duration) ?? num(raw.defaultDuration);
  if (d != null && d > 0) return d;
  if (p.per_duration) { const k = Object.keys(p.per_duration)[0]; if (k && isFinite(+k)) return +k; }
  if (Array.isArray(p.supported_durations) && p.supported_durations.length) return +p.supported_durations[0];
  if (p.fixed_duration_seconds != null) return num(p.fixed_duration_seconds) || 5;
  return 5;
}

/** Human basis for one priced node, mirroring the estimator's own quantities. */
function basisFor(n, pricedNode, entry, pricingGraph) {
  const f = pricedNode.fields || {};
  const kind = KIND_OF(n);
  if (n.type === "decide") {
    const imgs = pricingGraph.links.filter((l) => l.to.node === n.id && /^img\d+$/.test(l.to.port)).length;
    const inTok = 120 + Math.round((textLen(f.question) + textLen(f.options) + textLen(f.levels)) / 4) + 250 + imgs * 400;
    const asks = (f.mode === "choose" || f.mode === "score" || f.mode === "yesno") ? 1 : 2;
    return `up to ${inTok} input tokens per ask, ${asks} ask${asks === 1 ? "" : "s"} (usually less)`;
  }
  if (kind === "chat") {
    const inTok = Math.max(200, Math.round((textLen(f.system) + textLen(f.prompt)) / 4) + 200);
    const outTok = f.maxTokens ? +f.maxTokens : 500;
    return `up to ${inTok} input + ${outTok} output tokens (maxTokens; usually less)`;
  }
  const p = (entry && entry.pricing) || {};
  if (kind === "image") {
    const sp = entry.supported_parameters || {}, maxOut = sp.max_output_images || 1, fixed = sp.fixed_image_count || 0;
    const count = fixed > 1 ? fixed : Math.min(maxOut, Math.max(1, parseInt(f.variations, 10) || 1));
    const per = p.per_image || {};
    const size = per[f.size] != null ? f.size
      : per.square != null ? "square" : per.square_hd != null ? "square_hd" : (Object.keys(per)[0] || f.size || "default size");
    return `${count} image${count === 1 ? "" : "s"} at ${size} (fixed price)`;
  }
  if (kind === "video") return `${videoSeconds(p, f)}s video at catalog price (varies)`;
  if (kind === "model3d") return "one 3D model at catalog price";
  if (kind === "audio") {
    let secs;
    if (n.type === "cleanvoice") {
      const link = pricingGraph.links.find((l) => l.to.node === n.id && (l.to.port === "audio" || l.to.port === "video"));
      const src = link && pricingGraph.nodes.find((x) => x.id === link.from.node);
      const d = parseFloat(src && src.fields && src.fields.duration);
      secs = isFinite(d) && d > 0 ? d : 30;
    } else {
      const sp = entry.supported_parameters || {};
      const d = parseFloat(f.duration);
      secs = 30;
      if (sp.min_duration != null && sp.max_duration != null && isFinite(d)) {
        const lo = num(sp.min_duration), hi = num(sp.max_duration);
        secs = Math.min(hi != null ? hi : d, Math.max(lo != null ? lo : d, d));
      }
    }
    const chars = textLen(f.prompt) || 600;
    if (n.type !== "transcribe" && n.type !== "cleanvoice" && (p.per_thousand_chars != null || p.per_prompt_char_block != null)) {
      return `up to ${chars} characters at catalog price`;
    }
    if (p.per_generation != null) return "one generation at catalog price";
    if (p.per_second != null || p.per_billing_interval != null) return `about ${secs}s of audio at catalog price (varies)`;
    if (p.per_minute != null) return "about 1 minute of audio at catalog price (varies)";
    return "one audio job at catalog price (varies)";
  }
  return "catalog price";
}

// ---------------------------------------------------------------------------
// Binding: the graph a paid server runs is the graph it priced
// ---------------------------------------------------------------------------

/** Characters per token, for every text-length bound. */
const CHARS_PER_TOKEN = 4;
/** Input tokens allowed per image wired into an llm node. */
const LLM_IMAGE_TOKENS = 1500;
/** Ceiling on any one text value, in characters (also caps join chains). */
const MAX_TEXT_CHARS = 50_000_000;
/** A decide node outputs a label, a score or yes/no. */
const DECIDE_OUT_CHARS = 256;
/** Catalog notes that mean the price is set by a live quote at run time. */
const LIVE_QUOTE_RE = /live quote/i;

/**
 * A length-only stand-in for a text field in the pricing copy. The estimator
 * only reads `.length`, so a bound of millions of characters costs no memory.
 * The pricing copy is never run.
 */
const lenOnly = (n) => Object.freeze({ length: Math.max(0, Math.floor(n)) });
const textLen = (v) => (v == null ? 0 : typeof v === "object" && typeof v.length === "number" ? v.length : String(v).length);

/**
 * The graph a paid server will actually run, with every quantity the price
 * depends on written into it, so the provider is asked for exactly what was
 * priced:
 *   - llm: maxTokens set (the model's max output, at most DEFAULT_CHAT_OUTPUT_TOKENS)
 *     when the graph sets none, so the run always sends max_tokens;
 *   - tvideo/ivideo: duration set to the catalog default the run would send;
 *   - music: duration set (30 s, clamped to the model's range) when the model takes one.
 * Models whose catalog price comes from a live quote are refused.
 * Pure; returns a new graph.
 */
export function bindPaidGraph(workflowGraph, catalogs) {
  const g = structuredClone(workflowGraph);
  const refusals = [];
  for (const n of g.nodes) {
    if (!isPaidNode(n)) continue;
    const f = n.fields = { ...(n.fields || {}) };
    const kind = KIND_OF(n);
    const model = String(f.model || "").trim();
    const entry = catalogEntry(catalogs, kind, model);
    const note = entry && entry.pricing && typeof entry.pricing.note === "string" ? entry.pricing.note : "";
    if (LIVE_QUOTE_RE.test(note)) {
      refusals.push({
        code: "LIVE_PRICED_MODEL", nodeId: n.id, type: n.type, model,
        message: `${label(n)} uses model "${model}", whose exact price is only set by a live provider quote at run time, so this server cannot hold a deposit that covers it; pick another ${kind} model listed by noodle_guide`,
      });
    }
    if (n.type === "llm" && (f.maxTokens == null || String(f.maxTokens).trim() === "")) {
      const cap = num(entry && entry.max_output_tokens);
      f.maxTokens = cap && cap > 0 ? Math.min(DEFAULT_CHAT_OUTPUT_TOKENS, cap) : DEFAULT_CHAT_OUTPUT_TOKENS;
    } else if (n.type === "llm") {
      f.maxTokens = Number(String(f.maxTokens).trim());
    }
    if ((n.type === "tvideo" || n.type === "ivideo") && (f.duration == null || String(f.duration).trim() === "")) {
      const p = (entry && entry.supported_parameters && entry.supported_parameters.parameters) || {};
      const dP = p.duration || p.seconds;
      if (dP && dP.default != null && String(dP.default).trim() !== "") f.duration = String(dP.default);
    }
    if (n.type === "music" && (f.duration == null || String(f.duration).trim() === "")) {
      const sp = (entry && entry.supported_parameters) || {};
      const lo = num(sp.min_duration), hi = num(sp.max_duration);
      if (lo != null && hi != null) f.duration = Math.min(hi, Math.max(lo, 30));
    }
  }
  return { graph: g, refusals };
}

/**
 * Upper bound, in characters, of the text each node outputs. Text nodes give
 * their value; choice its longest option; join the sum of its inputs plus the
 * separator; llm its maxTokens; decide a short label. Anything else that
 * outputs text is unbounded (MAX_TEXT_CHARS); the allowlist refuses those.
 */
function textBounds(g) {
  const out = new Map();
  let order;
  try { order = topoSort(g); } catch { order = g.nodes; }
  const inBound = (id, port) => {
    let b = 0;
    for (const l of g.links) if (l.to.node === id && l.to.port === port) b = Math.max(b, out.has(l.from.node) ? out.get(l.from.node) : MAX_TEXT_CHARS);
    return b;
  };
  for (const n of order) {
    const f = n.fields || {};
    let b;
    switch (n.type) {
      case "text": b = textLen(f.text); break;
      case "choice": b = Math.max(0, ...String(f.options || "").split("\n").map((s) => s.trim().length)); break;
      case "join": b = inBound(n.id, "a") + inBound(n.id, "b") + String(f.sep != null ? f.sep : " ").length; break;
      case "llm": b = (Number(f.maxTokens) > 0 ? Number(f.maxTokens) : DEFAULT_CHAT_OUTPUT_TOKENS) * CHARS_PER_TOKEN; break;
      case "decide": b = DECIDE_OUT_CHARS; break;
      default: b = ((NODE_TYPES[n.type] && NODE_TYPES[n.type].outputs) || []).some((o) => o.type === "text") ? MAX_TEXT_CHARS : 0;
    }
    out.set(n.id, Math.min(MAX_TEXT_CHARS, b));
  }
  return { inBound };
}

/**
 * The pricing copy: the bound graph with the inputs applied and every billed
 * text field replaced by its upper bound, so wired text (inputs, joins, LLM
 * outputs feeding later prompts) is priced at its longest:
 *   - llm: system + prompt (+ LLM_IMAGE_TOKENS per wired image), capped at the
 *     model's context length;
 *   - decide: question + the wired text it judges;
 *   - tts / music: the prompt, capped at the model's max_chars.
 */
function pricingCopy(boundGraph, inputs, catalogs) {
  const g = applyInputs(boundGraph, inputs);
  const { inBound } = textBounds(g);
  for (const n of g.nodes) {
    if (!isPaidNode(n)) continue;
    const f = n.fields = { ...(n.fields || {}) };
    const wired = (port) => g.links.some((l) => l.to.node === n.id && l.to.port === port);
    const len = (port) => (wired(port) ? inBound(n.id, port) : textLen(f[port]));
    const entry = catalogEntry(catalogs, KIND_OF(n), String(f.model || "").trim());
    const ctx = num(entry && entry.context_length);
    const ctxChars = ctx && ctx > 0 ? ctx * CHARS_PER_TOKEN : Infinity;
    if (n.type === "llm") {
      const imgs = g.links.filter((l) => l.to.node === n.id && /^img\d+$/.test(l.to.port)).length;
      const sys = Math.min(len("system"), ctxChars);
      const prompt = Math.min(len("prompt") + imgs * LLM_IMAGE_TOKENS * CHARS_PER_TOKEN, ctxChars - sys);
      f.system = lenOnly(sys);
      f.prompt = lenOnly(prompt);
    } else if (n.type === "decide") {
      f.question = lenOnly(Math.min(len("question") + inBound(n.id, "text"), ctxChars));
      if (wired("options")) f.options = lenOnly(inBound(n.id, "options"));
      if (wired("levels")) f.levels = lenOnly(inBound(n.id, "levels"));
    } else if (n.type === "tts" || n.type === "music") {
      const maxChars = num(entry && entry.supported_parameters && entry.supported_parameters.max_chars);
      const c = len("prompt");
      f.prompt = lenOnly(maxChars && maxChars > 0 ? Math.min(c, maxChars) : c);
    }
  }
  return g;
}

/**
 * A video model priced as { per_second: { "480p": x, "720p": y } }. The engine's
 * estimator reads per_second only as a number and falls back to one flat
 * value (one second's price), so this shape is priced here: the rate for the
 * node's resolution (else the catalog default, else the highest) x duration.
 */
function perSecondByResolutionUsd(entry, fields) {
  const p = (entry && entry.pricing) || {};
  if (!p.per_second || typeof p.per_second !== "object") return 0;
  const params = (entry.supported_parameters && entry.supported_parameters.parameters) || {};
  const res = fields.resolution || (params.resolution && params.resolution.default) || p.default_resolution;
  const rates = Object.values(p.per_second).map(num).filter((v) => v != null);
  const rate = num(p.per_second[res]) ?? (rates.length ? Math.max(...rates) : null);
  return rate == null ? 0 : rate * videoSeconds(p, fields);
}

/** Single-node graph the estimator prices exactly as it would inside the full graph. */
function nodeSlice(g, n) {
  const linksIn = g.links.filter((l) => l.to.node === n.id);
  const nodes = [n];
  if (n.type === "cleanvoice") {
    const link = linksIn.find((l) => l.to.port === "audio" || l.to.port === "video");
    const src = link && g.nodes.find((x) => x.id === link.from.node);
    // The estimator reads only the source's fields.duration; as a "text" node it costs nothing itself.
    if (src && src.id !== n.id) nodes.push({ ...structuredClone(src), type: "text" });
  }
  return { nodes, links: linksIn };
}

/**
 * Itemized forecast for a materialized graph. Pure.
 * The graph is first bound (bindPaidGraph), then each paid node is priced alone
 * with estimateGraphCost on the pricing copy (pricingCopy), so the items add up
 * to the engine's own total for that copy. Chat steps are priced at their
 * maxTokens and at the longest text that can reach them.
 */
export function priceGraph(workflowGraph, catalogs, { inputs = {} } = {}) {
  const cats = catalogs || {};
  const bound = bindPaidGraph(workflowGraph, cats);
  const g = pricingCopy(bound.graph, inputs, cats);
  const items = [], unpriced = [];
  let estimatedCostUsd = 0;
  for (const n of g.nodes) {
    if (!isPaidNode(n)) continue;
    const kind = KIND_OF(n);
    const model = String((n.fields && n.fields.model) || "").trim();
    const e = estimateGraphCost(nodeSlice(g, n), cats);
    if (e.unpriced >= 1 || !(e.priced >= 1)) {
      let reason, catalogMissing = false;
      if (!Array.isArray(cats[kind])) { reason = `the ${kind} model catalog could not be loaded`; catalogMissing = true; }
      else if (!model && n.type !== "model3d" && n.type !== "cleanvoice") reason = "no model is set on this node";
      else if (model && !catalogEntry(cats, kind, model)) reason = `model is missing from the NanoGPT ${kind} catalog`;
      else reason = "the catalog lists a pricing shape the estimator does not recognise";
      unpriced.push({ nodeId: n.id, node: displayName(n), type: n.type, model: model || "(default)", kind, reason, ...(catalogMissing ? { catalogMissing } : {}) });
      continue;
    }
    const entry = catalogEntry(cats, kind, model || (n.type === "model3d" ? "tripo3d/v2.5" : n.type === "cleanvoice" ? "elevenlabs/audio-isolation" : ""));
    const usd = kind === "video" ? Math.max(e.usd, perSecondByResolutionUsd(entry, n.fields || {})) : e.usd;
    items.push({
      nodeId: n.id, node: displayName(n), type: n.type, model: model || "(default)",
      basis: basisFor(n, n, entry || {}, g), usd, fixedPrice: !!e.exact,
    });
    estimatedCostUsd += usd;
  }
  const fixedPrice = items.length > 0 && items.every((i) => i.fixedPrice);
  const headroom = fixedPrice ? 1.25 : 2;
  return {
    estimatedCostUsd, fixedPrice, items, unpriced,
    /** Refusals found while binding (models priced only by a live quote). */
    refusals: bound.refusals,
    /** The graph to run: what was priced, with maxTokens and durations written in. */
    boundGraph: bound.graph,
    serviceFeeRate: SERVICE_FEE_RATE,
    likelyChargeUsd: estimatedCostUsd * (1 + SERVICE_FEE_RATE),
    headroom,
    depositUsd: depositUsdFor(estimatedCostUsd, fixedPrice),
  };
}

/** Refusals that stop a quote: models priced only live, unpriced nodes, and a deposit above the server's maximum. */
export function refusalsForQuote(pricing, { maxDepositUsd = DEFAULT_LIMITS.maxDepositUsd } = {}) {
  const out = [...((pricing && pricing.refusals) || [])];
  for (const u of (pricing && pricing.unpriced) || []) {
    const missing = !!u.catalogMissing;
    const noModel = u.model === "(default)" && /no model is set/.test(u.reason);
    out.push({
      code: missing ? "CATALOG_UNAVAILABLE" : "UNPRICED_NODE", nodeId: u.nodeId, type: u.type, model: u.model,
      message: missing
        ? `node "${u.node}" (${u.type}) cannot be priced right now: ${u.reason}; try again in a minute`
        : noModel
          ? `node "${u.node}" (${u.type}) has no model set; set fields.model to a ${u.kind} model listed by noodle_guide`
          : `node "${u.node}" (${u.type}) uses model "${u.model}", which this server cannot price: ${u.reason}; pick a ${u.kind} model listed by noodle_guide`,
    });
  }
  if (pricing && pricing.depositUsd > maxDepositUsd) {
    out.push({
      code: "DEPOSIT_TOO_HIGH",
      message: `this workflow needs a $${exactUsd(pricing.depositUsd)} deposit; this server accepts at most $${exactUsd(maxDepositUsd)} — use cheaper models, fewer paid nodes or a lower maxTokens`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting: the single source of the pricing vocabulary
// ---------------------------------------------------------------------------

/** Plain decimal string (never exponent notation), trailing zeros trimmed. */
function plainDecimal(x, decimals) {
  let s = Math.abs(x).toFixed(decimals);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "") s = "0";
  return (x < 0 && s !== "0" ? "-" : "") + s;
}

/** Forecast USD: three significant digits below $1, cents at or above $1. */
export function estUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x === 0) return "0";
  if (Math.abs(x) >= 1) return x.toFixed(2);
  const r = Number(Math.abs(x).toPrecision(3));
  if (r >= 1) return (Math.sign(x) * r).toFixed(2);
  const decimals = Math.min(100, Math.max(0, 2 - Math.floor(Math.log10(r))));
  return plainDecimal(Math.sign(x) * r, decimals);
}

/** Money USD: up to nine decimals, trailing zeros trimmed, never exponent notation. */
export function exactUsd(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  return plainDecimal(x, 9);
}

const isMinimumDeposit = (p) => Math.ceil(p.likelyChargeUsd * p.headroom * 100) / 100 <= 0.01;

const MOST_YOU_PAY = "that is the most you can be charged, even if the run costs more, and the rest is refunded";

/**
 * The one sentence that says what the caller will most likely pay, that the
 * deposit is the cap, and that the rest comes back.
 * near.depositApprox: the NEAR deposit is a pre-quote figure (price_noodle);
 * the quote adds the unique dust.
 */
export function summarySentence(pricing, near = null) {
  const p = pricing;
  let tail;
  if (near && near.depositApprox) {
    tail = `You will send a deposit of about ${near.depositNear} NEAR (the quote adds up to 0.000999 NEAR so each amount is unique; that comes back with the refund); ${MOST_YOU_PAY} to your account as soon as the run finishes.`;
  } else if (near) {
    tail = `You send ${near.depositNear} NEAR as a deposit; ${MOST_YOU_PAY} to your account as soon as the run finishes.`;
  } else {
    tail = `The deposit is $${exactUsd(p.depositUsd)}; ${MOST_YOU_PAY} automatically as soon as the run finishes.`;
  }
  if (!(p.items && p.items.length) && !(p.unpriced && p.unpriced.length)) {
    return `This workflow calls no paid models, so you will most likely pay nothing. ${tail}`;
  }
  const nearPart = near ? ` (${near.likelyChargeNear} NEAR)` : "";
  return `You will most likely pay about $${estUsd(p.likelyChargeUsd)}${nearPart}: the estimated cost plus a 20% service fee. ${tail}`;
}

/** The one sentence that explains why the deposit is larger than the likely charge. */
export function depositWhySentence(pricing) {
  const dep = `$${exactUsd(pricing.depositUsd)}`;
  if (isMinimumDeposit(pricing)) {
    return `The deposit is the ${dep} minimum, because this workflow most likely costs less than that.`;
  }
  if (pricing.headroom === 1.25) {
    return `Every model here has a fixed price, so the deposit is the likely charge plus 25% headroom, rounded up to the next cent (${dep}).`;
  }
  return `Text, video and audio steps bill by what they actually produce, so the deposit holds twice the likely charge as headroom, rounded up to the next cent (${dep}); image prices are fixed.`;
}

const headroomStr = (h) => (h === 1.25 ? "1.25" : "2");
const REFUND_HOW = "returned automatically to the paying account after the run";

function structuredPricing(p, safety) {
  return {
    currency: "USD",
    estimatedCost: {
      usd: estUsd(p.estimatedCostUsd),
      fixedPrice: !!p.fixedPrice,
      items: (p.items || []).map((i) => ({
        nodeId: i.nodeId, node: i.node, type: i.type, model: i.model, basis: i.basis, usd: estUsd(i.usd), fixedPrice: !!i.fixedPrice,
      })),
    },
    serviceFee: { rate: String(SERVICE_FEE_RATE), appliesTo: "actual model cost", likelyUsd: estUsd(p.estimatedCostUsd * SERVICE_FEE_RATE) },
    likelyCharge: { usd: estUsd(p.likelyChargeUsd) },
    deposit: { usd: exactUsd(p.depositUsd), headroom: headroomStr(p.headroom), why: depositWhySentence(p) },
    refund: { likelyUsd: estUsd(Math.max(0, p.depositUsd - p.likelyChargeUsd)), how: REFUND_HOW },
    summary: null, // filled by the caller with or without NEAR figures
    safety: { ok: !!(safety && safety.ok), refusals: ((safety && safety.refusals) || []).map((r) => ({ ...r })) },
    unpriced: (p.unpriced || []).map((u) => ({ nodeId: u.nodeId, node: u.node, type: u.type, model: u.model, reason: u.reason })),
  };
}

/** Optional rate fields (src/near/rates.mjs) carried after nearUsd/source/at. */
export const RATE_EXTRA_KEYS = Object.freeze(["xnoUsd", "xnoSource", "xnoAt", "xnoPerNear", "nearPerXno", "spreadBps", "effectiveNearUsd"]);

/** The optional rate fields present on a rate object (none for a NEAR/USD-only rate). */
export function rateExtras(rate) {
  const out = {};
  if (rate && typeof rate === "object") for (const k of RATE_EXTRA_KEYS) if (k in rate) out[k] = rate[k];
  return out;
}

const bpsPct = (bps) => {
  const b = Math.trunc(Number(bps));
  const frac = String(b % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${Math.trunc(b / 100)}.${frac}` : `${Math.trunc(b / 100)}`;
};

/**
 * The XNO/USD, swap-rate and margin part of the one rate line, "" when the
 * rate carries none of them. Starts with "; ".
 */
export function rateExtrasText(x) {
  if (!x) return "";
  const parts = [];
  if ("xnoUsd" in x) {
    parts.push(x.xnoUsd != null
      ? `1 XNO = $${x.xnoUsd} (${x.xnoSource}, ${x.xnoAt}), so 1 NEAR = ${x.xnoPerNear} XNO`
      : "XNO/USD unavailable");
  }
  if (x.spreadBps) parts.push(`swap margin ${bpsPct(x.spreadBps)}%: NEAR amounts use 1 NEAR = $${x.effectiveNearUsd}`);
  return parts.map((p) => `; ${p}`).join("");
}

const itemLine = (i) => `- ${i.node} (${i.model}): $${estUsd(i.usd)} — ${i.basis}`;

function pricingLines(p, near) {
  const lines = ["Estimated cost:"];
  if (p.items.length) for (const i of p.items) lines.push(itemLine(i));
  else lines.push("- no paid model steps");
  lines.push(`Total estimated cost: $${estUsd(p.estimatedCostUsd)}`);
  lines.push(`Service fee: 20% of the actual model cost (likely $${estUsd(p.estimatedCostUsd * SERVICE_FEE_RATE)})`);
  lines.push(`Likely charge: $${estUsd(p.likelyChargeUsd)}${near ? ` (${near.likelyChargeNear} NEAR)` : ""} (estimated cost + 20% service fee)`);
  if (near && !near.depositApprox) {
    const dust = near.dustNear ? `: the $${exactUsd(p.depositUsd)} deposit plus ${near.dustNear} NEAR that makes the amount unique and comes back with the refund` : "";
    lines.push(`Deposit: ${near.depositNear} NEAR (about $${near.depositUsdSent} at the locked rate${dust}); the most you can be charged`);
  } else if (near) {
    lines.push(`Deposit: $${exactUsd(p.depositUsd)} (about ${near.depositNear} NEAR before the quote's unique dust); the most you can be charged`);
  } else {
    lines.push(`Deposit: $${exactUsd(p.depositUsd)}; the most you can be charged`);
  }
  lines.push(`Refund: the deposit minus what is actually charged, returned automatically (likely $${estUsd(Math.max(0, p.depositUsd - p.likelyChargeUsd))}${near && !near.depositApprox && near.dustNear ? " plus the dust" : ""})`);
  if (near) lines.push(`Rate: 1 NEAR = $${near.nearUsd} (${near.rateSource}, ${near.rateAt})${rateExtrasText(near.rateExtras)}, ${near.depositApprox ? "locked when you ask for a quote" : "locked for this quote"}; network ${near.network}`);
  return lines;
}

/**
 * Text + structured pricing for price_noodle (and the pricing half of a quote).
 * near (optional, strings): { network, nearUsd, rateSource, rateAt, likelyChargeNear, depositNear,
 *   rateExtras? (XNO/USD, swap rate, margin; see rateExtras) }
 */
export function pricingVocabulary(pricing, { near = null, safety = { ok: true, refusals: [] } } = {}) {
  const p = pricing;
  const summary = summarySentence(p, near);
  const sp = structuredPricing(p, safety);
  sp.summary = summary;
  const structured = { pricing: sp };
  if (near) {
    structured.near = {
      network: near.network,
      rate: { nearUsd: near.nearUsd, source: near.rateSource, at: near.rateAt, ...(near.rateExtras || {}) },
      likelyChargeNear: near.likelyChargeNear,
      depositNear: near.depositNear,
      ...(near.depositApprox ? { depositNearIsApproximate: true } : {}),
    };
  }
  const refusals = (safety && safety.refusals) || [];
  const lines = [];
  if (safety && safety.ok === false) {
    lines.push(`This workflow cannot run on this server as written: ${refusals.length} problem${refusals.length === 1 ? "" : "s"}, listed at the end. The figures below are what it would cost once fixed.`);
  }
  lines.push(summary, depositWhySentence(p), "", ...pricingLines(p, near));
  if (refusals.length) {
    lines.push("", "Problems to fix before this can run:");
    for (const r of refusals) lines.push(`- ${r.message}`);
  }
  return { text: lines.join("\n"), structured };
}

/**
 * The payment-required answer.
 * payment (strings): { network, paymentId, payTo, amountYocto, amountNear, depositUsd, likelyChargeNear, rate:{nearUsd,source,at}, expiresAt }
 */
export function formatQuote({ pricing, payment, now = Date.now() }) {
  const pay = payment || {};
  const rate = pay.rate || {};
  const near = {
    network: pay.network, nearUsd: rate.nearUsd, rateSource: rate.source, rateAt: rate.at, rateExtras: rateExtras(rate),
    likelyChargeNear: pay.likelyChargeNear, depositNear: pay.amountNear,
    depositUsdSent: pay.depositUsdSent, dustNear: pay.dustNear,
  };
  const voc = pricingVocabulary(pricing, { near });
  const next = `Send exactly ${pay.amountNear} NEAR (${pay.amountYocto} yoctoNEAR) to ${pay.payTo} on ${pay.network} in ONE transfer, then call this tool again with the same arguments plus _payment_id, _payment_tx and _payment_sender.`;
  const left = Date.parse(pay.expiresAt) - now;
  const mins = Number.isFinite(left) && left > 0 ? Math.max(1, Math.round(left / 60000)) : 30;
  const lines = [
    `PAYMENT REQUIRED (NEAR ${pay.network}) — ${summarySentence(pricing, near)}`,
    "",
    `Send exactly ${pay.amountNear} NEAR (${pay.amountYocto} yoctoNEAR) to ${pay.payTo} on ${pay.network}: one transfer, no other actions.`,
    `Then call this tool again with the same arguments plus _payment_id: "${pay.paymentId}", _payment_tx: <your transaction hash> and _payment_sender: <the account you paid from>.`,
    `The payment id is a secret; do not share it. The quote expires in about ${mins} minute${mins === 1 ? "" : "s"} (${pay.expiresAt}).`,
    `If the run fails, the whole deposit is refunded.`,
    "",
    depositWhySentence(pricing),
    "",
    ...pricingLines(pricing, near),
  ];
  return {
    text: lines.join("\n"),
    structured: { pricing: voc.structured.pricing, payment: { rail: "near", status: "payment_required", ...pay, next } },
  };
}

function refundStatusText(refund, paymentId) {
  const r = refund || {};
  const link = r.explorerUrl ? `, ${r.explorerUrl}` : "";
  switch (r.status) {
    case "sent": return `sent (tx ${r.txHash}${link})`;
    case "pending": return `pending, queued for retry${r.txHash ? ` (tx ${r.txHash}${link})` : ""}`;
    case "none": return "none (nothing to return, or below the 0.00001 NEAR minimum refund)";
    case "failed_permanent": return `could not be sent; contact the operator with payment id ${paymentId}`;
    default: return String(r.status || "unknown");
  }
}

/**
 * A NEAR amount for reading: at most six decimals, marked "≈" when rounded.
 * The exact yocto amount stays in the structured receipt.
 */
export function shortNear(near) {
  const s = String(near ?? "0");
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m || m[2].length <= 6) return s;
  let r = Number(s).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (r === "0") r = "0.000001";
  return `≈${r}`;
}

/** Receipt text + the receipt object, for every outcome. */
export function formatReceipt(receipt) {
  const r = receipt || {};
  const dep = r.deposit || {}, ref = r.refund || {}, ch = r.charged || {}, cost = r.actualCost || {}, rate = r.rate || {};
  const paid = `Paid ${shortNear(dep.near)} NEAR deposit (tx ${dep.txHash}${dep.explorerUrl ? `, ${dep.explorerUrl}` : ""}).`;
  const refundLine = `Refund ${shortNear(ref.near)} NEAR to ${ref.to}: ${refundStatusText(ref, r.paymentId)}.`;
  const rateLine = `Rate ${rate.nearUsd} USD/NEAR (${rate.source}, ${rate.at})${rateExtrasText(rateExtras(rate))}, locked when quoted.`;
  const costKnown = knownUsd(cost.usd) != null;
  let body;
  switch (r.outcome) {
    case "succeeded":
      if (!costKnown) {
        body = `${paid} The model reported no cost for this run, so nothing was charged (${shortNear(ch.near ?? "0")} NEAR). ${refundLine}`;
      } else if (cost.billedAs === "estimate") {
        const rep = knownUsd(cost.reportedUsd) != null ? `only $${cost.reportedUsd}` : "no cost";
        body = `${paid} The provider reported ${rep} for this run, so you are charged the estimated cost $${cost.usd} + 20% service fee = $${ch.usd} (${shortNear(ch.near)} NEAR). ${refundLine}`;
      } else {
        const capped = ch.capped ? ", capped at the deposit" : "";
        body = `${paid} Actual model cost $${cost.usd} + 20% service fee = $${ch.usd} (${shortNear(ch.near)} NEAR) charged${capped}. ${refundLine}`;
      }
      break;
    case "run_failed":
      body = `${paid} The run failed, so nothing was charged and the whole deposit is refunded. ${refundLine}`;
      break;
    case "interrupted":
      body = `${paid} The server restarted during the run, so nothing was charged and the whole deposit is refunded. The run was not repeated. ${refundLine}`;
      break;
    case "wrong_amount":
      body = `Received ${shortNear(dep.near)} NEAR (tx ${dep.txHash}), which is not the quoted amount, so nothing ran and nothing was charged. Everything you sent is refunded. ${refundLine} Ask for a new quote and send its exact amount.`;
      break;
    case "late_payment":
      body = `Received ${shortNear(dep.near)} NEAR (tx ${dep.txHash}) after the quote expired, so nothing ran and nothing was charged. Everything you sent is refunded. ${refundLine} Ask for a new quote.`;
      break;
    default:
      body = `${paid} Outcome: ${r.outcome}. Charged ${shortNear(ch.near ?? "0")} NEAR. ${refundLine}`;
  }
  const legs = Array.isArray(r.legs) ? legLines(r.legs, r.paymentId) : [];
  return { text: [`${body} ${rateLine}`, ...legs].join("\n"), structured: { receipt: r } };
}

/** The receipt's three money legs as three short lines (r.legs from the NEAR gate). */
function legLines(legs, paymentId) {
  const [caller, model, refund] = legs;
  const out = [];
  if (caller) {
    out.push(caller.status === "final"
      ? `Leg 1, caller payment: ${shortNear(caller.amount)} NEAR, tx ${caller.txHash}, final.`
      : `Leg 1, caller payment: none.`);
  }
  if (model) {
    let t;
    if (model.status === "none") t = "none (nothing ran)";
    else if (model.status === "unknown") t = `unknown (${model.basis})`;
    else t = `$${model.usd}${model.xno != null ? ` = ${model.xno} XNO` : ""} (${model.basis})`;
    out.push(`Leg 2, model payment to NanoGPT: ${t}.`);
  }
  if (refund) {
    out.push(`Leg 3, refund: ${shortNear(refund.amount)} NEAR, ${refundStatusText(refund, paymentId)}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authoring guide
// ---------------------------------------------------------------------------

const KEY_FIELDS = {
  llm: ["model", "system", "prompt", "maxTokens"],
  decide: ["model", "mode", "question", "options", "levels"],
  image: ["model", "prompt", "size", "variations"], edit: ["model", "prompt", "size"],
  tvideo: ["model", "prompt", "duration", "resolution", "aspect"], ivideo: ["model", "prompt", "duration", "resolution", "aspect"],
  music: ["model", "prompt", "duration"], tts: ["model", "prompt", "voice"],
  model3d: ["model", "prompt"], text: ["text"], choice: ["options", "selected"], join: ["sep"], comment: ["text"],
};

/**
 * Per allowed type: the text ports a wire can feed (a wire replaces that
 * field), the media ports, and what to set in fields. One line each in the guide.
 */
const GUIDE_PORTS = {
  text: { text: [], fields: "text (leave it empty to make it a caller input named after the node)" },
  choice: { text: [], fields: "options (one per line), selected" },
  join: { text: ["a", "b"], fields: "sep (separator, default a space)" },
  comment: { text: [], fields: "text (a note; does nothing)" },
  llm: { text: ["prompt", "system"], media: "img1, img2, ... (images, for a model that can see them)", fields: `model (a chat model), maxTokens (output limit; default ${DEFAULT_CHAT_OUTPUT_TOKENS})` },
  decide: { text: ["text", "question"], media: "img1, img2, ... (candidate images)", fields: "model (a chat model that supports decisions), mode (pick, choose, score or yesno), question, options (choose), levels (score)" },
  image: { text: ["prompt"], fields: "model (an image model), size, variations" },
  edit: { text: ["prompt"], media: "image, image2, ... (source images)", fields: "model (an image model), size" },
  tvideo: { text: ["prompt"], media: "ref1, ref2, ... (reference images)", fields: "model (a video model), duration (seconds; default: the model's), resolution, aspect" },
  ivideo: { text: ["prompt"], media: "image (first frame), endframe (last frame)", fields: "model (a video model), duration (seconds; default: the model's), resolution, aspect" },
  music: { text: ["prompt"], fields: "model (an audio model), duration (seconds)" },
  tts: { text: ["prompt"], fields: "model (an audio model), voice" },
  model3d: { text: ["prompt"], media: "image", fields: "model (a model3d model; default tripo3d/v2.5)" },
};

const MODEL_KINDS_LINE = "Model kinds: chat -> llm, decide; image -> image, edit; video -> tvideo, ivideo; audio -> music, tts; model3d -> model3d.";

const WIRING_RULES = [
  "A wire into a text port (prompt, system, a join's a/b, a decide's text) replaces that field at run time. An unwired prompt, or a text node's text, becomes a caller input keyed by the node's name.",
  "A link may feed a media port (image, endframe, or a numbered img*, image*, ref* port) only from a media output (image, video, audio, model3d) of an allowed NanoGPT node, and a media output may feed only a media port.",
  "No link may target a pricing or URL field: model, size, variations, duration, resolution, maxTokens, modelOpts, loraUrl, loras, url, image, mask, audio, video. Set those in the node's fields.",
  "No node field may hold a value starting with http:, https:, data:, file: or blob:. The exception is a LoRA URL on tvideo or ivideo, which must be https:.",
  `fields.modelOpts and fields.extraJson are refused. maxTokens must be a whole number (an llm without one is limited to ${DEFAULT_CHAT_OUTPUT_TOKENS} output tokens, the most it is priced for). duration must be a number of seconds.`,
  "Every paid node must use a model the NanoGPT catalog can price; models whose catalog price is set by a live quote at run time are refused. Each refusal names the node and the model.",
  "Chat steps are priced at their maxTokens and at the longest text that can reach them (inputs, joins, upstream LLM output at its maxTokens), so a lower maxTokens lowers the deposit.",
  "A url argument must be a full share link that carries its #g=, #j= or #a= fragment; short links are refused.",
];

const EXAMPLE_GRAPH = Object.freeze({
  v: 1,
  nodes: [
    { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
    { id: "n2", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write one vivid image prompt for the idea. Reply with the prompt only." } },
    { id: "n3", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024" } },
  ],
  links: [
    { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
    { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "prompt" } },
  ],
});

const KINDS = ["chat", "image", "video", "audio", "model3d"];

function smallestNumber(o) {
  let best = null;
  (function walk(v) {
    if (typeof v === "number") { if (v > 0 && (best == null || v < best)) best = v; return; }
    if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k]);
  })(o);
  return best;
}

function modelSummary(kind, m) {
  const p = (m && m.pricing) || {};
  if (kind === "chat") {
    const pin = num(p.prompt), pout = num(p.completion);
    if (pin == null && pout == null) return { sort: null, unitPrice: "price varies (not quotable)" };
    return { sort: (pin || 0) + (pout || 0), unitPrice: `$${pin ?? 0} in / $${pout ?? 0} out per 1M tokens` };
  }
  if (kind === "image") {
    const per = p.per_image && typeof p.per_image === "object" ? p.per_image : {};
    let best = null;
    for (const [size, v] of Object.entries(per)) { const x = num(v); if (x != null && (best == null || x < best.x)) best = { size, x }; }
    if (best) return { sort: best.x, unitPrice: `$${best.x} per image (size ${best.size})` };
  }
  let json = JSON.stringify(p);
  if (json.length > 120) json = json.slice(0, 117) + "...";
  return { sort: smallestNumber(p), unitPrice: json };
}

/** How to write a graph this server will run, plus priced models. */
export function authoringGuide({ catalogs = {}, kind = null, search = null, limit = 20 } = {}) {
  const nodeTypes = Object.keys(NODE_TYPES).map((type) => {
    const t = NODE_TYPES[type], pol = NODE_POLICY[type] || { allowed: false, why: "Not on this server's allowlist." };
    const gp = pol.allowed ? GUIDE_PORTS[type] || { text: [] } : null;
    return {
      type, title: t.title, allowed: pol.allowed, why: pol.why,
      inputs: [...(t.inputs || [])],
      textPorts: gp ? [...gp.text] : [],
      mediaPorts: gp && gp.media ? gp.media : null,
      outputs: (t.outputs || []).map((o) => ({ name: o.name, type: o.type })),
      keyFields: pol.allowed ? [...(KEY_FIELDS[type] || [])] : [],
      ...(gp ? { fields: gp.fields } : {}),
    };
  });

  const cap = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 20));
  const kinds = kind ? [kind] : KINDS;
  const q = search ? String(search).toLowerCase() : null;
  const pool = [];
  for (const k of kinds) {
    for (const m of (catalogs && Array.isArray(catalogs[k]) ? catalogs[k] : [])) {
      if (!m || m.id == null) continue;
      const id = String(m.id);
      if (q && !id.toLowerCase().includes(q)) continue;
      const s = modelSummary(k, m);
      pool.push({ kind: k, id, unitPrice: s.unitPrice, _sort: s.sort });
    }
  }
  pool.sort((a, b) => (a._sort == null) - (b._sort == null) || (a._sort ?? 0) - (b._sort ?? 0) || a.id.localeCompare(b.id));
  const models = pool.slice(0, cap).map(({ kind: k, id, unitPrice }) => ({ kind: k, id, unitPrice }));

  const allowed = nodeTypes.filter((t) => t.allowed), refused = nodeTypes.filter((t) => !t.allowed);
  const lines = [
    "How to write a nanoodle workflow graph for this server.",
    "",
    'A graph is { "nodes": [{ "id", "type", "name"?, "fields": {...} }], "links": [{ "from": { "node", "port" }, "to": { "node", "port" } }] }. Pass it as "graph" with "inputs" (strings keyed by input name).',
    "",
    "Allowed node types:",
    ...allowed.map((t) => [
      `- ${t.type} (${t.title}):`,
      t.textPorts.length ? ` wire text into [${t.textPorts.join(", ")}];` : "",
      t.mediaPorts ? ` media inputs [${t.mediaPorts}];` : "",
      ` outputs [${t.outputs.map((o) => `${o.name}:${o.type}`).join(", ")}];`,
      ` fields: ${t.fields}`,
    ].join("")),
    MODEL_KINDS_LINE,
    "",
    `Refused node types: ${refused.map((t) => t.type).join(", ")}. A refusal names the node, the reason and what to use instead.`,
    "",
    "Wiring and field rules:",
    ...WIRING_RULES.map((r) => `- ${r}`),
    "",
    "Example (text -> llm -> image; input \"Idea\"):",
    JSON.stringify(EXAMPLE_GRAPH),
    "",
    `Priced models${kind ? ` (${kind})` : ""}${q ? ` matching "${search}"` : ""}, cheapest first:`,
    ...(models.length ? models.map((m) => `- ${m.kind} ${m.id}: ${m.unitPrice}`) : ["- none matched (the catalog may be unavailable, or try another search)"]),
    "",
    "Check a design for free with price_noodle (same graph and inputs as run_noodle): it returns the itemized price and every problem, without creating a quote.",
  ];
  return {
    text: lines.join("\n"),
    structured: { nodeTypes, wiringRules: [...WIRING_RULES], example: structuredClone(EXAMPLE_GRAPH), models },
  };
}
