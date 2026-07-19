---
name: nanoodle-skill
description: Build and run nanoodle graphs — multi-model AI media pipelines (text, LLM, image, video, audio) saved as a single noodle-graph.json and executed headlessly against the NanoGPT API. Use when the user wants an AI image/video/audio or multi-model generation pipeline, wants to run or automate a nanoodle workflow / noodle-graph.json file, or brings a nanoodle.com share link (#g= graph or #a= app).
license: MIT
metadata:
  author: nanoodlecom
  homepage: https://nanoodle.com
---

# nanoodle: build and run multi-model AI pipelines

[nanoodle](https://nanoodle.com) is a browser-based node editor for AI workflows:
you wire text, LLM, image, video, and audio nodes into a feed-forward graph
("noodle"), run it against the [NanoGPT](https://nano-gpt.com) API with your own
key, turn it into a shareable app, and export it as a single self-contained HTML
file. There is no backend and no analytics — the API key and workflows stay in
the browser (or, headlessly, in your process). A saved workflow is one JSON file
(`noodle-graph.json`) that the official executor packages re-run byte-for-byte:
`nanoodle` on npm (Node >= 20, zero deps) and `nanoodle` on PyPI (Python >= 3.9,
stdlib only). Same graphs, same semantics, in either runtime.

## API key (bring your own)

Every generation is billed by NanoGPT against the user's own balance:

1. The user creates an API key at [nano-gpt.com](https://nano-gpt.com) (an OAuth
   access token also works) and funds the balance.
2. Export it as `NANOGPT_API_KEY` — both executors read that env var by default.

Never print or log the key. Loading, validating, and inspecting a workflow never
calls the API; only `run` spends money.

## Run a graph headlessly

### CLI (Node — `nanoodle` on npm; 0.4.0 is current, the core surface below needs >= 0.2.0)

```sh
export NANOGPT_API_KEY=...

# Inspect first — offline, free; prints the graph's inputs, outputs, settings, nodes
npx nanoodle inspect graph.json

# Run — calls NanoGPT and spends from the balance
npx nanoodle run graph.json --input Text="a cozy ramen shop"
```

Full surface (from `npx nanoodle --help`):

```
nanoodle run <graph.json|share-url> [--input k=v]... [--set k=v]... [--out dir] [--json] [--key K] [--env-file path] [--timeout ms]
nanoodle inspect <graph.json|share-url>
nanoodle init [path]
nanoodle --help | --version
```

- `run` executes a workflow (needs an API key, spends from the balance);
  `inspect` shows a workflow's inputs, outputs, and settings — fully offline, no
  key needed; `init` writes the starter graph (text → LLM prompt-writer → image)
  to path (default `./noodle-graph.json`). Both `run` and `inspect` take a local
  file or a share URL directly.
- `--input k=v` — set a workflow input (`Text=hello`, `n2.system=@notes.txt`;
  `@path` reads a file — media files ride as media, `.txt`/`.md`/`.json` as text)
- `--set k=v` — override a setting (`n3.model=flux-pro`, `n3.size=1k`)
- `--out dir` — directory for media outputs (default `./noodle-out`, created
  only when needed). Media is always written to disk as `<OutputKey>.<ext>` —
  extension follows MIME, so use the path the CLI prints, don't hard-code
  `.png`. Text outputs land in the run summary.
- `--json` — quiet mode: skips the progress/log lines on stderr. The JSON run
  summary — `outputs` (paths/text), `costUsd`, `costExact`, `remainingBalance`,
  `errors`, per-node statuses — is **always** printed to stdout either way;
  `--json` only silences the human-readable stderr chatter.
- `--key K` / `--env-file p` — key precedence here: `--key` > `--env-file` >
  `NANOGPT_API_KEY`
- `--pay` (0.4+) — accountless run, no API key or account: each paid call
  prints a Nano (XNO) invoice as a scannable QR + `nano:` URI on stderr and
  waits for the deposit (x402; ignores any configured key; a self-custody
  wallet does the send)
- `--timeout ms` — overall run timeout, in milliseconds
- Exit code 0 on success, 1 on failure (the JSON summary still carries partial
  results when an output node failed)

### CLI (Python — `pip install nanoodle`, >= 0.2.0)

Installed as `nanoodle-py` (`python -m nanoodle` always works); same `run` /
`inspect` commands and graph semantics, but a narrower and slightly different
flag surface:

```sh
nanoodle-py inspect graph.json
nanoodle-py run graph.json --input Text="a cozy ramen shop" --set n3.size=1k --out ./out
```

Porting notes (Python vs Node CLI):

- The key flag is `--api-key` (not `--key`).
- `--timeout` is in **seconds** (not milliseconds).
- An ambient `NANOGPT_API_KEY` wins over `--env-file`; in the Node CLI
  `--env-file` wins.
- PyPI 0.2.0 runs share URLs directly (same as the Node CLI). Both published
  CLIs have the accountless x402 `--pay` mode (npm needs 0.4+). There is no
  `init` command — for the starter-graph scaffold, use the Node CLI.

### Library (JavaScript)

```js
import { Workflow } from "nanoodle";

const wf = await Workflow.load("noodle-graph.json");           // key from NANOGPT_API_KEY
const result = await wf.run({ Text: "a cozy ramen shop on a rainy night" });
await result.get("Image").save("ramen.png");                   // media: MediaRef (url + bytes()/save())
console.log(result.costUsd, result.remainingBalance);
```

Discover the interface programmatically: `wf.inputs`, `wf.outputs`,
`wf.settings`. Media inputs: `mediaFromFile("photo.jpg")`, an `https://` URL, or
raw bytes. Settings/timeout/progress ride on the second argument:
`wf.run(inputs, { settings: { "n3.model": "flux-dev" }, timeoutMs, onProgress })`.
`run()` rejects with `RunError` when an output node fails; `err.result` still
has partial results and cost so far.

### Library (Python)

```python
from nanoodle import Workflow

wf = Workflow.load("noodle-graph.json")
result = wf.run({"Text": "a cozy ramen shop on a rainy night"})
result["Image"].save("ramen.png")            # media: MediaRef (url + bytes()/save())
print(result.cost_usd, result.remaining_balance)
```

Same shape, snake_case: `wf.inputs/outputs/settings`, `media_from_file(...)`,
`wf.run(inputs, settings={...}, timeout=600, on_progress=...)`, `RunError` with
`error.result`.

### Input, output, and setting keys

Input keys are flexible and case-insensitive: the node's custom name (`"Idea"`),
`nodeId.field` (`"n2.system"`), or the input's label when unique. Output keys
are the sink node's custom name (or its type name). Settings use `nodeId.field`
keys (`"n3.model"`). A workflow with exactly one required input also accepts a
bare value: `wf.run("hello")`. Run `inspect` to see the real keys — what it
prints is authoritative.

## The noodle-graph.json shape

A graph is plain JSON — nodes with typed ports, links between matching port
kinds (text | image | audio | video), no cycles:

```json
{
  "v": 1,
  "nodes": [
    { "id": "n1", "type": "text",  "name": "Idea",   "fields": { "text": "a cozy ramen shop" } },
    { "id": "n2", "type": "llm",   "fields": { "model": "zai-org/glm-5.2", "system": "You write image prompts..." } },
    { "id": "n3", "type": "image", "name": "Poster", "fields": { "model": "nano-banana-2-lite", "size": "1k" } }
  ],
  "links": [
    { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } },
    { "id": "l2", "from": { "node": "n2", "port": "text" }, "to": { "node": "n3", "port": "prompt" } }
  ]
}
```

You can author this by hand (both executors accept the minimal `{nodes, links}`
form) or build it visually at nanoodle.com and press 💾 Save. Node `name` values
become the input/output keys agents use — name every node you'll touch. Full
field-by-field detail and the node-type table:
[references/graph-format.md](references/graph-format.md). A complete runnable
example (idea → LLM prompt-writer → poster image) is at
[examples/poster.noodle-graph.json](examples/poster.noodle-graph.json):

```sh
npx nanoodle run examples/poster.noodle-graph.json --input "Idea=..." --out ./out
```

## Running the user's own workflow

The user doesn't install their graphs — they just give you one. Two forms, both
run the same way:

- **A file** they saved from nanoodle.com — `something.noodle-graph.json`.
- **A share link** — `https://nanoodle.com/#g=...`.

When they hand you either, do this:

```sh
# 1. Read its interface (free, offline) — this tells you the input names to ask for
npx nanoodle inspect their-graph.json      # or the "#g=..." URL, quoted

# 2. Run it with those inputs
npx nanoodle run their-graph.json --input "Idea=a cozy ramen shop" --out ./out
```

`inspect` prints the exact input and output names (they come from the names the
user gave their nodes), so you never have to guess. That's the whole thing — no
setup beyond the API key.

### Making one workflow run automatically

If the user wants a graph to fire on its own whenever they ask for that kind of
thing (e.g. "make a poster" always running *their* poster graph), it becomes its
own little skill — a folder with the `.noodle-graph.json` and a short `SKILL.md`.
Step-by-step recipe:
[docs/agent-skills.md](https://github.com/nanoodlecom/nanoodle-js/blob/main/docs/agent-skills.md).
Ready-made examples: [noodle-skills](https://github.com/nanoodlecom/noodle-skills).
Each workflow as a callable tool instead:
[nanoodle-mcp](https://github.com/nanoodlecom/nanoodle-mcp).

## Share links

nanoodle workflows are shared as URL fragments: `https://nanoodle.com/#g=...`
opens a graph in the editor, `https://nanoodle.com/play#a=...` opens a runnable
app. The payload lives entirely in the `#` fragment, which browsers never send
to any server — sharing a link does not upload the workflow anywhere. The Node
CLI (>= 0.2.0) takes share URLs directly — no browser round-trip needed:

```sh
npx nanoodle inspect "https://nanoodle.com/#g=..."     # offline, free
npx nanoodle run "https://nanoodle.com/#g=..." --input Text="..."
```

App links (`play#a=` / `play.html#a=`) work the same way. Quote the URL — `#` starts a shell
comment otherwise. The Python CLI (PyPI 0.2.0+) runs share URLs the same way.

## Limits and cost — be honest with the user

- **Stateless feed-forward DAG.** No loops, no branches that re-enter, no
  memory between runs. Each run is: inputs in → nodes execute in topological
  order → outputs out.
- **Every run spends real money** (except nodes that run locally). Costs are
  per-generation via NanoGPT; the result reports `costUsd`/`cost_usd`,
  `costExact` (false means some call omitted a price, so the total is a floor)
  and `remainingBalance`. A price of 0 means subscription-included, not unknown.
- **Headless executors support the NanoGPT-backed nodes** (llm, image, draw,
  edit, inpaint, vision, tvideo, ivideo, vedit, lipsync, music, remix, tts,
  transcribe) plus local ones (text, uploads, choice, join, comment). Local
  media-processing nodes (resize, vframes, combine, soundtrack, trim,
  extractaudio) also run headlessly (npm 0.4+, PyPI 0.2+): the Node CLI prefers
  a pure-JS path that matches the browser (lossless mp4 remux, PCM-WAV trim,
  PNG resize) and falls back to ffmpeg on `PATH` for everything else; the
  Python CLI needs ffmpeg on `PATH` for all of them. ffmpeg is a soft
  dependency — a clear error if it's required and missing, before any paid call.
- **Media rides inline as base64** (NanoGPT has no upload endpoint). Files over
  ~4.4 MB (~3.5 MB for transcription) are refused locally before any paid call.
- Missing keys, bad inputs, and unknown node types all fail **before** anything
  is spent.

## Full reference

- Machine-readable overview: https://nanoodle.com/llms.txt
- Format / engine / IO specs: `docs/SPEC-format.md`, `docs/SPEC-engine.md`,
  `docs/SPEC-io.md` in [nanoodle-js](https://github.com/nanoodlecom/nanoodle-js)
  (the [nanoodle-py](https://github.com/nanoodlecom/nanoodle-py) docs mirror them)
- Turning one of your own workflows into a dedicated agent skill:
  `docs/agent-skills.md` in either executor repo
