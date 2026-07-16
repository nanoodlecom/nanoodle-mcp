# nanoodle-mcp

**Your saved nanoodle workflows, as MCP tools.** Point this server at a folder
of `noodle-graph.json` saves from the [nanoodle](https://nanoodle.com) editor
and every graph becomes a tool any MCP client can call — Claude Code, Claude
Desktop, or anything else that speaks the
[Model Context Protocol](https://modelcontextprotocol.io).

Zero-dependency MCP implementation (stdio, JSON-RPC 2.0, hand-rolled — small
enough to read). The one runtime dependency is
[`nanoodle`](https://github.com/nanoodlecom/nanoodle-js), the zero-dep workflow
executor that does all the heavy lifting.

**Which repo do I want?** This server exposes saved workflows as typed MCP
tools. If your agent supports Agent Skills rather than MCP servers,
[nanoodle-skill](https://github.com/nanoodlecom/nanoodle-skill) (teaches your
agent to build any graph) and
[noodle-skills](https://github.com/nanoodlecom/noodle-skills) (prebuilt
one-task workflows) cover similar ground without running a server. Running
graphs in GitHub CI? →
[run-noodle-action](https://github.com/nanoodlecom/run-noodle-action).

## ⚠️ This spends real money

BYOK: the server runs on **your** [nano-gpt.com](https://nano-gpt.com) API key.
**Every `tools/call` executes a workflow against the NanoGPT API and spends
from your balance** — and the caller is usually an AI agent deciding on its
own when to call. Point it only at graphs you're happy to have run, and keep
an eye on your balance. Each result ends with a `cost: $X.XXXX` line so the
agent (and you) can see what a call cost.

## How it works

```
~/noodles/
  generate-hero-image.json   →  tool "generate-hero-image"
  make-jingle.json           →  tool "make-jingle"
```

For each graph:

- **Tool name** — the filename minus `.json`, sanitized to `[a-z0-9_-]`.
- **Description** — the graph's node chain (e.g. `text -> llm -> image; runs
  on NanoGPT …`), so the client knows what it does before calling.
- **Input schema** — derived from the workflow's unwired fields, exactly like
  the nanoodle CLI's `inspect`. Every input is a string; media-typed inputs
  (image / audio / video) take a **file path or https URL**.
- **Result** — text outputs come back as text blocks; media outputs are saved
  into `--out` (default `./nanoodle-out`) and the absolute path is returned.
  A final text block reports the run's cost.

## Install

```bash
npm install -g nanoodle-mcp     # not published to npm yet — until then:
git clone https://github.com/nanoodlecom/nanoodle-mcp && cd nanoodle-mcp
npm install && npm link         # `npm link` puts `nanoodle-mcp` on your PATH
```

(No `npm link`? Run it directly as `node bin/nanoodle-mcp.mjs` instead of
`nanoodle-mcp` below.)

## Quickstart

```bash
export NANOGPT_API_KEY=...      # or --key K, or --env-file .env
nanoodle-mcp --graphs ~/noodles --out ~/noodle-out
```

The server speaks MCP over stdio — you normally don't run it by hand, your
MCP client does. Startup logs (which tools loaded, which files were skipped
and why) go to stderr; stdout is protocol only.

```
usage:
  nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY from a .env-style file (--key wins if both given)

The server speaks MCP over stdio — wire it into an MCP client, don't run it by hand.
Every tools/call spends real money from your NanoGPT balance.
```

(`--help` / `-h` prints the same text.)

Key precedence matches the nanoodle CLI: `--key` > `--env-file` >
`NANOGPT_API_KEY`. It refuses to start if the directory holds no runnable
graphs, and says why per file.

### Claude Code

```bash
claude mcp add nanoodle -- npx nanoodle-mcp --graphs ~/noodles
```

`npx nanoodle-mcp` works once the package is on npm (not published yet). From
a git clone, point at the binary directly:

```bash
claude mcp add nanoodle -- node /path/to/nanoodle-mcp/bin/nanoodle-mcp.mjs --graphs ~/noodles
```

### Claude Desktop

Add to `claude_desktop_config.json` (same note as above: until the npm
publish, swap `"command": "npx"` / `"args": ["nanoodle-mcp", ...]` for
`"command": "node"` / `"args": ["/path/to/nanoodle-mcp/bin/nanoodle-mcp.mjs", ...]`):

```json
{
  "mcpServers": {
    "nanoodle": {
      "command": "npx",
      "args": ["nanoodle-mcp", "--graphs", "/Users/you/noodles"],
      "env": { "NANOGPT_API_KEY": "your-key-here" }
    }
  }
}
```

Then ask for what a graph produces — "make me a hero image of a lighthouse at
dawn" — and the client calls the matching tool.

## Run any share link

Every nanoodle share link is an executable tool. Alongside your saved graphs the
server always exposes one more tool, **`run_noodle`**, that takes any share link
and runs it — no file needed:

```
run_noodle("https://nanoodle.com/#g=…", { "Text": "a lighthouse at dawn" })
```

Pass the link as `url` and any workflow inputs as `inputs` (the same friendly
keys the graph's own tool would take; media inputs take a file path or https
URL). It accepts `#g=`/`#j=` workflow links, `#a=` app links, and da.gd /
TinyURL short links. Direct links decode locally; only fragment-less short links
trigger a network read, and it carries no credentials. Like every other tool, a
run **spends from your NanoGPT balance** and ends with a `cost: $X.XXXX` line.

## Making graphs

Build and test workflows in the [nanoodle editor](https://nanoodle.com), hit
💾, and drop the downloaded `noodle-graph.json` into your `--graphs` folder
(rename it — the filename becomes the tool name). Restart the server (or your
MCP client) to pick up new files.

## Limitations

Honest list — most of these are inherited from the executor:

- **Feed-forward DAGs only.** nanoodle graphs are stateless pipelines; there
  are no loops, no conversations, no memory between calls.
- **One run per call, no streaming.** A `tools/call` blocks until the whole
  workflow finishes — video graphs can take minutes. No MCP progress
  notifications yet.
- **Graphs load once at startup.** Adding or editing files in `--graphs`
  needs a restart; the tool list doesn't change mid-session (no
  `listChanged` notifications).
- **Browser-only nodes don't run.** Graphs using local media processing
  (resize, combine, trim, extract-audio, video-frames, soundtrack) are
  skipped at startup with a stderr note — the library can't run them.
- **Media rides inline.** NanoGPT has no upload endpoint, so media inputs are
  sent as base64 in the request body (~4 MB max, checked before spending).
- **No cost cap.** The server won't stop a client from calling an expensive
  graph repeatedly. Your NanoGPT balance is the only brake.

No telemetry, no analytics; the API key is never logged and never appears on
stdout.

## Testing

Fully offline — the suite spawns the real server against a canned local
NanoGPT stub and drives the MCP handshake over stdio:

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT or Anthropic. Build
workflows at [nanoodle.com](https://nanoodle.com); run them from code with
[nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) /
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py).
