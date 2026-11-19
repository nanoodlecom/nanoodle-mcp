import { checkGraphSafety } from "./custom-workflow.mjs";
import { editorShareUrl } from "./tools.mjs";

/** Reuse the mounted 3D workflow as a run_noodle template. The public paid
 * graph uses priced provider defaults rather than unpriced modelOpts. This
 * does not change the original Nano tool or weaken the graph safety policy.
 */
export function nearShowcase(tools, toolInfo) {
  const saved = tools.filter(t => !["run_noodle", "price_noodle", "noodle_guide", "image-model-arena"].includes(t.name));
  if (saved.some(t => t.name === "idea-to-3d-model")) return { tools: saved, info: toolInfo };
  const source = toolInfo.find(t => t.name === "idea-to-3d-model");
  if (!source?.rawText || !source.inputSchema) return { tools: saved, info: toolInfo };
  let graph;
  try {
    graph = JSON.parse(source.rawText);
    for (const n of graph.nodes) if (n.type === "model3d" && n.fields) delete n.fields.modelOpts;
    if (!checkGraphSafety(graph).ok) return { tools: saved, info: toolInfo };
  } catch { return { tools: saved, info: toolInfo }; }
  const rawText = JSON.stringify(graph), template = { ...source, graph, rawText, editorUrl: editorShareUrl(rawText) };
  const Object_idea = graph.nodes.find(n => n.name === "Object idea")?.fields?.text;
  template.defaults = { Object_idea };
  return { tools: [template, ...saved], info: [...toolInfo.filter(t => t.name !== template.name), template] };
}
