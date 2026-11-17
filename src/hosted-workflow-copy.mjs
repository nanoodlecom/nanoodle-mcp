/** Public copy only. Never use these overrides for graph identity or execution. */
export function hostedWorkflowCopy(record) {
  if (record.id === "wf_9f17576586b5b53ecf7fcc27") return {
    description: "Turn a day scene into a night video. Muse creates the day keyframe; Muse Edit repaints the same shot at night. MiniMax H3 Max connects the two frames. Provide a day prompt and a night edit, or use the saved defaults.",
    showCreatorInfo: false,
  };
  return { description: record.description, showCreatorInfo: true };
}
