import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Workflow } from "nanoodle";
import { authorAddress } from "./wallet.mjs";
import { buildInputSchema, keyedInputs, ParamsError } from "./tools.mjs";
import { createWorkflowRunner } from "./market/runner.mjs";
import { assertCreatorGraph, creatorPayoutAddress } from "./creator-format.mjs";
import { recommendPrice, PROBE_BRIEF } from "./market/catalog.mjs";

export const WORKFLOW_ID = /^wf_[a-f0-9]{24}$/;
const paymentKeys = new Set(["_pay_with", "_payment_id", "_payment_tx", "_payment_sender"]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// These native field ports are optional in the executor/editor. A saved text
// feeding only one of them remains recipe configuration (e.g. video motion).
const optionalPorts = new Set(["ivideo.prompt", "llm.system", "model3d.prompt"]);
function detectInputNodes(wf) {
  const byId = new Map(wf.graph.nodes.map(n => [n.id, n]));
  return keyedInputs(wf).filter(({ inp, optional, hasDef }) => {
    const n = byId.get(inp.nodeId);
    if (!["text", "choice"].includes(n.type) || !n.name?.trim()) return false;
    const links = wf.graph.links.filter(l => l.from.node === n.id);
    if (!links.length) return false;
    if (hasDef && (optional || links.every(l => optionalPorts.has(`${byId.get(l.to.node).type}.${l.to.port}`)))) return false;
    return true;
  }).map(({ inp }) => inp.nodeId);
}

function inputShape(graph, inputNodeIds) {
  const wf = Workflow.fromJSON(JSON.stringify(graph), { quiet: true });
  // Absent on legacy records: retain their published interface exactly.
  const visible = new Set(inputNodeIds || graph.nodes.filter(n => ["text", "choice"].includes(n.type) && n.name).map(n => String(n.id)));
  const inputs = keyedInputs(wf, { exactAliases: true }).filter(({ inp }) => visible.has(String(inp.nodeId)));
  if (inputs.some(({ inp, safe }) => safe.startsWith("_") || ["__proto__", "constructor", "prototype"].includes(safe) || (inputNodeIds && (inp.key.startsWith("_") || ["__proto__", "constructor", "prototype"].includes(inp.key))))) throw new ParamsError("Customer input names must not begin with an underscore or use a reserved object key");
  const schema = buildInputSchema(wf, inputs);
  return { inputs, schema: { ...schema, required: schema.required || [], additionalProperties: false } };
}

/** Immutable hosted workflows. Graphs stay server-side. */
export function createHostedWorkflows({ dir, callTool, publicBase, merchant, network, usdc, baseUrl, fetch = globalThis.fetch, maxWorkflows = 250, maxDepositUsd = 2 }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "workflows.json");
  let state;
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; state = { v: 1, workflows: {} }; }
  if (state.v !== 1 || !state.workflows || typeof state.workflows !== "object" || Array.isArray(state.workflows)) throw new Error("Invalid hosted workflow state");
  let persisted = JSON.stringify(state);
  function save() {
    const tmp = file + ".tmp";
    try {
      const text = JSON.stringify(state), fd = openSync(tmp, "w", 0o600);
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, file); const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); }
      persisted = text;
    } catch (e) { state = JSON.parse(persisted); throw e; }
  }
  const runner = createWorkflowRunner({ apiKey: "pricing-only", budgetUsd: maxDepositUsd, baseUrl, fetch });
  function get(id) { return WORKFLOW_ID.test(String(id)) && Object.hasOwn(state.workflows, id) ? structuredClone(state.workflows[id]) : null; }
  function publicView(record) {
    if (!record) return null;
    const { schema } = inputShape(record.graph, record.inputNodeIds);
    return { id: record.id, status: "live", name: record.name, description: record.description, author: record.author, inputName: record.inputName,
      schema, url: `${publicBase}/workflows/${record.id}`, mcpUrl: `${publicBase}/workflows/${record.id}/mcp`,
      estimatedCostUsd: record.estimatedCostUsd, recommendedPriceUsd: record.recommendedPriceUsd };
  }
  async function check(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ParamsError("Expected a workflow submission");
    let graph = body.graph;
    if (typeof graph === "string") { try { graph = JSON.parse(graph); } catch { throw new ParamsError("The workflow is not valid JSON"); } }
    try { assertCreatorGraph(graph); } catch (e) { throw new ParamsError(e.message); }
    const wf = Workflow.fromJSON(JSON.stringify(graph), { quiet: true });
    // Explicit legacy clients selected one named Text for the pricing probe,
    // while publishing all formerly visible inputs. Preserve that contract;
    // the automatic browser flow omits inputName and uses inferred inputs.
    const legacy = !!body.inputName;
    if (legacy && !graph.nodes.some(n => n.type === "text" && typeof n.name === "string" && n.name && n.name === body.inputName)) throw new ParamsError("Choose the named text input for the user’s request");
    const inputNodeIds = legacy ? undefined : detectInputNodes(wf), shape = inputShape(graph, inputNodeIds);
    if (!shape.inputs.length) throw new ParamsError("No customer inputs were detected. Connect named Text or Choice nodes to the workflow. Keep internal prompts locked; leave a saved default on optional prompts. Image upload nodes are not supported by hosted workflows.");
    const inputName = body.inputName || (shape.inputs.length === 1 ? shape.inputs[0].inp.key : null);
    let author; try { creatorPayoutAddress(graph); author = authorAddress(graph.x402); } catch (e) { throw new ParamsError(e.message); }
    const name = String(body.name || graph.name || "").trim();
    if (!name || name.length > 80) throw new ParamsError("Give this workflow a name of 1–80 characters");
    const description = String(body.description || "").trim();
    if (description.length > 2000) throw new ParamsError("Keep the description under 2,000 characters");
    const probeInputs = legacy ? { [inputName]: PROBE_BRIEF }
      : Object.fromEntries(shape.inputs.map(({ inp }) => [inp.key, inp.options?.[0] ?? PROBE_BRIEF]));
    const priced = await runner.price({ graph, inputs: probeInputs });
    if (!priced.ok) { const e = new ParamsError(priced.refusals.map(r => r.message).join("\n")); e.refusals = priced.refusals; throw e; }
    // Keep only the executable graph and the explicit payout field. Unknown
    // top-level editor/provider settings must not become hosted credentials.
    graph = author ? { ...wf.graph, x402: { author } } : { ...wf.graph };
    return { name, description, author, graph, inputName, inputNodeIds, schema: shape.schema, estimatedCostUsd: priced.pricing.estimatedCostUsd,
      recommendedPriceUsd: recommendPrice({ depositUsd: priced.pricing.depositUsd }) };
  }
  function tools(id) {
    const record = get(id); if (!record) return [];
    const { schema } = inputShape(record.graph, record.inputNodeIds);
    return ["run_workflow", "price_workflow"].map(name => ({ name,
      description: name === "price_workflow" ? "Check the cost of this hosted workflow for free; no models run."
        : `${record.description || record.name} Hosted by Nanoodle. Quote first; pay NEAR or USDC; unused funds return automatically. ${record.author ? "Creator earnings go to the graph's embedded Nano address." : "No creator payout is configured for this workflow."}`,
      inputSchema: { ...schema, properties: { ...schema.properties,
        _pay_with: { type: "string", enum: ["near", ...(usdc?.enabled ? ["usdc"] : [])] },
        ...(name === "run_workflow" ? Object.fromEntries(["_payment_id", "_payment_tx", "_payment_sender"].map(key => [key, { type: "string" }])) : {}) } } }));
  }
  return {
    dir, publicBase, merchant, network, usdc, get, publicView: id => publicView(get(id)), check,
    all: () => Object.values(state.workflows).map(r => structuredClone(r)),
    async submit(body) {
      const checked = await check(body), id = "wf_" + createHash("sha256").update(JSON.stringify(canonical({ graph: checked.graph, name: checked.name, description: checked.description, inputName: checked.inputName, inputNodeIds: checked.inputNodeIds }))).digest("hex").slice(0, 24);
      if (!get(id)) {
        if (Object.keys(state.workflows).length >= maxWorkflows) throw new ParamsError("Hosted workflow capacity is full. Please try again later.");
        state.workflows[id] = { ...checked, id, createdAt: Date.now() }; save();
      }
      return publicView(get(id));
    },
    listTools: tools,
    instructions(id) { const record = get(id); return `Run ${record?.name || "this workflow"} with run_workflow. price_workflow is free. A run first returns a payment quote; pay its exact NEAR or USDC amount, monitor the private pay link, then call run_workflow again with identical inputs and _payment_id. Continue automatically when paid. Never pay or create a replacement quote as a retry. The graph is hosted by Nanoodle; callers supply inputs, not graph JSON. Hosting requires no Nanoodle approval. Connect your agent to this workflow’s MCP endpoint and pay its execution quote from an authorized NEAR/USDC wallet. ${record?.author ? "Successful runs pay the embedded x402.author Nano address." : "No creator payout is configured for this workflow; execution still requires payment."}`; },
    async callTool(id, params, ctx) {
      const record = get(id); if (!record) throw new ParamsError("Unknown hosted workflow");
      if (!["run_workflow", "price_workflow"].includes(params?.name)) throw new ParamsError("Use run_workflow or price_workflow");
      const args = params.arguments || {}, { inputs, schema } = inputShape(record.graph, record.inputNodeIds), values = {}, payment = {};
      if (typeof args !== "object" || Array.isArray(args)) throw new ParamsError("Arguments must be an object");
      for (const [key, value] of Object.entries(args)) {
        if (paymentKeys.has(key)) { payment[key] = value; continue; }
        const input = inputs.find(i => i.safe === key);
        if (!input || typeof value !== "string") throw new ParamsError(`Unexpected workflow input: ${key}`);
        const choices = schema.properties[key]?.enum;
        if (choices && !choices.includes(value)) throw new ParamsError(`Choose one of the listed values for ${key}`);
        values[input.inp.key] = value;
      }
      for (const key of schema.required) if (!(key in args)) throw new ParamsError(`Missing workflow input: ${key}`);
      const result = await callTool({ ...params, name: params.name === "price_workflow" ? "price_noodle" : "run_noodle",
        arguments: { graph: record.graph, inputs: values, ...payment } }, { ...ctx, paymentTool: params.name });
      if (result.structuredContent?.payment) {
        result.structuredContent.payment.next = "After payment is confirmed, call run_workflow with these identical inputs and _payment_id. Continue automatically; do not pay again.";
      }
      if (params.name === "price_workflow" || result.structuredContent?.payment || result.isError) {
        result.content = (result.content || []).map(item => item.type === "text" ? { ...item,
          text: item.text.replace(/\brun_noodle\b/g, "run_workflow").replace(/\bprice_noodle\b/g, "price_workflow") } : item);
      }
      return result;
    },
  };
}
