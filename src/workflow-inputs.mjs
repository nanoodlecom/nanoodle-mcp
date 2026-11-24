const MAX_SCHEMA_KEY_LENGTH = 64;

/** Clamp a friendly name to the property-key charset MCP clients enforce. */
function schemaKey(key) {
  return key.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, MAX_SCHEMA_KEY_LENGTH) || "input";
}

/** Read author-marked optional inputs even with older SDKs (< 0.6.0). */
function authorOptional(wf, inp) {
  const node = wf.graph?.nodes?.find((n) => n.id === inp.nodeId);
  const value = node?.fields?.optional;
  return value === true || value === "true";
}

/** Pair each derived input with a schema-safe alias that cannot shadow another input. */
export function keyedInputs(wf, { exactAliases = false } = {}) {
  // Creator-hosted tools match their published keys exactly, then pass the
  // corresponding native key to the general resolver. Preserve those aliases.
  const normalize = exactAliases ? (key) => key : (key) => key.toLowerCase();
  const nativeKeys = new Set(exactAliases ? [] : wf.inputs.map(({ key }) => normalize(key)));
  const used = new Set();
  return wf.inputs.map((inp) => {
    const nativeKey = normalize(inp.key);
    const base = schemaKey(inp.key);
    let safe = base;
    let alias = normalize(safe);
    for (let count = 2; used.has(alias) || (alias !== nativeKey && nativeKeys.has(alias)); count++) {
      const suffix = `_${count}`;
      safe = base.slice(0, MAX_SCHEMA_KEY_LENGTH - Math.max(3, suffix.length)) + suffix;
      alias = normalize(safe);
    }
    used.add(alias);
    return {
      inp, safe,
      optional: !!inp.optional || authorOptional(wf, inp),
      hasDef: inp.def != null && String(inp.def) !== "",
    };
  });
}

/** Bind caller arguments for execution and pricing with the same aliases and precedence. */
export function matchInputs(keyed, args) {
  const aliases = new Map();
  for (const entry of keyed) {
    aliases.set(entry.safe.toLowerCase(), entry);
    aliases.set(entry.inp.key.toLowerCase(), entry);
  }
  const assignments = new Map();
  const unknown = [];
  const duplicates = new Set();
  for (const [key, value] of Object.entries(args || {})) {
    const entry = aliases.get(key.trim().toLowerCase());
    if (!entry) {
      unknown.push(key);
    } else if (duplicates.has(entry) || (assignments.has(entry) && assignments.get(entry).value !== value)) {
      // Two spellings for the same input must not select different values based on argument order.
      duplicates.add(entry);
      assignments.delete(entry);
    } else {
      assignments.set(entry, { key, value });
    }
  }
  const missing = keyed.filter((entry) => !entry.optional && !entry.hasDef && !assignments.has(entry) && !duplicates.has(entry));
  return { assignments, unknown, duplicates: [...duplicates], missing };
}
