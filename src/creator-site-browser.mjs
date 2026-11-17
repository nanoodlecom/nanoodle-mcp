import { NODE_TYPES } from "nanoodle/browser";
import { assertCreatorGraph } from "./creator-format.mjs";
const node = id => document.getElementById(id);
let busy = false, graphRevision = 0;
const metadata = new Map(["creator-name", "creator-description"].map(id => [id, { automatic: node(id).value, edited: !!node(id).value }]));
function defaultMetadata(id, value) {
  const field = node(id), state = metadata.get(id);
  // Also preserve browser autofill or edits that did not emit an input event.
  if (state.edited || field.value !== state.automatic) { state.edited = true; return; }
  const limit = field.maxLength;
  field.value = limit > 0 ? value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "") : value;
  state.automatic = field.value;
}
function clearDefaults() { defaultMetadata("creator-name", ""); defaultMetadata("creator-description", ""); }
function invalidate() { node("creator-preview").hidden = true; }
function fields() {
  const graph = JSON.parse(node("creator-graph").value);
  assertCreatorGraph(graph);
  return { graph, name: node("creator-name").value, description: node("creator-description").value };
}
function refreshInputs(filename = "") {
  node("creator-inputs").textContent = "Customer inputs are detected automatically when you check the workflow.";
  node("creator-error").textContent = "";
  clearDefaults();
  if (!node("creator-graph").value.trim()) return;
  try {
    const graph = JSON.parse(node("creator-graph").value);
    assertCreatorGraph(graph);
    if (!graph.nodes.length || !graph.nodes.every(n => Object.hasOwn(NODE_TYPES, n.type === "audio" ? "tts" : n.type))) return;
    const name = filename ? filename.split(/[\\/]/).pop().replace(/\.json$/i, "").replace(/\.noodle-graph$/i, "")
      : typeof graph.name === "string" ? graph.name.trim() : "";
    const comment = graph.nodes.find(n => n.type === "comment" && typeof n.fields?.text === "string" && n.fields.text.trim());
    defaultMetadata("creator-name", name);
    defaultMetadata("creator-description", comment?.fields.text.trim() || "");
  } catch (error) { node("creator-error").textContent = error instanceof SyntaxError ? "The workflow is not valid JSON." : error.message; }
}
function paragraph(parent, text) { const p = document.createElement("p"); p.textContent = text; parent.append(p); }
async function submit(host) {
  if (busy || !node("creator-form").reportValidity()) return;
  busy = true; node("creator-check").disabled = node("creator-host").disabled = true; node("creator-error").textContent = "";
  try {
    const response = await fetch(host ? "/creators/workflows" : "/creators/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields()) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not check this workflow. Try again.");
    const keys = Object.keys(result.schema.properties);
    node("creator-inputs").textContent = `Detected ${keys.length} customer input${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}.`;
    const preview = node("creator-preview"); preview.replaceChildren(); preview.hidden = false;
    const title = document.createElement("h2"); title.textContent = host ? "Your workflow is hosted." : "Ready to host."; preview.append(title);
    paragraph(preview, node("creator-inputs").textContent);
    paragraph(preview, `Estimated model cost: $${Number(result.estimatedCostUsd).toFixed(6)}. Users get a quote before each run.`);
    paragraph(preview, `Creator payouts: ${result.author}`);
    if (host) {
      const link = document.createElement("a"); link.href = result.url; link.className = "primary-link"; link.textContent = "Open your workflow ↗"; preview.append(link);
      paragraph(preview, "Your workflow is live. Share the run page with people, or connect an agent to its MCP endpoint. No Nanoodle approval is needed.");
    } else { paragraph(preview, "Checking never runs a model. Hosting creates your page immediately with the payout address shown above."); }
  } catch (error) { node("creator-error").textContent = error.message; }
  finally { busy = false; node("creator-check").disabled = node("creator-host").disabled = false; }
}
node("creator-form").addEventListener("submit", event => { event.preventDefault(); void submit(true); });
node("creator-check").addEventListener("click", () => void submit(false));
node("creator-form").addEventListener("input", invalidate);
for (const [id, state] of metadata) node(id).addEventListener("input", () => { state.edited = true; });
node("creator-graph").addEventListener("input", () => { graphRevision++; refreshInputs(); });
node("creator-file").addEventListener("change", async () => {
  invalidate(); const revision = ++graphRevision, file = node("creator-file").files[0];
  node("creator-graph").value = ""; clearDefaults(); node("creator-error").textContent = "";
  if (!file) return;
  if (file.size > 256 * 1024) { node("creator-error").textContent = "Use a graph file under 256 KiB."; return; }
  try {
    const text = await file.text();
    if (revision !== graphRevision) return;
    node("creator-graph").value = text; refreshInputs(file.name);
  } catch {
    if (revision === graphRevision) node("creator-error").textContent = "Could not read this file. Choose it again.";
  }
});
