/**
 * Transport/UI-independent execution view of any Nanoodle graph. The executor
 * remains the source of truth: consume its existing onProgress events, never
 * infer a percentage or run nodes again. Only topology and safe state leave
 * this adapter; fields, prompts, outputs, provider IDs and errors do not.
 */
export const WORKFLOW_META_KEY = "com.nanoodle/workflow";
const terminal = new Set(["done", "error", "skipped", "gated"]);
const label = value => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, 100);

export function createWorkflowProgress(graph, { publish = () => {}, now = Date.now } = {}) {
  const state = { v: 1, status: "running", startedAt: now(), updatedAt: now(), nodes: (graph.nodes || [])
    .filter(n => !["comment", "note"].includes(n.type)).map(n => ({ id: String(n.id), type: label(n.type),
      name: label(n.name || n.fields?.name || n.type || n.id), status: "pending" })), links: [] };
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  state.links = (graph.links || []).filter(l => nodes.has(String(l.from.node)) && nodes.has(String(l.to.node)))
    .map(l => ({ from: String(l.from.node), to: String(l.to.node) }));
  const snapshot = () => ({ ...state, nodes: state.nodes.map(n => ({ ...n })), links: state.links.map(l => ({ ...l })) });
  const send = () => { state.updatedAt = now(); try { publish(snapshot()); } catch { /* observers cannot break paid work */ } };
  send();
  return {
    snapshot,
    event(evt) {
      const node = nodes.get(String(evt?.nodeId));
      if (!node || terminal.has(node.status)) return;
      switch (evt.type) {
        case "node-start": node.status = "running"; node.startedAt = now(); break;
        case "node-done": node.status = "done"; node.ms = evt.ms; break;
        case "node-error": node.status = "error"; break;
        case "node-skipped": node.status = "skipped"; break;
        case "node-gated": node.status = "gated"; break;
        case "poll":
          // Provider responses can contain arbitrary content. Keep only known
          // states and a numeric queue position, never job IDs or response text.
          node.detail = /^(queued|pending|processing|running|completed)$/i.test(evt.status) ? String(evt.status).toLowerCase() : "working";
          if (Number.isSafeInteger(evt.queuePosition) && evt.queuePosition >= 0) node.queuePosition = evt.queuePosition;
          break;
        case "node-progress": node.detail = "working"; break;
        case "prompt-trimmed": node.detail = "prompt fitted to model limit"; break;
        default: return;
      }
      send();
    },
    finish(result, error) {
      for (const node of state.nodes) {
        const rec = result?.nodes?.[node.id];
        if (terminal.has(rec?.status)) { node.status = rec.status; if (Number.isFinite(rec.ms)) node.ms = rec.ms; }
        else if (!terminal.has(node.status)) node.status = error ? "error" : "skipped";
      }
      state.status = error || state.nodes.some(n => n.status === "error") ? "failed" : "succeeded";
      state.finishedAt = now(); send(); return snapshot();
    },
  };
}

export function workflowMessage(state) {
  const finished = state.nodes.filter(n => terminal.has(n.status)).length;
  const active = state.nodes.filter(n => n.status === "running");
  const step = active.map(n => `${n.name}${n.detail === "queued" ? " (provider queue)" : ""}`).join(", ");
  return `${finished}/${state.nodes.length} steps finished${step ? ` · Running: ${step}` : state.status === "running" ? " · Preparing next step" : ` · Workflow ${state.status}`}`;
}

/** Layer a DAG by its dependencies, including parallel branches and joins.
 * Editor coordinates are deliberately unnecessary. Oversized graphs scroll.
 */
export function layoutWorkflow(state) {
  const levels = new Map(), pending = new Set(state.nodes.map(n => n.id));
  while (pending.size) {
    let advanced = false;
    for (const id of pending) {
      const parents = state.links.filter(l => l.to === id).map(l => l.from);
      if (parents.some(p => pending.has(p))) continue;
      levels.set(id, parents.length ? Math.max(...parents.map(p => levels.get(p) || 0)) + 1 : 0);
      pending.delete(id); advanced = true;
    }
    // Defensive for an invalid/cyclic snapshot; execution validation is upstream.
    if (!advanced) { for (const id of pending) levels.set(id, 0); break; }
  }
  const rows = [];
  for (const n of state.nodes) { const level = levels.get(n.id) || 0; (rows[level] ||= []).push(n); }
  const width = Math.max(320, ...rows.map(row => row.length * 204 + 24));
  const nodes = rows.flatMap((row, level) => row.map((n, i) => ({ ...n,
    x: (width - row.length * 204) / 2 + i * 204 + 10, y: 16 + level * 98 })));
  return { nodes, links: state.links, width, height: Math.max(100, rows.length * 98) };
}
