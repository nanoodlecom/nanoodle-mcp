# x402 exact ingress: Base and Solana qualification

This draft adds `src/integrations/x402-exact-ingress.mjs`, an opt-in integration
boundary for Foundation x402 v2 `exact` payments in USDC on Base
(`eip155:8453`) and Solana mainnet
(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). It is **not wired to the CLI,
HTTP listener, public tools, or a funded wallet**. No live compatibility,
settlement, marketplace listing, adoption or revenue is claimed.

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

Before runtime wiring, the common boundary owner must implement
`contractVersion: "nanoodle-x402-boundary/v2"` and supply the eight operations
below, backed by the canonical payment/dispatch service. Missing/legacy contracts
fail closed before any payment operation. The test implementation
uses memory and illustrates transaction semantics; it is **not durable storage**.

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
They qualify adapter behavior, not CDP production screening, live finality,
actual provider billing or a durable boundary implementation.

Runtime wiring remains blocked on the common durable boundary and its executor,
reconciliation and USDC refund policy. Explicitly design those with the parent
integration owner before enabling routes. Do not substitute the NEAR offline
ledger or create a second ecosystem-specific ledger to bypass this dependency.

CDP indexes Bazaar metadata only after it successfully settles a payment for
that endpoint, according to its [facilitator documentation](https://docs.cdp.coinbase.com/x402/seller/facilitator).
This PR includes no Bazaar listing, no successful live settlement and no metadata
claim presented as marketplace publication.
