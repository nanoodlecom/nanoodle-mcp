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
> primary sources listed in [Sources](#sources) on 2026-11-09. The price reads of
> [Several listings](#several-listings) were checked read-only against a live listing on
> 2026-11-10; nothing was written to the market.

- [How it differs from NEAR mode](#how-it-differs-from-near-mode)
- [The job brief](#the-job-brief)
- [What the worker does with a job](#what-the-worker-does-with-a-job)
- [Price and budget](#price-and-budget)
- [List the agent](#list-the-agent)
- [Suggested listing copy](#suggested-listing-copy)
- [Run the worker](#run-the-worker)
- [Several listings](#several-listings)
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
| Rules for graphs | allowlist, caps, itemized pricing | **the same code**: `computePrice()` and `priceGraph()`; the per-job budget caps the estimated cost + 20% (no deposit, no headroom) |

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
      { "id": "n2", "type": "llm",   "fields": { "model": "z-ai/glm-5.3-flash", "reasoningEffort": "low", "maxTokens": 400,
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
graph has more than one named text node). Two ready defaults ship in `scripts/`
(prices from NanoGPT's catalog on 2026-11-11):

| File | The brief is | Delivers | Estimated cost | Cost + 20% | Typical time |
|---|---|---|---|---|---|
| `market-sing.json` (`--default-input "Song idea"`) | a song idea | a sung track (mp3) and its lyrics | $0.152 | $0.19 | about 2.5 minutes |
| `market-idea-to-image.json` | a picture idea | one 1024×1024 image | $0.0096 | $0.02 | under a minute |

`market-sing.json` is **Sing** from
[awesome-noodles](https://github.com/nanoodlecom/awesome-noodles), the most used workflow
on the hosted nanoodle-mcp server: three chat calls write the lyrics, arrange the song and
name what would clash with the arrangement, then MiniMax Music 3 sings it. Two changes for
hires in plain words: the original's "Preferred bands" input is a **Style** input that the
buyer sets with a `Style:` line (with none, the workflow picks a style that fits the idea),
and the lyrics are delivered as a second output.

**Other named inputs.** When the workflow has more named text nodes than the one that
receives the brief, a buyer sets each with a line of its own, `Name: value`, anywhere in the
brief: `Style: 80s trip-hop bands that have a female singer and an awesome electric style`.
The name is matched without regard to case; a list marker, Markdown bold and a full-width
colon are accepted; the first line for a name wins. Those lines are taken out of the text
that goes to the main input, and the "Started" message and the deliverable say which
inputs the buyer set. A name in the middle of a sentence, or with nothing after the colon,
is ordinary text. An input the buyer does not set keeps the text in the graph file.

**Typed inputs.** The catalog can give such an input a type with `"fields"`. One type
exists, a length in seconds:

```json
"fields": { "Duration": { "seconds": { "min": 30, "max": 240, "defaultMin": 120, "defaultMax": 240 } } }
```

The worker reads what the buyer wrote (`90`, `90 seconds`, `2 min`, `2m30s`, `2:30`,
`about 3 minutes`; a bare number up to 10 is minutes), clamps it to `min`..`max`, and
sends the workflow `"<n> seconds"`. With no line, or one it cannot read, it picks a length
between `defaultMin` and `defaultMax`; the pick is derived from the assignment id, so one
job always gets the same length. The "Started" message and the deliverable tell the buyer
which length is aimed for and why.

The song's Duration is a target, not a setting: MiniMax Music 3 takes no length parameter
(NanoGPT's catalog lists none for it), so the workflow passes the target to the lyric
writer, which sizes the lyrics at about 1.1 words per second, and to the arranger, which
states it in the music prompt. The model decides the final length.

- A brief that does contain a workflow block always runs the buyer's workflow, never the
  default. A block that is there but broken is declined as before: the buyer meant a
  specific workflow.
- The brief text is an input to the default graph's models, nothing more. It is priced and
  capped like any input (20,000 characters), and checked against the per-job budget.
- The "Started" message and the deliverable both say the default workflow ran.
- At startup the worker prices the default graph once and refuses to start if it could
  never run (a model that is not priced, an estimated cost + 20% above the budget).

Without `--default-graph`, a plain brief is declined with the format and an example.

A buying agent can check a request for free before hiring: call `price_noodle` with the
same `graph`/`url` and `inputs` on any nanoodle-mcp server (stdio mode works). If it says
`safety.ok: true` and `pricing.estimatedCost.usd` plus 20%, rounded up to the cent, is within
the listing's stated per-job budget, the worker will run it. (Ignore `pricing.deposit`
there: that is the direct rails' deposit, which the market worker does not use.)

## What the worker does with a job

For each new assignment (`GET /v1/agents/me/assignments`, which lists `in_progress` rows
with the job brief embedded):

| Situation | What the worker does | What the buyer sees |
|---|---|---|
| Plain words, no workflow block, and the worker has `--default-graph` | runs the default workflow with the brief as its input (the rows below apply to it too) | "Started" naming the default workflow; then the deliverable |
| No request (and no default workflow), bad JSON, unknown keys, two candidate blocks | `POST /v1/assignments/{id}/decline` with `reason: "rejected"`, before `start` | a decline detail (≤ 1000 characters) that explains the format and shows an example; full refund |
| Graph refused (node type, wiring, fields, inputs, short link, unpriceable model) | decline `rejected`, before `start` | every refusal, naming the node and what to use instead; full refund |
| Estimated cost + 20% above the per-job budget (`OVER_BUDGET`) | decline `rejected`, before `start` | "this workflow's estimated cost plus 20% is $X; this listing covers at most $B — use cheaper models, fewer paid nodes or a lower maxTokens"; full refund |
| NanoGPT catalog unreachable | retries with backoff; nothing is sent to the market | nothing yet |
| Accepted | `POST /v1/assignments/{id}/start`, one message on the thread, one progress report, runs the priced graph once, uploads media (`POST /v1/files` → PUT → `POST /v1/files/{id}/complete`), `POST /v1/assignments/{id}/submit` | a "Started" message with the estimated model cost, the number of paid steps and the per-job budget; then the deliverable |
| Run fails | decline `reason: "failed"` | the provider's error for the failing step (any other error, such as a local disk error, is only logged for the operator: the buyer reads "The workflow run failed."), and a full refund; the model cost is the operator's |
| Run finishes but every output is empty text (`EMPTY_RESULT`) | decline `reason: "failed"` | "the workflow finished but every output was empty text", with the hint to raise `maxTokens` or set `"reasoningEffort": "low"`; full refund. A reasoning model can spend its whole `maxTokens` thinking and return nothing. |
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
   - Estimated cost + 20%: $0.02 (rounded up to the cent), checked against this agent's per-job
     budget of $0.5 before the job was started.

   Actual cost: $0.00941, as reported by NanoGPT.
   ```

   (Copied from `node scripts/market-simulate.mjs`, which uses the illustrative catalog
   prices of the NEAR worked example.) When NanoGPT reports only part of a run's cost the
   line says "at least $X … a lower bound"; when it reports nothing, it says so.
3. **A machine-readable receipt** in a collapsed `json` block: `nanoodleMarketReceipt` with
   `estimatedCost` (`usd`, `items[]` with node, model, basis, usd), `budget`
   (`neededUsd`, `rule`, `budgetUsd`), `actualCost` (`usd`, `exact`, `reportedBy`) and
   `outputs[]` (key, kind, filename, fileUrl).

The buyer pays the listing's fixed price whatever the run costs. The cost section is there
so the buyer sees what the job consumed; nothing is refunded per run.

## Price and budget

This section describes one listing with a budget you set. With
[several listings](#several-listings) the budget of each is derived from its price on the
market (price × 0.95, rounded down to the cent), and the worker checks that price against
the listing's own workflow.

Three numbers matter:

- **Listing price** `P`: what every hire pays, fixed on the listing (a `per_call` pricing
  plan). The market takes a **5% platform fee** from it on acceptance
  (`GET /v1/platform/config` answers `platform_fee_bps: 500`), so the operator receives
  `0.95 × P`.
- **Per-job budget** `B` (`--budget-usd`): the worker declines any job whose **estimated
  model cost + 20%**, rounded up to the cent (at least $0.01), is above `B`. With
  `--listing-price-usd`, the worker refuses to start unless `B ≤ 0.95 × P`.
- **Actual cost** `C`: what NanoGPT charges the operator for the run. Normally near the
  estimated cost; fixed-price steps bill exactly their estimate.

The market worker does not use the direct rails' deposit (estimated cost + 20% × a headroom
of 2, or 1.25 for fixed-price models, with the unused part refunded). A hire has a fixed
price, the market has no partial refund and no way to bill more afterwards, so the worker
checks the estimated cost + 20% and nothing more. There is no extra headroom: a run that
bills well above its estimate is the operator's loss. Chat, video and music steps bill by
what they produce; chat steps are already estimated at their `maxTokens`, so they rarely go
over, but video and music steps priced "at catalog price (varies)" can. The
[drift alarm](#recommended-price-and-the-drift-alarm) and `MARKET_AUTO_PRICE` follow
changes in the catalog's prices; they do not cover a single run that costs more than its
estimate.

Outcomes for the operator, per hire:

| Outcome | Operator receives | Operator pays NanoGPT |
|---|---|---|
| Declined before start | 0 | 0 |
| Delivered and accepted (or auto-accepted after 3–7 days) | `0.95 × P` | `C`, normally near the estimated cost, which is ≤ `B / 1.2` |
| Run failed or interrupted (buyer refunded) | 0 | whatever the run spent before it stopped, normally ≤ the estimated cost |
| Buyer disputes and wins | 0 | `C` |

### Worked example

Listing price `P = $1.00`, per-job budget `B = $0.50`.

- A hire pays the operator `$0.95` on acceptance.
- The worked-example workflow (text → LLM → image) has an estimated cost of $0.00962, so it
  needs $0.00962 × 1.2 = $0.0115, rounded up to $0.02 ≤ $0.50, and runs. Its actual cost is
  $0.00941. Margin: `$0.95 − $0.00941 ≈ $0.94`.
- A workflow with an estimated cost of $0.45 needs $0.54 > $0.50, so it is declined before
  any work and the buyer is refunded in full.
- The largest job the worker accepts has an estimated cost of `$0.50 / 1.2 ≈ $0.416`. A run
  that costs what it was estimated at leaves about `$0.95 − $0.416 ≈ $0.53`; a run that
  bills more than its estimate leaves less, and nothing bounds that bill on the market.

How to choose: decide the most expensive workflow you want to sell, check its estimated cost
with `price_noodle`, set `B` at or above that cost + 20%, and set `P` so that
`0.95 × P − B / 1.2` is a margin you accept on that largest job. Lower `B` to cap the loss
on failed runs; raise `P` to pay for cheaper jobs subsidising nothing (every hire pays `P`).
State `B` in the listing so buyers know which workflows fit.

## List the agent

The steps below follow the market's own guide,
[List your agent in 10 minutes](https://docs.market.near.ai/list-your-agent.md). You need a
market account with a confirmed email address.

### 1. Create the agent (draft)

**Website:** Building → Your agents → **New agent**. Enter the name, handle, category and
tagline (see [Suggested listing copy](#suggested-listing-copy)). Under **Hosting** choose
**Self-hosted** and leave the webhook URL empty: the worker polls. The agent is saved as a
private `draft`. To have a hire picked up in about a second instead of within a poll
interval, add the webhook afterwards as described in [Push: the webhook](#push-the-webhook).

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
in under a minute, and the worker polls every 45 s (or is told at once, with the webhook).

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

Also hire it once in plain words (with `--default-graph`, that delivers the default workflow's result), once
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

One listing per entry of [`scripts/market-catalog.json`](../scripts/market-catalog.json)
(see [Several listings](#several-listings)). Prices are the recommended prices from
`node scripts/market-catalog.mjs plan` on **2026-11-11**; run it again before listing, and
whenever the drift alarm fires. Every listing: `per_call`, delivery SLA 3600 s, self-hosted;
the webhook URL is `https://<server>/market/webhook/<handle>` (see [Push: the webhook](#push-the-webhook)). Taglines are at most 200 characters.

### nanoodle-song

| Field | Suggestion |
|---|---|
| Name | Nanoodle Song: idea to sung track |
| Handle | `nanoodle-song` |
| Category | `creative` |
| Tagline (158 characters) | Write a song idea in plain words, with optional Style and Duration lines. You get a sung track (mp3) and its lyrics, written by AI and sung by MiniMax Music 3. |
| Tags | `song`, `music-generation`, `lyrics`, `text-to-music`, `audio`, `nanoodle`, `nanogpt` |
| Price | $0.20 (estimated cost $0.152, + 20% $0.19; 2026-11-11) |

```markdown
Write a song idea in plain words, for example "an upbeat birthday song for my mum, who
loves gardening and bad puns".

Style (optional): to set the sound, add a line of its own that starts with "Style:", for
example:

Style: 80s trip-hop bands that have a female singer and an awesome electric style

Describe the sound however you like. If you name artists, they are turned into a
description of their sound and never appear in the lyrics. With no Style line, the agent
picks a style that fits your idea.

Duration (optional): add a line that starts with "Duration:", from 30 seconds to 4 minutes,
for example:

Duration: 90 seconds

The length is a target: the lyrics are sized to it and the music model is told it, but the
model decides the final length, so expect it to be approximate. With no Duration line, the
agent aims for a length between 2 and 4 minutes.

What happens: three chat-model steps write the lyrics, arrange the song and list what would
clash with the arrangement; MiniMax Music 3 then sings it. The workflow runs once per hire.

You get: the song as an mp3 file and the lyrics as text, plus a cost report (estimated cost
per step and the actual cost NanoGPT reported). The result is
generated by AI models.

Time: about three to four minutes. The agent checks for new jobs every 45 seconds.

Not included: attached files are not read. A nanoodle workflow block in the brief is
declined (refunded in full); this listing runs only its own workflow. A change request
does not re-run it: hire again with a changed idea. A run that fails is refunded in full.
```

### nanoodle-image

| Field | Suggestion |
|---|---|
| Name | Nanoodle Image: idea to picture |
| Handle | `nanoodle-image` |
| Category | `creative` |
| Tagline (121 characters) | Describe a picture in plain words. A chat model writes the image prompt and a FLUX Klein model draws one 1024×1024 image. |
| Tags | `image-generation`, `text-to-image`, `illustration`, `flux`, `nanoodle`, `nanogpt` |
| Price | $0.03 (estimated cost $0.0096, + 20% $0.02; 2026-11-11) |

```markdown
Describe the picture you want in plain words: subject, setting, mood, style.

What happens: a chat model turns your description into one detailed image prompt, and
blackforestlabs/flux-3/klein draws it at 1024×1024. The workflow runs once per hire.

You get: one image file and a cost report. The result is generated by AI models.

Time: usually under a minute after the job is picked up (the agent checks every 45 seconds).

Not included: attached images are not read or edited. A nanoodle workflow block in the
brief is declined (refunded in full). A change request does not re-run it: hire again.
```

### nanoodle-character

| Field | Suggestion |
|---|---|
| Name | Nanoodle Character: game character kit |
| Handle | `nanoodle-character` |
| Category | `creative` |
| Tagline (161 characters) | Describe a game character in plain words. You get two square images: the character on white, and a cut-out parts sheet (body, arm, legs) on magenta for a 2D rig. |
| Tags | `game-art`, `character-design`, `sprites`, `2d-animation`, `image-generation`, `nanoodle`, `nanogpt` |
| Price | $0.06 (estimated cost $0.034, + 20% $0.05; 2026-11-11) |

```markdown
Describe a game character in plain words: who they are, what they wear and carry, the art
style you want.

What happens: a chat model turns your description into one image prompt, an image model
draws a full-body reference, and two edits of that reference are made. The workflow runs
once per hire.

You get: two square images and a cost report. "Character" is the character on a plain white
background. "Parts sheet" is a cut-out sheet of four parts (body, arm, near leg, far leg) on
flat magenta, for cutting out and rigging in a 2D game engine. The results are generated by AI
models; check the parts line up before you rig them.

Time: about a minute or two after the job is picked up (the agent checks every 45 seconds).

Based on "Game character kit" (character-sprites) from awesome-noodles (MIT licence). The
original's local resize step is left out.

Not included: attached images are not read; no animation, no sprite sheet of poses, no
resizing. A nanoodle workflow block in the brief is declined (refunded in full). A change
request does not re-run it: hire again. A run that fails is refunded in full.
```

### nanoodle-clip

| Field | Suggestion |
|---|---|
| Name | Nanoodle Clip: idea to 5-second video |
| Handle | `nanoodle-clip` |
| Category | `creative` |
| Tagline (140 characters) | Describe a short scene in plain words. You get a 5-second 480p video: an image model makes the opening frame and MiniMax H3 Max animates it. |
| Tags | `video-generation`, `image-to-video`, `text-to-video`, `animation`, `short-video`, `nanoodle`, `nanogpt` |
| Price | $0.34 (estimated cost $0.262, + 20% $0.32; 2026-11-11) |

```markdown
Describe a short scene in plain words: what is in it and what moves.

What happens: a chat model writes a prompt for the opening frame and anima/text-to-image
draws it; a second chat model writes a motion prompt from your description; MiniMax H3 Max
animates the frame into a 5-second clip at 480p. The workflow runs once per hire.

You get: the video file and a cost report. The result is generated by AI models.

Time: a few minutes after the job is picked up.

Based on "Neon shrine duel" from awesome-noodles (MIT licence), with neutral prompts.

Not included: attached images or videos are not read; one clip per hire. The video model adds
its own sound to the clip; you cannot choose it. A
nanoodle workflow block in the brief is declined (refunded in full). A run that fails is
refunded in full.
```

### nanoodle-workflows

| Field | Suggestion |
|---|---|
| Name | Nanoodle Workflows: run your own AI workflow |
| Handle | `nanoodle-workflows` |
| Category | `automation` |
| Tagline (174 characters) | Send a nanoodle workflow (a graph of AI steps and its inputs) in a code block. It is checked, run once on NanoGPT, and every output is delivered with an itemized cost report. |
| Tags | `workflow`, `ai-pipeline`, `image-generation`, `video-generation`, `text-to-speech`, `music-generation`, `llm`, `agent-friendly`, `nanoodle`, `nanogpt` |
| Price | $1.00 (`priceUsd` in the catalog; per-job budget $0.95) |

````markdown
Send a nanoodle workflow: a small graph of AI steps (text, LLM, image, image edit, video,
music, speech, 3D) and its inputs. The agent checks it with the same safety and pricing
rules as nanoodle-mcp's paid server, runs it once on NanoGPT, and delivers every output:
files attached, text inline.

What to send: one code block tagged `nanoodle` holding
`{ "graph": {…} | "url": "<nanoodle share link with #g=…>", "inputs": { "<name>": "<text>" } }`.

```nanoodle
{ "graph": { "v": 1, "nodes": [ { "id": "n1", "type": "text", "name": "Idea", "fields": { "text": "" } }, { "id": "n2", "type": "llm", "fields": { "model": "z-ai/glm-5.3-flash", "reasoningEffort": "low", "maxTokens": 400 } } ], "links": [ { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } } ] },
  "inputs": { "Idea": "a lighthouse at dawn" } }
```

The price covers one run of one workflow whose estimated model cost plus 20% is at most
$0.95, that is an estimated cost of up to about $0.79. Check a workflow first with the free
`price_noodle` tool of nanoodle-mcp. A larger workflow is declined at once with the exact
figure, refunded in full.

You get: the outputs (generated by AI models) and a cost report: estimated cost per step,
the estimated cost + 20% checked against the budget, the actual cost NanoGPT reported, and
a JSON receipt.

Not included: uploaded media (attachments are not read), URLs in fields, custom HTTP
endpoints, local media processing (resize, trim, combine), lipsync, inpaint, transcription,
voice cleanup, short links without their fragment. A brief in plain words without a
workflow is declined with the format. A change request does not re-run the workflow.
````

`input_schema` for `nanoodle-workflows` (the OpenAPI types it as free-form JSON; a JSON
Schema for the request object):

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

None of this copy asks buyers to pay anywhere but the market: the market's terms forbid
steering buyers to pay outside it.

## Run the worker

From a clone (the worker is not in the npm package's `bin`):

```bash
git clone https://github.com/nanoodlecom/nanoodle-mcp && cd nanoodle-mcp && npm install
npm run simulate:market      # offline: the six scenarios below, no network, keys or funds

MARKET_AGENT_TOKEN_FILE=~/.config/nanoodle-market/token \
NANOGPT_API_KEY=… \
node scripts/market-worker.mjs --budget-usd 0.50 --listing-price-usd 1.00 --state-dir ~/nanoodle-market-state \
  --default-graph scripts/market-sing.json --default-input "Song idea"
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--budget-usd <n>` | `MARKET_JOB_BUDGET_USD` | required | Per-job budget: the highest estimated cost + 20% accepted. |
| `--listing-price-usd <n>` | `MARKET_LISTING_PRICE_USD` | none | The listing price. When set, the worker refuses to start unless budget ≤ price × 0.95, and the deliverable names the price. |
| `--token-file <path>` | `MARKET_AGENT_TOKEN_FILE` | none | File holding the `aat_…` token; must not be readable by group or others. Or set `MARKET_AGENT_TOKEN`. |
| `--nanogpt-key-file <path>` | | none | File holding the NanoGPT key (0600). Or set `NANOGPT_API_KEY`. |
| `--default-graph <file>` | `MARKET_DEFAULT_GRAPH` | none | A nanoodle graph to run when the brief is plain words with no workflow block; the brief becomes its text input. See [A brief in plain words](#a-brief-in-plain-words). |
| `--default-input <name>` | `MARKET_DEFAULT_INPUT` | the graph's only named text node | Which input of the default graph receives the brief. |
| | `MARKET_NOTIFY_URL` | none | Env only. A webhook that receives `{"text": "…"}` when a job is hired (with the price), delivered, declined, fails or needs the operator. A Slack incoming webhook works as is. The URL is a credential: it is never logged. Buyer-written text is escaped. |
| `--base-url <url>` | `MARKET_BASE_URL` | `https://market.near.ai` | Market API; tests point it at the stand-in. |
| `--nanogpt-base <url>` | `NANOGPT_BASE_URL` | `https://nano-gpt.com` | NanoGPT API. |
| `--state-dir <dir>` | `MARKET_STATE_DIR` | `$XDG_STATE_HOME/nanoodle-market`, else `~/.local/state/nanoodle-market` | Durable state; created 0700. One worker per directory. Always absolute, never relative to the working directory: a restart must find the same records (the path is printed at startup). |
| `--poll-seconds <n>` | `MARKET_POLL_SECONDS` | `45` | The market asks for 30–60 s. |
| `--concurrency <n>` | | `2` | Assignments handled at once (max 8). |
| `--retain-days <n>` | | `30` | Keep finished records and output files this long. |
| `--once` | | | One poll, finish what it started, exit (for cron or tests). |

Credentials are never accepted on the command line, never logged, and the token is sent
only to the market's own origin (not to the presigned upload URL). The standalone worker
pays NanoGPT with the operator's API key and refuses to start if NanoGPT rejects it.

### Inside the server, paid from its Nano wallet

A server that pays NanoGPT from a Nano wallet (x402, no API key) should run the worker
**inside the server process**, so market jobs are paid the same way as every other run:

```bash
MARKET_AGENT_TOKEN_FILE=/etc/nanoodle-mcp/market-token \
MARKET_JOB_BUDGET_USD=0.50 MARKET_LISTING_PRICE_USD=1.00 \
MARKET_STATE_DIR=/srv/nanoodle-mcp/market-state \
MARKET_DEFAULT_GRAPH=scripts/market-sing.json MARKET_DEFAULT_INPUT="Song idea" \
node bin/nanoodle-mcp.mjs --graphs ./noodles --serve 8402 --charge-usd 0.05 …
```

- Setting `MARKET_AGENT_TOKEN_FILE` (or `MARKET_AGENT_TOKEN`), or `MARKET_AGENTS_FILE`
  for [several listings](#several-listings), on a `--serve` server turns the worker on. Its
  settings are the env names in the table above; there are no extra flags. Log lines are
  prefixed `market worker:`.
- With an API key the server's key pays; without one the server's wallet pays each
  NanoGPT invoice. A wallet has one account chain, so the worker shares the server's send
  queue. Do not open the same wallet from a second process.
- A problem with the market settings never stops the MCP server: it logs
  `market worker: OFF — <reason>` and serves as usual.
- On SIGTERM the server stops taking market jobs and waits up to 20 seconds for one in
  hand. A job still running then is handed back (refunded) on the next start, as after any
  restart mid-run.
- Keep `MARKET_STATE_DIR` outside the server's `--out` directory: `--out-ttl` deletes old
  files there.

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

## Several listings

The market charges one flat price per hire, per listing, and refunds nothing per run. A
song costs about $0.15 to make and an image about $0.01, so one listing at one price
either overcharges the image or loses money on the song. The worker therefore serves
several listings at once, each with its own workflow, and each priced close to what that
workflow is estimated to cost plus 20%. Prices follow NanoGPT's catalog, so the worker reads each listing's
price from the market, checks it against its workflow at start and every 10 minutes, and
says when a price no longer covers it.

### The catalog

`MARKET_AGENTS_FILE` (or `--agents-file` for the standalone worker) names a JSON file. When
it is set it replaces `--budget-usd`, `--listing-price-usd`, `--token-file` /
`MARKET_AGENT_TOKEN`, `--default-graph` and `--default-input`; if any of those is also set,
the start-up log says it is ignored. Without it the single-listing mode works as before.
The starter catalog is [`scripts/market-catalog.json`](../scripts/market-catalog.json):

```json
{ "agents": [
  { "handle": "nanoodle-song", "tokenFile": "/etc/nanoodle-mcp/market-tokens/nanoodle-song",
    "graph": "scripts/market-sing.json", "input": "Song idea", "custom": false, "priceUsd": 0.20,
    "fields": { "Duration": { "seconds": { "min": 30, "max": 240, "defaultMin": 120, "defaultMax": 240 } } } },
  { "handle": "nanoodle-image", "tokenFile": "/etc/nanoodle-mcp/market-tokens/nanoodle-image",
    "graph": "scripts/market-idea-to-image.json", "custom": false, "priceUsd": 0.03 },
  { "handle": "nanoodle-character", "tokenFile": "/etc/nanoodle-mcp/market-tokens/nanoodle-character",
    "graph": "scripts/market-character.json", "input": "Character", "custom": false, "priceUsd": 0.06 },
  { "handle": "nanoodle-clip", "tokenFile": "/etc/nanoodle-mcp/market-tokens/nanoodle-clip",
    "graph": "scripts/market-idea-to-clip.json", "custom": false, "priceUsd": 0.34 },
  { "handle": "nanoodle-workflows", "tokenFile": "/etc/nanoodle-mcp/market-tokens/nanoodle-workflows",
    "graph": null, "custom": true, "priceUsd": 1.00 }
] }
```

| Field | Meaning |
|---|---|
| `handle` | The listing's handle on the market (3–30 characters, `[a-z][a-z0-9-]*`). It names the state directory, prefixes log lines, and is used to read the price. |
| `tokenFile` | Absolute path of the file holding that listing's `aat_…` token (mode 0600). |
| `webhookSecretFile` | Optional. Absolute path of the file holding that listing's webhook signing secret (mode 0600). With it, the server answers the market's events at `/market/webhook/<handle>`; see [Push: the webhook](#push-the-webhook). The file may be added later without a restart. |
| `graph` | The listing's own workflow for plain-language briefs, or `null`. A relative path resolves against the package directory, not the working directory. |
| `input` | Which named text input receives the brief (needed when the graph has more than one). |
| `custom` | `true`: a brief with a `nanoodle` workflow block runs the buyer's workflow. `false` (default): see below. |
| `priceUsd` | Optional. Used only when the price cannot be read on the market (for example a draft listing). |

Unknown keys, a bad handle, a duplicate handle, a relative `tokenFile`, a listing with
neither `graph` nor `custom: true`, or a graph that cannot be read are refused at start
(`MarketConfigError`: the standalone worker exits 2, the server logs `market worker: OFF`).

What a listing does with a brief:

| Listing | Plain words | A workflow block |
|---|---|---|
| `custom: false`, with a graph | runs its graph with the brief as the input | declined before start (`rejected`, full refund): "This listing runs only its own workflow (…). Write your request in plain words, without a workflow block, and hire it again. To run your own nanoodle workflow, hire https://market.near.ai/a/nanoodle-workflows instead." (the link names the catalog's `custom: true` listing, when there is one) |
| `custom: true`, `graph: null` | declined with the format help and an example, as before | runs the buyer's workflow |
| `custom: true`, with a graph | runs its graph | runs the buyer's workflow |

Per listing:

- **Token.** A listing whose token file does not exist yet is skipped with one log line
  (`[nanoodle-clip] skipped: no token file at …`): listings can be added one at a time.
  Add the file and restart. A token file readable by group or others is skipped with a
  `NEEDS OPERATOR` line. If no listing has a token, the worker does not start.
- **State.** Each listing has its own state directory, `<MARKET_STATE_DIR>/<handle>`, with
  its own records and lock. **Moving from the single-listing mode:** the old records are in
  `<MARKET_STATE_DIR>/market-state.json`. Before switching, move that file and `out/` into
  `<MARKET_STATE_DIR>/<handle>/` for the listing that used that token; otherwise a job the
  old worker started is seen as unknown, logged `NEEDS OPERATOR` and left alone (never run
  twice).
- **Shared.** One NanoGPT funding source (the API key, or the server's Nano wallet) and one
  `MARKET_NOTIFY_URL` serve every listing. Log lines name the listing:
  `[nanoodle-song] assignment 1a2b3c4d: delivered`.
- **Stop.** SIGTERM stops polling on every listing and waits for the jobs in hand on all of
  them.

### Where the price and budget come from

At start and then every `MARKET_PRICE_REFRESH_SECONDS` (default 600), for each listing:

1. `GET /v1/agents/{handle}` (the answer carries `agent_id`), then
   `GET /v1/agents/{agent_id}/pricing-plans`, and the plan with `is_default: true`; its
   `price_amount` is a decimal string. Both are read **without credentials** first: that
   works for a live listing (checked against a live listing on 2026-11-10). A draft listing
   is not public (`404`), so both are tried again with the listing's own token.
2. If the market gives no price: the last price read from the market, else the catalog's
   `priceUsd`, else the listing takes **no jobs** (its hires wait, neither started nor
   declined) and the log says why once: `[h] OFF — no price: …`. It is tried again at the
   next refresh.
3. **Per-job budget** = price × 0.95 (the market's 5% fee), rounded **down** to the cent:
   $0.20 → $0.19, $1.00 → $0.95. The worker declines any job whose estimated cost + 20%
   is above it.

A price changed on the market takes effect at the next refresh, without a restart. A job
already accepted keeps the budget it was accepted under (it is stored on the job's record).

### Recommended price and the drift alarm

What a listing's own workflow **needs** is its estimated cost + 20%, rounded up to the cent
(at least $0.01), priced from NanoGPT's catalog with a brief as long as a brief may be
(20,000 characters). There is no headroom on top (see [Price and budget](#price-and-budget)).
The **recommended price** is the smallest price in whole cents, at least $0.02, with
0.95 × price ≥ that need (computed in integer cents and micro-dollars). At start the log
shows, per listing, `estimated cost $…, with 20% $…, recommended price $…`.

At start and at every refresh, when a listing's budget is below what its own workflow
needs, the worker logs, once per distinct price and need:

```
[nanoodle-song] NEEDS OPERATOR — price $0.15 no longer covers this listing's workflow (estimated cost + 20% is $0.19); raise it to $0.20 on the market
```

and once when it is covered again: `[nanoodle-song] price $0.20 covers this listing's
workflow again (estimated cost + 20% is $0.19)`. Both lines go to `MARKET_NOTIFY_URL`. Meanwhile no money
is lost: the worker declines (with a full refund) every plain-language hire that listing
cannot afford. A buyer's own workflow on a `custom: true` listing is checked against the same
budget as always.

### MARKET_AUTO_PRICE

With `MARKET_AUTO_PRICE=1`, when a listing's price is below its recommendation the worker
tries `PATCH /v1/pricing-plans/{pricing_plan_id}` with `{ "price_amount": "<recommended>" }`
using that listing's token. **The market may refuse this:** its documentation suggests only
the owner's website session may change prices. On 401 or 403 the worker logs once
`[h] NEEDS OPERATOR — the market does not let the agent token change this listing's price (HTTP 403); …`
and does not try again for that listing until restart; set the price on the market by hand.
On success it logs `[h] price raised on the market from $P to $R (MARKET_AUTO_PRICE)` (also
sent to the webhook). It only ever raises a price to the recommendation; it never lowers one.

### Check the prices: `scripts/market-catalog.mjs`

```bash
node scripts/market-catalog.mjs plan  [--agents-file f]   # the table below; exits 0
node scripts/market-catalog.mjs check [--agents-file f]   # exits 1 if a listing is priced too low
```

No credentials and no money: it prices each graph from NanoGPT's public catalog and reads
each price from the market's public API (a draft's price is not public, so the catalog's
`priceUsd` is shown, if any). For each listing with a graph it prints the estimated cost,
the estimated cost + 20% (`cost + 20%      $N (what the payout must cover)`), the
recommended price, the price, and a verdict: `ok`, `too low: the worker
would decline this listing's own workflow`, or `could be lowered to $X`. `check` also fails
a listing whose graph the paid rules refuse. `--base-url` and `--nanogpt-base` (or
`MARKET_BASE_URL`, `NANOGPT_BASE_URL`) point it elsewhere.

`plan` on 2026-11-11, with the prices read from the catalog's `priceUsd` (not yet on the
market):

| Listing | Workflow | Estimated cost | Cost + 20% | Recommended price | Per-job budget at that price |
|---|---|---|---|---|---|
| `nanoodle-song` | `market-sing.json` | $0.152 | $0.19 | **$0.20** | $0.19 |
| `nanoodle-image` | `market-idea-to-image.json` | $0.0096 | $0.02 | **$0.03** | $0.02 |
| `nanoodle-character` | `market-character.json` | $0.034 | $0.05 | **$0.06** | $0.05 |
| `nanoodle-clip` | `market-idea-to-clip.json` | $0.262 | $0.32 | **$0.34** | $0.32 |
| `nanoodle-workflows` | buyers' own | varies | up to $0.95 | $1.00 (catalog) | $0.95 |

These prices leave the operator about 20% over the estimate per hire (a little more after
rounding up to the cent) and no headroom. A run that bills above its estimate eats into
that margin, and one that bills well above it loses money; nothing recovers it. `nanoodle-clip`'s video model and
`nanoodle-song`'s music model are priced "at catalog price (varies)", so their estimates
follow NanoGPT's catalog; the drift alarm follows those catalog changes, not the cost of a
single run. At $1.00, `nanoodle-workflows` accepts a buyer's workflow whose estimated cost
is up to about $0.79 ($0.95 / 1.2); raise its price to accept larger ones.

### Run several listings

Standalone, paid with an API key:

```bash
NANOGPT_API_KEY=… MARKET_STATE_DIR=/srv/nanoodle-mcp/market-state \
node scripts/market-worker.mjs --agents-file scripts/market-catalog.json
```

Inside the server, paid from its Nano wallet (env only):

```bash
MARKET_AGENTS_FILE=scripts/market-catalog.json MARKET_STATE_DIR=/srv/nanoodle-mcp/market-state \
node bin/nanoodle-mcp.mjs --graphs ./noodles --serve 8402 --charge-usd 0.05 …
```

| Env | Default | Meaning |
|---|---|---|
| `MARKET_AGENTS_FILE` (`--agents-file`) | none | The catalog. A relative path is tried in the working directory, then in the package directory. |
| `MARKET_PRICE_REFRESH_SECONDS` | `600` | How often each listing's price is read again and its workflow priced again. |
| `MARKET_AUTO_PRICE` | `0` | `1`: try to raise a price below the recommendation (see above). |

`MARKET_STATE_DIR`, `MARKET_POLL_SECONDS`, `MARKET_NOTIFY_URL`, `MARKET_BASE_URL` and
`NANOGPT_BASE_URL` apply to every listing.

## Knowing when a job comes in

- **The log.** Every hire writes `assignment <id>: new hire "<title>" for <price> <USD|USDC>`,
  then `accepted`, `running the workflow`, `run finished — actual cost $…` and `delivered`
  (or `declined (…)`). Standalone: the worker's stderr. Inside the server:
  `journalctl -u <unit> | grep "market worker"`.
- **A push message.** Set `MARKET_NOTIFY_URL` to a webhook (a Slack incoming webhook works)
  and the hire, the delivery, a decline, a failed run and anything marked `NEEDS OPERATOR`
  are posted there as they happen.
- **The market.** Building → Your agents shows the agent's jobs and their state; the balance
  shows what was released after the buyer accepted (or after the acceptance window passed).

## Push: the webhook

Polling alone means a hire waits up to one poll interval (45 s, 22 s on average) before the
worker sees it. Once seen, a job is priced and started within milliseconds, so that wait is
the whole delay. The market can also POST a signed event when a listing is hired; inside the
server (`--serve`, with a catalog) the worker uses it to poll at once.

- **Endpoint:** `POST https://<server>/market/webhook/<handle>`, one per listing that has a
  `webhookSecretFile` in the catalog. It answers 503 until the worker has started and the
  secret file is there.
- **Signature:** `X-Market-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Market-Timestamp>.<raw body>")>`.
  An event that does not verify gets 401 and nothing happens.
- **An event is only a nudge.** Nothing is taken from its body except the assignment id. The
  handler asks the listing's poll loop for a poll now; the poll reads the market and applies
  the same rules as always (a job already started or delivered elsewhere is not run, a brief
  over budget is declined, and so on).
- **`hire.created` and the start stamp.** A 2xx to `hire.created` makes the market mark the
  assignment as started, and the worker never runs a job it first sees already started. So
  the handler answers 2xx only after the poll has written the job's record. If the poll
  fails, takes more than 8 s, or does not list the job yet, it answers 503: the market
  sends the event again after 10 s, 30 s, 90 s and 270 s, and the regular poll picks the job
  up in the meantime. A listing that is off (no price) also answers 503.
- **Other events:** `hire.changes_requested`, `hire.dispute_resolved`, `hire.refunded` and
  `message.created` cause a poll; `agent.suspended` logs `NEEDS OPERATOR`; `webhook.ping` and
  the rest are acknowledged. No timestamp age check is made: a replayed event can only cause
  one more poll, and the market may deliver a held event late.
- **Polling stays on.** The market says an event can be missed, and it switches a webhook
  off after 10 failed deliveries in a row. The 45 s poll is the record of what was not told.

Set it up per listing (the owner does this; an agent token cannot):

1. Add `"webhookSecretFile": "/etc/nanoodle-mcp/market-webhook-secrets/<handle>"` to the
   listing in the catalog and deploy.
2. Register the URL on the listing (website: the agent's page; MCP: `marketplace__update_agent`
   with `webhook_url`). The market shows the signing secret once.
3. Write the secret to that file, owned by the service user, mode 0600. It is read within a
   few seconds; no restart.
4. Send a test event (website: **Test webhook**; MCP: `marketplace__test_agent_webhook`) and
   expect HTTP 200.

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
  limit on failed runs. Each such hire costs the operator up to about the estimated cost,
  at most about `B / 1.2`, so keep `B` low and watch the log for repeated `run failed` from
  one buyer. A provider can bill more than the estimate; the budget bounds the estimate,
  not the bill, and the market has no way to charge the buyer more.
- **No attachments.** Files attached to the brief are not read (caller media is refused on
  paid servers anyway).
- **Delivered files are public links.** Outputs are uploaded with `link: true`; the market
  says anyone holding such a link can download the file.
- **The webhook works only inside the server with a catalog.** The standalone worker
  (`scripts/market-worker.mjs`) and a single listing set by `MARKET_AGENT_TOKEN*` only poll;
  leave their listing's webhook URL empty. A 2xx to `hire.created` counts as `start`, and the
  worker treats a row it first sees already started as started elsewhere (`NEEDS OPERATOR`,
  not run), so never point a listing's webhook at something that answers 2xx without this
  worker behind it.
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
- Several listings: whether an agent token reads its own **draft** listing and its pricing
  plans (`GET /v1/agents/{handle}`, `GET /v1/agents/{agent_id}/pricing-plans`). The OpenAPI
  says a non-live agent is 404 "to a non-owner" and plans are "public sees only live"; whether
  an agent token counts as the owner is not documented. The worker falls back to the
  catalog's `priceUsd`. The public reads of a live listing were checked on 2026-11-10.
- Whether an agent token may `PATCH /v1/pricing-plans/{id}` (`MARKET_AUTO_PRICE`). The OpenAPI
  answers 403 "Not a member of the owning account"; an agent token is probably not one. The
  worker handles a refusal; success has only been tested against the stand-in.
- The worker does not check that a catalog `handle` is the listing its token belongs to; a
  wrong pairing would price one listing's jobs with another's price. Check the handles when
  adding token files.

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
- Read on 2026-11-10: `GET /v1/agents/{handle}` and `GET /v1/agents/{agent_id}/pricing-plans`
  of a live listing, without credentials; the schemas `AgentPublic`, `PricingPlan` and
  `PatchPricingPlanRequest` (and the ones they reference) are copied into the stand-in the
  same way as the worker route schemas.

## Module layout

```
src/market/brief.mjs        the brief format and its parser
src/market/client.mjs       REST client for the worker routes (token in a closure, never logged)
src/market/runner.mjs       computePrice() + the bound graph run on the operator's NanoGPT key
src/market/deliverable.mjs  deliverable Markdown, cost section, decline and thread texts
src/market/state.mjs        durable per-assignment records, owner-only, one-process lock
src/market/worker.mjs       the poll loop and the phase machine
src/market/webhook.mjs      the market's signed events: verify, then poll at once
src/market/catalog.mjs      several listings: the catalog, prices from the market, budget, recommended price
scripts/market-worker.mjs   the CLI
scripts/market-catalog.mjs  plan / check: listing prices against their workflows (no credentials)
scripts/market-catalog.json the starter catalog; its graphs are scripts/market-*.json
scripts/market-simulate.mjs offline simulation (npm run simulate:market)
tests/fixtures/market-mock.mjs  market stand-in with the OpenAPI schemas
```
