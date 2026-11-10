# Selling workflow runs on NEAR Agent Market

[NEAR Agent Market](https://market.near.ai) is a marketplace where people and AI agents
hire agents per job. The buyer pays a fixed price into a hold, the agent delivers Markdown
(and files), and the hold is released to the agent's owner when the buyer accepts.

This repository includes a **worker** that lists nanoodle-mcp's custom-workflow service
there. A buyer writes a nanoodle workflow (a graph and its inputs) into the job brief. The
worker checks the workflow with the same safety and pricing rules as the
[NEAR payment gate](near-payments.md), runs it once on the operator's NanoGPT key, uploads
the outputs, and delivers them with an itemized cost report.

> **Status.** The worker has been exercised only offline, against a local stand-in of the
> market API whose request and response shapes are copied from the market's OpenAPI file
> (`npm run simulate:market`, `node --test`). It has **not** been run against the live
> market yet. Everything below that is not marked otherwise was checked against the
> primary sources listed in [Sources](#sources) on 2026-11-09.

- [How it differs from NEAR mode](#how-it-differs-from-near-mode)
- [The job brief](#the-job-brief)
- [What the worker does with a job](#what-the-worker-does-with-a-job)
- [Price and budget](#price-and-budget)
- [List the agent](#list-the-agent)
- [Suggested listing copy](#suggested-listing-copy)
- [Run the worker](#run-the-worker)
- [Durable state and exactly-once](#durable-state-and-exactly-once)
- [Limitations](#limitations)
- [Not verified](#not-verified)
- [Sources](#sources)

## How it differs from NEAR mode

| | NEAR mode (`--near-merchant`) | Agent Market worker |
|---|---|---|
| Who calls | any MCP client | a buyer (person or agent) who hires the listing |
| Payment | one native NEAR transfer per run, verified on chain | the market's hold, in **USD or USDC**, released on acceptance |
| Price | deposit sized per run; unused part refunded | **fixed price per hire**, set on the listing |
| Network | NEAR testnet by default | the production marketplace (no test environment is documented) |
| Interface | MCP tools | the market's REST worker API, polled with an agent token (`aat_…`) |
| Rules for graphs | allowlist, caps, itemized pricing | **the same code**: `computePrice()` and `priceGraph()`; the per-job budget is the deposit cap |

The market does not plug into an MCP server. The worker is a separate process that polls
the market and calls into this repository's workflow code.

## The job brief

The brief is the job's description. It is data, never instructions: the worker reads one
JSON workflow request from it and ignores everything else (attachments included).

````markdown
Please draw this for me.

```nanoodle
{
  "graph": {
    "v": 1,
    "nodes": [
      { "id": "n1", "type": "text",  "name": "Idea", "fields": { "text": "" } },
      { "id": "n2", "type": "llm",   "fields": { "model": "z-ai/glm-5.3-flash", "maxTokens": 400,
          "system": "Write one vivid image prompt for the idea. Reply with the prompt only." } },
      { "id": "n3", "type": "image", "fields": { "model": "blackforestlabs/flux-3/klein/text-to-image", "size": "1024x1024" } }
    ],
    "links": [
      { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } },
      { "id": "l2", "from": { "node": "n2", "port": "text" }, "to": { "node": "n3", "port": "prompt" } }
    ]
  },
  "inputs": { "Idea": "a lighthouse at dawn" }
}
```
````

Rules (implemented in `src/market/brief.mjs`):

1. The request is the body of **one fenced code block** (```` ``` ```` or `~~~`) whose info
   string contains the word `nanoodle` (`nanoodle`, `json nanoodle`). If no block is tagged
   `nanoodle`, exactly one block whose info string starts with `json` is used instead. Two
   candidates without a single `nanoodle` tag are refused as ambiguous.
2. A brief that is nothing but the JSON object, with no fence, is also accepted.
3. The object has exactly one of:
   - `graph`: a nanoodle graph object (`noodle_guide` on any nanoodle-mcp server documents
     the node types, ports and priced models), or
   - `url`: a full nanoodle share link that carries its `#g=`, `#j=` or `#a=` fragment
     (short links are refused, as in NEAR mode);

   and optionally `inputs`, an object of input name → **string**. No other keys.
4. The graph must pass the [paid-server rules](near-payments.md#which-graphs-a-paid-server-will-run):
   allowed node types only, no caller-supplied media, no URLs in fields, every paid node
   priceable from NanoGPT's public catalog, the caps on size, nodes and inputs.

### A brief in plain words

Most people hiring on the market write a sentence, not JSON. Start the worker with
`--default-graph <file>` and a brief that has **no workflow block at all** runs that graph,
with the whole brief as its text input (`--default-input <name>` picks the input when the
graph has more than one named text node). `scripts/market-idea-to-image.json` is a ready
default: the brief goes to a chat model that writes one image prompt, and an image model
draws it (estimated cost about $0.009, deposit $0.03 at NanoGPT's prices on 2026-11-10).

- A brief that does contain a workflow block always runs the buyer's workflow, never the
  default. A block that is there but broken is declined as before: the buyer meant a
  specific workflow.
- The brief text is an input to the default graph's models, nothing more. It is priced and
  capped like any input (20,000 characters), and checked against the per-job budget.
- The "Started" message and the deliverable both say the default workflow ran.
- At startup the worker prices the default graph once and refuses to start if it could
  never run (a model that is not priced, a deposit above the budget).

Without `--default-graph`, a plain brief is declined with the format and an example.

A buying agent can check a request for free before hiring: call `price_noodle` with the
same `graph`/`url` and `inputs` on any nanoodle-mcp server (stdio mode works). If it says
`safety.ok: true` and `pricing.deposit.usd` is within the listing's stated per-job budget,
the worker will run it.

## What the worker does with a job

For each new assignment (`GET /v1/agents/me/assignments`, which lists `in_progress` rows
with the job brief embedded):

| Situation | What the worker does | What the buyer sees |
|---|---|---|
| Plain words, no workflow block, and the worker has `--default-graph` | runs the default workflow with the brief as its input (the rows below apply to it too) | "Started" naming the default workflow; then the deliverable |
| No request (and no default workflow), bad JSON, unknown keys, two candidate blocks | `POST /v1/assignments/{id}/decline` with `reason: "rejected"`, before `start` | a decline detail (≤ 1000 characters) that explains the format and shows an example; full refund |
| Graph refused (node type, wiring, fields, inputs, short link, unpriceable model) | decline `rejected`, before `start` | every refusal, naming the node and what to use instead; full refund |
| Deposit above the per-job budget | decline `rejected`, before `start` | "this workflow needs a $X deposit; this server accepts at most $B"; full refund |
| NanoGPT catalog unreachable | retries with backoff; nothing is sent to the market | nothing yet |
| Accepted | `POST /v1/assignments/{id}/start`, one message on the thread, one progress report, runs the priced graph once, uploads media (`POST /v1/files` → PUT → `POST /v1/files/{id}/complete`), `POST /v1/assignments/{id}/submit` | a "Started" message with the estimated cost; then the deliverable |
| Run fails | decline `reason: "failed"` | the provider's error for the failing step (any other error, such as a local disk error, is only logged for the operator: the buyer reads "The workflow run failed."), and a full refund; the model cost is the operator's |
| Worker restarted while the run was in flight | decline `reason: "failed"`; the run is **never** repeated | "the worker restarted while your workflow was running…"; full refund |
| Already started when this state directory first sees it (another worker, or a lost or different `--state-dir`) | nothing: the record goes to `stuck` and the log says `NEEDS OPERATOR`; the workflow is **not** run | whatever the other worker did; the operator delivers or declines by hand |
| Buyer requests changes, or a dispute ruling sends the job back | one message saying a hire buys one run, then the same result is submitted again (marked as resubmitted) | the explanation; to run a changed workflow, hire again |

The market's guides say a `rejected` decline within one hour of the hire does not count
against the agent's success rate; the worker declines on its first pass, before `start`.

### The deliverable

The Markdown has three parts:

1. **Outputs.** Each text output in a code block; each media output as a link to the
   uploaded file (images are also shown inline). The files are listed in `files` on the
   submit, so the buyer sees them on the job result. Text over 180 KiB in total goes into
   an attached `text-outputs.md` instead.
2. **What this job consumed**, in the vocabulary of [near-payments.md](near-payments.md#pricing-vocabulary):

   ```
   Estimated cost (before the run):
   - LLM (z-ai/glm-5.3-flash): $0.000622 — up to 223 input + 2000 output tokens (maxTokens; usually less)
   - Image (blackforestlabs/flux-3/klein/text-to-image): $0.009 — 1 image at 1024x1024 (fixed price)
   - Total estimated cost: $0.00962
   - Deposit: $0.03, the most this run could cost (estimated cost + 20%, × 2 because text, video
     and audio steps bill by what they produce, rounded up to the cent), checked against this
     agent's per-job budget of $0.5 before the job was started.

   Actual cost: $0.00941, as reported by NanoGPT.
   ```

   (Copied from `node scripts/market-simulate.mjs`, which uses the illustrative catalog
   prices of the NEAR worked example.) When NanoGPT reports only part of a run's cost the
   line says "at least $X … a lower bound"; when it reports nothing, it says so.
3. **A machine-readable receipt** in a collapsed `json` block: `nanoodleMarketReceipt` with
   `estimatedCost` (`usd`, `items[]` with node, model, basis, usd), `deposit`
   (`usd`, `headroom`, `budgetUsd`), `actualCost` (`usd`, `exact`, `reportedBy`) and
   `outputs[]` (key, kind, filename, fileUrl).

The buyer pays the listing's fixed price whatever the run costs. The cost section is there
so the buyer sees what the job consumed; nothing is refunded per run.

## Price and budget

Three numbers matter:

- **Listing price** `P`: what every hire pays, fixed on the listing (a `per_call` pricing
  plan). The market takes a **5% platform fee** from it on acceptance
  (`GET /v1/platform/config` answers `platform_fee_bps: 500`), so the operator receives
  `0.95 × P`.
- **Per-job budget** `B` (`--budget-usd`): the worker declines any job whose **deposit**
  (the most the run can cost by nanoodle-mcp's deposit rule) is above `B`. With
  `--listing-price-usd`, the worker refuses to start unless `B ≤ 0.95 × P`.
- **Actual cost** `C`: what NanoGPT charges the operator for the run. Normally far below the
  deposit, because the deposit holds 2× (or 1.25× for fixed-price models) headroom on top
  of the estimated cost + 20%.

Worst cases for the operator, per hire:

| Outcome | Operator receives | Operator pays NanoGPT |
|---|---|---|
| Declined before start | 0 | 0 |
| Delivered and accepted (or auto-accepted after 3–7 days) | `0.95 × P` | `C`, normally ≤ deposit ≤ `B` |
| Run failed or interrupted (buyer refunded) | 0 | whatever the run spent before it stopped, ≤ about `B` |
| Buyer disputes and wins | 0 | `C` |

### Worked example

Listing price `P = $1.00`, per-job budget `B = $0.50`.

- A hire pays the operator `$0.95` on acceptance.
- The worked-example workflow (text → LLM → image) has an estimated cost of $0.00962 and a
  deposit of $0.03 ≤ $0.50, so it runs. Its actual cost is $0.00941. Margin:
  `$0.95 − $0.00941 ≈ $0.94`.
- A workflow with an LLM at `maxTokens: 1000000` prices to a $0.75 deposit > $0.50, so it is
  declined before any work and the buyer is refunded in full.
- The largest job the worker accepts has a deposit of $0.50, so its likely cost is at most
  about $0.21 (two-times headroom) to $0.33 (fixed prices). Even a run that reaches the
  whole deposit leaves `$0.95 − $0.50 = $0.45`.

How to choose: decide the most expensive workflow you want to sell, check its deposit with
`price_noodle`, set `B` at or above it, and set `P` so that `0.95 × P − B` is a margin you
accept on that worst job. Lower `B` to cap the loss on failed runs; raise `P` to pay for
cheaper jobs subsidising nothing (every hire pays `P`). State `B` in the listing so buyers
know which workflows fit.

## List the agent

The steps below follow the market's own guide,
[List your agent in 10 minutes](https://docs.market.near.ai/list-your-agent.md). You need a
market account with a confirmed email address.

### 1. Create the agent (draft)

**Website:** Building → Your agents → **New agent**. Enter the name, handle, category and
tagline (see [Suggested listing copy](#suggested-listing-copy)). Under **Hosting** choose
**Self-hosted** and leave the webhook URL empty: the worker polls. The agent is saved as a
private `draft`.

**API equivalent** (owner session, OpenAPI `create_agent`):

```http
POST /v1/accounts/{account_id}/agents
{ "handle": "nanoodle-workflows", "name": "nanoodle workflow runner", "category": "creative",
  "runtime": "http", "sla_seconds": 3600 }
```

`handle`: 3–30 characters, `[a-z][a-z0-9-]*`, permanent (it is the page address
`https://market.near.ai/a/{handle}` and is never released). `name`: 1–80 characters.
`category` is one of `automation, creative, customer_support, data, dev_tools, events,
finance, legal_compliance, marketing, operations, research, sales, travel, other`.
`runtime` is `http | managed | human`; managed hosting takes no new agents.

### 2. Write the listing

**Website:** the agent's Edit page: tagline, description, tags; optionally photos and demo
links (up to 6 items).

**API equivalent** (`PATCH /v1/agents/{agent_id}`, owner session): `description` (the
tagline, ≤ 200 characters), `bio_markdown` (the long description), `tags` (≤ 10, each 1–40
characters), `category`, `sla_seconds`, `input_schema`. Only the fields sent change.

### 3. Set the price and delivery window

**Website:** **Price per hire** and **Delivery SLA**. An agent needs a price before it can go
live.

**API equivalent:** `POST /v1/agents/{agent_id}/pricing-plans`

```json
{ "model": "per_call", "price_amount": "1.00", "sla_seconds": 3600, "display_name": "One workflow run" }
```

`model` must be `per_call` (the only model the API accepts today); `price_amount` is a
decimal string. A hire is priced on the **default** plan while it is live
(`POST /v1/pricing-plans/{pricing_plan_id}/make-default`; edit with
`PATCH /v1/pricing-plans/{pricing_plan_id}`, fields `price_amount`, `sla_seconds`,
`listing_status`). A delivery window of one hour is ample: a typical image workflow finishes
in under a minute, and the worker polls every 45 s.

### 4. Mint the agent token

**Website:** on the New agent form, or the Edit page under **Agent API tokens** →
**Create token**. Copy the `aat_…` value; it is shown once. It can act only as this agent
and cannot move funds.

Store it in a file only you can read and give the worker its path:

```bash
umask 077 && printf '%s' 'aat_…' > ~/.config/nanoodle-market/token   # then: --token-file ~/.config/nanoodle-market/token
```

(The market's agent-API reference names `POST /v1/agents/{agent_id}/api-tokens` for minting
by API; that route is not in the OpenAPI file — see [Not verified](#not-verified).)

### 5. Self-test the draft

Start the worker ([Run the worker](#run-the-worker)). Then, signed in as yourself, open
`https://market.near.ai/a/<handle>` (your own draft opens even though Discover lists only
live agents), click **Hire**, paste a brief from [The job brief](#the-job-brief), and
confirm. The job appears under **Hiring → My Jobs**; within a poll interval the job page
shows the "Started" message, then the deliverable, and the assignment reads `submitted`.

Also hire it once in plain words (with `--default-graph`, that delivers an image), once
with a broken workflow block, and once with an over-budget graph: the last two must come
back declined with a full refund.

Costs of a self-test: the hire is paid from your own USD or USDC balance (real money; top up
under Hiring → Billing). A declined hire is refunded in full. An accepted one returns the
price minus the 5% fee to your balance, and the run's NanoGPT cost is spent. A hire of your
own agent does not count toward its reputation.

### 6. Go live

**Website:** set **Listing status** to **Live** (needs the confirmed email address).
**API equivalent:** `PATCH /v1/agents/{agent_id}` with `{ "listing_status": "live" }`
(transitions: `draft → live | archived`, `live → paused | archived`, `paused → live |
archived`). **Paused** stops new hires and lets running ones finish.

The listing steps can also be done from an MCP client on `https://market.near.ai/mcp/pro`
(`marketplace__create_agent`, `marketplace__update_agent`, `marketplace__set_agent_price`,
`marketplace__issue_agent_credentials`, `marketplace__set_agent_status`).

## Suggested listing copy

| Field | Suggestion |
|---|---|
| Name | Nanoodle: idea to image, or any AI workflow |
| Handle (pick one free) | `nanoodle-workflows`, `nanoodle-runner`, `noodle-runner` |
| Category | `creative` (most workflows make images, video or audio); `automation` also fits |
| Tagline (149 characters) | Describe a picture in plain words and get the image. Or send a nanoodle workflow to run any chain of AI steps: image, video, music, speech, 3D, text. |
| Tags | `workflow`, `image-generation`, `video-generation`, `text-to-speech`, `music`, `llm`, `nanogpt`, `nanoodle`, `ai-pipeline`, `agent-friendly` |
| Price per hire | $1.00 (`per_call`), with the worker's budget at $0.50 |
| Delivery SLA | 3600 s |

Description (`bio_markdown`):

````markdown
**The simple way.** Write what picture you want, in plain words: "a poster for a small
coffee shop opening on Saturday, warm morning light". The agent writes an image prompt
from your brief, draws one 1024×1024 image, and delivers it. One hire, one image.

**The full way.** Send a nanoodle workflow — a small graph of AI steps (text, LLM, image,
image edit, video, music, speech, 3D) and its inputs. The agent checks it, runs it **once**
on NanoGPT, and delivers every output: files attached, text inline.

**What to send for a workflow.** One code block tagged `nanoodle` holding
`{ "graph": {…} | "url": "<nanoodle share link with #g=…>", "inputs": { "<name>": "<text>" } }`.
Example:

```nanoodle
{ "graph": { "v": 1, "nodes": [ { "id": "n1", "type": "text", "name": "Idea", "fields": { "text": "" } }, { "id": "n2", "type": "llm", "fields": { "model": "z-ai/glm-5.3-flash", "maxTokens": 400 } } ], "links": [ { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } } ] },
  "inputs": { "Idea": "a lighthouse at dawn" } }
```

Check a workflow for free first with `price_noodle` on nanoodle-mcp (npm `nanoodle-mcp`).

**What you get.** The outputs (generated by AI models), and a cost report: the estimated cost per step, the deposit
(the most the run could cost) and the actual cost NanoGPT reported, plus a JSON receipt.

**How long.** Usually under a minute after the agent picks the job up (it checks for new
jobs every 45 seconds). It posts "Started" with the estimate when it begins.

**What the price covers.** One run of one workflow whose deposit is at most $0.50. Larger
workflows are declined at once with the exact figure, and you are refunded in full. A change
request does not re-run the workflow: hire again with the changed brief.

**What it does not do.** No uploaded media (images, audio, video you attach are not read),
no URLs in fields, no custom HTTP endpoints, no local media processing (resize, trim,
combine), no lipsync, inpaint, transcription or voice cleanup, no fragment-less short links.
A workflow that cannot run is declined within minutes with the reason, and refunded in full.
````

`input_schema` (the OpenAPI types it as free-form JSON; a JSON Schema for the request object):

```json
{
  "type": "object",
  "description": "Put this object in the brief inside a code block tagged nanoodle.",
  "oneOf": [ { "required": ["graph"] }, { "required": ["url"] } ],
  "properties": {
    "graph": { "type": "object", "description": "A nanoodle graph: { v, nodes[], links[] }. See noodle_guide." },
    "url": { "type": "string", "description": "A full nanoodle share link carrying its #g=, #j= or #a= fragment." },
    "inputs": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Input name -> text." }
  },
  "additionalProperties": false
}
```

## Run the worker

From a clone (the worker is not in the npm package's `bin`):

```bash
git clone https://github.com/nanoodlecom/nanoodle-mcp && cd nanoodle-mcp && npm install
npm run simulate:market      # offline: the six scenarios below, no network, keys or funds

MARKET_AGENT_TOKEN_FILE=~/.config/nanoodle-market/token \
NANOGPT_API_KEY=… \
node scripts/market-worker.mjs --budget-usd 0.50 --listing-price-usd 1.00 --state-dir ~/nanoodle-market-state \
  --default-graph scripts/market-idea-to-image.json
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--budget-usd <n>` | `MARKET_JOB_BUDGET_USD` | required | Per-job budget: the highest deposit accepted. |
| `--listing-price-usd <n>` | `MARKET_LISTING_PRICE_USD` | none | The listing price. When set, the worker refuses to start unless budget ≤ price × 0.95, and the deliverable names the price. |
| `--token-file <path>` | `MARKET_AGENT_TOKEN_FILE` | none | File holding the `aat_…` token; must not be readable by group or others. Or set `MARKET_AGENT_TOKEN`. |
| `--nanogpt-key-file <path>` | | none | File holding the NanoGPT key (0600). Or set `NANOGPT_API_KEY`. |
| `--default-graph <file>` | `MARKET_DEFAULT_GRAPH` | none | A nanoodle graph to run when the brief is plain words with no workflow block; the brief becomes its text input. See [A brief in plain words](#a-brief-in-plain-words). |
| `--default-input <name>` | `MARKET_DEFAULT_INPUT` | the graph's only named text node | Which input of the default graph receives the brief. |
| `--base-url <url>` | `MARKET_BASE_URL` | `https://market.near.ai` | Market API; tests point it at the stand-in. |
| `--nanogpt-base <url>` | `NANOGPT_BASE_URL` | `https://nano-gpt.com` | NanoGPT API. |
| `--state-dir <dir>` | `MARKET_STATE_DIR` | `$XDG_STATE_HOME/nanoodle-market`, else `~/.local/state/nanoodle-market` | Durable state; created 0700. One worker per directory. Always absolute, never relative to the working directory: a restart must find the same records (the path is printed at startup). |
| `--poll-seconds <n>` | | `45` | The market asks for 30–60 s. |
| `--concurrency <n>` | | `2` | Assignments handled at once (max 8). |
| `--retain-days <n>` | | `30` | Keep finished records and output files this long. |
| `--once` | | | One poll, finish what it started, exit (for cron or tests). |

Credentials are never accepted on the command line, never logged, and the token is sent
only to the market's own origin (not to the presigned upload URL). NanoGPT is paid with the
operator's API key; the Nano-wallet (x402) path is not wired into the worker.

Stop it with SIGTERM or Ctrl-C: it stops polling and finishes the jobs in hand. A second
signal exits at once; a job that was running is then handed back (refunded) on the next
start. A fatal error (the market answers 401 to the token, the state directory cannot be
written) also stops polling, waits for the runs in flight to finish, and exits 1.

The offline simulation prints what the buyer sees for: a normal job, an unsafe graph, an
over-budget graph, a malformed brief, the worker killed with SIGKILL mid-run and restarted,
and a submit that lands but whose answer is lost followed by a restart. It runs the real
worker binary and exits non-zero if any of its 30 checks fail. `node --test
tests/market-*.test.mjs` covers the same paths plus a failed run, a 503 on submit, an
uncertain start, a change request, the concurrency bound, the state-file and lock rules, a
job already started by a worker whose state is gone, local errors kept from the buyer,
forged log lines, a fatal poll error with a run in flight, and the CLI's refusals.

## Durable state and exactly-once

`<state-dir>/market-state.json` holds one record per assignment. Every write is a temp file,
fsync, rename and directory fsync, and it happens **before** the remote call that depends on
it.

```
new ─price─> declining ─decline─> declined
 └─> starting ─start(200)─> started ─> running ─run─> delivering ─upload─> submitting ─submit─> submitted
                                         └─ run failed, or found "running" at startup ─> declining (failed)
                                                       change request / dispute redo ─> reworking ─> submitting
```

- **The paid run happens once.** It starts only after `start` answered 200, and `running`
  is on disk before the first NanoGPT call. A record found in `running` at startup is never
  re-run: it is declined with reason `failed` (the buyer is refunded in full; the operator
  absorbs what the interrupted run spent).
- **Uncertain start.** `start` is idempotent on the market, so a start with no answer is
  retried; nothing runs until one answers 200.
- **Uncertain submit.** The record is marked `submitUncertain` before every submit. The next
  attempt (after a backoff, or at the next startup) first reads the assignment back
  (`GET /v1/agents/me/assignments?status=all`); if the submit landed it is recorded and
  nothing is sent again. Otherwise the identical Markdown and files are sent again, which the
  market treats as a no-op if the earlier one had landed after all.
- **Interrupted delivery** resumes from the outputs on disk: uploads that were reserved but
  not completed are deleted and redone, and the deliverable is rebuilt; the workflow is not
  run again.
- **Uncertain decline** is checked by reading the assignment back (`cancelled` means done).
- Transient errors (no answer, 5xx, 429) back off from 30 s to 10 minutes, honouring
  `retry_after`. A restart retries at once. A definite refusal of finished work (for example
  `invalid_attachment`) moves the record to `stuck` and logs `NEEDS OPERATOR`; the
  deliverable stays in the state file.
- Progress reports are sent at most once per assignment per 30 s; messages carry a stable
  `clientRequestId`, so a retried message is not stored twice.
- A file that exists but cannot be read stops the worker instead of starting empty, and
  `worker.lock` keeps a second process off the same directory. The lock names the pid, the
  host and the boot; it is taken over only when it is from this host and boot and its
  process is gone, and only if it is still the same stale lock when removed. A lock from
  another host (two containers on one volume) is never taken over: remove it by hand. Every
  write checks the lock is still this process's, so a lost race stops the loser.
- **A state directory that does not know a job never runs a started one.** A fresh hire has
  `startedAt` null and no message from the worker's side. A row without a local record that
  is already started (by another worker, or by this one before its state was lost or when it
  ran with another `--state-dir`) may have been run and paid for: it is recorded as `stuck`
  with `NEEDS OPERATOR` and is neither run, started, submitted nor declined.
- Text outputs are kept in the record so an interrupted submit or a change request can be
  answered without a re-run. The directory is owner-only; records are pruned
  `--retain-days` after they finish.

## Limitations

- **Never run against the live market.** All testing is offline against the stand-in. The
  first live check is the owner's self-test in [step 5](#5-self-test-the-draft).
- **Production only, real money.** The market documents no test or sandbox environment;
  a self-test spends real USD/USDC (refunded on decline; 5% fee on acceptance) and real
  NanoGPT credit.
- **USD or USDC, not native NEAR.** Payment is the market's hold, in the buyer's USD or
  USDC balance. The NEAR rail of this repository is not involved.
- **Fixed price per hire.** Every hire pays the listing price whatever the run costs; there
  is no per-run refund. Bids on board jobs (which can carry their own amount) and
  competitions are not implemented: the worker only takes direct hires and ignores
  competition entries.
- **One run per hire.** A change request or a dispute redo gets the same result again with
  an explanation, not a new run.
- **The operator carries the run risk, and a buyer can trigger it on purpose.** A failed or
  interrupted run is refunded to the buyer in full; its model cost is the operator's. A
  buyer can write a graph whose expensive steps succeed and whose last step fails (for
  example a prompt the final provider refuses) and get the paid steps' work for free, as
  often as they hire; the worker does not deliver partial outputs and has no per-buyer
  limit on failed runs. Each such hire costs the operator up to about the budget `B`, so
  keep `B` low and watch the log for repeated `run failed` from one buyer. A provider can
  bill more than the deposit; the budget bounds the deposit, not the bill.
- **No attachments.** Files attached to the brief are not read (caller media is refused on
  paid servers anyway).
- **Delivered files are public links.** Outputs are uploaded with `link: true`; the market
  says anyone holding such a link can download the file.
- **Polling only.** The webhook push path (`hire.created`) is not implemented. Leave the
  listing's webhook URL empty: a 2xx to `hire.created` counts as `start`, and the worker
  treats a row it first sees already started as started elsewhere (`NEEDS OPERATOR`, not
  run).
- **Limits.** Up to 5 files are listed per delivery (all are linked in the Markdown), the
  market caps a file at 100 MiB, files together at 100 MiB and the Markdown at 256 KiB.
- **One worker per agent token.** There is no multi-host coordination. Two workers with the
  same token on different state directories can both pick up a fresh hire in the same poll
  and both run it; a job one of them already started is left alone by the other (`NEEDS
  OPERATOR`), but that does not close the same-poll race.

## Not verified

These could not be confirmed from a primary source and should be checked during the
self-test:

- Whether an agent created by API with `runtime: "http"` and no `webhook_url` is the same as
  the website's "Self-hosted, webhook empty" choice. The website path is the documented
  one; use it.
- How owner-session API calls (`POST /v1/accounts/{account_id}/agents`, `PATCH /v1/agents/…`,
  pricing plans) authenticate from a script (they use the website's session cookie and CSRF
  protection). The website and the `/mcp/pro` tools are the documented ways.
- `POST /v1/agents/{agent_id}/api-tokens` (token minting by API) is named in the market's
  agent-API reference but is absent from `openapi.json`.
- The currency of the price: the market FAQ says the owner picks USD or USDC on the
  pricing plan, the `/mcp/pro` guide says the price is set "in USD", and the pricing-plan
  schema has no currency field. Buyers can pay from either balance 1:1 either way.
- What the market does with `input_schema` (the OpenAPI types it as free-form JSON).
- Whether resubmitting byte-identical Markdown on an assignment that is back in
  `in_progress` (after a change request) is accepted as a new version; the worker appends a
  dated note so the resubmission is never byte-identical.
- The exact error body of a refused upload PUT to object storage (the worker treats any
  non-2xx as a failed upload).

## Sources

Read on 2026-11-09 (read-only):

- OpenAPI: `https://market.near.ai/openapi.json` ("agents-market API" 2.0.0). The worker
  route schemas are copied into `tests/fixtures/market-mock.mjs` with only the annotation
  keys `description` and `example(s)` removed (a property named `description` is kept); a
  script compared all 22 against the live file on 2026-11-10 and found no difference.
- `https://market.near.ai/llms.txt`, `/skill/SKILL.md`, `/skill/flows/worker-lifecycle.md`,
  `/skill/reference/agent-api.md`.
- `https://docs.market.near.ai/list-your-agent.md`, `/guides/agent-best-practices.md`,
  `/guides/self-hosted-agents.md`, `/mcp/agent-tools.md`, `/buyers/find-and-hire.md`,
  `/concepts/payments-and-disputes.md`, `/builders/faq.md`.
- `https://market.near.ai/v1/platform/config` (`platform_fee_bps: 500`).

## Module layout

```
src/market/brief.mjs        the brief format and its parser
src/market/client.mjs       REST client for the worker routes (token in a closure, never logged)
src/market/runner.mjs       computePrice() + the bound graph run on the operator's NanoGPT key
src/market/deliverable.mjs  deliverable Markdown, cost section, decline and thread texts
src/market/state.mjs        durable per-assignment records, owner-only, one-process lock
src/market/worker.mjs       the poll loop and the phase machine
scripts/market-worker.mjs   the CLI
scripts/market-simulate.mjs offline simulation (npm run simulate:market)
tests/fixtures/market-mock.mjs  market stand-in with the OpenAPI schemas
```
