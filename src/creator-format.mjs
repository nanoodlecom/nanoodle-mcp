/** Format checks shared by creator upload UI and intake. No graph leaves the browser here. */
export function assertCreatorGraph(graph) {
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (object(graph) && ("last_node_id" in graph || "last_link_id" in graph ||
      (Array.isArray(graph.nodes) && graph.nodes.some(n => object(n) && ("widgets_values" in n || "class_type" in n))) ||
      Object.values(graph).some(n => object(n) && "class_type" in n) ||
      (Array.isArray(graph.links) && graph.links.some(Array.isArray)))) {
    throw new Error("This is a ComfyUI/OpenArt workflow. Creators runs native Nanoodle workflows only. Open or rebuild the workflow in the Nanoodle editor, then use Save to export noodle-graph.json. Renaming the file will not convert it.");
  }
  if (!object(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    throw new Error("Use a native Nanoodle Save export (noodle-graph.json) with nodes and links arrays.");
  }
  const ids = new Set();
  for (const n of graph.nodes) {
    if (!object(n) || !["string", "number"].includes(typeof n.id) || !String(n.id) || typeof n.type !== "string" ||
        (n.name != null && typeof n.name !== "string") || (n.fields != null && !object(n.fields)) || ids.has(String(n.id))) {
      throw new Error("The Nanoodle graph has an invalid or duplicate node. Export it again using Save in the editor.");
    }
    ids.add(String(n.id));
  }
  for (const l of graph.links) {
    if (!object(l) || ![l.from, l.to].every(e => object(e) && ids.has(String(e.node)) && typeof e.port === "string" && e.port)) {
      throw new Error("The Nanoodle graph has an invalid link. Export it again using Save in the editor.");
    }
  }
}
