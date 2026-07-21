# nanoodle-mcp

**Build a multi-model media pipeline visually at [nanoodle.com](https://nanoodle.com) — then hand the whole pipeline to your agent as ONE typed tool.**

> **Skill or MCP?** Running (or designing) a *single* workflow? The
> [nanoodle skill](https://github.com/nanoodlecom/nanoodle-skill) is one
> command and no setup. This server is for when you've built up a *folder*
> of saved graphs and want each one exposed to your agent as its own tool.

Point this MCP stdio server at a folder of `noodle-graph.json` saves from the
nanoodle editor and every graph becomes a callable tool with a derived input
schema — in Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, or anything
else that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

No middleman server, no telemetry — and with [wallet mode](#wallet-mode--no-account-no-api-key-x402),
no account either. The MCP implementation here is hand-rolled (stdio, JSON-RPC
2.0 — small enough to read). Two runtime dependencies:
[`nanoodle`](https://github.com/nanoodlecom/nanoodle-js), the zero-dep workflow
executor that does all the heavy lifting, and
[`nanocurrency`](https://github.com/marvinroger/nanocurrency-js) for signing
Nano blocks in wallet mode. Your NanoGPT API key goes straight from your
machine to [nano-gpt.com](https://nano-gpt.com); it is never logged and never
appears on stdout.

## Install

You need: **Node 20+**, a folder of saved graphs (say `~/noodles` — see
[Making graphs](#making-graphs)), and a [nano-gpt.com](https://nano-gpt.com)
API key in `NANOGPT_API_KEY` (or passed via `--key` / `--env-file`) — or no
key at all with a Nano wallet, see
[wallet mode](#wallet-mode--no-account-no-api-key-x402).

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

The server runs on **your** money — either a nano-gpt.com API key (BYOK) or,
keyless, your own Nano wallet via
[x402](#wallet-mode--no-account-no-api-key-x402). **Every `tools/call`
executes a workflow against the NanoGPT API and spends from that balance** —
and the caller is usually an AI agent deciding on its own when to call. Point
it only at graphs you're happy to have run, and keep an eye on your balance.
Each result ends with a `cost: $X.XXXX` line so the agent (and you) can see
what a call cost.

## Wallet mode — no account, no API key (x402)

NanoGPT supports [x402 accountless payments](https://docs.nano-gpt.com/api-reference/miscellaneous/x402):
a keyless API call answers `HTTP 402` with a Nano invoice, you pay it, the
call completes. Give the server a wallet and it does this automatically —
**no NanoGPT account, no API key, no signup anywhere**:

```bash
export NANO_SEED=<64-hex seed>        # account 0 pays; or NANO_PRIVATE_KEY=<64-hex key>
nanoodle-mcp --graphs ~/noodles --max-usd 0.50
```

Per call, the server: sees the 402 invoice → signs a Nano send block locally →
broadcasts it through a Nano RPC node (`--nano-rpc` / `NANO_RPC_URL`, default
[rpc.nano.to](https://rpc.nano.to)) → NanoGPT detects the deposit and returns
the result. The seed/private key never leaves the process: only the *signed
block* goes to the RPC node, and neither secret is ever logged. An API key,
if present, always wins — the wallet is only used keyless.

**Proof-of-work reliability.** Every send block needs Nano proof-of-work. The
server asks the RPC node's `work_generate` first, but public nodes routinely
refuse or throttle it (no GPU, key required); the fallback is local
single-threaded CPU work, which can take a minute. For fast, dependable sends,
run [nano-work-server](https://github.com/nanocurrency/nano-work-server) on
the same machine and point `--work-rpc` / `NANO_WORK_URL` at it
(`nano-work-server --cpu-threads 8 -l 127.0.0.1:7076` → work in a few
seconds). Order: `--work-rpc` → `--nano-rpc` node → local CPU.

**This is a hot wallet.** Use a dedicated wallet holding pocket money, not
your savings: its balance is a natural spend ceiling, and `--max-usd` adds a
per-call one on top. NanoGPT auto-refunds overpayments and failed generations
on its side.

**Prefer prepay?** Wallet mode settles on-chain per call. If you'd rather pay
once and draw down a balance, that's exactly what a NanoGPT account is:
[deposit crypto](https://docs.nano-gpt.com/api-reference/endpoint/crypto-deposits)
(Nano included) into an account, take its API key, and run the server in
normal BYOK mode — same tools, one payment instead of many.

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
| `description` | the graph's first comment (if any), its node chain in dependency order with node names (e.g. `text:Feature -> llm -> image:Mockup`), a `returns …` contract (output kinds with the sink's model/size and the saved-to-disk note), a spend warning, and — once the tool has run — its last observed cost (`last run $0.018`) |
| `inputSchema` | one string property per unwired field, exactly like the nanoodle CLI's `inspect`; dropdown fields become `enum`s; only inputs without a baked-in default are `required` |
| media inputs | image / audio / video inputs take a **file path or https URL** — local files ride inline as base64 |
| result | text outputs as text blocks; media outputs saved into `--out` (default `./nanoodle-out`) with the absolute path returned; a final text block reports the run's cost |

Protocol behavior worth knowing: malformed calls (unknown tool, unknown /
missing / non-string argument) are rejected as JSON-RPC `-32602` **before any
money is spent**; a run that fails (network, model error, missing key) comes
back as a normal tool result with `isError: true`.

```
usage: nanoodle-mcp --graphs <dir> [--graphs <dir> …] [--out dir] [--key K] [--env-file path] [--nano-rpc url] [--work-rpc url] [--max-usd n]

  --graphs dir   directory of noodle-graph.json saves (required; repeat to serve
                 several dirs — scanned in order, so an earlier dir wins name clashes)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY / NANO_WORK_URL from a .env-style file
  --nano-rpc u   Nano RPC node for wallet mode (default https://rpc.nano.to; NANO_RPC_URL)
  --work-rpc u   dedicated work_generate endpoint, e.g. a local nano-work-server
                 (NANO_WORK_URL; falls back to --nano-rpc, then local CPU work)
  --max-usd n    wallet mode: refuse any single x402 invoice above $n
```

Key precedence matches the nanoodle CLI: `--key` > `--env-file` >
`NANOGPT_API_KEY`; wallet secrets come only from the environment or
`--env-file`, never argv. The server refuses to start if no directory holds a
runnable graph, and says why per file on stderr; stdout is protocol only.

### Per-project graphs + a shared library

`--graphs` is repeatable, so one server can merge several folders. The pattern:
commit a `noodles/` dir to a repo for that project's own tools, then list your
global library after it as a fallback:

```
nanoodle-mcp --graphs ./noodles --graphs ~/noodles
```

Dirs are scanned in the order given, and **the earlier dir wins a name clash**:
if both folders have a `changelog.json`, the project's becomes `changelog` and
the shared one becomes `changelog-2`. So a project can override a shared tool
just by dropping a same-named graph in `./noodles`, while everything else in
`~/noodles` stays available. An unreadable dir (a typo, a folder that isn't
there) is a hard startup error naming the offender — no silent half-load.

## Run any share link

Every nanoodle share link is an executable tool. Alongside your saved graphs the
server always exposes one more tool, **`run_noodle`**, that takes any share link
and runs it — no file needed:

```
run_noodle("https://nanoodle.com/#g=…", { "Text": "a lighthouse at dawn" })
```

Pass the link as `url` and any workflow inputs as `inputs` (the same friendly
keys the graph's own tool would take; media inputs take a file path or https
URL). It accepts `#g=`/`#j=` workflow links, `#a=` app links, and short links
to one. Direct links decode locally; only fragment-less short links trigger a
network read, and it carries no credentials. Like every other tool, a run
**spends real money** and ends with a `cost: $X.XXXX` line.

## Making graphs

Build and test workflows in the [nanoodle editor](https://nanoodle.com), hit
💾, and drop the downloaded `noodle-graph.json` into your `--graphs` folder
(rename it — the filename becomes the tool name). Restart the server (or your
MCP client) to pick up new files.

### Describing your tools

The first comment node in a graph doubles as the MCP tool's description: its
text leads the auto-derived node chain, so the calling agent reads your words
first. Keep it to one sentence saying what the tool produces from what inputs —
e.g. *"Renders a product mockup image from a one-line feature description."*
Long text is truncated to 200 characters and whitespace is collapsed, so write
for one line. Graphs without a comment just get the node chain, as before.

After each successful run the tool's real cost is recorded in
`<out>/costs.json` (a small `{tool: {usd, at}}` sidecar next to your media
outputs) and folded into the description as `last run $X` — observed, not
estimated. The server announces the change with a
`notifications/tools/list_changed` notification, so MCP clients that honor it
show updated prices mid-session; others catch up on restart.

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
- **Local media nodes need nanoodle ≥ 0.4** (this package's dependency).
  Graphs using resize, combine, trim, extract-audio, video-frames, or
  soundtrack run headlessly — pure JS where possible, ffmpeg on `PATH` for
  the rest (see the [supported-nodes
  table](https://github.com/nanoodlecom/nanoodle-js#supported-nodes)). A
  graph with a node type the library doesn't know is still skipped at
  startup with a stderr note.
- **Media rides inline.** NanoGPT has no upload endpoint, so media inputs are
  sent as base64 in the request body (~4 MB max, checked before spending).
- **No cost cap in key mode.** The server won't stop a client from calling an
  expensive graph repeatedly. Your NanoGPT balance is the only brake. (Wallet
  mode is better here: `--max-usd` caps each call, and the wallet's balance
  caps the total.)

No telemetry, no analytics; the API key and wallet secrets are never logged
and never appear on stdout.

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

## Which repo do I want?

This server exposes saved workflows as typed MCP tools. If your agent supports
Agent Skills rather than MCP servers,
[nanoodle-skill](https://github.com/nanoodlecom/nanoodle-skill) (teaches your
agent to build any graph) and
[noodle-skills](https://github.com/nanoodlecom/noodle-skills) (prebuilt
one-task workflows) cover similar ground without running a server. Running
graphs in GitHub CI? →
[run-noodle-action](https://github.com/nanoodlecom/run-noodle-action).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT or Anthropic. Build
workflows at [nanoodle.com](https://nanoodle.com); run them from code with
[nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) /
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py).
