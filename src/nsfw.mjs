/**
 * Opt-in NSFW mode.
 *
 * Off for every caller and every tool. A spicy or uncensored model runs only
 * when the caller sets `nsfw: true` on that call, or opts the session in with
 * the same flag on `initialize`. Prompt text, model ids, and any other field
 * never turn it on — choosing a spicy model does not enable the mode; while
 * the mode is off that model is replaced with its non-spicy variant, or the
 * call is refused before any money is spent.
 *
 * The flag is exactly the property name `nsfw`. Boolean true and the string
 * "true" enable it. Boolean false and the string "false" keep it off and
 * override a session opt-in for that call. Every other value ("yes", "1",
 * "on", "spicy", "True") is not an opt-in.
 */

/** Sentence appended to every tool description so a caller sees the default. */
export const NSFW_OPT_IN_NOTE =
  "NSFW mode is off unless this call sets nsfw to true. Spicy and uncensored model variants run only then; prompt text never turns it on.";

/** initialize.instructions — same contract, for clients that surface server guidance. */
export const NSFW_INSTRUCTIONS =
  "NSFW mode is off for every caller and every tool. It turns on only when a tools/call sets nsfw to true, " +
  "or when this session opted in by initialize with nsfw: true (a stdio session, or an HTTP client that sends " +
  "the same Mcp-Session-Id on later calls). Prompt wording, model choice, and any other field never turn it on. " +
  "While it is off, spicy and uncensored model variants are replaced with the non-spicy variant when one exists, " +
  "safety filtering stays on, and a spicy model with no safe variant is refused before any money is spent. " +
  "While it is on, the graph's spicy or uncensored models run as authored; a safe model is not upgraded to a spicy one.";

/** JSON Schema property added to every tool, including run_noodle. Not a workflow input. */
export const NSFW_PROPERTY = {
  type: "boolean",
  default: false,
  description:
    "Opt-in NSFW mode. Default false for every caller. Set to true only when this call should allow spicy or uncensored model variants. " +
    "The string \"true\" also counts; \"false\" forces it off for this call. Any other value (yes, 1, on, spicy, True) leaves it off. " +
    "Prompt text, model ids, and every other argument never enable it. " +
    "When false, non-spicy model variants are used, safety checkers stay on, and a spicy model with no safe variant is refused before any money is spent.",
};

/** Lines for /llms.txt. Agents read this before they call. */
export function nsfwLlmsLines() {
  return [
    `## NSFW mode`,
    ``,
    `- Off by default for every caller and every tool. Prompt text, model ids, and any other field never turn it on.`,
    `- Opt in per call with nsfw: true (boolean, or the string "true") on tools/call. nsfw: false forces that call off.`,
    `- Opt in per session with initialize params nsfw: true. On HTTP that applies only to later calls carrying the same Mcp-Session-Id. Stdio is one caller, so initialize opts in that process.`,
    `- While off, a spicy/nsfw/uncensored model id is replaced with its non-spicy variant when one exists (the spicy token is removed; minimax-h3/image-to-video-spicy runs as minimax-h3-singularity/image-to-video). Safety checkers the graph turned off are turned back on. A spicy model with no safe variant is refused before any money is spent.`,
    `- While on, those models run as the graph authored them. A safe model is not switched to a spicy one.`,
    ``,
  ];
}

/**
 * Explicit opt-in / opt-out. null means "not a flag value" — never treated as on.
 * @param {unknown} value
 * @returns {true|false|null}
 */
export function explicitNsfwFlag(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * Arguments the run should see, with the NSFW flag normalized.
 * Unrecognized `nsfw` values are dropped so they cannot enable the mode and
 * are not forwarded as a workflow input. An explicit false is kept so a paid
 * quote stays bound to that choice. Session opt-in materializes `nsfw: true`
 * when the call itself did not set the flag.
 *
 * @param {object} args tool arguments (the `nsfw` key is reserved)
 * @param {boolean} [sessionNsfw] true only after an explicit session opt-in
 * @param {unknown} [paramsNsfw] tools/call params.nsfw, when that key was sent
 */
export function bindNsfwArgs(args, sessionNsfw = false, paramsNsfw) {
  const src = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const fromArgs = Object.prototype.hasOwnProperty.call(src, "nsfw") ? explicitNsfwFlag(src.nsfw) : null;
  const fromParams = paramsNsfw === undefined ? null : explicitNsfwFlag(paramsNsfw);
  // arguments.nsfw wins when it is an explicit true or false. Anything else is not a flag.
  const explicit = fromArgs !== null ? fromArgs : fromParams;
  const on = explicit !== null ? explicit : sessionNsfw === true;
  const rest = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "nsfw") continue;
    rest[k] = v;
  }
  if (on) return { ...rest, nsfw: true };
  if (explicit === false) return { ...rest, nsfw: false };
  return rest;
}

/** Workflow inputs, with the reserved flag removed. */
export function graphArguments(bound) {
  if (!bound || typeof bound !== "object" || Array.isArray(bound)) return {};
  const rest = {};
  for (const [k, v] of Object.entries(bound)) {
    if (k === "nsfw") continue;
    rest[k] = v;
  }
  return rest;
}

/**
 * Whether this call may use spicy/uncensored models.
 * Reads only `arguments.nsfw`, `params.nsfw`, and an already-explicit session latch.
 */
export function effectiveNsfw(params, ctx) {
  const args = params && params.arguments;
  const paramsNsfw = params && typeof params === "object" && !Array.isArray(params) &&
    Object.prototype.hasOwnProperty.call(params, "nsfw")
    ? params.nsfw
    : undefined;
  const bound = bindNsfwArgs(
    args && typeof args === "object" && !Array.isArray(args) ? args : {},
    !!(ctx && ctx.sessionNsfw === true),
    paramsNsfw,
  );
  return bound.nsfw === true;
}

/** spicy / nsfw / uncensored as its own token. "sfwnsfw" is caught separately. */
const SPICY_TOKEN_SRC = "(^|[^a-z0-9])(?:spicy|nsfw|uncensored)(?=[^a-z0-9]|$)";

function spicyTokenRe() {
  return new RegExp(SPICY_TOKEN_SRC, "gi");
}

/**
 * A model id is a spicy/uncensored variant when it carries spicy, nsfw, or
 * uncensored as its own token, or the letters nsfw glued into a longer token
 * (aniflatmix-anime-sfwnsfw). Display names are not consulted. A model that is
 * merely marked nsfw-capable in a catalog is not rewritten — that flag covers
 * ordinary models this server already runs.
 */
export function isSpicyModel(model) {
  const id = String(model ?? "").trim();
  if (!id) return false;
  if (spicyTokenRe().test(id)) return true;
  return /nsfw/i.test(id);
}

/**
 * Pairs whose non-spicy id is not what you get by deleting the token.
 * minimax-h3/image-to-video does not exist; the non-spicy image-to-video
 * sibling is MiniMax H3 Singularity (capabilities.nsfw false).
 */
const SAFE_VARIANTS = Object.freeze({
  "minimax-h3/image-to-video-spicy": "minimax-h3-singularity/image-to-video",
});

/**
 * Non-spicy id for a spicy model, or null when stripping the token does not
 * leave a different id. Does not consult prompt text. Returns null for a
 * model that is not spicy.
 */
export function safeModelVariant(model) {
  const id = String(model ?? "").trim();
  if (!id || !isSpicyModel(id)) return null;
  const mapped = SAFE_VARIANTS[id] || SAFE_VARIANTS[id.toLowerCase()];
  if (mapped) return mapped;
  const key = Object.keys(SAFE_VARIANTS).find((k) => k.toLowerCase() === id.toLowerCase());
  if (key) return SAFE_VARIANTS[key];
  let next = id.replace(spicyTokenRe(), "");
  next = next.replace(/[-/]{2,}/g, (s) => (s.includes("/") ? "/" : "-"));
  next = next.replace(/\/-|-\//g, "/");
  next = next.replace(/^[-/:]+|[-/:]+$/g, "");
  if (!next || next.toLowerCase() === id.toLowerCase()) return null;
  return next;
}

/** Model id the default (NSFW off) run sends. Spicy ids with no sibling stay put and the call is refused. */
export function modelUsedWhenNsfwOff(model) {
  const id = String(model ?? "").trim();
  if (!id || !isSpicyModel(id)) return id;
  return safeModelVariant(id) || id;
}

function isExplicitFalse(v) {
  return v === false || v === "false" || v === 0 || v === "0";
}
function isExplicitTrue(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Put safety switches back to the safe value. Only keys the graph actually
 * set are touched — a checker is not invented on models that don't have one.
 * Returns a new object when something changed.
 */
function restoreSafetyOpts(opts) {
  const next = { ...opts };
  let changed = false;
  for (const key of ["enable_safety_checker", "safety_checker"]) {
    if (Object.prototype.hasOwnProperty.call(next, key) && isExplicitFalse(next[key])) {
      next[key] = true;
      changed = true;
    }
  }
  for (const key of ["disable_safety_checker", "disable_safety", "allow_nsfw", "uncensored"]) {
    if (Object.prototype.hasOwnProperty.call(next, key) && isExplicitTrue(next[key])) {
      next[key] = false;
      changed = true;
    }
  }
  // modelOpts.nsfw is a provider switch, not this server's flag.
  if (Object.prototype.hasOwnProperty.call(next, "nsfw") && isExplicitTrue(next.nsfw)) {
    next.nsfw = false;
    changed = true;
  }
  return { opts: changed ? next : opts, changed };
}

function nodeLabel(n) {
  return (n && (n.name || (n.fields && n.fields.name))) || (n && n.id) || "node";
}

/**
 * Apply the mode to a graph. The input graph is never mutated.
 * When nsfw is on, the graph is returned as-is (spicy models stay; safe models
 * are not upgraded) plus a notice when a spicy model will actually run.
 * When nsfw is off, spicy models are swapped for the non-spicy variant and
 * safety switches the graph turned off are restored. `blocked` lists spicy
 * models with no safe variant — the caller refuses the run before any spend.
 *
 * @param {object} graph
 * @param {{ nsfw?: boolean }} [opts]
 */
export function applyNsfwPolicy(graph, { nsfw = false } = {}) {
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const on = nsfw === true;
  if (on) {
    const spicy = [];
    for (const n of nodes) {
      const model = n && n.fields && n.fields.model;
      if (typeof model === "string" && isSpicyModel(model)) {
        spicy.push(`"${nodeLabel(n)}" uses ${String(model).trim()}`);
      }
    }
    const notices = spicy.length
      ? [`note: NSFW mode is on for this call (nsfw: true). Spicy/uncensored model variants are allowed: ${spicy.join("; ")}.`]
      : [];
    return { graph, notices, blocked: [], changed: false };
  }

  const blocked = [];
  const notices = [];
  let changed = false;
  const next = structuredClone(graph);
  for (const n of (next && next.nodes) || []) {
    if (!n || !n.fields) continue;
    const model = n.fields.model;
    if (typeof model === "string" && isSpicyModel(model)) {
      const safe = safeModelVariant(model);
      const label = nodeLabel(n);
      if (!safe) {
        blocked.push({ nodeId: n.id, name: label, model: String(model).trim() });
      } else {
        n.fields.model = safe;
        changed = true;
        notices.push(
          `note: NSFW mode is off, so "${label}" ran ${safe} instead of ${String(model).trim()}. ` +
          `Pass nsfw: true to use the spicy/uncensored variant.`);
      }
    }
    const opts = n.fields.modelOpts;
    if (opts && typeof opts === "object" && !Array.isArray(opts)) {
      const restored = restoreSafetyOpts(opts);
      if (restored.changed) {
        n.fields.modelOpts = restored.opts;
        changed = true;
        notices.push(`note: NSFW mode is off, so safety filtering on "${nodeLabel(n)}" stays on.`);
      }
    }
  }
  return { graph: changed ? next : graph, notices, blocked, changed };
}

/** ParamsError message when NSFW is off and a spicy model has no safe variant. */
export function spicyBlockedMessage(label, blocked) {
  const list = blocked.map((b) => `"${b.name}" (${b.model})`).join(", ");
  const plural = blocked.length > 1;
  return `${label} uses spicy/uncensored model ${plural ? "variants" : "variant"} ${list}, and NSFW mode is off. ` +
    `No non-spicy variant is available to substitute, so this call was refused before any money was spent. ` +
    `Pass nsfw: true to run ${plural ? "those models" : "that model"} as authored. Prompt text does not enable NSFW mode.`;
}
