# Paying for custom workflows in NEAR

nanoodle-mcp can sell workflow runs for native NEAR. An agent can compose its own
workflow graph, ask what it will cost, pay one NEAR transfer, get the result, and
receive the unused part of its deposit back in NEAR. Nobody needs an account or API key.

This document covers the design and how to operate it. It describes NEAR **testnet** by
default. Mainnet is a configuration change; read [Limitations](#limitations) before you
switch.

- [The flow in one picture](#the-flow-in-one-picture)
- [Pricing vocabulary](#pricing-vocabulary)
- [Worked example](#worked-example)
- [Tools and arguments](#tools-and-arguments)
- [Quote, receipt and price shapes](#quote-receipt-and-price-shapes)
- [Configuration](#configuration)
- [Which graphs a paid server will run](#which-graphs-a-paid-server-will-run)
- [Durable state](#durable-state)
- [On-chain verification](#on-chain-verification)
- [Refunds](#refunds)
- [Threat model](#threat-model)
- [Limitations](#limitations)
- [Module layout](#module-layout)

## The flow in one picture

```
agent                              nanoodle-mcp (NEAR mode)                NEAR RPC
  |  price_noodle {graph, inputs}     |                                        |
  |---------------------------------->|  validate + itemize (free, no quote)   |
  |<----------------------------------|                                        |
  |  run_noodle {graph, inputs}       |                                        |
  |---------------------------------->|  validate fully, price, lock rate,     |
  |<---------- quote -----------------|  store quote (pending, 15 min)         |
  |                                                                            |
  |  ONE native transfer of exactly quote.amountYocto to quote.payTo --------->|
  |                                                                            |
  |  run_noodle {graph, inputs,       |                                        |
  |   _payment_id, _payment_tx,       |  tx status (FINAL) ------------------->|
  |   _payment_sender}                |<---------------------------------------|
  |---------------------------------->|  check, consume tx hash (durable),     |
  |                                   |  run ONCE on NanoGPT, settle           |
  |                                   |  refund transfer --------------------->|
  |<----- result + receipt -----------|                                        |
  |  (same call again)                |                                        |
  |---------------------------------->|  replay stored outcome, never re-run   |
```

1. **Quote.** The agent calls a paid tool with no payment arguments. The server checks the
   call completely before it quotes: argument shapes, graph safety, caps, and that every
   paid node can be priced. It then returns a quote. A quote has a payment id, the merchant
   account, the network, the exact amount in yoctoNEAR and as a NEAR decimal, an expiry, and
   the itemized pricing. The amount ends in a small random *dust* that makes it unique among
   open quotes, so the amount identifies the quote.
2. **Pay.** The agent (or its human) sends **one** native NEAR transfer of exactly that
   amount to the merchant account. One transaction with one `Transfer` action and no other
   actions.
3. **Run.** The agent repeats the same call with the same arguments, plus `_payment_id`, the
   transaction hash (`_payment_tx`) and the account it paid from (`_payment_sender`). The
   server reads the transaction from RPC at `FINAL` finality and checks it (see
   [On-chain verification](#on-chain-verification)). It records the transaction hash as
   consumed before anything runs, then runs the workflow once.
4. **Settle.** The charge is `min(actual model cost + 20% service fee, deposit)`. It is
   converted at the NEAR/USD rate locked into the quote. The graph that ran is the graph
   that was priced (see [The run is bound to the price](#the-run-is-bound-to-the-price)). The server returns the rest to the
   paying account in one NEAR transfer. The result carries a receipt with the charge, the
   refund, both transaction hashes and explorer links.
5. **Replay.** Repeating the call with the same `_payment_id` returns the stored outcome. It
   never runs, charges or refunds again.

A run that fails refunds the **whole deposit**. This matches the Nano (XNO) charge mode.
Provider costs already incurred are the operator's loss, never the caller's.

## Pricing vocabulary

Every price the server shows uses these terms, with the same meaning in
`price_noodle`, quotes, receipts, tool descriptions and the README.

| Term | Meaning |
|---|---|
| **estimated cost** | The model cost this run is expected to have, itemized per paid node: node, model, basis, USD. It comes from NanoGPT's public model catalog. Text steps are priced at their `maxTokens` and at the longest text that can reach them. |
| **service fee** | 20% of the **actual** model cost. It is not a percentage of the estimate or of the deposit. |
| **likely charge** | Estimated cost + 20% service fee: what the caller will most likely pay. |
| **deposit** | The most you can be charged. It is held up front and is the amount you send. |
| **charged** | Actual model cost + 20% service fee, capped at the deposit. When the provider does not report a run's full cost, the estimated cost is charged instead (see below). |
| **refund** | The deposit minus what was charged. It is sent back to the paying account automatically. |
| **rate** | The NEAR/USD rate used, with its source and timestamp. A quote locks it, so settlement uses the same rate. |

In `structuredContent`, a figure named after its term is `usd` (`estimatedCost.usd`,
`likelyCharge.usd`, `deposit.usd`, `charged.usd`); a figure only known after the run is
`likelyUsd` (`serviceFee.likelyUsd`, `refund.likelyUsd`).

Each quote and `price_noodle` answer includes a sentence like this one, which states what the
caller will most likely pay, that the deposit is the cap, and that the rest comes back:

> You will most likely pay about $0.0115 (0.003172 NEAR): the estimated cost plus a 20%
> service fee. You send 0.008379 NEAR as a deposit; that is the most you can be charged,
> even if the run costs more, and the rest is refunded to your account as soon as the run
> finishes.

(`price_noodle` says "You will send a deposit of about 0.008242 NEAR", because the quote
adds the unique dust.) A second sentence explains why the deposit is larger than the
likely charge:

> Text, video and audio steps bill by what they actually produce, so the deposit holds
> twice the likely charge as headroom, rounded up to the next cent ($0.03); image prices
> are fixed.

For an all-image workflow it reads "Every model here has a fixed price, so the deposit is
the likely charge plus 25% headroom, rounded up to the next cent ($0.02)", and below a
cent "The deposit is the $0.01 minimum, because this workflow most likely costs less than
that."

### How the deposit is computed

```
likely charge = estimated cost × 1.2
deposit (USD) = max($0.01, round up to the cent( likely charge × headroom ))
headroom      = 1.25 when every priced node has a fixed price (image-only), else 2
```

This formula is the same one the Nano charge mode uses for saved graphs (`priceFor` in
`src/gate.mjs`), so both payment rails quote the same deposits. When a deposit would exceed
the operator's configured maximum (`--near-max-deposit-usd`, default $2.00), the call is
refused before a quote exists.

The deposit in NEAR is `ceil(deposit USD / rate)`, rounded up to a whole 0.000001 NEAR.
Dust of 1 to 999 steps of 0.000001 NEAR is then added, chosen so the amount differs from
every other open quote. The amount therefore has at most six decimals and can be typed into
any wallet exactly. The dust is at most 0.000999 NEAR, and it comes back with the refund.
When all 999 amounts at one price are held by open quotes, the server answers "too many
open quotes at this price; try again in a few minutes" instead of widening the dust.

The quote shows the deposit as what is actually sent: "Deposit: 0.008379 NEAR (about
$0.0305 at the locked rate: the $0.03 deposit plus 0.000137 NEAR that makes the amount
unique and comes back with the refund)". The receipt's `deposit.usd` is that sent value at
the locked rate (`0.03049956`), next to `deposit.quotedUsd` (`0.03`), so
`deposit.usd − charged.usd = refund.usd`.

### How the charge is computed

All on-chain arithmetic uses BigInt yoctoNEAR (1 NEAR = 10^24 yocto) and no floating point.
The locked rate is stored as an exact pair: `usdNano` nano-dollars buy `yocto` yoctoNEAR.

```
cost    = ceil(actual model cost USD × yocto / usdNano)    // as reported by NanoGPT
fee     = floor(cost / 5)                                   // 20% service fee
charged = min(cost + fee, deposit)
refund  = deposit − charged
```

The cost used is the one NanoGPT reports for the run. When it reports only part of it
(the engine marks the total as a lower bound) or nothing at all, the **estimated cost** is
charged instead, if it is higher; the receipt then says "The provider reported only $X for
this run, so you are charged the estimated cost $Y + 20% service fee" and carries
`actualCost.billedAs: "estimate"`. Strangers choose the models on a NEAR server, so a lower
bound is not charged as if it were the cost. When a run costs more than its deposit, the
caller pays the deposit (`charged.capped: true`) and the operator absorbs the rest.

## Worked example

The graph is `text → llm → image`. The caller types the idea, an LLM turns it into an image
prompt, and an image model draws it.

```json
{
  "v": 1,
  "nodes": [
    { "id": "n1", "type": "text",  "name": "Idea", "fields": { "text": "" } },
    { "id": "n2", "type": "llm",   "fields": { "model": "z-ai/glm-5.3-flash",
        "system": "Write one vivid image prompt for the idea. Reply with the prompt only." } },
    { "id": "n3", "type": "image", "fields": { "model": "blackforestlabs/flux-3/klein/text-to-image",
        "size": "1024x1024" } }
  ],
  "links": [
    { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } },
    { "id": "l2", "from": { "node": "n2", "port": "text" }, "to": { "node": "n3", "port": "prompt" } }
  ]
}
```

Inputs are `{ "Idea": "a lighthouse at dawn" }`. The catalog prices used here are
illustrative: GLM costs $0.10 per 1M input tokens and $0.30 per 1M output tokens, and FLUX
Klein costs $0.009 per 1024×1024 image. The rate is 1 NEAR = $3.64.

| Step | USD | NEAR |
|---|---|---|
| Estimated cost, `LLM` (z-ai/glm-5.3-flash): up to 223 input and 2,000 output tokens | $0.000622 | |
| Estimated cost, `Image` (flux-3 klein): one 1024×1024 image, fixed price | $0.009 | |
| **Estimated cost** | **$0.00962** | |
| Likely charge (estimated cost + 20% service fee) | $0.0115 | 0.003172 |
| **Deposit** (likely charge × 2, rounded up to the cent; the graph includes a text model) | **$0.03** | 0.008242 + dust 0.000137 = **0.008379** (8379000000000000000000 yocto; ≈ $0.0305 at the locked rate) |
| Actual model cost reported by NanoGPT after the run | $0.00941 | 0.002585164835164835164836 |
| Service fee (20% of actual) | $0.001882 | 0.000517032967032967032967 |
| **Charged** | **$0.011292** | **0.003102197802197802197803** |
| **Refund** (deposit − charged) | **$0.03049956 − $0.011292 = $0.019207559** | **0.005276802197802197802197** |

The LLM row prices output at 2,000 tokens because this node sets no `maxTokens`; the run
is then sent `max_tokens: 2000`. See [Pricing assumptions](#pricing-assumptions).

## Tools and arguments

| Tool | Paid in NEAR mode? | Purpose |
|---|---|---|
| `run_noodle` | yes | Runs a workflow given as `graph` (an inline nanoodle graph object) **or** `url` (a nanoodle share link), with `inputs`. |
| `price_noodle` | no, free | The same `graph` / `url` / `inputs` as `run_noodle`. Returns the itemized price and safety verdict without creating a quote. Use it to iterate on a design. |
| `noodle_guide` | no, free | How to author a graph: allowed node types, their ports and fields, a complete example, and the priced models per kind with unit prices (`kind`, `search`, `limit` filters). |
| saved-graph tools | yes | Every graph in `--graphs` that passes the same safety checks. They are priced the same itemized way. |

The built-in tools (`subnano_comment`, `sfw_check`, `humanize-comment`) are not offered in
NEAR mode.

`run_noodle` and `price_noodle` are also available in the free stdio and HTTP modes, where
`graph` works too. The Nano (XNO) charge mode is unchanged: it still withdraws `run_noodle`,
and it also withdraws `price_noodle` and `noodle_guide`.

Payment arguments, used on the paying call only:

| Argument | Meaning |
|---|---|
| `_payment_id` | The `paymentId` from the quote. |
| `_payment_tx` | The hash of your transfer transaction (base58). |
| `_payment_sender` | The account you paid from. RPC uses it to locate the transaction. The payer the server refunds is always read from the chain, never taken from this argument. |

A payment id is bound to the tool name and a hash of all other arguments. Changing any
argument requires a new quote.

## Quote, receipt and price shapes

Every answer has human-readable text and a `structuredContent` object. Field names are
stable. USD and NEAR amounts are **decimal strings**, yocto amounts are **integer strings**,
and times are ISO 8601.

Estimates (`estimatedCost`, `likely*` and the service-fee estimate) are forecasts. In USD
they are rounded to three significant digits, and in NEAR to six decimals. Amounts that are
money (`deposit`, actual cost, fee, `charged`, `refund`) are exact in `structuredContent`:
USD amounts are trimmed after nine decimals, and NEAR amounts after 24. The text shows
NEAR amounts with at most six decimals, marked `≈` when rounded.

### `pricing` (in `price_noodle`, quotes and receipts)

```json
{
  "pricing": {
    "currency": "USD",
    "estimatedCost": {
      "usd": "0.00962",
      "fixedPrice": false,
      "items": [
        { "nodeId": "n2", "node": "LLM", "type": "llm", "model": "z-ai/glm-5.3-flash",
          "basis": "up to 223 input + 2000 output tokens (maxTokens; usually less)", "usd": "0.000622", "fixedPrice": false },
        { "nodeId": "n3", "node": "Image", "type": "image", "model": "blackforestlabs/flux-3/klein/text-to-image",
          "basis": "1 image at 1024x1024 (fixed price)", "usd": "0.009", "fixedPrice": true }
      ]
    },
    "serviceFee": { "rate": "0.2", "appliesTo": "actual model cost", "likelyUsd": "0.00192" },
    "likelyCharge": { "usd": "0.0115" },
    "deposit": { "usd": "0.03", "headroom": "2", "why": "Text, video and audio steps bill by what they actually produce, so the deposit holds twice the likely charge as headroom, rounded up to the next cent ($0.03); image prices are fixed." },
    "refund": { "likelyUsd": "0.0185", "how": "returned automatically to the paying account after the run" },
    "summary": "You will most likely pay about $0.0115 (0.003172 NEAR): the estimated cost plus a 20% service fee. You send 0.008379 NEAR as a deposit; ...",
    "safety": { "ok": true, "refusals": [] },
    "unpriced": []
  }
}
```

This block was copied from a real run of the worked example (`node scripts/near-simulate.mjs`
prints the same figures).

`price_noodle` returns `pricing` plus, when NEAR mode is on, a `near` block with the same
figures in NEAR at the current rate (`rate`, `likelyChargeNear`, `depositNear`,
`depositNearIsApproximate: true` because the quote adds the dust). It does not return a
payment id. When a graph cannot be run or priced, `price_noodle` still answers without an
error. It sets `safety.ok: false` and lists every refusal: unsafe nodes and wiring, unknown
or missing inputs (`BAD_INPUTS`), nodes it could not price (`UNPRICED_NODE`, also listed
under `unpriced`), models priced only by a live quote, and a deposit over the cap. So
`safety.ok: true` means a quote will be issued. A graph that
cannot be read at all (bad JSON shape, unreadable share link) gets `pricing: null` and a
top-level `safety` block. A `note` string says how this server is paid (free, or NEAR on
which network).

A refused paid call returns `isError: true` with `structuredContent.refusals`
(`[{ code, message, nodeId?, type?, model? }]`) and creates no quote. Codes:
`NODE_NOT_ALLOWED`, `UNKNOWN_NODE`, `UNSAFE_WIRING`, `UNSAFE_FIELD`, `BAD_FIELD`, `BAD_GRAPH`,
`GRAPH_TOO_LARGE`, `TOO_MANY_NODES`, `INPUTS_TOO_LARGE`, `SHORT_LINK`, `UNPRICED_NODE`,
`LIVE_PRICED_MODEL`, `CATALOG_UNAVAILABLE`, `DEPOSIT_TOO_HIGH`. Malformed arguments (both or neither of
`url`/`graph`, an unknown or missing input, a missing `_payment_tx`) are JSON-RPC `-32602`.

### Quote (the payment-required answer)

```json
{
  "pricing": { "...": "as above" },
  "payment": {
    "rail": "near",
    "status": "payment_required",
    "network": "testnet",
    "paymentId": "nq_4kGm2b7XyQ1v",
    "payTo": "merchant.testnet",
    "amountYocto": "8379000000000000000000",
    "amountNear": "0.008379",
    "depositUsd": "0.03",
    "depositUsdSent": "0.0305",
    "dustNear": "0.000137",
    "likelyChargeNear": "0.003172",
    "rate": { "nearUsd": "3.64", "source": "coingecko", "at": "2026-11-09T12:00:00.000Z" },
    "expiresAt": "2026-11-09T12:15:00.000Z",
    "next": "Send exactly 0.008379 NEAR (8379000000000000000000 yoctoNEAR) to merchant.testnet on testnet in ONE transfer, then call this tool again with the same arguments plus _payment_id, _payment_tx and _payment_sender."
  }
}
```

### Receipt (appended to a paid result)

```json
{
  "receipt": {
    "rail": "near",
    "network": "testnet",
    "paymentId": "nq_4kGm2b7XyQ1v",
    "deposit": { "yocto": "8379000000000000000000", "near": "0.008379", "usd": "0.03049956", "quotedUsd": "0.03",
                 "txHash": "...", "explorerUrl": "https://testnet.nearblocks.io/txns/..." },
    "actualCost": { "usd": "0.00941", "exact": true, "billedAs": "reported", "reportedUsd": "0.00941" },
    "serviceFee": { "usd": "0.001882" },
    "charged": { "yocto": "3102197802197802197803", "near": "0.003102197802197802197803", "usd": "0.011292", "capped": false },
    "refund": { "yocto": "5276802197802197802197", "near": "0.005276802197802197802197", "usd": "0.019207559",
                "to": "payer.testnet", "status": "sent", "txHash": "...", "explorerUrl": "https://testnet.nearblocks.io/txns/..." },
    "rate": { "nearUsd": "3.64", "source": "coingecko", "at": "2026-11-09T12:00:00.000Z" },
    "outcome": "succeeded"
  }
}
```

The result's own text replaces the engine's `cost: $X` line (model cost only) with what was
charged, for example `charged: $0.011292 (≈0.003102 NEAR): model cost $0.00941 + 20% service
fee; refund ≈0.005277 NEAR sent`, so a paid result never shows two different "cost" figures.

`refund.status` is one of `sent` (the transfer executed at FINAL and its hash is known),
`pending` (the first send failed and is queued for retry; its hash is shown once known),
`none` (nothing to return) or `failed_permanent` (retries exhausted; contact the operator
with the payment id). A failed, rejected or interrupted call is returned with `isError: true`
and the same `receipt`. `outcome` is `succeeded`, `run_failed` (whole deposit refunded),
`wrong_amount` (no run; everything you sent was refunded), `late_payment` (no run; refunded),
or `interrupted` (the server restarted during the run; whole deposit refunded).

## Configuration

NEAR mode is opt-in. It requires `--serve` and cannot be combined with `--charge-usd`.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--near-merchant <account>` | `NEAR_MERCHANT` | (none: NEAR mode off) | Account that receives payments and sends refunds. |
| `--near-network testnet\|mainnet` | `NEAR_NETWORK` | `testnet` | Network to verify and refund on. |
| `--near-rpc <url>` | `NEAR_RPC_URL` | testnet `https://test.rpc.fastnear.com`, mainnet `https://free.rpc.fastnear.com` | JSON-RPC endpoint. Use a provider you trust: it attests finality. |
| `--near-key-file <path>` | `NEAR_PRIVATE_KEY` (`ed25519:...`; also read from `--env-file`) | (required) | Full-access key of the merchant account, used to sign refunds. A key file is a near-cli credentials JSON (`account_id`, `public_key`, `private_key`). Its `account_id` must equal the merchant account. The key is never logged or echoed, and never accepted on the command line. |
| `--near-usd <n>` | `NEAR_USD` | (live) | Static NEAR/USD rate for tests and demos. Without it, the rate comes from CoinGecko's public simple-price endpoint. It is cached for 60 seconds and a stale copy is used for at most 5 minutes. After that, quoting **fails closed**: no quote is issued without a rate. |
| `--near-max-deposit-usd <n>` | | `2` | Refuse any call whose deposit would exceed this. |

NanoGPT is paid exactly as it is today, with the operator's `NANOGPT_API_KEY` or Nano wallet.
NEAR mode changes only how callers pay the operator.

The state file is `<out>/near-state.json`. Money events are appended to `<out>/usage.jsonl`
with `"rail": "near"` and the same event names as the Nano mode (`quote`, `paid`,
`refund`, `change`). Use a **dedicated merchant account** whose key no other software uses.
Refund nonces are managed by this server alone (see [Refunds](#refunds)).

## Which graphs a paid server will run

A NEAR-mode server runs strangers' graphs, so it accepts only node types that read no
caller-chosen file or URL, run no local-media node, and whose cost can be bounded before
the run. Unknown types are refused. Every refusal names the node, the reason and what to
use instead.

| Node type | Allowed | Why |
|---|---|---|
| `text`, `choice`, `join` | yes | Pure text logic. |
| `comment` | yes | A note; does nothing. |
| `llm`, `decide` | yes | NanoGPT chat models. Any media they read must come from an upstream NanoGPT node (see wiring rules). |
| `image`, `edit` | yes | NanoGPT image models. `edit` sources must be upstream NanoGPT images. |
| `tvideo`, `ivideo` | yes | NanoGPT video models. Sources come only from upstream NanoGPT nodes. A LoRA URL is passed to the provider and never fetched by the server. |
| `music`, `tts` | yes | NanoGPT audio models. |
| `model3d` | yes | NanoGPT 3D models; any image comes from an upstream NanoGPT node. |
| `vision` | **no** | Its chat call carries no output limit, so its cost has no upper bound. Use `llm` with the image on `img1`. |
| `vedit`, `remix`, `transcribe`, `cleanvoice` | **no** | Billed by the length of an input clip, which is not known before the run. |
| `upload`, `aupload`, `vupload`, `mupload` | **no** | Caller-supplied media. As a file path it reads the server's disk; as a URL the server fetches it; as inline data it can trigger local ffmpeg resizing. |
| `inpaint` | **no** | Takes its image and mask straight from fields (any URL or inline data) and composites the mask locally. |
| `lipsync` | **no** | May trim audio locally with ffmpeg. |
| `resize`, `vframes`, `combine`, `soundtrack`, `trim`, `extractaudio` | **no** | Local media processing (pure JS or ffmpeg) on the server. |
| `endpoint` | **no** | POSTs to any URL written in the graph, which would let a caller reach internal addresses. |
| anything else (including the retired `draw`) | **no** | Unknown to the engine. |

No caller-chosen file, URL or local-media node runs. `ffmpeg`/`ffprobe` may still run on
images NanoGPT generated: to shrink an image that is too large to send to the next model,
and to fit images wired into `decide`.

### Wiring and field rules

- A link may feed a **media port** (`image`, `mask`, `audio`, `video`, `model`, or a
  numbered `img*`, `ref*`, `clip*`, `vid*`, `frame*` port) only from a media output of
  an allowed NanoGPT node. Text never flows into a media port, so a caller cannot smuggle a
  URL into a fetch.
- No link may target a **pricing or URL field**: `model`, `size`, `variations`,
  `duration`, `resolution`, `maxTokens`, `modelOpts`, `loraUrl`, `loras`, `url`, `image`,
  `mask`, `audio`, `video`. A wire into `model` would swap in an unpriced model at run time.
- A media output may feed only a media port (an image wired into a prompt would be sent as
  megabytes of text), and no audio may be wired into an `llm` (billed by its length).
- `fields.modelOpts` (video, 3D) and `fields.extraJson` (audio) are refused when not empty:
  the engine merges them into the provider request as-is, where they could replace the
  priced model or length.
- `fields.maxTokens` on an `llm` must be a whole number of at least 1, or absent.
  `fields.duration` on `tvideo`, `ivideo` and `music` must be a number of seconds, or absent.
- No node field may hold a value starting with `http:`, `https:`, `data:`, `file:` or `blob:`.
  The exception is a LoRA URL on video nodes, which must be `https:`.
- A `url` must be a full share link that carries its `#g=`, `#j=` or `#a=` fragment.
  Fragment-less short links (da.gd, TinyURL) are refused, because resolving them makes the
  server follow redirects to wherever they point.
- Every paid node must be priceable from the catalog. The refusal names each node and model
  the catalog cannot price. A model whose catalog entry says its exact price comes from a
  live quote at run time is refused (`LIVE_PRICED_MODEL`).

### Caps

| Limit | Default |
|---|---|
| Nodes (including comments) | 40 |
| Graph JSON size | 200,000 bytes |
| Input keys | 32 |
| One input value | 20,000 characters |
| All input values together | 50,000 characters |
| Deposit | `--near-max-deposit-usd` ($2.00) |
| Share link | 2 × the graph cap in characters, and its gzip payload is inflated with an output limit of the graph cap, so a small link cannot expand to gigabytes |
| Open (unpaid, unexpired) quotes | 1,000; more are answered "busy, try again in a few minutes" |

Input values must be strings. Allowed graphs only ever derive text inputs (and `choice`
selections), so no input is a file path or a URL.

### Pricing assumptions

- Prices come from NanoGPT's public catalog (`/api/v1/models?detailed=true`,
  `/api/v1/image-models`, `/api/v1/video-models`, `/api/v1/audio-models`,
  `/api/v1/3d-models`). They are cached for an hour. A graph with a paid node is refused
  when its catalog cannot load.
- Each node is priced with the engine's own estimator (`estimateGraphCost`), one node at a
  time, so the itemized lines add up to the engine's total. One shape the estimator reads
  as a flat price, video `per_second` given per resolution, is priced here as rate ×
  duration.
- Inputs are applied to the graph first, with the same key resolution the run uses.
- **Wired text is priced at its longest.** Each node's text output gets an upper bound in
  characters: a `text` node its value, a `choice` its longest option, a `join` the sum of
  its two inputs plus the separator, an `llm` its `maxTokens` × 4, a `decide` 256. Every
  consumer that bills by input is priced with that bound: an `llm`'s `system` and `prompt`
  (plus 1,500 tokens per wired image), capped at the model's context length; the text a
  `decide` judges, added to its question; a `tts` or `music` prompt, capped at the model's
  `max_chars`. Output is priced at the node's `maxTokens`.
- Video, audio and chat prices are estimates, so their deposit has twice the headroom.
  Image prices are exact.

### The run is bound to the price

The graph a paid server runs is the priced graph, with every quantity the price depends on
written into it before it runs (saved graphs too):

- an `llm` without `maxTokens` is sent `max_tokens` = 2,000, or the model's
  `max_output_tokens` when that is lower (the engine alone would send no limit);
- a `tvideo`/`ivideo` without `duration` is sent the catalog's default duration, the one it
  was priced at;
- a `music` node without `duration` is sent 30 s, clamped to the model's range.

## Durable state

Everything that moves money is written to `<out>/near-state.json` **before** the step that
depends on it. Each write is synchronous: a temp file, `fsync`, then rename.

```json
{
  "v": 1,
  "network": "testnet",
  "merchant": "merchant.testnet",
  "quotes": { "nq_...": { "...quote record..." } },
  "consumedTx": { "<txHash>": "nq_..." },
  "refunds": { "rf_...": { "...refund record..." } }
}
```

Quote record:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `nq_` + 12 random base64url characters (72 bits); a bearer secret. |
| `tool`, `argsHash` | string | Binds the quote to one call (`hashArgs` from `src/gate.mjs`). |
| `status` | enum | `pending` → `running` → `settled` \| `failed`; `pending` → `expired` (marked at startup once past `expiresAt`; it can still be paid late and is then refunded); `pending`/`expired` → `rejected` (wrong amount or late: refunded, never run). |
| `amountYocto` | string | Exact deposit. |
| `depositUsd` | string | |
| `rate` | object | `{ usdNano: string, yocto: string, nearUsd: string, source, at }`, locked at quote time. |
| `estimatedCostUsd` | string | Used when the provider does not report a run's full cost. |
| `createdAt`, `expiresAt` | number (ms) | |
| `payTx`, `payer`, `paidYocto`, `paidAtBlockMs` | | Set when a payment is verified. |
| `outcome` | string \| null | `succeeded`, `run_failed`, `wrong_amount`, `late_payment` or `interrupted`. |
| `finishedAt` | number \| null | When the quote reached a final status. |
| `settlement` | object \| null | `{ costUsd, exact, billedAs, reportedUsd, costYocto, feeYocto, chargedYocto, refundYocto }`. Written while the quote is still `running`, before the refund intent. |
| `refundId` | string \| null | Links to the refund record. |
| `result` | object \| null | Media-only results (files and links, plus the receipt). Text output is never written to disk; see below. |
| `error` | string \| null | The gate-authored failure sentence only, never upstream error text. |

Refund record: `{ id, paymentId, to, amountYocto, reason, status: "queued"|"signed"|"sent"|"failed_permanent", txHash, signedTxBase64, nonce, blockHash, signedAt, attempts, nextAttemptAt, lastError, createdAt, sentAt, finishedAt }`.
The file also keeps `meta.lastNonce`, the last refund nonce this server signed.

Rules that make restarts safe:

- **The consumed-transaction map is written before the run starts** and is never pruned. A
  transaction hash can satisfy at most one quote, ever.
- **A quote found in `running` at startup is never re-run.** It moves to `failed` with
  outcome `interrupted`, and its whole deposit is refunded. Restarting costs the operator one
  model run at most and never runs anything twice. If its settlement was already written
  (the run finished, the server stopped before the refund was recorded), it is settled
  instead and only the change is refunded.
- A `failed` or `rejected` quote found at startup without a refund record gets one.
- **A refund is signed and recorded, hash included, before it is broadcast.** After a
  restart, the server re-broadcasts the same signed bytes, which is idempotent because the
  hash is the same. It signs a new transaction only when the old one is provably dead (see
  [Refunds](#refunds)).
- Text output, the caller's paid content, stays in memory only, as in the Nano mode. A replay
  after a restart returns the receipt and states that the text was not retained. It never
  runs again.
- Finished quotes are pruned 24 hours after they finish; unpaid quotes one hour after they
  expire. Pruning runs at startup and at most once a minute while quoting. A stored quote
  keeps only what payment and settlement need (amount, USD deposit, estimated cost, locked
  rate, times); the itemized pricing is in the answer, not on disk. Consumed hashes and
  refunds are kept.
- A state file that exists but cannot be read stops the server with an error instead of
  starting empty. Starting empty could forget a consumed hash or an owed refund.

One process owns the state file. Do not run two servers against the same `--out` directory.

## On-chain verification

The server calls `tx` with `{ tx_hash, sender_account_id, wait_until: "FINAL" }` and
accepts the payment only if all of the following hold:

1. The RPC reports `final_execution_status == "FINAL"`.
2. `status` has `SuccessValue`, and no entry in `receipts_outcome` has a `Failure` status.
3. `transaction.hash` equals `_payment_tx`.
4. `transaction.receiver_id` equals the merchant account.
5. `transaction.actions` is exactly one `{ "Transfer": { "deposit": "<yocto>" } }`.
6. The block of `transaction_outcome.block_hash`, fetched with `block`, has a
   `header.timestamp_nanosec` no earlier than the quote's creation (allowing 120 s of
   clock skew).
7. The hash is not in `consumedTx`.

The payer is `transaction.signer_id`. The caller's `_payment_sender` only routes the lookup.
Public RPCs answer `tx` even when the sender is wrong (checked read-only on
`rpc.testnet.near.org` and `rpc.testnet.fastnear.com`), so the claim would prove nothing.

After these checks:

- If the deposit equals `amountYocto` and the block time is no later than `expiresAt`, the
  quote is paid and the workflow runs.
- If the amount equals the amount of **another open quote**, the transfer belongs to that
  quote's payer: the call is refused and nothing is consumed (see the threat model).
- Otherwise, if the amount differs (underpaid or overpaid), the hash is consumed,
  **everything received is refunded**, and nothing runs (`wrong_amount`).
- If the payment arrived after `expiresAt`, the hash is consumed, everything is refunded, and
  nothing runs (`late_payment`).
- If the transaction is not found, not final, failed, or not a single transfer to the
  merchant, the call returns an error and nothing is consumed. The caller can retry with
  the right hash once it is final.

The RPC returns some numbers as JSON numbers beyond 2^53, such as `header.timestamp`. The
client parses integers exactly and uses `timestamp_nanosec`, which is a string.

## Refunds

Refunds are native transfers from the merchant account. A queue in the server sends them
one at a time.

1. **Persist the owed refund as `queued`** before touching the network, so an RPC outage
   never loses it. Read the access key (`query` / `view_access_key`, `finality: "final"`)
   for its `nonce` and `block_hash`. The new nonce is `max(chain nonce, last nonce used) + 1`.
2. Build the Borsh `Transaction`, sign `sha256(transaction)` with ed25519, and compute
   the hash as `base58(sha256(transaction))`. **Persist the record as `signed`, hash
   included.**
3. Broadcast with `send_tx` (`wait_until: "FINAL"`), which returns once the transfer's
   receipt has executed. If the answer has no executed outcome yet, read it with `tx`
   (`wait_until: "FINAL"`). Only then is the refund `sent`. A transfer whose receipt failed
   (for example, the payer deleted its account after paying) is `failed_permanent` and
   logged for the operator; the NEAR is back in the merchant account.
4. If the broadcast fails, retry the **same bytes** with backoff (30 s up to 10 min).
   Before signing again, check the old hash with `tx` (`wait_until: "NONE"`). A new
   transaction is signed only when the old hash is unknown **and** the network rejected it as
   `Expired` (its block hash is more than about a day old) or `InvalidNonce` **and** the old
   transaction was signed less than 36 hours ago. Regular RPC nodes forget transactions after
   a few epochs, so for an older record "unknown" proves nothing: it is marked
   `failed_permanent` with `lastError: "UNPROVABLE"` and logged, so the operator checks an
   explorer (or an archival RPC) instead of the server risking a second refund.
5. After 100 failed attempts, the refund is marked `failed_permanent` and logged for the
   operator. The money stays in the merchant account, and the receipt says to contact the
   operator.

The merchant pays the refund's gas, about 0.00002 NEAR. A refund is not sent when it is
smaller than 0.00001 NEAR (10^19 yocto). The receipt then shows `refund.status: "none"`,
and the amount counts toward `charged`.

## Threat model

| Threat | What happens |
|---|---|
| **Replay** of a paid call | The payment id maps to one stored outcome. Repeat calls return it and never run, charge or refund again. A different tool or different arguments with the same id are refused. |
| **Reuse of a consumed transaction** | `consumedTx` is durable and checked under the same synchronous step that records it. A second quote presenting the same hash is refused, even after a restart. |
| **Front-running a visible tx hash** | Anyone can see your transfer on chain. To use it, an attacker needs a quote whose exact amount matches (dust makes amounts unique among open quotes) **and** your payment id, which is a 72-bit secret only you received. A hash presented with another quote while its amount is still held by your open quote is refused **without consuming it**, so nobody can burn your payment with a free quote of their own. A transfer that matches no open quote is consumed and refunded to its signer, never to the presenter. Treat your payment id like a password. |
| **Underpayment / overpayment** | Exact match only. Any other amount is consumed and refunded in full, and nothing runs. |
| **Wrong network** | The server only queries its configured network. A mainnet hash is not found on testnet, so the call errors and nothing is consumed. Every quote names the network. |
| **Expired quote** | Before payment, the caller gets a fresh quote. A payment whose block time is after `expiresAt` is refunded in full (`late_payment`). |
| **Restart mid-run** | The consumed hash and the `running` status are on disk before the run. On restart the quote becomes `interrupted` and is fully refunded, and it is never re-run. |
| **Refund failure** | The signed refund is persisted with its hash and retried with the same bytes. It is re-signed only when the old transaction is provably dead. The receipt shows `pending` until it is sent. |
| **Rate movement** | The quote locks the rate. Settlement uses that rate even if NEAR moves during the 15-minute window. A live rate older than 5 minutes stops quoting; it does not guess. |
| **Malicious graph** | Allowlisted nodes only, typed wiring, no URL or data fields, no `modelOpts`/`extraJson`, fragment-only share links, and caps on size (checked before a share link is inflated), nodes, inputs and deposit. The run is bound to the priced graph. Everything is checked before a quote exists, so nobody pays for a call that could not run. |
| **Quote spam** | Quotes are free. At most 1,000 unpaid quotes are open at once; unpaid quotes are pruned an hour after expiry; a stored quote is a few hundred bytes. A flood can make the server answer "busy" for a while (denial of service), but it cannot grow the state file without bound or block payments already quoted. There is no per-client rate limit; put one in front of the server if that matters. |
| **Lying RPC** | Out of scope. The configured RPC is trusted to report finality honestly. Use a provider you trust, or your own node. |

## Limitations

These are deliberate cuts for this version.

- **No caller-supplied media.** Image, audio and video inputs (`upload` and the other input
  nodes) are refused in NEAR mode. Graphs can use media only when an upstream NanoGPT node
  generates it.
- No local-media nodes (resize, trim, combine and the like), no `lipsync`, `inpaint` or
  custom `endpoint` in NEAR mode.
- Fragment-less short links are refused in NEAR mode. Paste the long share link or pass
  `graph`.
- Native NEAR only. There is no NEP-141 token support (such as USDC), and meta-transactions
  are refused: a relayed `Delegate` action is not exactly one `Transfer`.
- The configured RPC is trusted for finality. There is no light-client proof.
- One server process per state file. There is no multi-instance coordination.
- Deposits are bounds built from the public catalog, not guarantees. Text steps are bounded
  by `maxTokens`, but a provider can still bill more than the catalog suggests (for example
  a reasoning model's hidden tokens, if a provider does not count them against
  `max_tokens`). A run that costs more than its deposit is capped at the deposit, and the
  operator absorbs the overrun.
- Text results are not kept across restarts. A replay after a restart returns the receipt
  only.
- Built-in tools (`subnano_comment`, `sfw_check`, `humanize-comment`) are not sold in
  NEAR mode.
- There is no pay page, QR code or payment-watch stream for NEAR. The caller presents the
  transaction hash itself.
- The live rate comes from a single public source (CoinGecko). Use `--near-usd` to pin it.
- Everything is exercised offline against a local chain stand-in that speaks the public RPC
  wire format, plus read-only queries against public testnet RPC. Testnet is the intended
  first live network; mainnet works by configuration only.
- Unpaid quotes are pruned one hour after they expire. A payment for a quote that was
  pruned is answered "unknown payment id"; the NEAR stays in the merchant account and the
  operator must return it by hand.
- No per-client rate limit on free quotes and `price_noodle` (see Quote spam).
- The refund signer must be the only user of the merchant key. Another wallet sending from
  the same key can make a signed refund's nonce stale; the server then re-signs it (see
  [Refunds](#refunds)), which is safe but slower.

## Module layout

```
src/near/errors.mjs      NearError (one error class, stable string codes)
src/near/account.mjs     NEAR account id check
src/near/amount.mjs      yocto <-> NEAR decimal, USD -> yocto at a locked rate (BigInt only)
src/near/base58.mjs      base58 encode/decode
src/near/keys.mjs        parse ed25519 secret keys, sign; never exposes or logs the key
src/near/tx.mjs          Borsh Transfer transaction, sign, hash
src/near/rpc.mjs         JSON-RPC client with injected fetch, exact integers, typed errors
src/near/verify.mjs      read and check a payment transaction
src/near/ledger.mjs      durable quotes / consumed hashes / refunds (sync atomic JSON file)
src/near/rate.mjs        NEAR/USD: static or CoinGecko, cached, fail closed
src/near/refunds.mjs     serialized refund sender with persist-before-broadcast
src/near/explorer.mjs    per-network defaults (RPC, explorer) and nearblocks.io links
src/near/index.mjs       re-exports
src/custom-workflow.mjs  graph args, safety allowlist + caps, itemized pricing,
                         deposit, pricing-vocabulary formatters, authoring guide
src/near-gate.mjs        quote -> verify -> run once -> settle -> refund -> replay
scripts/near-simulate.mjs   whole flow offline: the real server binary against a local
                            chain stand-in and NanoGPT stand-in (npm run simulate:near)
scripts/near-check-tx.mjs   read-only: check a real transfer against the rules above
tests/fixtures/near-fake-chain.mjs  the chain and NanoGPT stand-ins the tests and the
                            simulation share
```
