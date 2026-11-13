import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Workflow } from "nanoodle";
import { authorAddress } from "./wallet.mjs";
import { buildInputSchema, keyedInputs, ParamsError } from "./tools.mjs";
import { createWorkflowRunner } from "./market/runner.mjs";
import { recommendPrice, PROBE_BRIEF } from "./market/catalog.mjs";

export const WORKFLOW_ID = /^wf_[a-f0-9]{24}$/;
const paymentKeys = new Set(["_pay_with", "_payment_id", "_payment_tx", "_payment_sender"]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function inputShape(graph) {
  const wf = Workflow.fromJSON(JSON.stringify(graph), { quiet: true });
  const visible = new Set(graph.nodes.filter(n => ["text", "choice"].includes(n.type) && n.name).map(n => String(n.id)));
  const inputs = keyedInputs(wf).filter(({ inp }) => visible.has(String(inp.nodeId)));
  if (inputs.some(({ safe }) => safe.startsWith("_") || ["__proto__", "constructor", "prototype"].includes(safe))) throw new ParamsError("Customer input names must not begin with an underscore or use a reserved object key");
  const schema = buildInputSchema(wf), allowed = new Set(inputs.map(i => i.safe));
  return { inputs, schema: { type: "object", properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => allowed.has(key))),
    required: (schema.required || []).filter(key => allowed.has(key)), additionalProperties: false } };
}

/** Immutable hosted recipes. Graphs and marketplace credentials stay server-side. */
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
    const { schema } = inputShape(record.graph);
    return { id: record.id, status: "live", name: record.name, description: record.description, author: record.author, inputName: record.inputName,
      schema, url: `${publicBase}/workflows/${record.id}`, mcpUrl: `${publicBase}/workflows/${record.id}/mcp`,
      estimatedCostUsd: record.estimatedCostUsd, recommendedPriceUsd: record.recommendedPriceUsd };
  }
  async function check(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ParamsError("Expected a workflow submission");
    let graph = body.graph;
    if (typeof graph === "string") { try { graph = JSON.parse(graph); } catch { throw new ParamsError("The workflow is not valid JSON"); } }
    if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) throw new ParamsError("Paste a Nanoodle graph with a nodes array");
    let author; try { author = authorAddress(graph.x402); } catch { throw new ParamsError("The embedded x402.author must be a valid Nano payout address"); }
    if (!author) throw new ParamsError('Add your Nano payout address as "x402": {"author":"nano_…"} at the top level of the graph');
    const names = graph.nodes.filter(n => n?.type === "text" && typeof n.name === "string" && n.name).map(n => n.name);
    const inputName = body.inputName || (names.length === 1 ? names[0] : null);
    if (!inputName || !names.includes(inputName)) throw new ParamsError("Choose the named text input that receives a marketplace customer's brief");
    const name = String(body.name || graph.name || "").trim();
    if (!name || name.length > 80) throw new ParamsError("Give this workflow a name of 1–80 characters");
    const description = String(body.description || "").trim();
    if (description.length > 2000) throw new ParamsError("Keep the description under 2,000 characters");
    const priced = await runner.price({ graph, inputs: { [inputName]: PROBE_BRIEF } });
    if (!priced.ok) { const e = new ParamsError(priced.refusals.map(r => r.message).join("\n")); e.refusals = priced.refusals; throw e; }
    // Keep only the executable graph and the explicit payout field. Unknown
    // top-level editor/provider settings must not become hosted credentials.
    const wf = Workflow.fromJSON(JSON.stringify(graph), { quiet: true });
    graph = { ...wf.graph, x402: { author } };
    inputShape(graph); // Reject input names the bound public interface cannot expose.
    return { name, description, author, graph, inputName, estimatedCostUsd: priced.pricing.estimatedCostUsd,
      recommendedPriceUsd: recommendPrice({ depositUsd: priced.pricing.depositUsd }) };
  }
  function tools(id) {
    const record = get(id); if (!record) return [];
    const { schema } = inputShape(record.graph);
    return ["run_workflow", "price_workflow"].map(name => ({ name,
      description: name === "price_workflow" ? "Check the cost of this hosted workflow for free; no models run."
        : `${record.description || record.name} Hosted by Nanoodle. Quote first; pay NEAR or USDC; unused funds return automatically. Creator earnings go to the graph's embedded Nano address.`,
      inputSchema: { ...schema, properties: { ...schema.properties,
        _pay_with: { type: "string", enum: ["near", ...(usdc?.enabled ? ["usdc"] : [])] },
        ...(name === "run_workflow" ? Object.fromEntries(["_payment_id", "_payment_tx", "_payment_sender"].map(key => [key, { type: "string" }])) : {}) } } }));
  }
  return {
    dir, publicBase, merchant, network, usdc, get, publicView: id => publicView(get(id)), check,
    all: () => Object.values(state.workflows).map(r => structuredClone(r)),
    async submit(body) {
      const checked = await check(body), id = "wf_" + createHash("sha256").update(JSON.stringify(canonical({ graph: checked.graph, name: checked.name, description: checked.description, inputName: checked.inputName }))).digest("hex").slice(0, 24);
      if (!get(id)) {
        if (Object.keys(state.workflows).length >= maxWorkflows) throw new ParamsError("Hosted workflow capacity is full. Please try again later.");
        state.workflows[id] = { ...checked, id, createdAt: Date.now() }; save();
      }
      return publicView(get(id));
    },
    listTools: tools,
    instructions(id) { return `Run ${get(id)?.name || "this workflow"} with run_workflow. price_workflow is free. A run first returns a payment quote; pay its exact NEAR or USDC amount, monitor the private pay link, then call run_workflow again with identical inputs and _payment_id. Continue automatically when paid. Never pay or create a replacement quote as a retry. The graph is hosted by Nanoodle; callers supply inputs, not graph JSON. Hosting requires no Nanoodle approval. Creators can connect this MCP endpoint to their own agents and marketplace listings; creators own their listings, choose their hire prices and receive marketplace proceeds in their own accounts. A listing's agent pays Nanoodle's execution quote separately using its authorized NEAR/USDC wallet. Successful runs pay the embedded x402.author Nano address.`; },
    async callTool(id, params, ctx) {
      const record = get(id); if (!record) throw new ParamsError("Unknown hosted workflow");
      if (!["run_workflow", "price_workflow"].includes(params?.name)) throw new ParamsError("Use run_workflow or price_workflow");
      const args = params.arguments || {}, { inputs, schema } = inputShape(record.graph), values = {}, payment = {};
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
