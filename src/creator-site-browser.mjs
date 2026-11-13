const node = id => document.getElementById(id);
let checked = false, busy = false;
function invalidate() { checked = false; node("creator-host").disabled = true; node("creator-preview").hidden = true; }
function fields() {
  const graph = JSON.parse(node("creator-graph").value);
  return { graph, name: node("creator-name").value, description: node("creator-description").value, inputName: node("creator-input").value };
}
function refreshInputs() {
  const select = node("creator-input"), previous = select.value; select.replaceChildren();
  try {
    const graph = JSON.parse(node("creator-graph").value);
    for (const n of graph.nodes || []) if (n?.type === "text" && n.name) {
      const option = document.createElement("option"); option.value = option.textContent = n.name; select.append(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    if (!node("creator-name").value && graph.name) node("creator-name").value = graph.name;
  } catch { const option = document.createElement("option"); option.textContent = "Load a valid graph to choose"; option.value = ""; select.append(option); }
}
function paragraph(parent, text) { const p = document.createElement("p"); p.textContent = text; parent.append(p); }
async function submit(host) {
  if (busy || (host && !checked)) return;
  busy = true; node("creator-check").disabled = node("creator-host").disabled = true; node("creator-error").textContent = "";
  try {
    const response = await fetch(host ? "/creators/workflows" : "/creators/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields()) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Could not check this workflow. Try again.");
    const preview = node("creator-preview"); preview.replaceChildren(); preview.hidden = false;
    const title = document.createElement("h2"); title.textContent = host ? "Your workflow is hosted." : "Ready to host."; preview.append(title);
    paragraph(preview, `Estimated model cost: $${Number(result.estimatedCostUsd).toFixed(6)}. Suggested marketplace hire: $${Number(result.recommendedPriceUsd).toFixed(2)}.`);
    paragraph(preview, `Creator payouts: ${result.author}`);
    if (host) {
      const link = document.createElement("a"); link.href = result.url; link.className = "primary-link"; link.textContent = "Open your workflow ↗"; preview.append(link);
      paragraph(preview, "Share this link with people or agents. Marketplace publication is pending Nanoodle review.");
    } else { checked = true; paragraph(preview, "Checking never runs a model. Hosting creates your page with the payout address shown above."); }
  } catch (error) { node("creator-error").textContent = error.message; }
  finally { busy = false; node("creator-check").disabled = false; node("creator-host").disabled = !checked; }
}
node("creator-form").addEventListener("submit", event => { event.preventDefault(); void submit(false); });
node("creator-host").addEventListener("click", () => void submit(true));
node("creator-form").addEventListener("input", invalidate);
node("creator-graph").addEventListener("input", refreshInputs);
node("creator-file").addEventListener("change", async () => {
  invalidate(); const file = node("creator-file").files[0]; if (!file) return;
  if (file.size > 256 * 1024) { node("creator-error").textContent = "Use a graph file under 256 KiB."; return; }
  node("creator-graph").value = await file.text(); refreshInputs();
});
