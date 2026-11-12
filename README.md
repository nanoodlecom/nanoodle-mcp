# nanoodle-mcp

**Build a multi-model media pipeline visually at [nanoodle.com](https://nanoodle.com) — then hand the whole pipeline to your agent as ONE typed tool.**

> **Skill or MCP?** Running (or designing) a *single* workflow? The
> [nanoodle skill](https://github.com/nanoodlecom/nanoodle-skill) is one
> command and no setup. This server is for when you've built up a *folder*
> of saved graphs and want each one exposed to your agent as its own tool.

Point this MCP server at a folder of `noodle-graph.json` saves from the
nanoodle editor and every graph becomes a callable tool with a derived input
schema — in Claude Code, Grok, Claude Desktop, Cursor, VS Code, Windsurf, or
anything else that speaks the [Model Context Protocol](https://modelcontextprotocol.io).
It speaks stdio to your own agent by default, or HTTP to everyone with
[serve mode](#serve-mode--host-your-noodles-as-a-service---serve) — including
[charging per call in Nano](#charging-per-call---charge-usd), so strangers'
agents can pay to run your noodles with no account anywhere — or
[selling runs for native NEAR, custom workflows included](#pay-with-near--run-custom-workflows).

No middleman server, no telemetry — and with [wallet mode](#wallet-mode--no-account-no-api-key-x402),
no account either. The MCP implementation here is hand-rolled (stdio +
streamable HTTP, JSON-RPC 2.0 — small enough to read). Two runtime dependencies:
[`nanoodle`](https://github.com/nanoodlecom/nanoodle-js) (MIT), the zero-dep
workflow executor that does all the heavy lifting, and
[`nanocurrency`](https://github.com/marvinroger/nanocurrency-js) (GPL-3.0) for
signing Nano blocks — loaded only on the x402 paths, see
[Licensing](#licensing). Your NanoGPT API key goes straight from your
machine to [nano-gpt.com](https://nano-gpt.com); it is never logged and never
appears on stdout.

## NEAR HACKATHON entry

Built at [NEAR HACKATHON](https://nearhackathon.com) (2026-11-01 to 2026-11-14), track
`agents` (Agent Economy). Only the NEAR integration described here is the entry; the rest
of this README documents the product it was added to.

**What it is.** nanoodle-mcp is an MCP server that runs nanoodle workflow graphs
(multi-step pipelines of NanoGPT text, image, video, audio and 3D models) as tools. In the
hackathon it gained a NEAR payment rail: an AI agent composes its own workflow, gets an
itemized price for free, pays with one native NEAR transfer, receives the result, and gets
the unused part of its deposit back on chain. A second piece, a worker for
[NEAR Agent Market](https://market.near.ai), sells the same workflow runs as market jobs.

**Problem.** An agent that wants to run a paid multi-model pipeline needs an account and
an API key at the provider, and cannot tell what a multi-step run will cost before it
starts. A fixed price per call means the buyer overpays or the seller loses money on
expensive runs.

**How NEAR fits.** NEAR carries the payment and the refund. The quote comes back inside
the MCP tool answer: a payment id, the receiving account, an exact yoctoNEAR amount and a
30-minute expiry. The agent sends one native `Transfer`. The server reads that transaction
from NEAR RPC at FINAL finality, checks the receiver, the exact amount, the single action,
the timing and that the hash was not used before, runs the workflow once, and signs a
refund transfer of the deposit minus the actual cost. Finality in 2–3 seconds and gas of
about 0.000045 NEAR per transfer make a deposit and refund per call practical. This is not
x402: there is no HTTP 402 and no facilitator, only an in-band MCP quote paid by a plain
transfer. Design and threat model: [docs/near-payments.md](docs/near-payments.md).

**Status.**
- Offline: the whole payment flow passes against a local NEAR chain stand-in and a local
  NanoGPT stand-in (35 checks), and the market worker passes against a local market
  stand-in that checks every request and answer against the market's OpenAPI file
  (30 checks).
- Real testnet, read-only: the transaction checker and the server's own payment verifier
  read a real testnet transfer from public RPC and pass (step 4 below).
- Not done yet: this code has **not moved real NEAR**. The first real testnet payment and
  refund is the maintainer-run step 5 below. The market worker has not been run against
  the live market. The hosted server at `mcp.nanoodle.com` defaults to Nano.
  The NEAR-first listener and wallet payment page are implemented; hosting requires
  a funded merchant and DNS for `mcp-near.nanoodle.com` (see
  [deployment instructions](docs/near-payments.md#near-endpoint-and-wallet-payments)).
- NEAR mode first ships in npm version 0.7.0. Until `npm view nanoodle-mcp version` shows
  0.7.0 or later, run it from a clone as below.

**Try it: do X, see Y.** Node 22.23.4+, 24.22.1+ or 26.12.1+. Steps 1–3 need no network
after `npm ci`, and no keys or funds.

```bash
git clone -b near-hackathon https://github.com/nanoodlecom/nanoodle-mcp && cd nanoodle-mcp && npm ci
```

| Do | See |
|---|---|
| 1. `npm run simulate:near` | The real server binary starts in NEAR mode against local stand-ins. An agent prices a custom `text → llm → image` graph, gets a quote, pays one transfer, receives the image and a receipt, and the rest of the deposit is refunded. Then replay, a reused transaction, an unsafe node, an unpriceable model, underpayment, a late payment, a failed run and a server killed mid-run and mid-refund. Ends `PASS: all 35 checks passed`. |
| 2. `npm run simulate:market` | The Agent Market worker runs as a child process against a local market stand-in: a normal job, an unsafe graph, an over-budget graph, a malformed brief, a kill and restart mid-run, and a lost submit answer. Ends `30/30 checks passed.` |
| 3. `npm test` | The full offline test suite. Ends with `ℹ fail 0` (705 tests when this was written). |
| 4. `node scripts/near-check-tx.mjs --network testnet --rpc https://archival-rpc.testnet.fastnear.com --merchant tx-bench-buddy.testnet --tx 7wg9AhBTJvKoLCTvdwACzxjLdoPACFXV9hKD12aAxYZp --sender tx-bench.testnet --amount-yocto 1` | Read-only, no keys. The payment rules the server applies (final, succeeded, receiver, one `Transfer`, exact amount) and the server's own verifier, run on a real public testnet transfer of 1 yoctoNEAR between two accounts unrelated to this project. Ends `PASS — 7/7 rules passed`. The archival RPC is used because public RPC nodes drop transactions after a few days. |
| 5. Real testnet payment and refund (maintainer-run; moves testnet NEAR, needs two funded testnet accounts and, for the last variant, a NanoGPT key) | [Prove it on testnet](#prove-it-on-testnet-turnkey): two scripts create the accounts, pay a quote, check the refund on chain and print explorer links. `--dry-run` stops before the first transfer. |

**Built in the hackathon window, and before.** The diff of the entry is
[`compare/pre-hackathon...near-hackathon`](https://github.com/nanoodlecom/nanoodle-mcp/compare/pre-hackathon...near-hackathon)
(branch `near-hackathon`). The `pre-hackathon` tag is the last commit on `main` before the
NEAR work (2026-11-06). Commits on `main` between the hackathon announcement (2026-10-19)
and that tag are Nano-payment and maintenance work; they are counted as baseline and not
claimed.

- Before: the nanoodle workflow engine ([`nanoodle`](https://github.com/nanoodlecom/nanoodle-js))
  and this server: saved graphs as typed MCP tools, BYOK, pay per call in Nano (x402),
  serve mode, the hosted server, and `run_noodle` for share links.
- In the window:
  - `src/near/`: NEAR RPC client, payment verification, refund signing (ed25519 with
    `node:crypto`, transactions serialized by hand), exact yoctoNEAR math, NEAR/USD rate,
    durable payment ledger.
  - `src/custom-workflow.mjs`: the safety allowlist and itemized pricing for workflows an
    agent composes.
  - `src/near-gate.mjs`: the NEAR payment gate, `run_noodle` with an inline `graph`, the
    free `price_noodle` and `noodle_guide` tools.
  - `src/market/` and `scripts/market-*`: the NEAR Agent Market worker, its listing catalog
    and price check ([docs/near-agent-market.md](docs/near-agent-market.md)).
  - `scripts/near-simulate.mjs`, `scripts/near-check-tx.mjs`, `scripts/near-pay.mjs`,
    `scripts/near-testnet-*.mjs`, the tests for all of the above, and the docs.
  - `src/near/rates.mjs`: NEAR/USD, XNO/USD and the NEAR→XNO swap rate derived from
    them, an optional swap margin, background and forced refresh, `GET /rates`; receipts
    with three money legs (caller payment, model payment, refund) and per-call operator
    accounting in the ledger.
  - `src/rail-router.mjs` and `scripts/dual-simulate.mjs`: one server that accepts Nano or
    NEAR per call (`--charge-usd` together with `--near-merchant`).

**Declarations.**
- Baseline (own, pre-hackathon, MIT): the nanoodle engine and the nanoodle-mcp server.
- Libraries: the two Node runtime dependencies predate the hackathon:
  `nanoodle` (MIT, own) and `nanocurrency` (GPL-3.0, Nano signing; see
  [Licensing](#licensing)). Server-side NEAR verification and signing use Node built-ins.
  The wallet payment page bundles NEAR Connect 0.12.0 (MIT, HOT Labs), with esbuild
  as a build tool; both are pinned development dependencies. See [assets/README.md](assets/README.md).
- AI-generated code: most of the code, tests and documentation in the hackathon diff were
  written with AI coding assistants, directed by the maintainer.
- Other chains: the pre-existing product accepts payment in Nano (XNO) through x402. That
  is not part of the entry.
- External services the NEAR code calls: public NEAR RPC (fastnear by default), CoinGecko
  for the NEAR/USD rate (can be pinned with `--near-usd`), NanoGPT for the models, and, in
  the testnet scripts only, the NEAR testnet account helper.

## Example: a description becomes a playable fighter

[Play Iron Verdict](https://nanoodle.com/examples/iron-verdict/): a furnace knight
with heavy jumps, punches, ground slams and punishing arena combat. A coding
agent built the game using the
[character-sprites skill](https://github.com/nanoodlecom/noodle-skills/tree/main/skills/character-sprites).

The `character-sprites` graph turns a humanoid description into a character
reference and a matching parts sheet. The skill's local rig script turns those
parts into transparent idle, walk, punch and jump frames with an atlas and
timing metadata. The coding agent then implements physics, combat and game
rules. The finished game demonstrates that combination; one MCP call returns
the reference and parts images, not the complete game.

Mount the [character-sprites graph](https://github.com/nanoodlecom/awesome-noodles/blob/main/graphs/character-sprites.noodle-graph.json)
in your server's graph folder to expose it as a tool. Use `tools/list` to check
whether a given server has it mounted and read its input schema before calling.
For the published graph, the generation step is:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"character-sprites","arguments":{"Character":"A compact furnace knight with an ivory helmet, amber visor, navy armor and brass gauntlets. Outlined 2D platformer art. No weapon or wings."}}}
```

Install the skill for local extraction and animation (Node 22.23.4+, 24.22.1+, or 26.12.1+ and ffmpeg/ffprobe
required). A useful agent request is: “Use character-sprites to make an animated
fighter from my description, inspect the joints and alpha edges, then build a
small playable arena with heavy gravity and impactful combat.”

## Install

You need: **Node 22.23.4+, 24.22.1+, or 26.12.1+**, a folder of saved graphs (say `~/noodles` — see
[Making graphs](#making-graphs)), and a [nano-gpt.com](https://nano-gpt.com)
API key in `NANOGPT_API_KEY` (or passed via `--key` / `--env-file`) — or no
key at all with a Nano wallet, see
[wallet mode](#wallet-mode--no-account-no-api-key-x402).

**Optional: `ffmpeg` on PATH.** Tools whose graphs include a local-media node
(resize, video frames, combine, audio trim/extract) use a pure-JS path for the
common case but fall back to `ffmpeg`/`ffprobe` for formats it can't handle —
JPEG/WebP resize, reading video frames, compressed audio. Without ffmpeg those
runs fail (and auto-refund in charge mode); the server prints a warning at
startup naming the affected tools. Pure image/LLM/vision tools don't need it.
Install with `apt install ffmpeg` (Debian/Ubuntu) / `brew install ffmpeg`.

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

### Grok

```bash
grok mcp add nanoodle -e NANOGPT_API_KEY=your-key-here -- npx -y nanoodle-mcp --graphs ~/noodles
```

Or, for a remote/serve endpoint (no local process, no API key on your machine):

```bash
grok mcp add --transport http noodles https://mcp.nanoodle.com/mcp
```

That writes `[mcp_servers.noodles]` into `~/.grok/config.toml` (or
`.grok/config.toml` with `--scope project`). Same shape by hand:

```toml
[mcp_servers.noodles]
url = "https://mcp.nanoodle.com/mcp"
enabled = true
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

ChatGPT only connects to remote HTTPS MCP servers. The hosted endpoint is
already live — add `https://mcp.nanoodle.com/mcp` (paid per call in Nano, no
API key). Local stdio (`npx nanoodle-mcp --graphs …`) stays BYOK and is not
reachable from ChatGPT.

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
single-threaded CPU work, which can take a minute. Two fast options, both via
`--work-rpc` / `NANO_WORK_URL`:

- **Hosted GPU work API** — sub-second work, no hardware. E.g.
  [nano.to's PoW API](https://docs.nano.to/pow) (`--work-rpc https://rpc.nano.to`)
  or [Nanswap Nodes](https://nanswap.com/nodes)
  (`--work-rpc https://nodes.nanswap.com/XNO` — the fast work server is on
  their paid plan; the free one queues for minutes). Put the API key in
  `NANO_WORK_KEY` (env or `--env-file`, never a flag) — it's sent as both a
  `key` body field (nano.to style) and a `nodes-api-key` header (Nanswap
  style).
- **Your own [nano-work-server](https://github.com/nanocurrency/nano-work-server)**
  on the same machine (`nano-work-server --cpu-threads 8 -l 127.0.0.1:7076` →
  work in a few seconds, free forever).

Order: `--work-rpc` (2-minute timeout, so a hung server can't stall a payment)
→ `--nano-rpc` node → local CPU. The wallet also **precomputes work for the
next block** the moment one publishes, and serve mode prewarms at boot — with
any healthy work source, callers effectively never wait on proof-of-work.

The local-CPU last resort runs on the Node main thread: in `--serve` mode a
send-difficulty grind (minutes) freezes the whole HTTP server while it runs.
If your remote work sources are dependable, pass `--no-local-work` — the send
then fails cleanly instead (an unpayable invoice is refused up front, and a
failed refund/payout send leaves the balance in the wallet for the next
settle to move).

**This is a hot wallet.** Use a dedicated wallet holding pocket money, not
your savings: its balance is a natural spend ceiling, and `--max-usd` adds a
per-call one on top. NanoGPT auto-refunds overpayments and failed generations
on its side.

**Prefer prepay?** Wallet mode settles on-chain per call. If you'd rather pay
once and draw down a balance, that's exactly what a NanoGPT account is:
[deposit crypto](https://docs.nano-gpt.com/api-reference/endpoint/crypto-deposits)
(Nano included) into an account, take its API key, and run the server in
normal BYOK mode — same tools, one payment instead of many.

## Serve mode — host your noodles as a service (`--serve`)

Everything above speaks MCP over stdio to *your own* agent. `--serve` speaks
MCP over **streamable HTTP** instead, turning a directory of noodles into a
service *anyone's* agent can connect to:

```bash
nanoodle-mcp --graphs ~/noodles --serve 8402
```

Callers connect with one command — no key, no signup:

```bash
claude mcp add --transport http noodles https://your-host/mcp
# or
grok mcp add --transport http noodles https://your-host/mcp
```

`GET /` serves a landing page with the tool list and that exact command (Claude
and Grok behind a one-click toggle — same endpoint, same flags), so sharing
your server's bare URL *is* the onboarding. Every workflow on it links to its
source: an **open in editor** link (a share link minted from the exact graph
file being served — it loads the workflow in the
[nanoodle editor](https://nanoodle.com) to inspect, remix, or run on your own
key) and its raw **graph JSON** at `/graph/<tool>.json`. The page also spells
out the economics (deposits settle at metered cost + 20%; the markup is the
author's cut on graphs that name a payout address, and the operator's on the
rest, and the page says which of yours do) and how to self-host — this server, the editor, and the
executor are MIT ([licensing](#licensing)). Generated media is served
back under unguessable `/out/…` URLs (small images also ride inline in the
tool result). Runs themselves are **not logged**: free serve mode keeps no
record of who called what, and charge mode keeps only a payments ledger (money
events, never run telemetry — see below).

**Generated media is deleted after `--out-ttl` hours** — a privacy backstop so
a hosted server doesn't hoard every caller's generations on disk forever. In
`--serve` mode it defaults to **24h**; pass `--out-ttl <hours>` to change it
(fractions like `0.5` are fine) or `--out-ttl 0` to keep everything. Stdio mode
defaults to **off** — files you generated locally are yours to keep — but honors
the flag if you pass it. The sweep only ever removes media artifacts (images,
video, audio); the operator's own `costs.json`, `gate-state.json`, and
`usage.jsonl` are never touched. Note the 24h default matches the charge gate's
replay window: a paid result stays replayable for 24h and references its `/out/`
URL, so lowering `--out-ttl` below 24h in charge mode means a replayed result
can point at a file that's already been swept.

### Privacy — what your server keeps

Run with the defaults and the same promise the hosted server makes holds on
your box, every line checkable in this repo:

- **No accounts, no API keys, no sign-ins.** In charge mode, paying is the only
  thing that authorizes a call.
- **Prompts and inputs are never written to disk or logs.** Input media rides
  in memory only — it is never stored. In charge mode the gate keeps only a
  short hash binding a payment to its call (`hashArgs`), never the arguments.
- **Generated media auto-deletes after `--out-ttl` hours** (default 24h in
  `--serve`, off for local stdio), served at unguessable `/out/…` URLs until
  then. Set `--out-ttl 0` to keep everything.
- **Results are held in memory for delivery, not stored** — the restart-state
  file carries no result text or error detail.
- **No analytics, no trackers, no IP logs** — the app keeps no request logs.
  In charge mode the one thing it writes is `usage.jsonl`, a payments ledger of
  money-lifecycle events that mirror the public Nano ledger — no run telemetry,
  no error text. Free serve mode writes no ledger at all.

`gate-state.json` itself never holds customer content. It exists to keep
in-flight money safe across the restart a deploy causes — quotes and owed sends
survive — but a paid tool's **text output and any upstream error detail are
never written to disk**. Media results persist only their `/out/` pointer and a
receipt; a text result persists as nothing, so a restart between a run and the
caller's retry simply re-runs the tool (charged once, delivered once — the
operator eats one duplicate model call) rather than replaying content from disk,
and a failed run replays a fixed placeholder plus its refund status, never the
original error message.

One caveat, stated plainly: generation runs on [NanoGPT](https://nano-gpt.com)'s
API, so prompt content in flight is governed by
[their privacy policy](https://nano-gpt.com/privacy).

Free serve mode runs on **your** balance — fine on a trusted network, ruinous
on the open internet. For that, charge for calls:

### Charging per call (`--charge-usd`)

```bash
nanoodle-mcp --graphs ~/noodles --env-file wallet.env \
  --serve 0.0.0.0:8402 --public-url https://noodles.example.com --charge-usd 0.05
```

Now every tool call is paid in Nano (XNO) **by the caller**, with no accounts
on either side. The flow their agent walks through (the server's MCP
`instructions` teach it automatically):

On each **PAYMENT REQUIRED** quote the tools/call **hangs up** with `payUrl`,
`watchUrl`, and a `next` imperative ( `blocking: false` ):

1. **Pay.** Show the user ONLY `payUrl` (QR for the exact amount); any Nano
   wallet scans it. Never show them `watchUrl` or the wallet address.
2. **Watch — immediately, on that same payment link.** The agent opens
   `watchUrl` (`GET /x402/watch/<id>`, agent-only SSE) the moment it has the
   quote. One `status` event per state change; when payment lands the stream
   **closes** with `done: true` and a `next` field for phase 3. (The pay page
   uses the same stream; poll `GET /x402/status/<id>?wait=1` as a fallback.)
   Detection is RPC polling or push via `--nano-ws` — about a second.
3. **Results.** ONLY after the watch closes paid: re-call the tool with the same
   arguments plus `_payment_id`. That `tools/call` is the **results stream** —
   it runs the workflow (progress heartbeats on a streaming transport) and
   returns the result with a receipt. Do not open it while still watching for
   payment. Re-calls with the same `_payment_id` replay the cached result free.

**What they paid is a deposit, not the price**: the call settles at the run's
*actual* metered model cost + 20%, and everything above that is sent back to the
paying wallet as change — the same deposit→meter→refund model NanoGPT itself
uses, one layer up. Nobody ever pays off an estimate.

Nano has no payment memo, so each quote's amount carries a few raw of random
dust — **the amount is the memo**. Quotes expire after 15 minutes; a payment
that arrives late is bounced straight back, and **a run that fails after
payment is refunded automatically**. Arguments are validated *before* a quote
is issued (nobody pays for a typo), and `run_noodle` is withdrawn in Nano charge
mode; NEAR mode prices and sells it, custom graphs included — see
[Pay with NEAR](#pay-with-near--run-custom-workflows).

Pricing: `--charge-usd` sets the **ceiling** deposit, and the opening quote
for a tool that has never run. Once a tool has run, its deposit tracks its
real cost automatically: quotes become twice the settle price (worst observed
metered cost + 20%, from the `costs.json` sidecar), ceiled to a whole cent
with a 1¢ floor — a tool that meters $0.004 quotes a $0.01 deposit, not the
flat ceiling. Size the ceiling generously; over-covering costs callers
nothing since the difference comes back as change, while an under-sized
deposit means runs can cost more than was collected and *you* eat the
difference (the gate warns at startup when a graph's deposit is below its
last observed cost + 20%). The XNO conversion comes from **NanoGPT itself**:
the gate fires a keyless `x-x402` probe and keeps the invoice's exact
raw-XNO/USD pair — the same rate your downstream payments settle at, so
quotes and costs can never drift apart on FX, and no market-data service is
involved (probe invoices are never paid; they just expire). Cached 60s, stale
cache rides out probe outages, and `--xno-usd` forces a static rate if you
ever need one. Per-graph overrides are a hand-added top-level block in the
graph JSON:

```json
"x402": { "usd": 0.10, "author": "nano_1abc…" }
```

**humanize-comment** quotes each request on its own. The quote is built from the draft,
context, guidance, and `maxChars` actually sent. Each call's `max_tokens` is
sized from that request: `maxChars`, or the draft's length when `maxChars` is
omitted, plus a small slack. The decider also reserves tokens for its ranking JSON and for GLM reasoning, which shares that max_tokens budget. Tokens are estimated at about 3.5 bytes each; the draft, context, and guidance the decider reads are priced at 2.5 bytes per token, so its estimate grows with context length. Until the decider starts, a hosted run admits a writer, fallback, or re-ask only if it fits the deposit with the decider's estimated cost still counted. That estimate is admission headroom, not money set aside, so it makes a skipped decider less likely but does not rule it out. The
priced worst case is every writer once, one extra retry, the decider, and a second decider pass when
a protected span can be repaired or the call can ask the decider to confirm one fitting rewrite (a title, a length cap, or a required ending).
When Cydonia fails and the Starry Ocean fallback runs, both calls are charged.
On a hosted payment the quote caps what the customer pays. A step whose estimate or invoice would push the spend past
the quote is skipped. A skipped writer step ends as a partial result, or with nothing
owed when nothing was sent. A skipped or unusable decider is an error, not the original draft returned as a successful comment. The deposit is 12% above that priced charge, at least $0.001,
rounded up, and never below it. Settlement of a hosted payment charges the customer the lesser of the metered
cost plus 20% and the quoted deposit, and returns the difference. When a provider
meters more than the quote, the operator absorbs that overrun. This refund and cap apply to hosted payments.
Direct-wallet spending has no cap and is not refunded. A short comment
is not asked for the longest comment's hold. The graph's `usd` is only the
ceiling for that longest request, used when a model has no price.

`usd` overrides the deposit for every other tool. `author` routes **the 20% markup of every
successful call to that address** — computed on what the run *actually* cost,
never on the deposit, and capped by whatever the deposit has left once the cost
is taken out (a deposit too small to cover cost + 20% pays the author only the
remainder). Nano has no network fees and this server takes no cut of the
markup, so creators keep 100% of what does get routed. **With no `author`
field the markup stays with the wallet running the server** — it is opt-in per
graph, not the default. In exact raw, per settled call:

```
cost   = metered model cost, converted at the deposit's own oracle pair, rounded up
markup = cost / 5                    (20%, integer floor)
take   = min(markup, deposit − cost) → author (or kept, if no author field)
change = deposit − cost − take       → back to the payer
```

A run costing more than its deposit keeps the whole deposit and the operator
absorbs the excess; a run whose model reports no cost settles at $0 and the
whole deposit is returned (the caller is never billed off a number the meter
didn't produce). The math is **integer-exact end to end**: USD decimals parse
by string into nano-dollars, the rate is the oracle invoice's literal
raw/USD pair, every conversion is BigInt ratio arithmetic with an explicit
floor or ceil, and floats never touch an on-chain value.

The wallet (`NANO_SEED` / `NANO_PRIVATE_KEY`, via `--env-file`) receives
payments, sends refunds and author payouts, and — if you don't set an API
key — also pays NanoGPT per call via x402, making the whole service
nano-in/nano-out. With an API key, runs spend from the key and the wallet only
handles the customer side.

### Payment detection

Polling `receivable` on your Nano RPC node (1s while quotes are pending) is
the always-on default. Add `--nano-ws wss://…` to subscribe to a Nano node
websocket for push detection — settlement is then effectively instant and
polling relaxes to a safety net. Public websockets exist (e.g.
`wss://nanoslo.0x.no/websocket` worked at the time of writing); your own node
is the dependable option. Either way the poller also checks `account_history`,
so payments pocketed by a concurrently-running wallet are still found.

### Payments ledger

In charge mode `<out>/usage.jsonl` is a **payments ledger**: one line per money
event only — `quote`, `paid`, `refund`, `change`, `author_payout` — your
server's own record of money moving, nothing client-side. It is deliberately
**not** a usage log: there are no `run` events, no run timing, no
success/failure telemetry, and no upstream error strings (which can quote user
content). A money event does carry `.tool` — the tool name is the *subject of
the payment*, not a record of a run — so you can see what earns, but not who
ran what when or whether it failed. Refunds record a fixed category
(`run_failed`, `late_payment`), never the underlying error text — the full
error still reaches the caller and the operator's stderr. Free serve mode
writes no ledger at all. Some starters:

```bash
jq -r 'select(.event=="paid") | .tool' usage.jsonl | sort | uniq -c | sort -rn  # paid calls per tool
jq 'select(.event=="paid") | .settleMs' usage.jsonl                             # quote→settle latency
jq 'select(.event=="paid") | .usd' usage.jsonl | jq -s add                      # gross deposits taken
jq -r 'select(.event=="refund") | .reason' usage.jsonl | sort | uniq -c         # refunds by category
```

### Hosting checklist

- **Reverse proxy / tunnel**: bind localhost, put Caddy/nginx/cloudflared in
  front for HTTPS, and set `--public-url` to the outside URL (it's what pay
  links and media links are built from).
- **systemd** (adjust paths):

  ```ini
  [Unit]
  Description=nanoodle-mcp serve
  After=network-online.target

  [Service]
  ExecStart=/usr/bin/npx nanoodle-mcp --graphs /srv/noodles --out /srv/noodle-out \
    --env-file /srv/wallet.env --serve 8402 --public-url https://noodles.example.com \
    --charge-usd 0.05 --work-rpc http://127.0.0.1:7076
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```

- **Keep the float small**: the wallet is hot. Sweep revenue to cold storage
  regularly; if you run with an API key, cap that account's balance too.
- **Work server**: refunds and payouts are Nano sends and need proof-of-work —
  use a hosted GPU work API (nano.to, Nanswap — key in `NANO_WORK_KEY` in the
  env file), or point `NANO_WORK_URL` at a `nano-work-server --gpu` on any box
  you own over a tailnet (work requests carry only block hashes — nothing
  secret). Pair either with `--no-local-work` so a work outage can't freeze
  the server on CPU work. Wallet-material and key env vars all belong in the
  `--env-file`, which also takes `NANO_WS_URL` for a key-bearing websocket URL
  (e.g. Nanswap's `wss://nodes.nanswap.com/ws/?ticker=XNO&api_key=…`).
- There is intentionally **no auth**: on a charged server, payment is the
  authorization. Don't serve graphs you wouldn't want strangers running.

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
| result | text outputs as text blocks; media outputs saved into `--out` (default `./nanoodle-out`) with the absolute path returned; a final text block reports the run's cost; a leading `note:` block whenever the run changed something the caller asked for (see below) |

**When the run does not use your prompt verbatim, the result says so.** Many
image and video models reject an over-long prompt outright, and in a graph the
prompt is usually written by an upstream LLM — nobody typed it, so nobody can
shorten it. `nanoodle` (0.8.0+) trims it to the model's cap at a sentence
boundary instead of losing the run to a certain 400. That is only defensible if
the caller is told, so the trim leads the tool result:

```
note: prompt trimmed for "Poster" (qwen-image-3) — the prompt was 1320 characters
and this model accepts at most 800, so nanoodle cut it to 791 characters at a
sentence boundary. The run used the shortened prompt.
```

It matters most in charge mode, where that run is already paid for. The library
also emits a `process` warning, but stderr belongs to whoever started the server,
not to the agent that paid.

**A ⚖️ Decide gate that answers no is a result, not an error.** `nanoodle`
0.9.0 runs the Decide node. A yes/no gate that says no settles as status
`gated` and stops its branch. The tool result is normal (not `isError`), the
decision's tiny cost is billed, and nothing behind the gate runs or bills. The
result leads with:

```
gated: "Is it a cat?" answered no (yes 12%), so the run stopped there on purpose — skipped, not billed: "Cat poem". This is a result, not an error.
Cat poem: skipped — gate "Is it a cat?" answered no
cost: $0.000003
```

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
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY / NANO_WORK_URL /
                 NANO_WORK_KEY / NANO_WS_URL from a .env-style file
  --nano-rpc u   Nano RPC node for wallet mode (default https://rpc.nano.to; NANO_RPC_URL)
  --work-rpc u   dedicated work_generate endpoint — a local nano-work-server or a hosted
                 GPU work API (NANO_WORK_URL; NANO_WORK_KEY carries its API key;
                 falls back to --nano-rpc, then local CPU work)
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

#### Wiring it into your editor

MCP config is per-project in most clients, so the two-dir pattern lives in the
repo, right next to the graphs it serves. For Claude Code that's a `.mcp.json`
at the project root — commit it along with `noodles/` and everyone who clones
gets the same tools:

```json
{
  "mcpServers": {
    "nanoodle": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nanoodle-mcp", "--graphs", "./noodles", "--graphs", "/home/you/noodles"]
    }
  }
}
```

Relative paths resolve from the project root. A project-scoped server named
`nanoodle` shadows a user-scoped one of the same name, so repos with a
`.mcp.json` get their own graphs and every other directory falls back to your
global install untouched.

Two things to keep out of a committed config: your **API key** (leave `env`
out and let `NANOGPT_API_KEY` come from the environment, or point
`--env-file` at a file outside the repo — never commit a key) and, for team
repos, your **personal library path** (the second `--graphs` above is an
absolute path on *your* machine; drop it from a shared repo's config and keep
just `./noodles`, since `~` is not expanded in MCP args). Cursor
(`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`) take the same `args` in
the config shapes shown under [Install](#install).

## Hosted subnano tools

When at least one graph is loaded, the server also exposes two built-in tools
(they are not graph files, and an empty `--graphs` directory still refuses to
start):

- **`subnano_comment`** — one call that rewrites a draft with `liquid/lfm-2.5-2.6b`
  (Liquid d1 is a decision model and cannot write the comment), runs the mounted
  `humanize-comment` graph on that rewrite, then asks `liquid/d1` whether the
  result is safe to post and how funny it is. Needs `humanize-comment` in
  `--graphs`. A "no" from the gate is returned with the comment; it does not
  discard it.
- **`sfw_check`** — one yes/no safe-for-work decision per still image and per
  evenly sampled video frame (`perplexity/pplx-decider-v1.2`). The check passes
  only when every picture is yes. There is no argument that turns it off.
  Sampling a video needs ffmpeg; checking a still image does not.

In charge mode each call's deposit is quoted before payment and is a cap on
the charge. `subnano_comment` sizes every stage's max_tokens from that draft
(about 1.5× its length, plus a little slack), estimates input at about one
token per 3.5 bytes plus a small margin, and caps re-asks at the same output
size. The decider keeps 256 ranking-JSON tokens and 512 GLM reasoning tokens
on top of that writer cap, and the humanize hold inside the call is quoted at
those caps. The gate and the funny judge read the comment clipped to that size.
Settlement is the metered cost plus 20%, and never more than the quote. Before
each paid stage the run stops when the remaining budget cannot cover it,
returns what already finished, and charges only the calls that ran.
`sfw_check` is the same kind of cap: the quote is the pictures that request
asks to check, a picture that would exceed the remaining budget is not sent,
and settlement cannot exceed the quote. The difference is returned.

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

From version 0.7.0, `run_noodle` also takes a workflow you composed yourself: pass the graph JSON as
`graph` instead of `url`. Two free helpers sit next to it: `noodle_guide` explains
the graph format, node types and priced models, and `price_noodle` returns the
itemized estimated cost of a `graph` or `url` without running it.

## Pay with NEAR / run custom workflows

A server started with `--near-merchant` sells workflow runs for **native NEAR**,
and it runs **workflows the caller composes itself**, not only the saved ones.
An agent with a NEAR wallet can design a graph, see what it will cost before it
commits, pay one transfer, get the result, and get the unused part of its deposit
back in NEAR. Nobody needs an account or an API key. Testnet is the default;
mainnet is a flag. The full design (verification rules, durable state, threat
model) is in [docs/near-payments.md](docs/near-payments.md).

> NEAR mode first ships in npm version 0.7.0. Until `npm view nanoodle-mcp version`
> shows 0.7.0 or later, `npx nanoodle-mcp` installs a release without NEAR mode: run it
> from a clone (`node bin/nanoodle-mcp.mjs …`, as below). The scripts used below
> (`scripts/…`) are not in the npm package at all; they need a clone.
>
> Status: the flow passes offline and the verifier passes read-only checks against a real
> testnet transfer. This code has not yet moved real NEAR; the first real testnet run
> is [Prove it on testnet](#prove-it-on-testnet-turnkey). For the NEAR-first hostname,
> shared Nano pool and connected-wallet payment flow, see
> [NEAR endpoint and wallet payments](docs/near-payments.md#near-endpoint-and-wallet-payments).
>
> The same workflow runs can also be sold as jobs on NEAR Agent Market, paid by the
> market's escrow instead of a transfer per call: see
> [docs/near-agent-market.md](docs/near-agent-market.md).

### Try it in one command (offline)

```bash
git clone -b near-hackathon https://github.com/nanoodlecom/nanoodle-mcp && cd nanoodle-mcp && npm ci
node scripts/near-simulate.mjs      # or: npm run simulate:near
```

| You do | You see |
|---|---|
| run the simulation | the real server binary starts in NEAR mode against a local NEAR chain stand-in and a local NanoGPT stand-in, with a throwaway merchant key |
| step 2–4 | the tool list, `noodle_guide`, then `price_noodle` on a custom `text → llm → image` graph: the itemized estimate, in the words below |
| step 5–7 | the quote, one transfer of exactly that amount, then the result with a receipt: charged `0.003102197802197802197803` NEAR, the rest refunded on chain |
| step 8–15 | replay (no re-run, no re-refund), a reused transaction, an unsafe node, an unpriceable model, underpayment, a late payment, a failed run, and the server killed mid-run and mid-refund — each refused or refunded correctly |
| step 16 | both balances, reconciled: deposits − refunds = what was charged, gas aside |

It needs no network, keys or funds, and exits non-zero if any of its 35 checks fail.

### How pricing works

Every price uses these terms, in `price_noodle`, quotes, receipts and tool
descriptions:

| Term | Meaning |
|---|---|
| **estimated cost** | The model cost the run is expected to have, itemized per paid node (node, model, basis, USD), from NanoGPT's public catalog. Text steps are priced at their `maxTokens` and at the longest text that can reach them. |
| **service fee** | 20% of the **actual** model cost. |
| **likely charge** | Estimated cost + 20% service fee: what you will most likely pay. |
| **deposit** | The most you can be charged. It is held up front and is the amount you send: the likely charge × 2 (× 1.25 when every model has a fixed price), rounded up to the next cent, minimum $0.01. |
| **charged** | Actual model cost + 20% service fee, capped at the deposit. If the provider does not report the full cost of a run, the estimated cost is charged instead. |
| **refund** | The deposit minus what was charged, sent back to the paying account automatically. Exact in yoctoNEAR. |
| **rate** | The NEAR/USD rate used, with its source and time; when known also XNO/USD and the swap rate derived from the two ("1 NEAR = N XNO"), and the swap margin when it is not zero. A quote locks all of it for its lifetime; settlement uses the locked rate. |

In `structuredContent.pricing`, a figure named after its term is `usd`
(`estimatedCost.usd`, `likelyCharge.usd`, `deposit.usd`); a figure that is only
known after the run is `likelyUsd` (`serviceFee.likelyUsd`, `refund.likelyUsd`).

Each quote says, in one sentence, what you will most likely pay and that the
rest comes back, and in another why the deposit is larger:

> You will most likely pay about $0.0115 (0.003172 NEAR): the estimated cost plus a 20%
> service fee. You send 0.008379 NEAR as a deposit; that is the most you can be charged,
> even if the run costs more, and the rest is refunded to your account as soon as the run
> finishes.
>
> Text, video and audio steps bill by what they actually produce, so the deposit holds
> twice the likely charge as headroom, rounded up to the next cent ($0.03); image prices
> are fixed.

The worked example (`text → llm → image`, 1 NEAR = $3.64, illustrative catalog prices):

| Step | USD | NEAR |
|---|---|---|
| Estimated cost, `LLM` (z-ai/glm-5.3-flash): up to 223 input and 2,000 output tokens | $0.000622 | |
| Estimated cost, `Image` (flux-3 klein): one 1024×1024 image, fixed price | $0.009 | |
| **Estimated cost** | **$0.00962** | |
| Likely charge (estimated cost + 20% service fee) | $0.0115 | 0.003172 |
| **Deposit** (likely charge × 2, rounded up to the cent) | **$0.03** | 0.008242 + dust 0.000137 = **0.008379** (≈ $0.0305) |
| Actual model cost reported by NanoGPT after the run | $0.00941 | 0.002585164835164835164836 |
| Service fee (20% of actual) | $0.001882 | 0.000517032967032967032967 |
| **Charged** | **$0.011292** | **0.003102197802197802197803** |
| **Refund** (deposit − charged) | **$0.0305 − $0.011292 ≈ $0.019208** | **0.005276802197802197802197** |

The *dust* (here 0.000137 NEAR, at most 0.000999) makes each open quote's amount
unique, so the amount identifies the quote; it comes back with the refund, which
is why the refund is a little more than $0.03 − $0.011292. All on-chain math is
exact integer yoctoNEAR. A run that fails refunds the whole deposit.

The quote's rate line reads, for example, `Rate: 1 NEAR = $3.64 (coingecko, …); 1 XNO =
$0.95 (nanogpt-x402, …), so 1 NEAR = 3.831578947 XNO, locked for this quote`. The swap
rate is derived from the two USD rates; no swap venue is queried, and the server does
not swap NEAR to XNO itself (refilling the Nano float from received NEAR is a manual
operator task). `GET /rates` on the server shows the current rates, their sources and
ages; `GET /rates?refresh=1` refetches them (at most once every 15 s).

Every receipt ends with the three money legs, each with its own status:

```
Leg 1, caller payment: 0.008379 NEAR, tx 8PyS…, final.
Leg 2, model payment to NanoGPT: $0.00941 (paid from the operator's NanoGPT balance).
Leg 3, refund: ≈0.005277 NEAR, sent (tx 8yto…, https://testnet.nearblocks.io/txns/8yto…).
```

On a server that pays NanoGPT from its Nano wallet, leg 2 also gives the XNO amount,
derived from the reported cost at the locked XNO/USD rate. An unknown cost stays
"unknown", never zero.

### The agent's side

1. **Design (free).** `noodle_guide` lists the node types this server runs, the
   ports each one takes wires on, their fields, the wiring rules, a complete
   example graph and the priced models. `price_noodle { graph, inputs }` returns
   the itemized price and every problem, without a quote. Iterate until
   `pricing.safety.ok` is true (it is false whenever a node cannot be priced or
   the deposit is over the server's cap).
2. **Quote.** Call `run_noodle { graph, inputs }` (or a saved-graph tool) with no
   payment arguments. The answer is `structuredContent.payment`: `paymentId`,
   `payTo`, `network`, `amountYocto`, `amountNear`, `expiresAt` (30 minutes by default) and
   the `pricing`. Nothing is charged.
3. **Pay.** Send **one** native transfer of exactly `amountNear` to `payTo`, for example with
   [near-cli-rs](https://github.com/near/near-cli-rs):

   ```bash
   near tokens payer-name.testnet send-near merchant-name.testnet '0.008379 NEAR' network-config testnet sign-with-keychain send
   ```

4. **Run.** Repeat the same call with the same arguments plus `_payment_id`,
   `_payment_tx` (the transaction hash the wallet printed) and `_payment_sender`
   (the account you paid from). The server reads the transaction at FINAL finality,
   checks receiver, amount, single `Transfer` action and timing, records the hash as
   consumed, runs the workflow once, and returns the result with a `receipt`:
   charged, refunded, both transaction hashes and explorer links.
5. **Replay.** Repeating the paying call returns the stored outcome. It never runs,
   charges or refunds again.

If the transaction is not final yet, the call says so and nothing is consumed:
call again 3 seconds later (finality takes 2–3 s). A wrong amount or a payment
after expiry is refunded in full and nothing runs.

### Prove it on testnet (turnkey)

Two scripts run the whole flow on real NEAR testnet with throwaway accounts: one
creates the accounts, the other plays both the operator and the agent. They move
testnet NEAR only. Keys stay in the directory you pass as `--keys-dir` (files mode
0600; only public keys are sent or printed); use a directory outside the repository.

```bash
# 1. Two new testnet accounts (merchant + payer) through the testnet account helper
node scripts/near-testnet-accounts.mjs --keys-dir ~/.near-testnet-nanoodle
#    Ends with READY and exit 0. Exit 1: the helper refused (fallbacks are printed);
#    exit 3: the accounts exist but need funding (merchant ≈0.05, payer ≈0.1 NEAR).
#    No helper: add --implicit and fund the two printed accounts yourself.
#    Own accounts: --use-existing --merchant <id> --merchant-key-file <p> --payer <id> --payer-key-file <p>

# 2. Every check that moves no funds: keys, RPC, balances, rate, server, price, quote
node scripts/near-testnet-e2e.mjs --keys-dir ~/.near-testnet-nanoodle --dry-run --mock-model
#    "=== Transactions ===" lists "(none: no funds moved)"; the last line is
#    "PASS: 14/14 checks passed (dry run: no funds moved)", exit 0.

# 3. Real payment and refund, model replaced by a local stand-in (no NanoGPT key needed)
node scripts/near-testnet-e2e.mjs --keys-dir ~/.near-testnet-nanoodle --mock-model

# 4. The same with one real NanoGPT call (about $0.00002, capped at 48 output tokens);
#    the server reads NANOGPT_API_KEY from .env (or pass --env-file <path>)
node scripts/near-testnet-e2e.mjs --keys-dir ~/.near-testnet-nanoodle
```

Step 3 sends four testnet transactions: a payment, its refund, a payment 0.0000005 NEAR
short (refused, refunded in full, nothing runs) and that refund. It checks the receipt
against the chain to the yoctoNEAR (deposit − refund = charged), that the charge is the
model cost + 20% at the quote's locked rate (with `--mock-model`, the stand-in's own
reported cost), both balances, replay
(same receipt, no second refund) and reuse of a spent transaction, prints an explorer
link and a `near-check-tx` command for every transaction, and ends `PASS` with exit 0.
On any `FAIL` it exits 1 and prints what to check for each failed area. The server's
state and money log stay in `nanoodle-out/near-testnet-e2e/<time>/`.

The rest of this section does the same by hand, with your own server.

### Running a NEAR-paid server (testnet)

From the cloned repository:

```bash
# 1. A merchant account (receives payments, signs refunds); near-cli-rs, testnet faucet
near account create-account sponsor-by-faucet-service merchant-name.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account export-account merchant-name.testnet using-private-key network-config testnet   # prints ed25519:…

# 2. Secrets in a file, never on the command line
cat > .env <<'EOF'
NANOGPT_API_KEY=your-nanogpt-key
NEAR_PRIVATE_KEY=ed25519:the-key-printed-above
EOF
chmod 600 .env

# 3. Serve (a graphs folder must exist; it may be empty — run_noodle needs no saved graphs)
mkdir -p noodles
node bin/nanoodle-mcp.mjs --graphs ./noodles --serve 0.0.0.0:8402 --public-url https://your-host \
  --near-merchant merchant-name.testnet --env-file .env
```

At startup the server checks that the RPC is on the configured network and that
the key is a full-access key of the merchant account, finishes anything a
previous run left in flight (a run interrupted by a restart is refunded, never
re-run), and logs the network, merchant, RPC host and rate source. It refuses to
start on any mismatch. Use a **dedicated** merchant account: no other software
should send from its key.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--near-merchant <account>` | `NEAR_MERCHANT` | off | Turns NEAR mode on. Needs `--serve`. With `--charge-usd` too, the server accepts either rail per call (below). |
| `--near-network testnet\|mainnet` | `NEAR_NETWORK` | `testnet` | Network to verify payments and send refunds on. |
| `--near-rpc <url[,url]>` | `NEAR_RPC_URL` | fastnear's public RPC, then near.org's | RPC endpoint(s) you trust to report finality, tried in order with failover. No node of your own is needed: the server looks up the one transaction each caller names. |
| `--near-key-file <path>` | `NEAR_PRIVATE_KEY` (env or `--env-file`) | required | The merchant's full-access key: `ed25519:…` in the env, or a JSON key file with `account_id`, `public_key` and `private_key` (legacy near-cli credentials, or what `scripts/near-testnet-accounts.mjs` writes). near-cli-rs key files have no `account_id`; use `NEAR_PRIVATE_KEY` for those. Never accepted on argv, never logged. |
| `--near-usd <n>` | `NEAR_USD` (env or `--env-file`) | live (CoinGecko, 60 s cache) | Pin the NEAR/USD rate. Without a fresh live rate the server stops quoting rather than guess. |
| `--xno-usd <n>` | | live (NanoGPT x402 invoices, else CoinGecko) | Pin the XNO/USD rate (the same flag the Nano charge mode uses). Required to quote when the server pays NanoGPT from its Nano wallet; informational with an API key. |
| `--near-swap-spread-bps <n>` | `NEAR_SWAP_SPREAD_BPS` (env or `--env-file`) | `0` | Swap margin, 0–2000 basis points: NEAR amounts are computed at a NEAR/USD rate that much worse for the caller, to cover swapping NEAR to XNO. |
| `--near-quote-ttl-min <n>` | `NEAR_QUOTE_TTL_MIN` | `30` | Quote lifetime, 1–120 minutes; the quote's rates stay locked for all of it. |
| `--near-rates-refresh-s <n>` | `NEAR_RATES_REFRESH_S` | `60` | Background refresh of live rates; `0` turns the timer off. |
| `--near-max-deposit-usd <n>` | | `2` | Refuse any call whose deposit would exceed this. |

NanoGPT is still paid by your API key or Nano wallet, exactly as in the other
modes; NEAR only changes how callers pay you. Money events go to
`<out>/usage.jsonl` with `"rail": "near"`; durable payment state is
`<out>/near-state.json` (one server per `--out` directory). Each settled call's
`change` event records the locked rates, the NEAR charged and refunded, the USD model
cost and, on a wallet-funded server, the XNO it cost (derived), each in its own unit, so
you can total NEAR in against XNO out and decide when to swap
([reading the ledger](docs/near-payments.md#reading-the-payments-ledger)). Those
conversions are for reporting; nothing is swapped.

`kill -HUP <pid>` re-reads `NEAR_USD` and `NEAR_SWAP_SPREAD_BPS` from the `--env-file`
and refetches the live rates, without a restart; open quotes keep their locked rates.

#### Running both rails on one server

```bash
node bin/nanoodle-mcp.mjs --graphs ./noodles --serve 0.0.0.0:8402 --public-url https://your-host \
  --charge-usd 0.05 --near-merchant merchant-name.testnet --env-file .env   # .env also holds NANO_SEED
```

Each call is paid in Nano by default, exactly as with `--charge-usd` alone. A saved tool
the NEAR gate also sells says so in its description and takes `"_pay_with": "near"` for a
NEAR quote; `run_noodle`, `price_noodle` and `noodle_guide` are NEAR-side tools. A Nano
payment id starts with `pay_`, a NEAR one with `nq_`, and the server routes the paying
call by it. The two rails keep separate state and ledgers (`usage.jsonl` and
`near-usage.jsonl`). `npm run simulate:dual` shows it offline: a tool quoted in Nano, the
same tool quoted and paid in NEAR, a NEAR-paid custom graph, `GET /rates` before and after
a forced refresh, and a `SIGHUP` reload.

### Try it live on testnet

With the server above running at `https://your-host`, any shell can act as the
agent. `jq` is only used to pick fields out of the answers.

```bash
# 1. A payer account (a second account; the faucet funds it with testnet NEAR)
near account create-account sponsor-by-faucet-service payer-name.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

# 2. The workflow and a helper that calls run_noodle over MCP's HTTP transport
GRAPH='{"nodes":[{"id":"n1","type":"text","name":"Idea","fields":{"text":""}},{"id":"n2","type":"llm","fields":{"model":"z-ai/glm-5.3-flash","system":"Write one vivid image prompt for the idea. Reply with the prompt only.","maxTokens":300}},{"id":"n3","type":"image","fields":{"model":"blackforestlabs/flux-3/klein/text-to-image","size":"1024x1024"}}],"links":[{"from":{"node":"n1","port":"text"},"to":{"node":"n2","port":"prompt"}},{"from":{"node":"n2","port":"text"},"to":{"node":"n3","port":"prompt"}}]}'
call() { curl -s https://your-host/mcp -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"run_noodle\",\"arguments\":{\"graph\":$GRAPH,\"inputs\":{\"Idea\":\"a lighthouse at dawn\"}$1}}}"; }

# 3. Free price check, then the quote
curl -s https://your-host/mcp -H 'content-type: application/json' -H 'accept: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"price_noodle\",\"arguments\":{\"graph\":$GRAPH,\"inputs\":{\"Idea\":\"a lighthouse at dawn\"}}}}" | jq -r '.result.content[0].text'
call "" | jq '.result.structuredContent.payment | {paymentId, payTo, amountNear, expiresAt}'

# 4. Send exactly amountNear to payTo; near-cli prints the "Transaction ID"
near tokens payer-name.testnet send-near merchant-name.testnet '<amountNear> NEAR' network-config testnet sign-with-keychain send

# 5. Present the payment: same arguments plus the three _payment_ fields
call ',"_payment_id":"nq_…","_payment_tx":"<Transaction ID>","_payment_sender":"payer-name.testnet"' \
  | jq '{text: [.result.content[] | select(.type == "text") | .text], receipt: .result.structuredContent.receipt}'
```

The receipt has `deposit.explorerUrl` and `refund.explorerUrl`: open both on
testnet.nearblocks.io. Then check both transfers the way the server does,
read-only (no keys):

```bash
# the payment
node scripts/near-check-tx.mjs --network testnet --merchant merchant-name.testnet --tx <payment hash> --sender payer-name.testnet \
  --state ./nanoodle-out/near-state.json --payment-id nq_…
# the refund (payer and merchant swap places)
node scripts/near-check-tx.mjs --network testnet --merchant payer-name.testnet --tx <refund hash> --sender merchant-name.testnet \
  --amount-yocto <receipt refund.yocto>
```

It prints PASS/FAIL for each rule (final, succeeded, receiver, single transfer,
exact amount, inside the quote's time window). Public RPC nodes keep transactions
for only a few days; to check an older one, add
`--rpc https://archival-rpc.testnet.fastnear.com`. An MCP client that can sign NEAR
transfers (or an agent with a wallet tool) does steps 3–5 itself; clients that
cannot sign need a bridge like the shell above.

**Mainnet** is `--near-network mainnet` with a mainnet merchant account and key
(and preferably a keyed RPC first in `--near-rpc`). Read the
[limitations](docs/near-payments.md#limitations) first.

**Pay one call on a running server** (testnet or mainnet), the way an agent would:

```sh
node scripts/near-pay.mjs --url https://your-server --network mainnet \
  --payer you.near --payer-key-file ~/.near-credentials/mainnet/you.near.json
```

It asks for a quote, refuses to go on if the network differs or the amount is above
`--max-near` (default 1), sends ONE transfer of exactly the quoted amount, makes the paid
call, waits for the refund and checks deposit − refund = charged and both transfers on
chain. It prints an explorer link for each transfer and ends `PASS` with exit 0.
`--quote-only` stops before any funds move and needs no key. The default call is a tiny
custom workflow (one chat model, 48 output tokens at most); `--tool <name> --args '<json>'`
pays a saved tool instead.

To pay from a wallet app instead of a key file: run it with `--quote-only`, send exactly
the quoted amount to the pay-to account from the wallet, then run it again with
`--payment-id <nq_…> --payment-tx <hash>` in place of the key file.

### What a paid server will run

Strangers' graphs run on your server, so NEAR mode accepts only node types whose
inputs come from the caller as text or from upstream NanoGPT nodes, and whose cost
can be bounded before the run: text logic (`text`, `choice`, `join`, `comment`) and
the NanoGPT model nodes `llm`, `decide`, `image`, `edit`, `tvideo`, `ivideo`,
`music`, `tts` and `model3d`. Refused: `upload`/media-input nodes, local media
processing (resize, trim, combine…), `lipsync`, `inpaint`, custom `endpoint` nodes,
`vision` (it sends no output limit; use `llm` with an image on `img1`), and nodes
billed by the length of an input clip (`vedit`, `remix`, `transcribe`,
`cleanvoice`). Also refused: fields that hold URLs or inline data, `modelOpts` and
`extraJson` (they are sent to the provider unpriced), a non-numeric `maxTokens` or
`duration`, wires into pricing fields, media wired into text fields, and
fragment-less short links. No caller-chosen file, URL or local-media node runs;
`ffmpeg` may still run on images NanoGPT generated (to shrink one that is too
large to send to the next model, or to fit an image into a `decide` request).

The graph that runs is the graph that was priced: an `llm` without `maxTokens` is
sent `max_tokens` = 2,000 (or the model's lower maximum), and a video without a
duration is sent the catalog default it was priced at. Every paid node must be
priced by the catalog, and models whose catalog price is set by a live quote at
run time are refused (the refusal names the node and model). Caps: 40 nodes,
200 kB of graph JSON (checked before a share link is inflated), 32 inputs of at
most 20,000 characters (50,000 in total), the deposit cap, and 1,000 open quotes.
Everything is checked before a quote exists, so nobody pays for a call that could
not run. Saved graphs that fail these checks are not offered in NEAR mode, and
neither are the built-in tools.

### Limitations

- No caller-supplied media (image/audio/video inputs); media must be generated by
  an upstream NanoGPT node.
- Native NEAR only: no NEP-141 tokens such as USDC, no meta-transactions.
- The configured RPC is trusted for finality; there is no light-client proof.
- Deposits are bounds, not guarantees. Text steps are bounded by `maxTokens`, but
  a provider can still bill more than the catalog suggests (for example a reasoning
  model's hidden tokens); the charge is capped at the deposit and the operator
  absorbs the rest.
- Text results stay in memory only; a replay after a restart returns the receipt
  and says the text was not kept.
- Wallet payments have a pay page and monitoring stream. A transfer sent outside
  that page must be confirmed with its sender and hash.
- A transfer for a quote that expired more than an hour earlier is not refunded
  automatically (the quote is gone); the operator sees it in the merchant account.
- The NEAR→XNO swap rate is derived from two USD rates and the server never swaps; the
  operator carries NEAR/XNO price movement for up to the quote lifetime (30 minutes by
  default) and until it swaps by hand. The swap margin is the cushion for that.

The full list is in [docs/near-payments.md](docs/near-payments.md#limitations).

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
- **Headless coverage follows `nanoodle` 0.9.0** (this package's dependency).
  Local-media graphs (resize, combine, trim, extract-audio, video-frames,
  soundtrack) run on your machine — pure JS where possible, ffmpeg on `PATH`
  for the rest. Decide, Clean voice (`cleanvoice`), 3D model (`model3d`),
  3D input (`mupload`), and custom endpoint nodes also load and run; they are
  not skipped at startup. A closed Decide gate is a normal `gated` result.
  See the [supported-nodes
  table](https://github.com/nanoodlecom/nanoodle-js#supported-nodes). A
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

It also carries release guards: the three release manifests must agree on the
version, the landing page's chip table may only name node types the `nanoodle`
library still has, and no startup path may statically import the GPL-3.0
dependency.

Those guards are offline, so they compare repo files to each other and cannot
see npm. One more guard needs the network and therefore runs in the publish
workflow, not in `npm test`: `scripts/assert-npm-version.mjs` fails the registry
publish unless `server.json`'s version is really on npm. See
[PUBLISHING.md](PUBLISHING.md).

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

## Licensing

**MIT:** this server (see [LICENSE](LICENSE)), the
[nanoodle editor](https://nanoodle.com), and the
[`nanoodle`](https://github.com/nanoodlecom/nanoodle-js) executor this server
runs graphs on. The sibling projects — [nanoodle-py](https://github.com/nanoodlecom/nanoodle-py),
[nanoodle-skill](https://github.com/nanoodlecom/nanoodle-skill),
[noodle-skills](https://github.com/nanoodlecom/noodle-skills) — are MIT too.

**Graphs are not covered by any of that.** A `noodle-graph.json` is its
author's work. Serving one as a tool, or downloading one from `/graph/<tool>.json`,
does not place it under this repo's licence. The public library this project
maintains, [awesome-noodles](https://github.com/nanoodlecom/awesome-noodles), is
MIT because that repo says so; the graphs on any other server carry whatever
licence their authors give them.

**GPL-3.0:** one runtime dependency,
[`nanocurrency`](https://github.com/marvinroger/nanocurrency-js). It derives
Nano keys, builds and signs blocks, and computes proof-of-work. It is used only
by the optional x402 Nano wallet: [wallet mode](#wallet-mode--no-account-no-api-key-x402)
(`NANO_SEED` / `NANO_PRIVATE_KEY`) and [charge mode](#charging-per-call---charge-usd)
(`--charge-usd`). [NEAR mode](#pay-with-near--run-custom-workflows) (`--near-merchant`)
loads it too, because it reuses two helpers from `src/gate.mjs`; the NEAR code itself
does not call it.

Be clear about what that means for you. **Every installer receives it.**
`npm install nanoodle-mcp` and `npx -y nanoodle-mcp` both download and unpack
`nanocurrency` onto your disk, whether or not you ever touch x402. Your
dependency tree contains GPL-3.0 code from the moment you install, and it is
redistributed with any bundle or image you build from this package.

What the on-demand load changes is narrower, and only that: **which runs
execute it.** `src/wallet.mjs` and `src/gate.mjs` are the only modules that
touch `nanocurrency`, and `bin/nanoodle-mcp.mjs` reaches them through
`await import()` inside the branches that already gate x402. So a BYOK
(API-key) run never loads or runs GPL-3.0 code — it still has it installed.
`tests/gpl-boundary.test.mjs` holds that line.

We keep it a normal dependency on purpose. npm installs `optionalDependencies`
by default, so that would change nothing; the only way to skip it is an
optional `peerDependency`, and then `npx -y nanoodle-mcp` — the documented
one-command install — could no longer run wallet or charge mode at all. Correct
labelling beats a broken accountless install.

Not affiliated with NanoGPT or Anthropic. Build workflows at
[nanoodle.com](https://nanoodle.com); run them from code with
[nanoodle-js](https://github.com/nanoodlecom/nanoodle-js) /
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py).
