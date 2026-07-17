# nanoodle-mcp

**Your saved nanoodle workflows, as MCP tools.** Point this server at a folder
of `noodle-graph.json` saves from the [nanoodle](https://nanoodle.com) editor
and every graph becomes a tool any MCP client can call — Claude Code, Claude
Desktop, or anything else that speaks the
[Model Context Protocol](https://modelcontextprotocol.io).

Zero-dependency MCP implementation (stdio, JSON-RPC 2.0, hand-rolled — small
enough to read). Two runtime dependencies:
[`nanoodle`](https://github.com/nanoodlecom/nanoodle-js), the zero-dep workflow
executor that does all the heavy lifting, and
[`nanocurrency`](https://github.com/marvinroger/nanocurrency-js) for signing
Nano blocks in [wallet mode](#wallet-mode--no-account-no-api-key-x402).

**Which repo do I want?** This server exposes saved workflows as typed MCP
tools. If your agent supports Agent Skills rather than MCP servers,
[nanoodle-skill](https://github.com/nanoodlecom/nanoodle-skill) (teaches your
agent to build any graph) and
[noodle-skills](https://github.com/nanoodlecom/noodle-skills) (prebuilt
one-task workflows) cover similar ground without running a server. Running
graphs in GitHub CI? →
[run-noodle-action](https://github.com/nanoodlecom/run-noodle-action).

## ⚠️ This spends real money

The server runs on **your** money — either a
[nano-gpt.com](https://nano-gpt.com) API key (BYOK) or, keyless, your own Nano
wallet via [x402](#wallet-mode--no-account-no-api-key-x402). **Every
`tools/call` executes a workflow against the NanoGPT API and spends from that
balance** — and the caller is usually an AI agent deciding on its own when to
call. Point it only at graphs you're happy to have run, and keep an eye on
your balance. Each result ends with a `cost: $X.XXXX` line so the agent (and
you) can see what a call cost.

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
npm install -g nanoodle-mcp
```

(Hacking on it? `git clone https://github.com/nanoodlecom/nanoodle-mcp && cd
nanoodle-mcp && npm install`, then run it as `node bin/nanoodle-mcp.mjs`.)

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
  nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY from a .env-style file
                 (--key wins over its NANOGPT_API_KEY if both given)
  --nano-rpc u   Nano RPC node for wallet mode (default https://rpc.nano.to; NANO_RPC_URL)
  --max-usd n    wallet mode: refuse any single x402 invoice above $n

No API key? Set NANO_SEED or NANO_PRIVATE_KEY (env or --env-file) to run accountless:
each call's HTTP 402 invoice is paid in Nano (XNO) from that wallet via x402.
Use a dedicated wallet with a small balance — it doubles as your spend cap.

The server speaks MCP over stdio — wire it into an MCP client, don't run it by hand.
Every tools/call spends real money (your NanoGPT balance, or your Nano wallet).
```

(`--help` / `-h` prints the same text.)

Key precedence matches the nanoodle CLI: `--key` > `--env-file` >
`NANOGPT_API_KEY`. It refuses to start if the directory holds no runnable
graphs, and says why per file.

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

**This is a hot wallet.** Use a dedicated wallet holding pocket money, not
your savings: its balance is a natural spend ceiling, and `--max-usd` adds a
per-call one on top. NanoGPT auto-refunds overpayments and failed generations
on its side.

**Prefer prepay?** Wallet mode settles on-chain per call. If you'd rather pay
once and draw down a balance, that's exactly what a NanoGPT account is:
[deposit crypto](https://docs.nano-gpt.com/api-reference/endpoint/crypto-deposits)
(Nano included) into an account, take its API key, and run the server in
normal BYOK mode — same tools, one payment instead of many.

### Claude Code

```bash
claude mcp add nanoodle -- npx nanoodle-mcp --graphs ~/noodles
```

From a git clone, point at the binary directly instead:

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

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT or Anthropic. Build
workflows at [nanoodle.com](https://nanoodle.com); run them from code with
[nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) /
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py).
