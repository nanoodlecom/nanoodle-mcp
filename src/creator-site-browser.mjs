import { assertCreatorGraph } from "./creator-format.mjs";
const node = id => document.getElementById(id);
let busy = false;
function invalidate() { node("creator-preview").hidden = true; }
function fields() {
  const graph = JSON.parse(node("creator-graph").value);
  assertCreatorGraph(graph);
  return { graph, name: node("creator-name").value, description: node("creator-description").value };
}
function refreshInputs() {
  node("creator-inputs").textContent = "Customer inputs are detected automatically when you check the workflow.";
  node("creator-error").textContent = "";
  if (!node("creator-graph").value.trim()) return;
  try {
    const graph = JSON.parse(node("creator-graph").value);
    assertCreatorGraph(graph);
    if (!node("creator-name").value && graph.name) node("creator-name").value = graph.name;
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
node("creator-graph").addEventListener("input", refreshInputs);
node("creator-file").addEventListener("change", async () => {
  invalidate(); const file = node("creator-file").files[0]; if (!file) return;
  if (file.size > 256 * 1024) { node("creator-error").textContent = "Use a graph file under 256 KiB."; return; }
  node("creator-graph").value = await file.text(); refreshInputs();
});
