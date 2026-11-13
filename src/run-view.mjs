import { renderWorkflow, displayAmount } from "./workflow-view.mjs";

/** One read-only execution/result view for the studio and the payment page. */
export function runViewHtml(prefix) {
  return `<div class="run-view">
    <details id="${prefix}-workflow" class="workflow-view" hidden open><summary class="workflow-heading"><span id="${prefix}-workflow-count"></span><span id="${prefix}-elapsed" aria-label="Elapsed time"></span></summary><div id="${prefix}-workflow-graph" class="workflow-graph" tabindex="0" role="region" aria-label="Workflow execution graph; scroll to explore branches"></div><p class="workflow-legend"><span class="legend-running">Running</span><span class="legend-done">Done</span><span>Waiting</span></p></details>
    <dl id="${prefix}-totals" class="studio-totals" hidden><div class="total-deposit"><dt>Deposit paid</dt><dd id="${prefix}-total-paid"></dd></div><div><dt>Final cost</dt><dd id="${prefix}-total-charged"></dd><small>Models + service fee</small></div><div class="total-return"><dt>Your change</dt><dd id="${prefix}-total-returned"></dd><small id="${prefix}-refund-state"></small></div></dl>
    <div id="${prefix}-result" class="run-result" hidden><h3>Your result</h3><div id="${prefix}-media" class="run-media"></div><pre id="${prefix}-output" class="run-output"></pre><div id="${prefix}-output-links" class="run-output-links"></div><div id="${prefix}-transactions" class="studio-transactions"></div><details class="form-help"><summary>Exact amounts &amp; run details</summary><pre id="${prefix}-receipt"></pre><pre id="${prefix}-raw-output"></pre></details></div>
  </div>`;
}

export function resultText(result) {
  const content = [...(result.content || [])];
  if (result.structuredContent?.receipt?.outcome === "succeeded" && /^Paid [\d.]+ (?:USDC|NEAR)\b/.test(content.at(-1)?.text || "")) {
    content.pop();
    if (content.at(-1)?.type === "text" && /^charged: \$/.test(content.at(-1).text)) content.pop();
  }
  return content.filter(c => c.type === "text").map(c => c.text).join("\n\n");
}

export function createRunView(prefix, { collapseFinished = true, origin = location.origin } = {}) {
  const node = id => document.getElementById(`${prefix}-${id}`);
  let outputKey, workflowKey, displayKey;
  const paintElapsed = wf => {
    if (!wf) return;
    const seconds = Math.max(0, Math.floor(((wf.finishedAt || Date.now()) - wf.startedAt) / 1000));
    node("elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return {
    elapsed: paintElapsed,
    render({ payment = {}, workflow, result, receipt = result?.structuredContent?.receipt }) {
      node("workflow").hidden = !workflow;
      if (workflow) {
        const key = JSON.stringify(workflow);
        if (key !== workflowKey) { renderWorkflow(node("workflow-graph"), workflow); workflowKey = key; }
        const finished = workflow.nodes.filter(n => ["done", "skipped", "gated", "error"].includes(n.status)).length;
        const stateKey = `${payment.paymentId}:${!!workflow.finishedAt}`;
        if (displayKey !== stateKey) { node("workflow").open = !collapseFinished || !workflow.finishedAt; displayKey = stateKey; }
        node("workflow-count").textContent = `${finished} / ${workflow.nodes.length} steps finished`;
        paintElapsed(workflow);
      }
      node("totals").hidden = !receipt;
      if (receipt) {
        for (const [id, amount] of [["paid", receipt.deposit], ["charged", receipt.charged], ["returned", receipt.refund]]) {
          const exact = amount?.amount ?? amount?.near ?? "0", asset = receipt.asset || payment.asset || "NEAR";
          node(`total-${id}`).textContent = `${displayAmount(exact)} ${asset}`;
          node(`total-${id}`).title = `${exact} ${asset} (exact)`;
        }
        node("refund-state").textContent = receipt.refund.status === "sent" ? "Back in your wallet" : receipt.refund.status === "pending" ? "Returning to your wallet…" : ["none", "skipped"].includes(receipt.refund.status) ? "No change due" : `Refund ${receipt.refund.status}`;
      }
      node("result").hidden = !result;
      if (!result) return;
      const text = resultText(result), key = JSON.stringify(result.content);
      // Polling receipts must never restart a player or replace the paid text.
      if (key !== outputKey) {
        const readable = text.split("\n").filter(line => !/^[^\n]*https?:\/\/[^\s]+\/out\/[^\s]+$/.test(line.trim())).join("\n").trim();
        node("output").textContent = readable; node("output").hidden = !readable;
        node("raw-output").textContent = text;
        node("media").replaceChildren(); node("output-links").replaceChildren();
        for (const value of [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) || [])]) {
          let url; try { url = new URL(value); } catch { continue; }
          const media = /^\/out\/[^/]+\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|ogg)$/i.exec(url.pathname);
          const model = /^\/out\/[^/]+\.(glb|gltf|obj|stl|ply|fbx|zip)$/i.test(url.pathname);
          const href = media || model ? new URL(url.pathname, origin).href : url.href;
          if (media) {
            const kind = /^(png|jpe?g|webp|gif)$/i.test(media[1]) ? "img" : /^(mp4|webm)$/i.test(media[1]) ? "video" : "audio";
            const preview = document.createElement(kind); preview.src = href;
            if (kind === "img") { preview.alt = "Generated workflow result"; preview.loading = "lazy"; }
            else { preview.controls = true; preview.preload = "metadata"; }
            node("media").append(preview);
          }
          const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = model ? "Download 3D model ↗" : media ? "Download result ↗" : "Open result ↗";
          if (model) a.download = url.pathname.split("/").at(-1);
          node("output-links").append(a);
        }
        outputKey = key;
      }
      node("receipt").textContent = JSON.stringify(receipt, null, 2);
      node("transactions").replaceChildren();
      for (const [label, leg] of [["Payment", receipt?.deposit], ["Refund", receipt?.refund], ["Creator payout", receipt?.authorPayout]]) {
        if (!leg?.explorerUrl) continue;
        const url = new URL(leg.explorerUrl);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const a = document.createElement("a"); a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = `${label} transaction ↗`; node("transactions").append(a);
      }
    },
  };
}

export const RUN_VIEW_CSS = `
  .run-view{min-width:0}.run-view .studio-totals{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1.2rem 0;padding:1rem;background:#171d2b;border:1px solid #36415e;border-radius:9px}.run-view .studio-totals dt{font-size:.72rem;color:var(--muted)}.run-view .studio-totals dd{font:600 clamp(.82rem,1.7vw,1.05rem)/1.8 var(--brand-font-sans),sans-serif;margin:.2rem 0;overflow-wrap:anywhere}.run-view .studio-totals small{font-size:.65rem;color:var(--muted);display:block}.run-view .total-deposit{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:.75rem;border-bottom:1px solid #313a50;padding-bottom:.65rem}.run-view .total-deposit dd{font-size:.74rem;font-weight:400;margin:0;color:var(--muted)}.run-view .total-return dd{color:#b2e9c4}.run-result{border-top:1px solid #36415e;margin-top:1.5rem;padding-top:.4rem}.run-result>h3{font-size:1.1rem;margin:1rem 0 .5rem}.run-view .run-output{font-family:var(--brand-font-sans),sans-serif;font-size:.85rem;line-height:1.85;background:transparent;padding:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto}.run-view details pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:20rem;overflow:auto;font:.74rem/1.75 var(--brand-font-mono),monospace}.run-media img,.run-media video,.run-media audio{display:block;width:100%;max-height:26rem;object-fit:contain;border-radius:8px;margin:1rem 0;background:#0b0e16}.run-output-links{display:flex;gap:.5rem;flex-wrap:wrap}.run-output-links a{display:inline-flex;padding:.45rem .75rem;border:1px solid #596690;border-radius:6px;font-size:.75rem;text-decoration:none;color:#a9b6ff;overflow-wrap:anywhere}.studio-transactions{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1rem}.studio-transactions a{font-size:.7rem;color:var(--muted)}
  .workflow-view{margin-top:1.3rem;border:1px solid #37415b;border-radius:9px;overflow:hidden;background:#0b0e16}.workflow-heading{cursor:pointer;display:flex;justify-content:space-between;gap:.5rem;padding:.7rem .8rem;border-bottom:1px solid #2d354b;font:11px var(--brand-font-mono),monospace;color:#b9c3dd}.workflow-heading:before{content:"▸";color:#a5b3da}.workflow-view[open]>.workflow-heading:before{content:"▾"}.workflow-heading>span:first-child{flex:1}.workflow-heading>span:last-child{font-variant-numeric:tabular-nums;color:#a9b6ff}.workflow-graph{overflow:auto;max-height:370px;scrollbar-color:#505e85 #101521;overscroll-behavior:contain}.workflow-graph svg{display:block;margin:auto;max-width:none}.workflow-wire{fill:none;stroke:#38425b;stroke-width:2}.workflow-wire.is-done{stroke:#79959a}.workflow-node rect{fill:#151b29;stroke:#45506a;stroke-width:1}.workflow-node text{font-family:var(--brand-font-sans),sans-serif;fill:#a4b0c7;font-size:10px}.workflow-node .workflow-name{fill:#dce3f1;font-size:12px;font-weight:550}.workflow-node .workflow-dot{fill:#5e6a80}.workflow-node[data-status=running] rect{fill:#222640;stroke:#a7b2ff;stroke-width:1.5;animation:workflow-pulse 2s ease-in-out infinite}.workflow-node[data-status=running] .workflow-dot{fill:#c2bcff}.workflow-node[data-status=running] .workflow-state{fill:#d3ccff}.workflow-node[data-status=done] rect{stroke:#3b705c}.workflow-node[data-status=done] .workflow-dot,.workflow-node[data-status=done] .workflow-state{fill:#a4ddba}.workflow-node[data-status=error] rect{stroke:#d8877d}.workflow-node[data-status=error] .workflow-dot{fill:#ffb4a6}.workflow-node[data-status=skipped],.workflow-node[data-status=gated]{opacity:.65}.workflow-legend{display:flex;gap:1rem;padding:.5rem .8rem;border-top:1px solid #2d354b;margin:0;font-size:.65rem;color:#919bb0}.workflow-legend span:before{content:"";display:inline-block;width:5px;height:5px;background:#5e6a80;border-radius:50%;margin-right:.35rem;vertical-align:middle}.workflow-legend .legend-running:before{background:#c2bcff}.workflow-legend .legend-done:before{background:#a4ddba}@keyframes workflow-pulse{50%{stroke:#c7b0ed;fill:#2b2c4d}}@media(prefers-reduced-motion:reduce){.workflow-node[data-status=running] rect{animation:none}}
`;
