# x402 exact ingress: Base and Solana qualification

This adds `src/integrations/x402-exact-ingress.mjs`, an opt-in integration
boundary for Foundation x402 v2 `exact` payments in USDC on Base
(`eip155:8453`) and Solana mainnet
(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), **plus the durable boundary
implementation it was gated on** (`src/integrations/x402-boundary-store.mjs`,
see "Durable boundary" below) **and CDP Bazaar discovery support** (see
"Bazaar discovery" below). The adapter is **not wired to the CLI, HTTP
listener, public tools, or a funded wallet**, and remains inactive by
default. No live compatibility, settlement, marketplace listing, adoption
or revenue is claimed. (This work re-lands the closed draft PR #91 on
current main and completes the prerequisite it named.)

The official `@x402/core`, `@x402/evm` and `@x402/svm` SDKs are pinned to
2.29.0. Solana Kit is pinned to 8.6.0, satisfying this published SVM package's
`>=8.0.0` peer requirement. Package tarballs are integrity-locked in
`package-lock.json`; source references and checksums are in
`x402-source-manifest.json`. The published package, rather than a possibly
stale `main` documentation snapshot, determines the tested API.

## Existing execution path and missing common API

Base: `main` at `98e426254a038c90fcaa14a42881ace6bb8c7278`. There are no
multi-asset quote/reservation APIs on this base. The adapter uses the real
registry's `prepareCall` and the existing dispatcher seam, but deliberately
requires an injected canonical boundary for quotes, durable reservation state
and downstream dispatch. It never invokes the unguarded `registry.callTool`.

The existing Nano charge gate and vendored `nanoodle` downstream x402 path
are unchanged. The adapter adds no payment ledger, exchange,
automatic USDC→Nano swap, wallet management, refund or relayer. It has no
dependency on the unmerged NEAR branch or `src/payments/offline-usdc-mcp.mjs`.

The boundary contract is `contractVersion: "nanoodle-x402-boundary/v2"` with
the eight operations below. Missing/legacy contracts fail closed before any
payment operation. **The durable implementation now ships in this repo** as
`createDurableX402Boundary` in `src/integrations/x402-boundary-store.mjs`
(next section); the in-memory implementation in the adapter tests remains
as a semantics reference only.

| Operation | Required semantics |
| --- | --- |
| `issueQuote({request,binding,buildRequirements,signal})` | Validate authoritative pricing and XNO budget, persist one immutable quote per authenticated request, return it on retry. Use `buildRequirements({network,amountAtomic,maxTimeoutSeconds})` for each enabled network. Prices are atomic decimal strings; this callback does no FX or margin calculation. |
| `lookupQuote({request,binding,signal})` | Return the same persisted quote only for the authenticated scope, request, workflow and call binding; do not reprice a signed retry. |
| `lookupReservation({...identity,signal})` | Read the global authorization reservation, or return null. This read grants no attempt and creates no state. The adapter validates identity on returned records. |
| `lookupFundingClaim({fundingKey,quoteId,binding,signal})` | Read the authenticated request's funding claim across **all** authorizations, quotes and networks, or return null. A read grants no attempt. A different authorization cannot replace an existing settling/uncertain/settled/dispatched claim. |
| `reserve({...identity,expiresAt,now,signal})` | Atomically reserve globally unique authorization identity. A different quote, customer, call or payload cannot consume it. New reservations must be unexpired. Return existing state on retry; never reset an attempted authorization. This alone does **not** grant a funding/settlement attempt. |
| `beginSettlement({...identity,reservationId,now,expiresAt,signal})` | In **one durable transaction**, claim exclusive request-level funding AND compare-and-set its authorization `reserved`→`settling`. Commit both before returning `{granted:true,reservation,fundingClaim}`. Only one authorization/network/process may receive a grant for the request. If funding is already claimed, return `{granted:false,reservation,fundingClaim}` with the actual winning claim. Expired/cancelled attempts get no grant. A lost reply retains the exclusive funding claim and settlement intent. |
| `recordSettlement({...identity,reservationId,state,receipt?})` | Persist success or uncertainty monotonically on **both** the reservation and its request funding claim. A late uncertain write must not erase authoritative settlement. Atomically enforce unique `(network,transaction)` across quotes. Return the full persisted reservation; the adapter rereads the durable funding claim before dispatch. |
| `dispatchSettled({...identity,reservationId,receipt,request,signal})` | Validate authoritative settled reservation, exclusive funding claim and receipt against the stored quote, reserve downstream Nano budget, then invoke the established paid executor once **per fundingKey/request**, regardless of nonce/network. Persist execution intent before any downstream spend. Persist and cache/replay typed success **and failure** outcomes with refund state; a lost dispatch response must never rerun the workflow. Retain a recoverable receipt/output reference without logging prompts or raw signed payloads. |

`identity` consists of `fundingKey`, `quoteId`, `binding`, `authorizationKey`, `paymentDigest`.
Every reservation response includes these exact fields, `reservationId`, `state`
(`reserved`, `settling`, `uncertain`, `settled`, `dispatched`) and, for the latter
two states, `receipt`. The adapter checks these fields before proceeding.

`fundingKey = sha256(canonical(["nanoodle-funding/v1", customerScope, requestId]))`.
It deliberately excludes quote ID, authorization nonce, network, workflow and
price. The canonical authority must enforce this same request funding identity
across its replicas and adapters. Requoting or changing workflow metadata for
the same authenticated request does not create another funding opportunity.
A funding claim contains `fundingKey`, `claimId`, `quoteId`, `binding`,
`reservationId`, `authorizationKey`, `paymentDigest` and `state` (`settling`,
`uncertain`, `settled`, `dispatched`). A fresh authorization or alternate network
returns `202 FUNDING_CLAIMED` with safe reconciliation identifiers while any of
these states exists. The original settled authorization can replay its result.
The adapter never releases a claim. Only canonical authoritative reconciliation
may clear one after proving the prior attempt cannot have charged; a timeout,
expiry, dispatch failure or refund request is insufficient. Settlement or a
completed/refunded execution does not automatically authorize repurchasing the
same request. A separate intentional purchase needs a new server request ID.

## Durable boundary (implemented)

`createDurableX402Boundary({ file, priceQuote, execute, now })` implements
the v2 contract against one private JSON state file, replaced through the
repo's `writePrivateStateSync` primitive (staging file, fsync, atomic
rename, directory fsync). A mutation returns only after it is durable.

- **Atomic grant.** All operations serialize on an internal promise chain
  and every critical section is synchronous: `beginSettlement` claims the
  request's funding AND flips its authorization `reserved`->`settling` in
  one persisted transaction. Global uniqueness covers the authorization
  identity, the request `fundingKey` (across quotes, networks and nonces),
  and `(network, transaction)` for settled receipts.
- **Monotone settlement.** `settled`/`dispatched` are terminal for
  settlement writes; a late `uncertain` never erases a receipt.
- **Dispatch exactly once.** The dispatch intent is persisted BEFORE the
  injected `execute` (the established Nano-funded workflow executor) runs.
  Outcomes are cached by `fundingKey` and replayed verbatim. A crash or
  lost reply leaves an intent with no outcome: redispatch throws and the
  adapter answers `202 DISPATCH_UNCERTAIN` until an operator calls
  `reconcileDispatch` stating the authoritative outcome or proving the
  executor never ran.
- **Fail closed.** A corrupt, truncated or foreign-version state file
  throws at load (never resets — a reset would re-enable spent nonces).
  A durability-uncertain write poisons the instance. A sha256 fingerprint
  of the loaded/last-written bytes guards the file: any external change
  (second live writer, restore, manual edit) poisons the instance with
  `BOUNDARY_STATE_CHANGED` instead of letting a stale snapshot overwrite
  another writer's grants. Single-writer per file: multi-process
  deployments must hold the repo writer lock (`src/process-lock.mjs`) or
  run one boundary process.
- **Operator surface** (not adapter operations): `reconcileSettlement`
  (settling/uncertain -> settled on authoritative provider/chain
  evidence), `reconcileDispatch` (above), `recordRefundState` (monotone
  refund-state transitions; `refunded` requires the canonical refundId of
  a refund transfer executed elsewhere — this module never moves money).
- **Injected policy.** `priceQuote({request, binding})` returns the
  authoritative USDC prices per network, the downstream XNO budget and
  `ttlSeconds` (1..300). The store performs no FX, margin or swap logic.

## Bazaar discovery

Passing `discoveryFor` to `createX402ExactIngress` enables CDP Bazaar
discovery via the official `@x402/extensions` 2.29.0 bazaar extension.
For each call it returns `{ description, inputSchema?, example?, output? }`
(or null to leave the call undiscoverable):

- The 402 challenge body carries `extensions.bazaar` (MCP discovery info:
  tool name, description, input schema, example input, output example).
- Descriptions are capped at **500 characters** — the CDP Facilitator
  rejects longer ones — and a longer description fails the call closed
  before any payment operation.
- On settle, the resource server forwards the payment payload's
  `resource` + `extensions.bazaar` to the facilitator; per CDP's
  documentation that settled call is what triggers Bazaar indexing.
- Discovery is computed only for the challenge and for a fresh
  verify/settle — never on the replay path — so a metadata failure
  cannot block delivery of already-paid work.
- Metadata text is descriptive only: CDP screens it against a content
  policy (text that reads as an instruction to an agent is rejected),
  which is the operator's editorial responsibility.
- **No listing exists or is claimed.** Indexing requires a first
  successful LIVE settlement through the CDP Facilitator (see
  "Remaining work for live launch").

## Typed dispatch outcomes and refund state

The v2 boundary returns one of these envelopes, durably cached by fundingKey:

```js
{ status: "completed", refund: { state: "not_required" },
  result: { isError: false, content: [{ type: "text", text: "protected output" }] } }
{ status: "failed", refund: { state: "not_requested" } }
```

This bounded success schema accepts text blocks only and no extra result or
content fields. Media/structured output needs a separately reviewed schema;
it must not be passed through unchecked. A returned legacy `{isError:true,...}`
or typed failed/nested error result becomes `502 EXECUTION_FAILED` with the fixed
`workflow_failed` category. No raw provider error content or metadata is returned.
Malformed outcomes become `502 DISPATCH_INVALID_OUTCOME`; thrown/timeout outcomes
remain `202 DISPATCH_UNCERTAIN`. These responses retain the validated payment
receipt, quote ID, reservation ID, funding key/claim ID, `reconciliationRequired`
and an explicit refund state. They never masquerade as HTTP 200 success.

On a typed failure, canonical refund states are `not_requested`, `pending`,
`refunded` or `uncertain`. `refunded` additionally requires a bounded canonical
`refundId` and must refer to an already authoritatively reconciled, durable
refund receipt. Extra refund fields are not exposed. For legacy/malformed/
thrown outcomes, state is `unknown`, requiring reconciliation. `not_required`
is valid only on completed success. These are reports from the trusted authority;
this adapter never initiates a refund transfer or infers one from an exception.

Quote shape:

```js
{
  quoteId, binding, issuedAt, expiresAt, // milliseconds, max lifetime 300 seconds
  resource: { url, mimeType: "application/json" },
  requirements: [/* persisted SDK v2 PaymentRequirements */],
  downstream: { asset: "XNO", unit: "raw", amountAtomic: "..." }
}
```

`resolveContext(cleanCall, transportContext)` must obtain `requestId`,
`customerScope`, saved `workflowDigest` (SHA-256 hex) and `resource` from trusted
server state, not client prices, payment headers or workflow arguments. It may
also bind an expected `payer`. The adapter hashes this context, clean call,
route policy and facilitator identity. `run_noodle` and mixed Nano/NEAR payment
arguments are excluded. The transport must authenticate the scope and reject
ambiguous/duplicate payment headers before invoking this seam.

## Flow and trust limits

1. `handle({params,context,signal})` validates the call before quoting. It returns
   a v2 challenge body and SDK-encoded `PAYMENT-REQUIRED` header.
2. The client uses its network-specific SDK to sign and retries with
   `paymentSignature`. The original `accepted` requirements must match the
   stored quote exactly: scheme, network, token address, recipient, amount,
   timeout and extra fields. Resource metadata, when present, must match too.
3. The adapter reads any existing reservation. A new authorization is verified
   through the SDK resource server and explicitly injected facilitator **before**
   reserving its global replay identity; an invalid signature cannot poison the
   legitimate payer's nonce/message. It then atomically obtains a durable,
   exclusive request funding claim and settlement grant in the same transaction.
   Per-authorization deduplication is insufficient: a second genuine signature
   with a fresh nonce, or a Solana payment instead of Base, cannot fund it again.
   Verification alone never permits dispatch.
4. It asks the facilitator to settle once, validates `success`, network,
   transaction format, optional settled amount and payer, and persists a bound
   receipt before dispatch. The receipt contains quote/call/payload binding,
   request funding key, network, asset, atomic amount, recipient, payer, transaction and facilitator
   identity. Asset/amount/recipient are bound from the verified exact request;
   the facilitator settlement response is not falsely described as independently
   supplying all those fields or as a local chain-finality proof.
5. Only the canonical boundary's `dispatchSettled` can release protected output.
   The successful response includes the SDK `PAYMENT-RESPONSE` header.

The facilitator is a trusted verification/settlement authority, supplied by the
operator; no public facilitator URL or credential is selected automatically.
There is no local onchain verifier or claim that a scripted fixture proves
CDP/mainnet finality. A future runtime integration must authenticate that
provider and specify its authoritative confirmation/finality policy.

Capabilities are fetched via the facilitator's actual `getSupported` contract
at runtime, cached for at most 60 seconds (30 seconds by default), and refreshed
before using stale support. Only an explicit v2/exact Base or Solana pair grants
capability; wildcard, v1, unknown network and alternate scheme entries do not.
This bounded implementation accepts the SDK default USDC asset only. It rejects
Permit2, `upto`, alternate payment flows and payload extensions even where the
provider supports them. A capability outage fails closed. A previously settled
reservation can still replay its receipt/output without re-verification or
another charge after quote expiry.

Base replay identity includes network, token, payer and EIP-3009 nonce, independent
of signature representation. Solana replay identity hashes the decoded signed
transaction message, independent of its signatures. The exact payment payload
digest is bound separately. Durable global uniqueness remains the boundary's
responsibility, including across replicas, restarts and ecosystem adapters.

Every injected operation has a bounded wait. Cancellation before a grant makes
no payment attempt. Timeout/cancellation after durable intent, provider errors,
failed or malformed settlement responses, and uncertain storage writes return
`202 SETTLEMENT_UNCERTAIN` and never automatically settle again. Late provider
success is not processed as a new settlement. The canonical reconciler must
inspect authoritative provider/chain evidence before changing uncertain state.
It must not infer failure from a timeout or release/reuse the authorization.
An ambiguous downstream result returns `202 DISPATCH_UNCERTAIN`; only the
canonical dispatcher may reconcile/replay it. Raw callback, storage, SDK and
upstream exception messages are replaced with fixed error codes.

Settlement precedes work in this adapter. Consequently a paid workflow failure
needs a separately designed refund/recovery policy; the Nano gate's automatic
refund policy does not cover USDC by implication. No refund is attempted here.

## Onboarding friction and economics

Buyers need a compatible v2/exact client, a signer/wallet and sufficient USDC
on the chosen network. Holding USDC on Base does not fund Solana or Nano. No
bridging, swapping, wallet creation or funding is automated by this PR.
Sellers need a recipient address on each enabled chain, their own Nano execution
liquidity, an explicitly selected facilitator, and the durable boundary above.
Using CDP additionally requires operator-managed API credentials and its service
screening; this PR creates no account or credentials. Solana client construction
also reads mint metadata and a recent blockhash; tests intercept both RPC reads.

The [official CDP facilitator pricing](https://docs.cdp.coinbase.com/x402/seller/facilitator)
checked 2026-11-03 says the first 1,000 onchain facilitator transactions each
month are free, then **$0.001 per onchain transaction**. Verification is free.
An accepted `exact` payment settles in one onchain transaction. Deposits,
refunds and withdrawals each count as additional onchain transactions; the
free tier is monthly, not per endpoint or request. Provider pricing can change.

For `T` total monthly billable onchain transactions, the documented facilitator
fee is `max(0,T−1000) × $0.001`. Other providers may price differently. Above the
free tier, that fee consumes 10% of a $0.01 sale or 1% of a $0.10 sale, **before**
model execution, hosting, treasury conversion/spread and support/refund costs.
It is a provider expense, not our margin. Gross contribution is customer price
minus those costs; for example, a hypothetical $0.01 sale with $0.008 execution
cost and $0.001 facilitator fee leaves $0.001 before all remaining costs.
These are arithmetic scenarios, not observed costs, a fixed margin commitment,
or a promise that USDC/USD or USDC/XNO conversion is free or pegged.

The canonical quote service must price the exact atomic USDC charge with a
documented rate source, timestamp, expiry, spread and separately identified
margin, while preserving a sufficient downstream XNO budget. This adapter never
accepts a buyer-supplied exchange rate or treats facilitator fees as revenue.

## Offline evidence and remaining work

Run `node --test tests/x402-exact-ingress.test.mjs`. The fixture uses the actual
Foundation EVM/SVM client schemes to generate signed authorizations/transactions,
actual core schemas/header codecs/resource server and actual Solana transaction
decoding. EVM EIP-712 and Solana Ed25519 signatures are independently checked
offline. SVM mint/blockhash JSON-RPC reads are replaced with in-memory responses
that reject unrecognized operations; the settlement response and persistence
service are explicitly scripted. A real `loadTools().prepareCall` +
`createDispatcher` challenge integration is included. No workflow is executed.

Tests cover immutable pricing/binding, capability revocation, replay across
quotes, concurrent grants, new adapter instances, expiry, payer identity,
malformed/failed receipts, timeouts, cancellation, storage errors and safe errors.
`tests/x402-boundary-store.test.mjs` qualifies the durable store (atomic
grants under concurrency, restart replay, crash-orphaned dispatch intents,
state corruption, cross-writer fingerprint guard, write-failure rollback,
refund-state monotonicity). `tests/x402-bazaar-discovery.test.mjs` runs the
adapter end to end on the durable store for Base and Solana, including
12-way concurrent duplicate payments and the Bazaar settle payload.
They qualify adapter + store behavior, not CDP production screening, live
finality or actual provider billing.

## Remaining work for live launch

The durable boundary, its reconciliation operators and Bazaar discovery
are implemented and offline-proven. What remains is deliberately NOT in
this PR, because each step is an operator decision or a live action:

1. **Route wiring.** Mount the adapter on a served HTTP/MCP route (the
   hosted server) behind operator configuration. Until then it is
   importable library code only — inactive by default.
2. **Facilitator + credentials.** Select the facilitator (CDP requires
   operator-managed API credentials and performs its own screening) and
   supply `payTo` recipient addresses for each enabled network.
3. **Pricing + liquidity.** Operate `priceQuote` with a documented rate
   source and keep sufficient downstream Nano (XNO) execution liquidity.
4. **USDC refund policy.** Settlement precedes work; a paid workflow
   failure needs the operator's refund/recovery decision implemented via
   `recordRefundState` + an actual refund transfer path.
5. **First live settlement (the go decision).** One real settled payment
   through the CDP Facilitator is what indexes the endpoint in the
   Bazaar. No testnet/mainnet payment, wallet action, account creation
   or marketplace publication occurred in this PR.

CDP indexes Bazaar metadata only after it successfully settles a payment for
that endpoint, according to its [facilitator documentation](https://docs.cdp.coinbase.com/x402/seller/facilitator).
This PR includes no Bazaar listing, no successful live settlement and no metadata
claim presented as marketplace publication.
