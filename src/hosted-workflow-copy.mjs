/** Public copy only. Never use these overrides for graph identity or execution. */
export function hostedWorkflowCopy(record) {
  if (record.id === "wf_9f17576586b5b53ecf7fcc27") return {
    description: "Turn a day scene into a night video between two keyframes. Provide a day-scene prompt and a night edit instruction. Muse creates the day frame; Muse Edit repaints the same shot at night. MiniMax H3 Max starts on the day frame and ends on the night frame. You can also use this setup for other before/after transitions.",
    showCreatorInfo: false,
  };
  return { description: record.description, showCreatorInfo: true };
}
