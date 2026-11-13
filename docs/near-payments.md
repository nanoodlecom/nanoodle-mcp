# Paying for custom workflows in NEAR

nanoodle-mcp sells workflow runs for native NEAR or Circle-issued USDC on NEAR. An agent can compose its own
workflow graph, ask what it will cost, pay one NEAR transfer, get the result, and
receive the unused part of its deposit back in the same asset. Nobody needs a Nanoodle account or API key.

The native NEAR examples below retain their original amount fields. See
[USDC on NEAR](#usdc-on-near) for token payments and [the browser studio](#browser-studio) for the website.

This document covers the design and how to operate it. It describes NEAR **testnet** by
default. Mainnet is a configuration change; read [Limitations](#limitations) before you
switch.

The hosted mainnet endpoint is **https://near.nanoodle.com/mcp**, with
`nanoodle.near` as the merchant. A real payment, automatic detection, workflow
run and refund were verified on 2026-11-13; see [Live mainnet verification](#live-mainnet-verification).

- [The flow in one picture](#the-flow-in-one-picture)
- [Pricing vocabulary](#pricing-vocabulary)
- [Worked example](#worked-example)
- [Tools and arguments](#tools-and-arguments)
- [Quote, receipt and price shapes](#quote-receipt-and-price-shapes)
- [Configuration](#configuration)
- [Rates and the swap margin](#rates-and-the-swap-margin)
- [One server, both rails](#one-server-both-rails)
- [NEAR endpoint and wallet payments](#near-endpoint-and-wallet-payments)
- [USDC on NEAR](#usdc-on-near)
- [Browser studio](#browser-studio)
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
  |<---------- quote -----------------|  store quote (pending, 30 min)         |
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
   converted at the NEAR/USD rate locked into the quote (with the swap margin, if the
   operator set one; see [Rates and the swap margin](#rates-and-the-swap-margin)). The graph that ran is the graph
   that was priced (see [The run is bound to the price](#the-run-is-bound-to-the-price)). The server returns the rest to the
   paying account in one NEAR transfer. The result carries a receipt with the charge, the
   refund, both transaction hashes and explorer links.
5. **Replay.** Repeating the call with the same `_payment_id` returns the stored outcome. It
   never runs, charges or refunds again.

A run that fails refunds the **whole deposit**. This matches the Nano (XNO) charge mode.
Provider costs already incurred are the operator's loss, never the caller's.

## NEAR endpoint and wallet payments

The same server process can expose a second hostname where NEAR is the default.
Both listeners use the **same Nano funding wallet**, serialized wallet queue,
workflow registry, generated files and NEAR ledger. Do not start another process
with the same Nano seed or state directory.

On an existing Nano-paid deployment, add these variables to its service environment:

```dotenv
NEAR_MERCHANT=your-merchant.near
NEAR_NETWORK=mainnet
NEAR_PRIVATE_KEY=ed25519:YOUR_MERCHANT_REFUND_KEY
NEAR_SERVE=127.0.0.1:18403
NEAR_PUBLIC_URL=https://near.nanoodle.com
NEAR_PUBLIC_ALIASES=https://mcp-near.nanoodle.com
NEAR_USDC=1
```

Keep the existing `NANO_SEED` / `NANO_PRIVATE_KEY` and primary `--serve` /
`--charge-usd` settings. `--near-serve` and `--near-public-url` are equivalent
CLI flags. Fund the merchant with NEAR before enabling it: the server verifies
its full-access refund key on chain, and the merchant pays refund gas. An
unfunded implicit account does not yet exist. If verification fails on a dual
deployment, Nano keeps serving and the NEAR listener offers no runnable tools.

Point the new hostname at the existing host, terminate HTTPS, and proxy to the
second listener. For Caddy:

```caddyfile
near.nanoodle.com, mcp-near.nanoodle.com {
    reverse_proxy localhost:18403
}
```

The old `mcp-near.nanoodle.com` hostname remains an alias. Connect an agent to
`https://near.nanoodle.com/mcp`. No `_pay_with` argument
is needed there. The primary endpoint continues to default to Nano; its NEAR
quotes link to the same NEAR payment page.

Choose a free local port for the second listener. If that port cannot bind,
the server logs the error and keeps the primary paid endpoint serving.

1. A paid tool returns `payment.payUrl`, `payment.watchUrl` and
   `payment.statusUrl`, alongside the exact amount and expiry.
2. The agent shows **only the pay URL** to the user, then opens the watch URL
   (SSE), or long-polls the status URL with `?wait=1`.
3. The user connects a NEAR wallet on the payment page and approves **one
   native Transfer** of the exact deposit. NEAR Connect handles wallet selection;
   no private key or access key is given to this server. A manual transfer can
   also be confirmed on that page with its sender account and hash.
4. The page submits the hash to `POST /near/pay/:id`. The existing FINAL
   verification, transaction reuse checks and wrong/late-payment refund rules
   apply. Acceptance is persisted as `paid`, without running a model or storing
   workflow inputs. A reload retries confirmation of the saved transaction;
   an uncertain wallet result does not offer another payment automatically.
5. The monitor ends with `status: "paid"`, `done: true` and `next`. The agent
   repeats the original tool call with **only `_payment_id` added**. The server
   runs once, pays models from the shared Nano pool, and returns unused NEAR
   to the actual transaction signer. The original arguments remain bound to
   the quote, and accepted payments survive restarts.

Agents with their own signing wallet can still pay directly with
`_payment_id`, `_payment_tx` and `_payment_sender`. There is no automatic
NEAR-to-Nano swap: NEAR is received and refunded natively; the existing Nano
float pays model invoices.

### Automatic transfer detection

One shared watcher polls finalized NEAR blocks every two seconds. While quotes
are outstanding it checks only the merchant's account changes, resolves receipt
IDs with `EXPERIMENTAL_receipt_to_tx`, and runs the same FINAL payment verifier.
An exact amount matching a quote is accepted automatically; the caller does not
need to paste a transaction hash. A payment must be in a block created after
its quote for automatic matching. A late exact payment for a retained quote is
refunded in full. An unmatched top-up is not treated as a workflow purchase.
Wrong-amount payments can still be confirmed explicitly for a full refund.

The processed block cursor is durable. RPC failures leave it unchanged and
retry with backoff; restarts catch up, and an existing quote is backfilled when
the watcher is first introduced. Re-reading a receipt cannot spend twice: the
payment gate keeps the consumed transaction hashes. `GET /near/health` reports
the watcher cursor and status without exposing workflow inputs.

The RPC must support `EXPERIMENTAL_changes` and `EXPERIMENTAL_receipt_to_tx`
(including receipt-to-transaction tracking). Public FastNEAR RPC was checked
read-only on mainnet on 2026-11-13. An RPC without those methods leaves automatic
detection unavailable; the payment page's explicit confirmation remains usable.

### Live mainnet verification

On 2026-11-13 a temporary payer sent
[0.003192 NEAR to nanoodle.near](https://nearblocks.io/txns/qF4e5cGJDBqXdoqpmLnQrrtBi7XR2NSeF6orRHcR5LT).
The shared watcher accepted it without a payment POST or caller-supplied hash.
The original `run_noodle` call resumed with only `_payment_id`, ran a small text
workflow on NanoGPT using the existing Nano wallet, and returned a receipt.
The model cost was $0.00000689; with the 20% service fee the charge was
$0.000008268, or 0.00000249036144578313253 NEAR at the locked rate.
[The remaining 0.00318950963855421686747 NEAR](https://nearblocks.io/txns/54CkAs3dK2Tf1u4LNX2Hn5qTCvKkW5ncPYmABMrjhQxs)
returned to the actual payer at FINAL finality. All 13 checks in the real-payment
verifier passed, including exact balance arithmetic and the refund recipient.
The temporary payer's remaining balance was returned to the merchant and its
account was closed. This verifies one real run; failure/restart scenarios remain
covered by local chain/provider simulations.

A real Circle USDC custom run was also verified on mainnet on 2026-11-13:
[0.010358 USDC payment](https://nearblocks.io/txns/GQtma288xJxXafx7pM6E2Tm3CRTQLj8vqTB9iT22FN3b),
automatic discovery without submitting a hash, one text workflow using the same
Nano funding pool, a charge of 0.000015 USDC, and
[0.010343 USDC returned to the payer](https://nearblocks.io/txns/DcX8qB65MPa9gCti3Qk1ucVbvKURPb9dcnZo9dvCzjhr)
at FINAL. A repeated call returned the same refund receipt without another run
or refund. The first discovery was delayed by public RPC rate limiting; the
service recovered from its durable cursor after switching to verified dRPC with
FASTNEAR fallback. Public requests are paced. A long outage prioritizes new
finalized transfers while older pending quotes backfill within the same scan budget.

The complete mainnet matrix also passed on 2026-11-13. Each payment was detected
without submitting its hash, each workflow ran against the real provider from
the same Nano funding pool, and each same-asset refund was checked at FINAL.
The saved workflow was `mix-the-references` (four image generations followed
by one editing step); the custom workflow was a small text-to-LLM graph.
Replaying all four calls returned the original refund hash without another run.

| Workflow / payment | Deposit | Charged | Returned | On-chain proof |
|---|---:|---:|---:|---|
| Custom text · USDC | 0.010358 | 0.000015 | 0.010343 | [payment](https://nearblocks.io/txns/GQtma288xJxXafx7pM6E2Tm3CRTQLj8vqTB9iT22FN3b) · [refund](https://nearblocks.io/txns/DcX8qB65MPa9gCti3Qk1ucVbvKURPb9dcnZo9dvCzjhr) |
| Saved scene · USDC | 0.080595 | 0.0636 | 0.016995 | [payment](https://nearblocks.io/txns/AwGoqbaWiJjfQSmVTgADS5gGs3egncfySGTZU9jpyhUp) · [refund](https://nearblocks.io/txns/9dpYPrhmYesCs2mLk6mCuu5GBUmhBPVJd7x3JGswMnws) |
| Custom text · NEAR | 0.003185 | 0.00000436332378223495702 | 0.00318063667621776504298 | [payment](https://nearblocks.io/txns/DamLnLz6MwDG7bjC5j8GnesvzvxPpzi7qAvxyw6oSV1n) · [refund](https://nearblocks.io/txns/FShUDcU6eBQjyvujs8XAyeVaxRtYV4jr2KUaFpeowU1j) |
| Saved scene · NEAR | 0.022986 | 0.018171428571428571428571 | 0.004814571428571428571429 | [payment](https://nearblocks.io/txns/F3VJUC3pLzMKFd8A4jj5z4YPJq3S7STNKw3CyjiL14Yt) · [refund](https://nearblocks.io/txns/B43QRp5nJUgmC2htVJ7Pbc274uZFgkLifiu2N94YMLyL) |

The paid USDC saved result was also resumed in the real browser studio; its
media link returned HTTP 200 and its refund status reached sent. The temporary
payer returned its remaining USDC, unregistered token storage and closed its
NEAR account with the merchant as beneficiary. All unused test funds returned;
the merchant's USDC balance was unchanged by the round trip. These are live
functional checks, not a load test.

## USDC on NEAR

The hosted endpoint accepts **Circle-issued USDC** alongside native NEAR. Operators
opt in with `NEAR_USDC=1`. Startup verifies the fixed network-specific contract's
`ft-1.0.0` metadata, USDC symbol, six decimals and the merchant's storage registration.
A failed check disables new USDC quotes while native NEAR keeps serving.

The canonical mainnet contract is
`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`;
testnet uses `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`.
These are [Circle's published USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses).
The merchant must register token storage using `storage_deposit` before enabling USDC.
`nanoodle.near` is registered on mainnet.

Call a saved tool or `run_noodle` with `_pay_with: "usdc"`. The quote carries
`asset: "USDC"`, `amountAtomic` (a decimal string of micro-USDC), `amount` (the
six-decimal human amount), `tokenContract`, and `decimals: 6`. It deliberately has
no `amountYocto` or `amountNear` fields. A small unique amount suffix identifies
the quote. USDC quotes use a denomination of **1 USD per USDC**, not a live peg
price; no NEAR/USD conversion is involved. The provider still uses the existing
Nano funding pool and requires its fresh XNO/USD rate.

Send one transaction to the quoted token contract with one `FunctionCall` action:

```json
{
  "methodName": "ft_transfer",
  "args": { "receiver_id": "nanoodle.near", "amount": "EXACT_QUOTED_amountAtomic" },
  "gas": "30000000000000",
  "deposit": "1"
}
```

The attached deposit is **one yoctoNEAR**, as required by the
[NEAR fungible-token standard](https://docs.near.org/primitives/ft/standard).
The payer also needs NEAR for network gas. The wallet page builds this exact
transaction. Token transfers are discovered automatically through finalized
changes to the token account, then verified at FINAL: exact contract, action,
amount, recipient and one matching NEP-141 transfer event from the contract.
An arbitrary token with symbol USDC is never accepted.

Repeat the original tool arguments with `_payment_id` after payment. The receipt
uses `asset`, `amountAtomic` and `amount` for deposits, charges and refunds. The
charge rounds down to six-decimal token precision; unused micro-USDC returns to
the transaction signer. Native and USDC refunds share **one durable signing
queue**, so they cannot race the same access-key nonce. Replays do not execute
or refund again. A quote is bound to its asset and exact original request;
wrong amounts or late matched payments refund in the payment asset. Disabling
new USDC quotes does not discard outstanding token refund obligations.

## Workflow creator payouts

A workflow can declare its creator's Nano address in top-level graph metadata:

```json
"x402": { "author": "nano_…" }
```

This works for saved tools and custom `run_noodle` graphs (objects, JSON strings,
or full share links). The recipient is locked when quoting. Customers still pay
NEAR or USDC and receive change in the same asset. On a successful run, the
collected 20% markup is paid to the author **in Nano from the shared Nano pool**.
There is no extra charge to the customer. Missing `author` leaves the fee with
the operator; invalid addresses are refused before quoting.

The payout uses the quote's locked XNO/USD rate. In integer arithmetic:

```
feeCollected = min(feeAtomic, max(chargedAtomic - costAtomic, 0))
authorRaw = floor(feeCollected × rate.usdNano × 10^30 / (rate.yocto × xnoUsdNano))
```

`Atomic` means yoctoNEAR for native payments and six-decimal token units for USDC.
The rate pair uses those same units. A deposit exhausted by model cost leaves
no author payout. Failed, rejected and interrupted runs produce no payout.
An authored workflow needs a current XNO/USD rate and a configured Nano wallet
before payment can be quoted, even when an API key pays the model provider.

The durable payout outbox is separate from customer refunds and is never pruned
with quotes. It records the debt and signed Nano block before broadcasting.
Retries and restarts republish the same block, so a lost response cannot create
a second payout. A new block can be signed only when a different confirmed
successor proves the original cannot land. All Nano operations use the existing
wallet's single signing queue. Payouts retry independently; customer results and
refunds do not wait for them. `receipt.authorPayout` exposes the recipient,
`amountRaw`, display amount, status and Nano block hash; it is also receipt leg 4.
The payment quote exposes `payment.authorPayout` before the customer pays.

## Browser studio

The private `/pay/<paymentId>` page follows the complete run, using the same
graph, receipt and result renderer as the studio. Its `?run=1` event subscription
continues through payment, node execution and refund settlement. Reopening the
page attaches to the current snapshot and reads the existing result; it never
starts a workflow or requests another payment.

`GET /near/result/<paymentId>` is a read-only result endpoint: 202 while the run
is unfinished, 200 with the existing MCP result and receipt after settlement,
404 for an unknown id. The unguessable private payment link grants read access
to that run's output, so keep it private. Responses use `no-store`; pay pages
send no referrer. Paid text remains in memory and is not recoverable after a
server restart. Persisted media links remain recoverable while the files exist.
The default agent payment watcher still closes on payment so agents can resume
their bound MCP call immediately; the browser's optional run watcher is separate.

**https://near.nanoodle.com** presents Nanoodle on NEAR and offers NEAR or USDC
only when enabled. Ready-made workflows have editable named inputs; the custom
tab accepts graph JSON and text inputs. Getting a quote never executes a model.
The pay link opens the wallet page, while the original tab watches the payment
and resumes the exact snapshotted request automatically. Results and refund
status appear in that tab. Multiple quotes retain their own request and result.

The tab keeps quote/request history in `sessionStorage` so a reload resumes the
same payment instead of requesting another. That browser storage can contain
the inputs you entered; generated result text is not persisted there. Server
logs do not retain prompts. Paid execution remains idempotent if a connection
fails or the tab reloads. Keep the result tab open; generated media expires after
24 hours and text results do not survive a server restart.

### Authorize the merchant refund key

Provision the dedicated server refund key on the merchant account privately,
using the owner's wallet key management or a trusted local NEAR signing tool.
Meteor blocks app-initiated Full Access requests. There is no public merchant
setup page. Preserve the owner's existing wallet key; the server only needs
its own dedicated signing key, not the owner's recovery phrase.

Full Access controls the entire merchant account; it is necessary for plain
native NEAR refund transfers, which function-call keys cannot sign. Use a
dedicated merchant account. The server's private refund key remains in its
existing protected environment file. On startup the service checks that this
public key is a Full Access key on the merchant account on the chosen network.
Restart after authorization, then check `/near/health` for the active listener
and watcher status. No paid workflows are offered on the NEAR listener until
startup verification succeeds. Never put credentials in chat or version control.

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
| **rate** | The NEAR/USD rate used, with its source and timestamp. When known, also the XNO/USD rate and the swap rate derived from the two ("1 NEAR = N XNO"), each with source and timestamp, and the swap margin when it is not zero. A quote locks all of it for its whole lifetime, so settlement uses the same rate. |

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
With no swap margin `yocto` is 10^24 (one NEAR); with a margin of `b` basis points it is
`10^24 × (10000 + b) / 10000`, so every NEAR amount is `b` basis points larger.

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
    "rate": { "nearUsd": "3.64", "source": "coingecko", "at": "2026-11-09T12:00:00.000Z",
              "xnoUsd": "0.95", "xnoSource": "nanogpt-x402", "xnoAt": "2026-11-09T12:00:01.000Z",
              "xnoPerNear": "3.831578947", "nearPerXno": "0.260989011", "spreadBps": 0 },
    "expiresAt": "2026-11-09T12:30:00.000Z",
    "next": "Send exactly 0.008379 NEAR (8379000000000000000000 yoctoNEAR) to merchant.testnet on testnet in ONE transfer, then call this tool again with the same arguments plus _payment_id, _payment_tx and _payment_sender."
  }
}
```

The `rate` object keeps `nearUsd`, `source` and `at` and adds the XNO/USD and swap fields
when the server has them (a NEAR/USD-only rate, or a quote stored before this version,
has only the first three). `xnoUsd` and the swap fields are `null` when XNO/USD is
unavailable on an API-key server; with a swap margin, `spreadBps` is non-zero and
`effectiveNearUsd` is the NEAR/USD the amounts were computed at. The quote's text carries
the same in its one rate line:

> Rate: 1 NEAR = $3.64 (coingecko, 2026-11-09T12:00:00.000Z); 1 XNO = $0.95 (nanogpt-x402,
> 2026-11-09T12:00:01.000Z), so 1 NEAR = 3.831578947 XNO, locked for this quote; network testnet

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
    "rate": { "nearUsd": "3.64", "source": "coingecko", "at": "2026-11-09T12:00:00.000Z",
              "xnoUsd": "0.95", "xnoSource": "nanogpt-x402", "xnoAt": "2026-11-09T12:00:01.000Z",
              "xnoPerNear": "3.831578947", "nearPerXno": "0.260989011", "spreadBps": 0 },
    "outcome": "succeeded",
    "legs": [
      { "leg": "caller payment", "asset": "NEAR", "amount": "0.008379", "yocto": "8379000000000000000000",
        "txHash": "...", "explorerUrl": "https://testnet.nearblocks.io/txns/...", "status": "final" },
      { "leg": "model payment", "status": "paid", "usd": "0.00941", "xno": "0.009905263",
        "basis": "XNO derived from the reported cost at the locked XNO/USD rate", "fundedBy": "wallet" },
      { "leg": "refund", "asset": "NEAR", "amount": "0.005276802197802197802197", "yocto": "5276802197802197802197",
        "to": "payer.testnet", "txHash": "...", "explorerUrl": "https://testnet.nearblocks.io/txns/...", "status": "sent" }
    ]
  }
}
```

`legs` shows the three money movements of one call separately, each with its own status;
nothing is labelled settled that is not:

1. **caller payment**: the NEAR deposit, its transaction hash and explorer link; `final`
   once the server has read it at FINAL finality.
2. **model payment**: what the server paid NanoGPT for the run, in USD as NanoGPT reported
   it. On a server that pays from its Nano wallet, `xno` is that cost converted at the
   quote's locked XNO/USD rate, labelled as **derived**: the wallet pays NanoGPT per x402
   invoice and its blocks are not attributed to a single run. On an API-key server the
   basis is "paid from the operator's NanoGPT balance" and `xno` is `null`. When the cost
   is not known (a failed or interrupted run, or a provider that reported nothing) the
   status is `unknown` and `usd` is `null`, never zero; when nothing ran it is `none`.
3. **refund**: the NEAR refund with its status (`sent`, `pending`, `none`,
   `failed_permanent`) and hash.

The receipt text ends with the same three legs on three short lines:

```
Leg 1, caller payment: 0.008379 NEAR, tx 8PyS…, final.
Leg 2, model payment to NanoGPT: $0.00941 = 0.009905263 XNO (XNO derived from the reported cost at the locked XNO/USD rate).
Leg 3, refund: ≈0.005277 NEAR, sent (tx 8yto…, https://testnet.nearblocks.io/txns/8yto…).
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

NEAR mode is opt-in and requires `--serve`. Combined with `--charge-usd`, one server takes
either rail per call (see [One server, both rails](#one-server-both-rails)).

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--near-merchant <account>` | `NEAR_MERCHANT` | (none: NEAR mode off) | Account that receives payments and sends refunds. |
| `--near-network testnet\|mainnet` | `NEAR_NETWORK` | `testnet` | Network to verify and refund on. |
| `--near-rpc <url[,url]>` | `NEAR_RPC_URL` | testnet `https://test.rpc.fastnear.com`, then `https://rpc.testnet.near.org`; mainnet `https://free.rpc.fastnear.com`, then `https://rpc.mainnet.near.org` | JSON-RPC endpoint(s), comma-separated, tried in order. Use providers you trust: each one attests finality. See [The RPC](#the-rpc-no-node-of-your-own). |
| `--near-key-file <path>` | `NEAR_PRIVATE_KEY` (`ed25519:...`; also read from `--env-file`) | (required) | Full-access key of the merchant account, used to sign refunds. A key file is a JSON file with `account_id`, `public_key` and `private_key`: legacy near-cli credentials, or what `scripts/near-testnet-accounts.mjs` writes. Its `account_id` must equal the merchant account. near-cli-rs key files have no `account_id` and are refused; use `NEAR_PRIVATE_KEY` for those. The key is never logged or echoed, and never accepted on the command line. |
| `--near-usd <n>` | `NEAR_USD` (also read from `--env-file`) | (live) | Static NEAR/USD rate for tests and demos. Without it, the rate comes from CoinGecko's public simple-price endpoint. See [Rates](#rates-and-the-swap-margin). |
| `--xno-usd <n>` | | (live) | Static XNO/USD rate; the same flag the Nano charge mode uses. Without it, XNO/USD comes from NanoGPT's own x402 invoices, else CoinGecko. |
| `--near-swap-spread-bps <n>` | `NEAR_SWAP_SPREAD_BPS` (also read from `--env-file`) | `0` | Swap margin, 0 to 2000 basis points. NEAR amounts are computed at a NEAR/USD rate that much worse for the caller, to cover the cost of swapping received NEAR to XNO. |
| `--near-quote-ttl-min <n>` | `NEAR_QUOTE_TTL_MIN` | `30` | Quote lifetime in minutes, 1 to 120. The quote's rates stay locked for all of it. |
| `--near-rates-refresh-s <n>` | `NEAR_RATES_REFRESH_S` | `60` | Background refresh of the live rates every n seconds; `0` turns the timer off (quotes still refresh a rate older than 60 s). |
| `--near-max-deposit-usd <n>` | | `2` | Refuse any call whose deposit would exceed this. |
| | `NEAR_USDC` | off | Set `1` to accept verified Circle USDC, with token refunds. |
| | `NEAR_PUBLIC_ALIASES` | none | Comma-separated exact HTTP(S) origin aliases for the NEAR listener. |

NanoGPT is paid exactly as it is today, with the operator's `NANOGPT_API_KEY` or Nano wallet.
NEAR mode changes only how callers pay the operator.

The state file is `<out>/near-state.json`. Money events are appended to `<out>/usage.jsonl`
(`<out>/near-usage.jsonl` when both rails run) with `"rail": "near"` and the same event
names as the Nano mode (`quote`, `paid`, `refund`, `change`). Use a **dedicated merchant
account** whose key no other software uses. Refund nonces are managed by this server alone
(see [Refunds](#refunds)).

### Reading the payments ledger

Each settled NEAR call writes one `change` event. Besides `chargedYocto` and `refundYocto`
it carries `paidYocto`, `chargedNear`, `refundNear`, `modelUsd` (the USD model cost),
`modelPayment` (`wallet` or `api_key`), `modelXno` (on a wallet-funded server: the XNO
the run cost, derived from `modelUsd` at the locked XNO/USD rate, with `modelXnoBasis:
"derived"`) and `rate` (the locked `nearUsd`, `xnoUsd`, `xnoPerNear`, `nearPerXno` and
`spreadBps`). Every asset stays in its own unit and nothing is netted across assets. To
decide when to swap, total `chargedYocto` over the `change` events (NEAR the operator kept)
and `modelXno` (XNO the Nano float spent); compare them at today's rates on `GET /rates`.
A conversion shown for reporting is never an executed swap: this server does not swap.

## Rates and the swap margin

Callers pay in NEAR. The server pays NanoGPT with its API key or in XNO from its Nano
wallet, so in wallet mode the operator is in effect swapping NEAR for XNO. The server
keeps three rates, each with its source and timestamp:

| Rate | Source, in order |
|---|---|
| NEAR/USD | `--near-usd` / `NEAR_USD`, else CoinGecko's public simple price (`near`) |
| XNO/USD | `--xno-usd`, else NanoGPT's own x402 invoice pair (the rate the Nano float is actually spent at; the same probe the Nano charge mode uses), else CoinGecko (`nano`) |
| swap rate | derived: `xnoPerNear = nearUsd / xnoUsd` and `nearPerXno = xnoUsd / nearUsd` |

The swap rate is **derived from the two USD rates; no swap venue is queried**, and the
server does **not** swap NEAR to XNO itself. Replenishing the Nano float from the NEAR the
merchant account received is a manual operator task. All rate math is exact (decimal
strings and BigInt); no float feeds an amount.

**Swap margin.** `--near-swap-spread-bps b` (default 0, at most 2000) makes NEAR amounts
`b` basis points larger: the locked pair is `{ usdNano, yocto: 10^24 × (10000 + b) / 10000 }`.
With 150 bps and NEAR at $3.64 the worked example's $0.03 deposit is 0.008366 NEAR before
dust instead of 0.008242, and the charge for the same $0.00941 run is
3148730769230769230769 yocto instead of 3102197802197802197803. The rate line then adds
"swap margin 1.5%: NEAR amounts use 1 NEAR = $3.586206897". With 0 every number is exactly
as without a margin.

**Refresh.** Live rates refresh on a background timer (`--near-rates-refresh-s`, 60 s), a
quote refetches a live rate older than 60 s, and a forced refresh refetches now:

- `SIGHUP` re-reads `NEAR_USD` and `NEAR_SWAP_SPREAD_BPS` from the `--env-file` (a flag on
  the command line still wins) and refetches the live rates, so an operator can change a
  pinned rate or the margin without a restart. An invalid value changes nothing. Open
  quotes keep the rate they locked.
- `GET /rates` returns the current rates as JSON: `nearUsd`, `xnoUsd`, `xnoPerNear`,
  `nearPerXno`, `spreadBps`, `effectiveNearUsd`, whether quoting is possible, each source
  with `at`, `fetchedAt`, `ageSeconds` and its last error, and the next scheduled refresh.
  `GET /rates?refresh=1` refetches at most once every 15 seconds; inside that window it
  answers from cache and says so in `refresh.note`.

**Fail closed.** Without a NEAR/USD rate younger than 5 minutes there is no NEAR quote.
On a server that pays NanoGPT from its Nano wallet the same holds for XNO/USD (the swap
rate is unknown). On an API-key server XNO/USD is informational: its absence never blocks
a quote and the rate line says "XNO/USD unavailable".

## One server, both rails

`--charge-usd` and `--near-merchant` together run one server that accepts Nano (XNO) or
NEAR per call. Each alone behaves exactly as before.

- `tools/list` is the Nano charge mode's list, unchanged in names, prices and schemas,
  plus the NEAR-only tools `run_noodle`, `price_noodle` and `noodle_guide`. Every saved
  tool the NEAR gate also sells gains one sentence saying it can be paid in NEAR with
  `"_pay_with": "near"`, and `_pay_with` (`nano` or `near`), `_payment_tx` and
  `_payment_sender` in its schema.
- A small router (`src/rail-router.mjs`) picks the gate: a NEAR-only tool, a `_payment_id`
  starting `nq_`, or no payment id with `"_pay_with": "near"` go to the NEAR gate; a
  `_payment_id` starting `pay_` and everything else go to the Nano gate. `_pay_with` is
  removed before either gate sees the call, so the paying call hashes to the same
  arguments whether or not it repeats it. `_pay_with: "near"` on a tool the NEAR gate does
  not sell, and contradictory payment arguments (a `pay_` id with `_payment_tx`, an `nq_` id
  with `_pay_with: "nano"`, `_payment_tx` without a NEAR quote), are refused with a clear
  message before anything is quoted or consumed.
- The gates keep separate state (`gate-state.json`, `near-state.json`) and ledgers
  (`usage.jsonl`, `near-usage.jsonl`). NEAR-paid runs spend XNO through the same wallet
  payment callback as Nano-paid runs, when the server has no API key.
- The server instructions, landing page and `/llms.txt` say both rails are accepted and
  where the rates are. `npm run simulate:dual` shows it end to end, offline.
- A NEAR problem never stops the Nano rail. If NEAR cannot start (unreachable RPC after
  several tries, a key that is not the merchant's, a state file for another account), the
  server logs `NEAR PAYMENTS ARE OFF` with the reason and serves Nano only; restart it
  after fixing the cause. With `--near-merchant` alone the same problem exits with status 1.

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

### The RPC: no node of your own

The server watches finalized account changes over RPC and resolves incoming
receipts to their original transactions. It verifies each candidate with `tx`
at `FINAL` and its block before matching the exact quoted amount. A caller can
also present a hash directly. No node, external indexer or websocket is needed.

`--near-rpc` takes one or more endpoints, tried in order:

- A call moves to the next endpoint only when the first could not answer: a network
  failure, a timeout, an unreadable body or a rate limit (HTTP 429, or JSON-RPC code
  -429, which the free public endpoints return under load). An answer, including
  "unknown transaction", is final for that call; the caller's own retry covers a node
  that is a block behind.
- A refund broadcast moves on only when the request was refused. The signed bytes are the
  same everywhere, so a second submission is the same transaction, never a second refund.
- An endpoint that failed rests for 30 seconds and is then tried first again.
- Every endpoint must report the configured network before it is used. One on another
  network is dropped: a testnet node can never vouch for a mainnet payment.

Free public endpoints are enough for light traffic: a paid call is a handful of
requests (look up the payment and its block, then sign and send the refund). They rate-limit by IP address, so a busy server should use
a keyed endpoint first and keep a public one as the fallback.

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

The merchant pays the refund's gas, about 0.000045 NEAR per plain transfer (the
transaction and its receipt each burn 0.0000223 NEAR at testnet's minimum gas price, as
read from a real testnet transfer). A refund is not sent when it is
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
| **Rate movement** | The quote locks NEAR/USD, XNO/USD and the swap rate for its whole lifetime (30 minutes by default, `--near-quote-ttl-min`). Settlement uses them even if NEAR or XNO moves, so the operator carries NEAR/XNO price movement for up to the quote lifetime, and on a wallet-funded server until the received NEAR is swapped by hand. The swap margin (`--near-swap-spread-bps`) is the operator's cushion for it. |
| **Stale rate** | A live NEAR/USD older than 5 minutes stops quoting; it does not guess. On a wallet-funded server the same applies to XNO/USD. Refreshes run every 60 s, lazily before a quote and on demand (`SIGHUP`, `/rates?refresh=1`, at most once per 15 s so the public endpoint cannot be used to hammer the rate sources). |
| **Swap exposure** | The swap rate is derived from two USD prices, not quoted by a venue, and the server never swaps. The NEAR the operator receives and the XNO it spends are recorded separately in the ledger; a real swap can cost more than the derived rate (fees, slippage, delay). Size the swap margin for that. |
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
- Native NEAR and opt-in Circle-issued USDC only. Other tokens and meta-transactions
  are refused; the verifier accepts only the exact action for the quoted asset.
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
- The NEAR pay page connects a wallet rather than using a universal payment QR code.
  Exact transfers sent outside that page are detected by the shared RPC watcher;
  an unmatched amount needs explicit confirmation to associate it with a quote.
- With both rails on one server, a NanoGPT max-cost refund to the shared Nano wallet is a
  receive like any caller payment; the Nano gate matches receives by amount, so such a
  refund can in rare cases match an open Nano quote's amount. This is the same exposure the
  Nano charge mode already has for its own runs; NEAR-paid runs on a wallet-funded server
  add more of those refunds. An API-key-funded server has none.
- The live NEAR/USD rate comes from a single public source (CoinGecko). Use `--near-usd` to pin it.
- The swap rate is derived from two USD rates; no swap venue is queried, and the server
  does not swap NEAR to XNO. Replenishing the Nano float is a manual operator task.
- On a wallet-funded server the receipt's XNO figure is derived from the reported USD cost
  at the locked rate, not read from the wallet's invoice blocks (the wallet pays per
  invoice and does not attribute blocks to a run).
- `--xno-usd` is a command-line flag only; `SIGHUP` reloads `NEAR_USD` and
  `NEAR_SWAP_SPREAD_BPS` from the env file, not a pinned XNO/USD.
- The background rate refresh asks NanoGPT for an x402 invoice (never paid) and CoinGecko
  once per interval while any rate is live.
- Failure and restart scenarios are exercised offline against a local chain stand-in
  that speaks the public RPC wire format. Read-only testnet verification and one
  mainnet payment/run/refund have also passed; this is not a production load test.
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
src/near/rates.mjs       NEAR/USD + XNO/USD + derived swap rate, swap margin, timer,
                         forced refresh, reload; what the NEAR gate and GET /rates use
src/near/refunds.mjs     serialized refund sender with persist-before-broadcast
src/near/explorer.mjs    per-network defaults (RPC, explorer) and nearblocks.io links
src/near/index.mjs       re-exports
src/custom-workflow.mjs  graph args, safety allowlist + caps, itemized pricing,
                         deposit, pricing-vocabulary formatters, authoring guide
src/near-gate.mjs        quote -> verify -> run once -> settle -> refund -> replay
src/rail-router.mjs      one server, both rails: picks the Nano or the NEAR gate per call
scripts/near-simulate.mjs   whole flow offline: the real server binary against a local
                            chain stand-in and NanoGPT stand-in (npm run simulate:near)
scripts/dual-simulate.mjs   one server with both rails, offline (npm run simulate:dual)
scripts/near-check-tx.mjs   read-only: check a real transfer against the rules above
scripts/near-pay.mjs        pay ONE call on any running server (testnet or mainnet) and
                            check the payment, receipt and refund against the chain
tests/fixtures/near-fake-chain.mjs  the chain and NanoGPT stand-ins the tests and the
                            simulation share
```
