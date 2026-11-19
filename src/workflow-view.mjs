import { layoutWorkflow } from "./workflow-progress.mjs";

const NS = "http://www.w3.org/2000/svg";
const statusLabel = { pending: "Waiting", running: "Running", done: "Done", error: "Failed", skipped: "Skipped", gated: "Gate closed" };
const svgNode = (tag, attrs, text) => {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text != null) el.textContent = text;
  return el;
};

/** Read-only renderer for the core execution snapshot; no payment/tool logic. */
export function renderWorkflow(container, state) {
  const layout = layoutWorkflow(state), byId = new Map(layout.nodes.map(n => [n.id, n]));
  const svg = svgNode("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height,
    role: "img", "aria-label": state.nodes.map(n => `${n.name}: ${statusLabel[n.status] || n.status}`).join("; ") });
  for (const link of layout.links) {
    const from = byId.get(link.from), to = byId.get(link.to);
    if (!from || !to) continue;
    const x1 = from.x + 92, y1 = from.y + 68, x2 = to.x + 92, y2 = to.y;
    svg.append(svgNode("path", { d: `M${x1} ${y1} C${x1} ${y1 + 18},${x2} ${y2 - 18},${x2} ${y2}`,
      class: `workflow-wire${["done", "gated"].includes(from.status) ? " is-done" : ""}` }));
  }
  for (const n of layout.nodes) {
    const g = svgNode("g", { transform: `translate(${n.x},${n.y})`, class: "workflow-node", "data-status": n.status, "data-node": n.id });
    const title = `${n.name} · ${n.type} · ${statusLabel[n.status] || n.status}${n.detail ? ` · ${n.detail}` : ""}`;
    g.append(svgNode("title", {}, title), svgNode("rect", { width: 184, height: 68, rx: 9 }),
      svgNode("circle", { cx: 14, cy: 19, r: 3.5, class: "workflow-dot" }),
      svgNode("text", { x: 25, y: 23, class: "workflow-name" }, n.name.length > 21 ? n.name.slice(0, 20) + "…" : n.name),
      svgNode("text", { x: 14, y: 48, class: "workflow-kind" }, n.type),
      svgNode("text", { x: 172, y: 48, "text-anchor": "end", class: "workflow-state" },
        n.status === "running" && n.detail === "queued" ? `Queued${n.queuePosition != null ? ` #${n.queuePosition}` : ""}` : statusLabel[n.status] || n.status));
    svg.append(g);
  }
  container.replaceChildren(svg);
}

/** Display rounding only. Exact quoted/settled strings stay in payment details. */
export function displayAmount(value) {
  const exact = String(value ?? "0");
  if (!/^\d+(\.\d+)?$/.test(exact)) return exact;
  const [whole, fraction = ""] = exact.split(".");
  if (fraction.length <= 6) return exact;
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6)) + (fraction[6] >= "5" ? 1n : 0n);
  if (scaled === 0n && /[1-9]/.test(exact)) return "<0.000001";
  const rounded = `${scaled / 1_000_000n}.${String(scaled % 1_000_000n).padStart(6, "0")}`.replace(/\.?0+$/, "");
  return `≈ ${rounded}`;
}
