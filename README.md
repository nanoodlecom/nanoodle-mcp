# nanoodle-mcp

**Build a multi-model media pipeline visually at [nanoodle.com](https://nanoodle.com) — then hand the whole pipeline to your agent as ONE typed tool.**

Point this MCP stdio server at a folder of `noodle-graph.json` saves from the
nanoodle editor and every graph becomes a callable tool with a derived input
schema — in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, or anything
else that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

No middleman server, no account, no telemetry. The MCP implementation here is
hand-rolled and dependency-free (stdio, JSON-RPC 2.0 — small enough to read),
and the one runtime dependency is [`nanoodle`](https://github.com/nanoodlecom/nanoodle-js),
the zero-dep workflow executor. Your NanoGPT API key goes straight from your
machine to [nano-gpt.com](https://nano-gpt.com); it is never logged and never
appears on stdout.

## Install

You need: **Node 20+**, a folder of saved graphs (say `~/noodles` — see
[Making graphs](#making-graphs)), and a [nano-gpt.com](https://nano-gpt.com)
API key in `NANOGPT_API_KEY` (or passed via `--key` / `--env-file`).

> npm publish is landing alongside the public launch. Until `npx nanoodle-mcp`
> resolves, clone this repo, `npm install && npm link`, and use `nanoodle-mcp`
> (or `node /path/to/nanoodle-mcp/bin/nanoodle-mcp.mjs`) as the command instead.

### Claude Code

```bash
claude mcp add nanoodle --env NANOGPT_API_KEY=your-key-here -- npx -y nanoodle-mcp --graphs ~/noodles
```

Or install it as a plugin — Claude Code prompts for your noodles folder and
API key, and also learns what a noodle is (this repo doubles as a plugin
marketplace):

```
/plugin marketplace add nanoodlecom/nanoodle-mcp
/plugin install nanoodle@nanoodle
```

### Cursor

[Install in Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=nanoodle&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm5hbm9vZGxlLW1jcCIsIi0tZ3JhcGhzIiwifi9ub29kbGVzIl0sImVudiI6eyJOQU5PR1BUX0FQSV9LRVkiOiJZT1VSX05BTk9HUFRfS0VZIn19)
(then edit the graphs path and key), or add to `.cursor/mcp.json` yourself:

```json
{
  "mcpServers": {
    "nanoodle": {
      "command": "npx",
      "args": ["-y", "nanoodle-mcp", "--graphs", "/absolute/path/to/noodles"],
      "env": { "NANOGPT_API_KEY": "your-key-here" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json` — note VS Code's root key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "nanoodle": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nanoodle-mcp", "--graphs", "/absolute/path/to/noodles"],
      "env": { "NANOGPT_API_KEY": "your-key-here" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "nanoodle": {
      "command": "npx",
      "args": ["-y", "nanoodle-mcp", "--graphs", "/absolute/path/to/noodles"],
      "env": { "NANOGPT_API_KEY": "your-key-here" }
    }
  }
}
```

### Claude Desktop

Same shape as Cursor/Windsurf, in `claude_desktop_config.json` under
`mcpServers`.

### ChatGPT

Not reachable: ChatGPT only connects to remote HTTPS MCP servers, and this is
a local stdio server by design. A hosted endpoint would put a middleman
between your API key and NanoGPT, which is the opposite of the point — so
none is planned.

## ⚠️ This spends real money

BYOK: the server runs on **your** nano-gpt.com API key. **Every `tools/call`
executes a workflow against the NanoGPT API and spends from your balance** —
and the caller is usually an AI agent deciding on its own when to call. Point
it only at graphs you're happy to have run, and keep an eye on your balance.
Each result ends with a `cost: $X.XXXX` line so the agent (and you) can see
what a call cost.

## How it works

```
~/noodles/
  generate-hero-image.json   →  tool "generate-hero-image"
  make-jingle.json           →  tool "make-jingle"
```

Every readable `*.json` graph in `--graphs` becomes one MCP tool:

| Tool field | Derived from the graph |
| --- | --- |
| `name` | filename minus `.json`, sanitized to `[a-z0-9_-]` (duplicates get `-2`, `-3`, …) |
| `description` | the graph's node chain in dependency order (e.g. `text -> llm -> image`) plus a spend warning |
| `inputSchema` | one string property per unwired field, exactly like the nanoodle CLI's `inspect`; dropdown fields become `enum`s; only inputs without a baked-in default are `required` |
| media inputs | image / audio / video inputs take a **file path or https URL** — local files ride inline as base64 |
| result | text outputs as text blocks; media outputs saved into `--out` (default `./nanoodle-out`) with the absolute path returned; a final text block reports the run's cost |

Protocol behavior worth knowing: malformed calls (unknown tool, unknown /
missing / non-string argument) are rejected as JSON-RPC `-32602` **before any
money is spent**; a run that fails (network, model error, missing key) comes
back as a normal tool result with `isError: true`.

```
usage: nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path]

  --graphs dir   directory of noodle-graph.json saves (required)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY from a .env-style file
```

Key precedence matches the nanoodle CLI: `--key` > `--env-file` >
`NANOGPT_API_KEY`. The server refuses to start if the directory holds no
runnable graphs, and says why per file on stderr; stdout is protocol only.

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

## Registry

`server.json` is the [official MCP registry](https://registry.modelcontextprotocol.io)
manifest (`io.github.nanoodlecom/nanoodle-mcp`); see [PUBLISHING.md](PUBLISHING.md)
for the release checklist.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT or Anthropic. Build
workflows at [nanoodle.com](https://nanoodle.com); run them from code with
[nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) /
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py).
