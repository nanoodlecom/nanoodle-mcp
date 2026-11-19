import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Workflow } from "nanoodle";
import { assertCreatorGraph } from "./creator-format.mjs";
import { DEFAULT_LIMITS, GraphArgsError, GraphRefusedError, checkGraphSafety } from "./custom-workflow.mjs";
import { writePrivateStateSync, syncPrivateStateParentSync } from "./private-state.mjs";
import { computePrice, keyedInputs, ParamsError } from "./tools.mjs";

export const CUSTOM_MCP = "/custom-mcp";
export const PROFILE_ID_SOURCE = "cm_[a-f0-9]{32}";
const PROFILE_ID = new RegExp("^" + PROFILE_ID_SOURCE + "$");
const OWNER = /^nmo_[a-f0-9]{64}$/;
const CLIENT = /^nmc_[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
// Keep the name reserved after #240 removed the hosted tool. An older
// profile can still carry it as a selection or a private workflow alias.
const RETIRED_TOOL = "subnano_comment";
const RESERVED = new Set(["run_noodle", "price_noodle", "run_workflow", "price_workflow", "custom_workflow", RETIRED_TOOL]);
const WORKFLOW_LIMIT = 8;
// An opaque revision also prevents a stale tab from editing a profile that was
// deleted and later recreated using the same recovery key.
const newRevision = () => randomInt(1, 2 ** 48 - 1);
export const PROFILE_BODY_LIMIT = 512 * 1024;

const digest = value => createHash("sha256").update(value).digest("hex");
const matches = (hash, secret) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
  && timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(digest(secret), "hex"));
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const reject = message => { throw new ParamsError(message); };
const hasExternalUrl = value => typeof value === "string" ? /^\s*(?:https?:|ftp:|file:|data:|\/\/)/i.test(value)
  : value && typeof value === "object" && Object.values(value).some(hasExternalUrl);

function describeGraph(graph) {
  const wf = new Workflow(graph, { quiet: true });
  const inputs = keyedInputs(wf);
  const properties = Object.create(null), required = [], keys = new Set();
  for (const { safe, inp, hasDef, optional } of inputs) {
    const aliases = new Set([inp.key.trim().toLowerCase(), safe.toLowerCase()]);
    if (!["textarea", "choice"].includes(inp.kind)
      || [...aliases].some(key => keys.has(key) || ["prototype", "__proto__", "constructor"].includes(key))) {
      reject("Use distinct, supported Text or Choice input names.");
    }
    for (const alias of aliases) keys.add(alias);
    properties[safe] = { type: "string", maxLength: DEFAULT_LIMITS.maxInputChars,
      ...(inp.options ? { enum: inp.options.map(String) } : {}) };
    if (!hasDef && !optional) required.push(safe);
  }
  if (inputs.length > DEFAULT_LIMITS.maxInputKeys) reject("The workflow has too many inputs.");
  // Describe the interface without revealing any saved text defaults.
  return { inputs, schema: { type: "object", properties, required, additionalProperties: false } };
}

function canonicalGraph(value) {
  // Stay within the bounded nesting expected by graph normalization and its
  // recursive safety and pricing walkers.
  const stack = [[value, 0]];
  while (stack.length) {
    const [entry, depth] = stack.pop();
    if (depth > 25) reject("The workflow JSON is nested too deeply.");
    if (!entry || typeof entry !== "object") continue;
    for (const [key, child] of Object.entries(entry)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) reject("The workflow JSON contains a reserved property.");
      stack.push([child, depth + 1]);
    }
  }
  try { assertCreatorGraph(value); } catch (error) { reject(error.message.replace(/Creators runs/, "Custom MCP runs")); }
  const check = checkGraphSafety(value);
  if (!check.ok) reject(check.refusals.map(r => r.message).join("\n"));
  // Keep only the executable graph. This private flow never accepts editor
  // credentials, creator payouts, price pins, share links, or external assets.
  const { nodes, links } = check.workflowGraph;
  if (nodes.some(n => hasExternalUrl(n.fields))) reject("Remove external URLs and inline media from the workflow.");
  return { nodes, links };
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

export function createCustomMcpStore({ dir, maxProfiles = 500 }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = new Set(readdirSync(dir).filter(name => name.endsWith(".json") && PROFILE_ID.test(name.slice(0, -5))));
  const active = new Map();
  let creationCredit = 16, lastRefill = Date.now();
  const read = id => {
    if (!PROFILE_ID.test(id)) return null;
    let profile;
    try { profile = JSON.parse(readFileSync(join(dir, id + ".json"), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
    if (profile.v !== 1 || profile.id !== id || !plain(profile.hosts)) throw new Error("Invalid Custom MCP state");
    return profile;
  };
  function owner(secret) {
    if (!OWNER.test(secret)) return null;
    const hash = digest(secret), id = "cm_" + hash.slice(0, 32);
    const profile = read(id);
    return !profile || matches(profile.ownerHash, secret) ? { hash, id, profile } : null;
  }
  function write(profile) {
    const name = profile.id + ".json", file = join(dir, name);
    if (!files.has(name) && files.size >= maxProfiles) {
      throw Object.assign(new Error("Custom MCP profile capacity is full. Try again later."), { status: 503 });
    }
    try { writePrivateStateSync(file, JSON.stringify(profile)); }
    catch (error) {
      if (error.code === "STATE_DURABILITY_UNCERTAIN") {
        files.add(name);
        syncPrivateStateParentSync(file);
      }
      throw error;
    }
    files.add(name);
  }
  return {
    owner, read, write,
    remove(id) {
      const name = id + ".json", file = join(dir, name);
      unlinkSync(file);
      files.delete(name);
      syncPrivateStateParentSync(file);
    },
    admitCreation() {
      const now = Date.now();
      creationCredit = Math.min(16, creationCredit + Math.max(0, now - lastRefill) / 7_500);
      lastRefill = now;
      if (creationCredit < 1) throw Object.assign(new Error("Too many new profiles. Try again shortly."), { status: 429 });
      creationCredit--;
    },
    run(scope, fn) {
      active.set(scope, (active.get(scope) || 0) + 1);
      return Promise.resolve().then(fn).finally(() => {
        const count = active.get(scope) - 1;
        if (count) active.set(scope, count);
        else active.delete(scope);
      });
    },
    busy: scope => active.has(scope),
  };
}

// Run strictly through the active host's existing payment wrappers. The Nano
// wrapper's internal name isn't registered on the public MCP endpoint.
export function wrapNanoCustomWorkflow({ gate, registry, baseUrl, fetch, limits }) {
  const name = "custom_workflow";
  const { callTool } = gate.wrapRegistry({
    tools: [],
    listTools: () => [{ name, description: "Private Nanoodle workflow", inputSchema: { type: "object" } }],
    async callTool({ arguments: args }, ctx) {
      const { pricing } = await checkedPrice(args, { baseUrl, fetch, limits });
      if (pricing.depositUsd > ctx.quoteUsd) throw new Error("The workflow no longer fits the quoted budget.");
      return registry.callTool({ name: "run_noodle", arguments: { graph: pricing.boundGraph, inputs: args.inputs } }, ctx);
    },
  }, {
    quoteCall: async ({ arguments: args }) => {
      const { pricing, read } = await checkedPrice(args, { baseUrl, fetch, limits });
      await registry.prepareRunNoodle(args, { read, allowShortLinks: false, requireFreshCatalogs: true });
      return pricing.depositUsd;
    },
  });
  return (args, ctx) => callTool({ name, arguments: args }, ctx);
}

async function checkedPrice(args, opts) {
  const result = await computePrice(args, { ...opts, allowShortLinks: false, requireFreshCatalogs: true });
  if (!result.safety.ok) throw new GraphRefusedError(result.safety.refusals);
  return result;
}

export function createCustomMcp({ store, key, listTools, callTool,
  nearTools, nanoWorkflow, hasOpenPayments = () => false, baseUrl, fetch, limits }) {
  const endpoint = id => CUSTOM_MCP + "/" + id + "/mcp";
  const catalog = () => listTools().filter(t => !RESERVED.has(t.name.toLowerCase()));
  const scope = id => digest(key + ":" + id);
  const hasPending = id => store.busy(scope(id)) || hasOpenPayments(scope(id));
  const settings = profile => profile?.hosts[key] ?? null;
  const view = (id, current) => ({
    id, endpoint: endpoint(id), revision: current?.revision ?? 0,
    builtins: current?.builtins ?? [], connected: !!current?.clientHash,
    workflows: (current?.workflows ?? []).map(({ name, description }) => ({ name, description })),
  });
  const publicCatalog = () => catalog().map(({ name, description }) => ({ name, description }));
  function available(current) {
    const builtins = new Set(current.builtins);
    const catalogNow = catalog();
    const selected = catalogNow.filter(t => builtins.has(t.name)).map(tool => ({ tool }));
    const reserved = new Set([...RESERVED, ...selected.map(({ tool }) => tool.name.toLowerCase())]);
    for (const workflow of current.workflows) {
      if (reserved.has(workflow.name.toLowerCase())) continue;
      const shape = describeGraph(workflow.graph);
      const payments = nearTools?.listTools().find(t => t.name === "run_noodle")?.inputSchema.properties;
      const rails = [...(nanoWorkflow ? ["nano"] : []), ...(nearTools?.assets ?? [])];
      const properties = { ...shape.schema.properties, _payment_id: { type: "string" },
        ...(payments?._payment_tx ? { _payment_tx: payments._payment_tx } : {}),
        ...(payments?._payment_sender ? { _payment_sender: payments._payment_sender } : {}),
        _pay_with: { type: "string", enum: rails } };
      selected.push({ workflow, shape, rails, tool: { name: workflow.name,
        description: (workflow.description ? workflow.description.replace(/[^.!?]$/, "$&.") + " " : "") + "Private workflow. Call for a payment quote, then resume with the same arguments and payment ID.",
        inputSchema: { ...shape.schema, properties } } });
    }
    return selected;
  }

  function management(secret) {
    const owned = store.owner(secret);
    if (!owned?.profile) return null;
    return view(owned.id, settings(owned.profile));
  }

  async function update(secret, body) {
    const owned = store.owner(secret);
    if (!owned) reject("Invalid recovery key.");
    const { id, hash } = owned;
    const existing = settings(owned.profile), revision = existing?.revision ?? 0;
    if (!plain(body) || !Number.isSafeInteger(body.revision) || !Array.isArray(body.builtins)
      || !Array.isArray(body.workflows) || body.workflows.length > WORKFLOW_LIMIT || body.builtins.length > 128) {
      reject("Choose built-in tools and up to eight private workflows.");
    }
    if (body.revision !== revision) throw conflict("This profile changed. Reopen it to load the current settings.");
    const builtinNames = new Set(catalog().map(t => t.name));
    const previouslySelected = new Set(existing?.builtins);
    const builtins = [...new Set(body.builtins)];
    if (builtins.some(n => !builtinNames.has(n) && !previouslySelected.has(n))) reject("Choose tools offered on this host.");
    if (!existing && !builtins.length && !body.workflows.length) reject("Choose at least one tool to create a profile.");
    if (!owned.profile) store.admitCreation();
    const names = new Set([...RESERVED, ...builtins.map(n => n.toLowerCase()),
      ...listTools().map(t => t.name.toLowerCase()).filter(name => !existing?.workflows.some(workflow => workflow.name.toLowerCase() === name))]);
    const oldByName = new Map((existing?.workflows ?? []).map(w => [w.name, w]));
    const workflows = [];
    for (const entry of body.workflows) {
      if (!plain(entry) || typeof entry.name !== "string" || !NAME.test(entry.name)) {
        reject("Choose a workflow tool name of 1–64 letters, digits, hyphens or underscores, starting with a letter.");
      }
      const name = entry.name.toLowerCase();
      if (names.has(name)) reject(name === RETIRED_TOOL ? "This tool name was retired. Choose a different name." : "Choose a unique workflow tool name.");
      if (typeof entry.description !== "string" || entry.description.length > 300) reject("Keep the workflow description under 300 characters.");
      names.add(name);
      let graph;
      if (Object.hasOwn(entry, "graph")) {
        graph = canonicalGraph(entry.graph);
        const { inputs } = describeGraph(graph);
        const probe = Object.fromEntries(inputs.filter(i => !i.hasDef && !i.optional)
          .map(({ inp }) => [inp.key, inp.options?.[0] ?? "Workflow input"]));
        try { await checkedPrice({ graph, inputs: probe }, { baseUrl, fetch, limits }); }
        catch (error) {
          if (error instanceof GraphRefusedError || error instanceof GraphArgsError) reject(error.message);
          throw error;
        }
      } else {
        graph = oldByName.get(entry.previousName)?.graph;
        if (!graph) reject("Upload a Nanoodle JSON export for each new workflow.");
      }
      workflows.push({ name: entry.name, description: entry.description.trim(), graph });
    }
    const stillOwned = store.owner(secret);
    if (!stillOwned || (settings(stillOwned.profile)?.revision ?? 0) !== revision) {
      throw conflict("This profile changed. Reopen it to load the current settings.");
    }
    const removals = existing?.builtins.some(n => !builtins.includes(n)) || existing?.workflows.some(w =>
      !workflows.some(next => w.name === next.name && JSON.stringify(w.graph) === JSON.stringify(next.graph)));
    if (removals && hasPending(id)) {
      throw conflict("Finish outstanding payments or wait for unpaid quotes to expire before removing or replacing tools.");
    }
    const profile = stillOwned.profile ?? { v: 1, id, ownerHash: hash, hosts: {} };
    const current = { revision: newRevision(), builtins, workflows, clientHash: existing?.clientHash ?? null };
    profile.hosts[key] = current;
    store.write(profile);
    return view(id, current);
  }

  function connection(secret, body) {
    const owned = store.owner(secret), profile = owned?.profile, current = settings(profile);
    if (!current) reject("Save your tools before connecting a client.");
    if (!plain(body) || !Object.hasOwn(body, "token") || (body.token !== null && (typeof body.token !== "string" || !CLIENT.test(body.token)))) {
      reject("Invalid client credential.");
    }
    const hash = body.token && digest(body.token);
    if (hash === current.clientHash) return view(profile.id, current);
    if (body.revision !== current.revision) throw conflict("This profile changed. Reopen it to load the current settings.");
    if (hash && !available(current).length) reject("Choose at least one available tool before connecting.");
    current.revision = newRevision();
    current.clientHash = hash;
    store.write(profile);
    return view(profile.id, current);
  }

  function remove(secret, revision) {
    const profile = store.owner(secret)?.profile;
    const current = settings(profile);
    if (!current) return profile ? view(profile.id, null) : null;
    if (revision !== current.revision) throw conflict("This profile changed. Reopen it to load the current settings.");
    if (hasPending(profile.id)) throw conflict("Finish outstanding payments or wait for unpaid quotes to expire before deleting this profile.");
    delete profile.hosts[key];
    if (!Object.keys(profile.hosts).length) {
      store.remove(profile.id);
      return null;
    }
    store.write(profile);
    return view(profile.id, null);
  }

  function authenticatedSettings(id, token) {
    if (!CLIENT.test(token)) return null;
    const current = settings(store.read(id));
    return matches(current?.clientHash, token) ? current : null;
  }

  function authorize(id, token) {
    const current = authenticatedSettings(id, token);
    if (!current) return null;
    const tools = available(current);
    return {
      listTools: () => tools.map(t => t.tool),
      instructions: "Call a listed tool to get a quote. Show the payer the payment link and monitor the watch URL. " +
        "When payment is confirmed, resume the same tool on this endpoint with identical arguments and _payment_id. " +
        "Keep the original payment asset. Retry a paid call with its original payment ID.",
      callTool(params, ctx) {
        const selected = tools.find(t => t.tool.name === params?.name);
        if (!selected) reject("This tool is unavailable in your Custom MCP profile.");
        // Only these server-created values reach the payment gates.
        const paymentScope = scope(id);
        const context = Object.assign(Object.create(ctx || null), {
          paymentScope, paymentAlias: params.name,
          report: ctx?.report?.bind(ctx), announce: ctx?.announce?.bind(ctx), workflow: ctx?.workflow?.bind(ctx),
        });
        return store.run(paymentScope, () => {
          if (!selected.workflow) return callTool(params, context);
          const { shape, workflow, rails } = selected;
          const args = params.arguments ?? {}, payment = {}, values = Object.create(null);
          if (!plain(args)) reject("Arguments must be an object.");
          for (const [name, value] of Object.entries(args)) {
            const prop = selected.tool.inputSchema.properties[name];
            if (!Object.hasOwn(selected.tool.inputSchema.properties, name) || typeof value !== "string"
              || (prop.enum && !prop.enum.includes(value)) || value.length > (prop.maxLength ?? 256)) {
              reject("Invalid workflow or payment argument.");
            }
            if (name.startsWith("_")) payment[name] = value;
            else values[shape.inputs.find(i => i.safe === name).inp.key] = value;
          }
          for (const name of shape.schema.required) if (!Object.hasOwn(args, name)) reject("Missing workflow input: " + name);
          const { _payment_id: pid, _pay_with, ...nearPayment } = payment;
          const implied = pid?.startsWith("pay_") ? "nano" : pid?.startsWith("nq_") ? "near" : null;
          const rail = _pay_with ?? implied ?? rails[0];
          if (!rails.includes(rail) || (pid !== undefined && (!/^(?:pay_|nq_)[A-Za-z0-9_-]{12}$/.test(pid) || (implied === "nano") !== (rail === "nano")))
            || (rail === "nano" && Object.keys(nearPayment).length)) reject("Use the original payment asset and payment ID.");
          const run = { graph: workflow.graph, inputs: values, ...(pid && { _payment_id: pid }) };
          return rail === "nano" ? nanoWorkflow(run, context) : nearTools.callTool({ name: "run_noodle",
            arguments: { ...run, ...nearPayment, ...(_pay_with && { _pay_with }) } }, context);
        });
      },
    };
  }

  return { management, update, connection, remove, authenticate: authenticatedSettings, authorize, publicCatalog };
}
