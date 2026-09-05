// Outcome examples belong to the mounted workflow, not the server's default tool set.
const WORKFLOW_EXAMPLES = {
  "character-sprites": {
    title: "Iron Verdict",
    play: "https://nanoodle.com/examples/iron-verdict/",
    skill: "https://github.com/nanoodlecom/noodle-skills/tree/main/skills/character-sprites",
    description: "A playable fighting game built with character-sprites. This graph generates a character reference and parts sheet; the local skill bakes animated sprites, and a coding agent adds combat, gravity and game rules.",
  },
};


export function workflowExample(name) {
  return Object.hasOwn(WORKFLOW_EXAMPLES, name) ? WORKFLOW_EXAMPLES[name] : null;
}
