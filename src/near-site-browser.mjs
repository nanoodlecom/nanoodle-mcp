import { WORKFLOW_META_KEY } from "./workflow-progress.mjs";
import { renderWorkflow, displayAmount } from "./workflow-view.mjs";
let rpcId = 0;
export async function callMcp(name, args, { onProgress = () => {}, onWorkflow = () => {}, fetch: request = globalThis.fetch } = {}) {
  const id = ++rpcId;
  const response = await request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: args._payment_id ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(args._payment_id ? { _meta: { progressToken: `studio:${id}` } } : {}) } }) });
  if (!response.ok) throw new Error(`The server could not complete this request (${response.status}).`);
  const unwrap = message => { if (message.error) throw new Error(message.error.message); return message.result; };
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return unwrap(await response.json());
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffered = "";
  for (;;) {
    const { value, done } = await reader.read(); buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let end;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
      const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const message = JSON.parse(data);
      if (message.id != null && ("result" in message || message.error)) { const result = unwrap(message); await reader.cancel(); return result; }
      if (message.method === "notifications/progress") {
        if (message.params?.message) onProgress(message.params.message);
        const workflow = message.params?._meta?.[WORKFLOW_META_KEY];
        if (workflow?.v === 1 && Array.isArray(workflow.nodes) && Array.isArray(workflow.links)) onWorkflow(workflow);
      }
    }
    if (done) break;
  }
  throw new Error("The result connection closed. Your payment is safe; this page will check the same run again.");
}

export function savedInputs(schema) {
  const result = {};
  for (const key of schema?.required || []) {
    if (key.startsWith("_")) continue;
    const field = schema.properties?.[key] || {};
    result[key] = field.default ?? field.enum?.[0] ?? (field.type === "number" || field.type === "integer" ? field.minimum ?? 1 : "a lighthouse at dawn");
  }
  return result;
}

export function resultText(result) {
  const content = [...(result.content || [])];
  // The gate appends its receipt after the paid output. Render that current
  // structured receipt separately, so an earlier "pending" line cannot linger
  // after a refund has been confirmed by the monitor.
  if (result.structuredContent?.receipt?.outcome === "succeeded" && /^Paid [\d.]+ (?:USDC|NEAR)\b/.test(content.at(-1)?.text || "")) {
    content.pop();
    if (content.at(-1)?.type === "text" && /^charged: \$/.test(content.at(-1).text)) content.pop();
  }
  return content.filter(c => c.type === "text").map(c => c.text).join("\n\n");
}

export function startStudio({ config, rpc = callMcp, status, update, storage, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const sessions = [], monitoring = new Set();
  const persist = () => { try { storage?.setItem("nanoodle-near-studio:v1", JSON.stringify(sessions.map(({ result, ...session }) => session))); } catch {} };
  const changed = session => { persist(); update(session, sessions); };
  async function monitor(session) {
    const id = session.payment.paymentId;
    if (monitoring.has(id)) return;
    monitoring.add(id);
    try {
      for (;;) {
        try {
          const view = await status(session.payment);
          session.view = view;
          if (view.workflow) session.workflow = view.workflow;
          if (view.receipt) session.receipt = view.receipt;
          if (view.status === "expired") { session.phase = "finished"; changed(session); break; }
          if (["paid", "settled", "rejected", "failed"].includes(view.status) && !session.result) {
            session.phase = "running"; changed(session);
            const result = await rpc(session.name, { ...session.args, _payment_id: id }, { onProgress: message => { session.message = message; changed(session); },
              onWorkflow: workflow => { session.workflow = workflow; changed(session); } });
            if (result.isError && !result.structuredContent?.receipt) throw new Error((result.content || []).map(c => c.text || "").join("\n"));
            session.result = result; session.message = "";
          }
          const receipt = view.receipt || session.result?.structuredContent?.receipt;
          if (session.result && receipt && receipt.refund?.status !== "pending") { session.phase = "finished"; session.receipt = receipt; changed(session); break; }
          session.phase = view.status === "pending" ? "waiting" : "running"; changed(session);
        } catch (error) { session.message = error.message; changed(session); }
        await pause(session.phase === "waiting" ? 100 : 2000);
      }
    } finally { monitoring.delete(id); }
  }
  return {
    sessions,
    async quote(name, args, { title } = {}) {
      if (sessions.filter(s => s.phase !== "finished").length >= 10) throw new Error("This tab already has ten open quotes. Finish a payment or wait for an earlier quote to expire.");
      const snapshot = JSON.parse(JSON.stringify(args));
      const result = await rpc(name, snapshot), payment = result.structuredContent?.payment;
      if (result.isError || !payment || payment.status !== "payment_required") throw new Error((result.content || []).map(c => c.text || "").join("\n") || "This workflow could not be quoted.");
      if (payment.payTo !== config.merchant || !/^nq_[A-Za-z0-9_-]+$/.test(payment.paymentId)) throw new Error("The server returned an unexpected payment destination.");
      const session = { name, args: snapshot, payment, pricing: result.structuredContent.pricing, ...(title ? { title } : {}), phase: "waiting" };
      sessions.push(session); changed(session); void monitor(session); return session;
    },
    restore() {
      try {
        const previous = JSON.parse(storage?.getItem("nanoodle-near-studio:v1") || "[]");
        if (!Array.isArray(previous)) return;
        const restored = [];
        for (const session of previous.slice(-10)) {
          if (!session?.payment || session.payment.payTo !== config.merchant || !/^nq_[A-Za-z0-9_-]+$/.test(session.payment.paymentId)
            || !session.args || typeof session.args !== "object" || !["run_noodle", ...config.tools.map(t => t.name)].includes(session.name)) continue;
          restored.push(session);
        }
        sessions.push(...restored);
        // Reconnect to the latest open run, rather than showing an older paid
        // result while a newer workflow silently continues in the background.
        const current = [...restored].reverse().find(s => s.phase !== "finished") || restored.at(-1);
        if (current) update(current, sessions);
        for (const session of restored) void monitor(session);
      } catch {}
    },
  };
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#near-studio");
  if (root) mount(root);
}

function mount(root) {
  const config = JSON.parse(root.dataset.config), node = id => document.getElementById(id);
  const example = { v: 1, nodes: [
    { id: "topic", type: "text", name: "Topic", fields: { text: "" } },
    { id: "writer", type: "llm", fields: { model: "meta-llama/llama-3.3-70b-instruct", system: "Reply with one vivid sentence about the topic.", maxTokens: 48 } },
  ], links: [{ id: "topic-writer", from: { node: "topic", port: "text" }, to: { node: "writer", port: "prompt" } }] };
  let mode = "saved", selected = null, quoting = false, renderedResult = null, renderedWorkflow = null, workflowDisplayKey = null;
  const safeUrl = value => {
    const url = new URL(value, location.origin), canonical = new URL(config.publicBase).origin;
    if (![location.origin, canonical].includes(url.origin) || !["http:", "https:"].includes(url.protocol)) throw new Error("Unexpected payment URL.");
    return url.href;
  };
  function render(session, sessions) {
    if (!selected) selected = session;
    node("studio-history").replaceChildren();
    for (const item of sessions) {
      const button = document.createElement("button"); button.type = "button";
      button.setAttribute("aria-pressed", String(item === selected));
      button.textContent = `${item.title || item.name.replace(/[-_]/g, " ")} · ${item.payment.asset || "NEAR"} · ${item.phase}`;
      button.addEventListener("click", () => { selected = item; render(item, sessions); }); node("studio-history").append(button);
    }
    if (session !== selected) return;
    node("studio-empty").hidden = true; node("studio-payment").hidden = false;
    const p = session.payment, receipt = session.receipt || session.result?.structuredContent?.receipt;
    const title = session.title || (session.name === "run_noodle" ? "Your workflow" : config.tools.find(t => t.name === session.name)?.title || session.name.replace(/[-_]/g, " "));
    node("studio-quoted-tool").textContent = title;
    const stage = receipt ? receipt.outcome === "succeeded" ? "Complete" : "Run failed" : session.phase === "waiting" ? "Awaiting payment" : session.phase === "running" ? "Running workflow" : "Quote expired";
    node("studio-stage").textContent = stage;
    node("studio-stage").dataset.phase = receipt ? receipt.outcome === "succeeded" ? "done" : "error" : session.phase;
    node("studio-amount").textContent = `${p.amount ?? p.amountNear} ${p.asset || "NEAR"}`;
    node("studio-deposit").hidden = session.phase !== "waiting";
    node("studio-breakdown").textContent = `Estimated models $${session.pricing?.estimatedCost?.usd ?? "—"} + 20% service fee. Unused funds return automatically.`;
    node("studio-pay").href = safeUrl(p.payUrl); node("studio-pay").hidden = session.phase !== "waiting";
    const refundStatus = receipt?.refund?.status;
    const refundMessage = refundStatus === "sent" ? "Change returned to your wallet." : refundStatus === "pending" ? "Returning your unused deposit…" : refundStatus === "skipped" ? "No change is due." : `Refund status: ${refundStatus}.`;
    node("studio-status").textContent = receipt
      ? `${receipt.outcome === "succeeded" ? "Your result is ready." : "This run did not complete."} ${refundMessage}`
      : session.message || (session.phase === "waiting" ? "Pay the exact deposit in your wallet to start." : session.phase === "running" ? "Payment confirmed. Preparing your workflow…" : `Quote ${session.view?.status || "finished"}.`);
    node("studio-payment-note").hidden = session.phase !== "waiting";
    node("studio-totals").hidden = !receipt;
    if (receipt) {
      for (const [id, amount] of [["paid", receipt.deposit], ["charged", receipt.charged], ["returned", receipt.refund]]) {
        const exact = amount?.amount ?? amount?.near ?? "0";
        node(`studio-total-${id}`).textContent = `${displayAmount(exact)} ${p.asset || "NEAR"}`;
        node(`studio-total-${id}`).title = `${exact} ${p.asset || "NEAR"} (exact)`;
      }
      node("studio-refund-state").textContent = receipt.refund.status === "sent" ? "Back in your wallet" : receipt.refund.status === "pending" ? "Returning to your wallet…" : receipt.refund.status === "skipped" ? "No change due" : `Refund ${receipt.refund.status}`;
    }
    node("studio-workflow").hidden = !session.workflow;
    if (session.workflow) {
      if (renderedWorkflow !== session.workflow) { renderWorkflow(node("studio-workflow-graph"), session.workflow); renderedWorkflow = session.workflow; }
      const wf = session.workflow, finished = wf.nodes.filter(n => ["done", "skipped", "gated", "error"].includes(n.status)).length;
      const displayKey = `${p.paymentId}:${!!wf.finishedAt}`;
      if (workflowDisplayKey !== displayKey) { node("studio-workflow").open = !wf.finishedAt; workflowDisplayKey = displayKey; }
      node("studio-workflow-count").textContent = `${finished} / ${wf.nodes.length} steps finished`;
      const elapsed = Math.max(0, Math.floor(((wf.finishedAt || Date.now()) - wf.startedAt) / 1000));
      node("studio-elapsed").textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
    }
    node("studio-result").hidden = !session.result;
    if (session.result) {
      const text = resultText(session.result);
      const newOutput = renderedResult !== session.result;
      if (newOutput) {
        // Media already has a player/preview and download action. Keep its raw
        // URL in details rather than repeating it in the main result.
        const readable = text.split("\n").filter(line => !/^[^\n]*https?:\/\/[^\s]+\/out\/[^\s]+$/.test(line.trim())).join("\n").trim();
        node("studio-output").textContent = readable; node("studio-output").hidden = !readable;
        node("studio-raw-output").textContent = text;
        node("studio-media").replaceChildren(); renderedResult = session.result;
      }
      node("studio-receipt").textContent = JSON.stringify(receipt, null, 2);
      node("studio-output-links").replaceChildren();
      for (const value of [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) || [])]) {
        const url = new URL(value), a = document.createElement("a");
        // Both hostnames serve the same output directory. Preview only local
        // generated files; never fetch an arbitrary model-supplied media host.
        const media = /^\/out\/[^/]+\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|ogg)$/i.exec(url.pathname);
        const model = /^\/out\/[^/]+\.(glb|gltf|obj|stl|ply|fbx|zip)$/i.test(url.pathname);
        const resultUrl = media || model ? new URL(url.pathname, location.origin).href : url.href;
        if (media && newOutput) {
          const kind = /^(png|jpe?g|webp|gif)$/i.test(media[1]) ? "img" : /^(mp4|webm)$/i.test(media[1]) ? "video" : "audio";
          const preview = document.createElement(kind); preview.src = resultUrl;
          if (kind === "img") { preview.alt = "Generated workflow result"; preview.loading = "lazy"; }
          else { preview.controls = true; preview.preload = "metadata"; }
          node("studio-media").append(preview);
        }
        a.href = resultUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = model ? "Download 3D model ↗" : media ? "Download result ↗" : "Open result ↗";
        if (model) a.download = url.pathname.split("/").at(-1);
        node("studio-output-links").append(a);
      }
      node("studio-transactions").replaceChildren();
      for (const [label, leg] of [["Payment", receipt?.deposit], ["Refund", receipt?.refund]]) {
        if (!leg?.explorerUrl) continue;
        const url = new URL(leg.explorerUrl);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const a = document.createElement("a"); a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = `${label} transaction ↗`; node("studio-transactions").append(a);
      }
    }
  }
  let tabStorage = null; try { tabStorage = sessionStorage; } catch {}
  const studio = startStudio({ config, storage: tabStorage, update: render, status: async payment => {
    const url = new URL(safeUrl(payment.statusUrl)); url.searchParams.set("wait", "1");
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (response.status === 404) return { status: "expired" };
    if (!response.ok) throw new Error("Payment monitor unavailable. Retrying the same quote—do not pay again.");
    return response.json();
  } });
  function setMode(value) {
    mode = value; node("saved-fields").hidden = mode !== "saved"; node("custom-fields").hidden = mode !== "custom"; node("custom-inputs").hidden = mode !== "custom";
    document.querySelectorAll("[data-mode]").forEach(button => button.setAttribute("aria-selected", String(button.dataset.mode === mode)));
    node("studio-inputs").value = JSON.stringify({ Topic: "a lighthouse at dawn" }, null, 2);
    if (mode === "saved") {
      const schema = config.tools.find(t => t.name === node("studio-tool").value)?.schema;
      const fields = node("studio-saved-inputs"); fields.replaceChildren();
      const defaults = { ...savedInputs(schema), ...config.tools.find(t => t.name === node("studio-tool").value)?.defaults };
      const advanced = document.createElement("details"), summary = document.createElement("summary");
      summary.textContent = "Advanced instructions"; advanced.append(summary); advanced.className = "form-help";
      for (const [key, field] of Object.entries(schema?.properties || {})) {
        if (key.startsWith("_")) continue;
        const label = document.createElement("label"), input = document.createElement("textarea");
        label.textContent = key.replace(/_/g, " "); input.id = `saved-${key}`; label.htmlFor = input.id;
        input.dataset.input = key; input.rows = 2; input.dataset.type = field.type;
        input.value = defaults[key] ?? ""; input.required = schema.required?.includes(key) || false;
        input.placeholder = field.description?.replace(/; optional$/, "") || "Leave blank to use the workflow’s saved default.";
        const parent = field.description?.startsWith("System prompt") ? advanced : fields; parent.append(label, input);
      }
      if (advanced.children.length > 1) fields.append(advanced);
    }
  }
  node("studio-graph").value = JSON.stringify(example, null, 2); setMode("saved");
  document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
  node("studio-tool").addEventListener("change", () => setMode("saved"));
  document.querySelectorAll("[data-choose]").forEach(button => button.addEventListener("click", () => {
    node("studio-tool").value = button.dataset.choose; setMode("saved"); node("studio-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  document.querySelectorAll("[data-start-custom]").forEach(link => link.addEventListener("click", () => {
    setMode("custom");
  }));
  node("studio-form").addEventListener("submit", async event => {
    event.preventDefault(); if (quoting) return; quoting = true; node("studio-quote").disabled = true; node("studio-error").textContent = "";
    try {
      const inputs = mode === "custom" ? JSON.parse(node("studio-inputs").value) : Object.fromEntries(
        [...node("studio-saved-inputs").querySelectorAll("[data-input]")].filter(input => input.value.trim()).map(input => [input.dataset.input,
          ["integer", "number"].includes(input.dataset.type) ? Number(input.value) : input.value]));
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error("Inputs must be a JSON object.");
      const template = mode === "saved" ? config.tools.find(t => t.name === node("studio-tool").value) : null;
      const name = mode === "custom" || template?.graph ? "run_noodle" : node("studio-tool").value;
      const args = mode === "custom" ? { graph: JSON.parse(node("studio-graph").value), inputs } : template?.graph ? { graph: template.graph, inputs } : inputs;
      const session = await studio.quote(name, { ...args, _pay_with: node("studio-asset").value }, { title: template?.title }); selected = session; render(session, studio.sessions);
    } catch (error) { node("studio-error").textContent = error.message; }
    finally { quoting = false; node("studio-quote").disabled = false; }
  });
  const command = () => node("connect-client").value === "url" ? `${config.publicBase}/mcp` : `${node("connect-client").value} mcp add --transport http nanoodle ${config.publicBase}/mcp`;
  node("connect-client").addEventListener("change", () => { node("connect-command").textContent = command(); });
  node("connect-copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(command()); node("connect-copy").textContent = "Copied"; } catch { node("connect-copy").textContent = "Select the command to copy"; } });
  setInterval(() => {
    const wf = selected?.workflow;
    if (!wf || selected.phase !== "running" || wf.finishedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - wf.startedAt) / 1000));
    node("studio-elapsed").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  studio.restore();
}
