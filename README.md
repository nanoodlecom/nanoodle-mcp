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
agents can pay to run your noodles with no account anywhere.

No middleman server, no telemetry — and with [wallet mode](#wallet-mode--no-account-no-api-key-x402),
no account either. The MCP implementation here is hand-rolled (stdio +
streamable HTTP, JSON-RPC 2.0 — small enough to read). Two runtime dependencies:
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
out the economics (deposits settle at metered cost + 20%, the markup is the
workflow author's cut) and how to self-host — this stack is MIT end to end. Generated media is served
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

1. First `tools/call` returns **PAYMENT REQUIRED** with a `payUrl` — a
   self-contained pay page showing a QR code for the exact amount. The agent
   shows its user the link; any Nano wallet scans it.
2. The page flips to a green check the moment the payment lands (about a
   second — the gate watches the chain by RPC polling, or push via
   `--nano-ws`). The agent re-calls the tool with the same arguments plus the
   `_payment_id` from step 1. It can call **right after showing the link**, not
   only after the user confirms: on a streaming transport (Claude Code, Cursor,
   …) that call is **held open** — it waits for the payment to land, then runs —
   so there's no third call after paying. (The pay page, and any HTTP client,
   can also subscribe to `GET /x402/watch/<id>` — one SSE `status` event per
   state change; when payment lands the stream **closes** with `done: true` and
   a `next` field telling the agent how to open the result stream (re-call with
   `_payment_id`) — or poll `GET /x402/status/<id>?wait=1` for the same fields.)
3. The run executes and the result streams back with a receipt. **What they
   paid is a deposit, not the price**: the call settles at the run's *actual*
   metered model cost + 20%, and everything above that is sent back to the
   paying wallet as change — the same deposit→meter→refund model NanoGPT
   itself uses, one layer up. Nobody ever pays off an estimate. Re-calls with
   the same `_payment_id` replay the cached result free.

Nano has no payment memo, so each quote's amount carries a few raw of random
dust — **the amount is the memo**. Quotes expire after 15 minutes; a payment
that arrives late is bounced straight back, and **a run that fails after
payment is refunded automatically**. Arguments are validated *before* a quote
is issued (nobody pays for a typo), and `run_noodle` is withdrawn in charge
mode — an arbitrary share link's cost can't be priced up front.

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

`usd` overrides the deposit. `author` routes **the whole 20% markup of every
successful call to that address** — computed on what the run *actually* cost,
never on the deposit. Nano has no network fees and this server takes no cut
of it, so creators keep 100% of what their noodle earns. In exact raw, per
settled call:

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
