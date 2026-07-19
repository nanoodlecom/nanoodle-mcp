# nanoodle-skill

An [Agent Skill](https://agentskills.io) that teaches any AI agent to build and
run [nanoodle](https://nanoodle.com) graphs — multi-model AI media pipelines
(text, LLM, image, video, audio) saved as a single `noodle-graph.json` and
executed headlessly against the [NanoGPT](https://nano-gpt.com) API with the
user's own key.

The skill itself is [SKILL.md](SKILL.md). Once installed, an agent that supports
the Agent Skills format (Claude Code, Cursor, Gemini CLI, OpenCode, and
[many others](https://agentskills.io)) will pull it in whenever a task looks
like "generate an image/video/audio pipeline" or "run this nanoodle workflow".

This skill teaches your agent to design and run **any** graph. Want prebuilt
one-task skills instead (poster, jingle, video teaser)? →
[noodle-skills](https://github.com/nanoodlecom/noodle-skills). Prefer each
saved workflow exposed as a typed, callable tool? →
[nanoodle-mcp](https://github.com/nanoodlecom/nanoodle-mcp). Running in GitHub
CI? → [run-noodle-action](https://github.com/nanoodlecom/run-noodle-action).

## Using your own workflow

You don't install your graphs — you just hand one to your agent. No extra setup.

1. Build a workflow at [nanoodle.com](https://nanoodle.com) and press **💾 Save**.
   You get a `noodle-graph.json` file, or a share link.
2. Ask your agent to run it — either works:
   - *"Run poster.noodle-graph.json with Idea='a cozy ramen shop'"*
   - *"Run https://nanoodle.com/#g=…"* (just paste the link)

The agent reads the workflow to find out what inputs it needs, then runs it.
That's it.

**Want a workflow to run automatically** whenever you ask for that kind of thing
(e.g. "make a poster")? Turn it into its own skill — see *Making one workflow
run automatically* in [SKILL.md](SKILL.md).

## Install

Via the open [skills CLI](https://github.com/vercel-labs/skills) (installs into
`~/.agents/skills/` with vendor symlinks):

```sh
npx skills add nanoodlecom/nanoodle-skill -g -y
```

Or manually: copy this directory to `.claude/skills/nanoodle-skill/`
(project-level), `~/.claude/skills/nanoodle-skill/` (user-level), or wherever
your agent reads skills from.

## What's inside

```
nanoodle-skill/
├── SKILL.md                        # the skill: run graphs via CLI or JS/Python library
├── references/graph-format.md      # noodle-graph.json format + node-type table
└── examples/poster.noodle-graph.json  # runnable example: idea → LLM → poster image
```

Runs require a NanoGPT API key (`NANOGPT_API_KEY`) with balance — generations
spend real money. Loading and inspecting graphs is free and offline.

## Related

- [nanoodle](https://github.com/nanoodlecom/nanoodle) — the browser editor (nanoodle.com)
- [nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) — `nanoodle` on npm: library + CLI
- [nanoodle-py](https://github.com/nanoodlecom/nanoodle-py) — `nanoodle` on PyPI: library + CLI

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT.
