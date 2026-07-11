---
name: noodles
description: How nanoodle workflow tools ("noodles") work — what the MCP tools this plugin serves actually do, what their inputs accept, where outputs land, and that every call spends real NanoGPT credit. Use when calling a nanoodle MCP tool or when the user asks about noodles, nanoodle graphs, or adding/changing workflow tools.
---

# What a noodle is

A **noodle** is a workflow graph built visually in the [nanoodle](https://nanoodle.com)
editor: a feed-forward DAG of AI nodes (LLM, image, video, audio, edit, ...) that
runs on the NanoGPT API with the user's own key. Saved graphs are
`noodle-graph.json` files. This plugin's MCP server scans one directory of those
files at startup and serves **each file as one MCP tool**.

# Facts that matter when calling these tools

- **Every call spends real money** from the user's nano-gpt.com balance. Don't
  loop or retry aggressively; the final content block of every result reports
  the run's cost as `cost: $X.XXXX`. Surface that cost to the user.
- **All inputs are strings.** Media-typed inputs (image / audio / video) accept
  a local file path or an `https://` URL. Local paths are read and sent inline
  (base64) — there is a ~4 MB cap, checked before any money is spent.
- **Text outputs** come back as text blocks. **Media outputs** are saved to the
  server's output directory and the result block gives the absolute saved path
  (e.g. `Image: saved /path/to/poster-Image-....png`). Read or open that file
  to show the user.
- **A failed run is not a protocol error** — it comes back as a tool result
  with `isError: true` and the failure message as text. Malformed arguments
  (unknown tool, unknown/missing/non-string argument) are rejected before
  anything is spent.
- Inputs with a baked-in default can be omitted; only inputs listed in the
  tool's `required` array must be provided.

# Adding or changing noodles

The server loads graphs **once at startup** — the tool list never changes
mid-session. To add or edit a tool:

1. Build and test the workflow at [nanoodle.com](https://nanoodle.com), press
   💾, and save the downloaded `noodle-graph.json` into the configured noodles
   folder. The filename (minus `.json`, sanitized to `[a-z0-9_-]`) becomes the
   tool name.
2. Restart the MCP server (in Claude Code: `/mcp` → reconnect, or restart the
   session) to pick it up.

Graphs that use browser-only nodes (resize, combine, trim, extract-audio,
video-frames, soundtrack) are skipped at startup with a stderr note — the
headless executor can't run those.
