# Virtuals ACP v2 seller qualification

This is a bounded **offline prototype**, disabled by default. Nothing imports it
from the CLI or HTTP server. It offers one configured fixed-price, text-input
Noodle workflow to an ACP service job; there is no registry listing, wallet,
signer, live chain call, auto-evaluation, fund-transfer job or deployment here.
It does not establish live compatibility, demand, adoption or profitability.

## Current protocol and provenance

Verified 2026-11-03 against the official [ACP v2 repository](https://github.com/Virtual-Protocol/acp-node-v2),
[ACP overview](https://os.virtuals.io/acp/overview), and the
[provider workflow](https://os.virtuals.io/acp/cli/provider-workflow). Current ACP uses
`AcpAgent.on("entry", ...)` and `JobSession`, rather than the archived ACP
callback/phase model. The qualified package is `@virtuals-protocol/acp-node-v2`
**0.1.15**, with **viem 2.57.14**; the independent qualification lock records all
resolved tarball integrities. See [the source manifest](../qualification/acp-v2/source-manifest.json).

[JobSession](https://github.com/Virtual-Protocol/acp-node-v2/blob/392dcc6eb17a6884c214c21aff31afa1b99f45ae/src/jobSession.ts)
derives status from the last-arriving system entry. That is useful UI state,
but replay/reordering can regress it. A requirement message or a `job.funded`
notification cannot authorize spending. The adapter requires a fresh, pinned
finalized `getJob` read and ABI-decoded canonical contract `JobFunded` log, exact
budget and buyer, correct provider, offering name, expiry, Base chain, and the
zero hook. Fund transfer, router, subscription and unknown hooks are refused.
`fromBlock` must be an operator-verified deployment/job creation bound that
includes the funding log. Missing history fails closed. RPC identity/finality
are operator trust assumptions; no live RPC is configured or exercised.

## Integration boundary

The private/hidden [offering draft](../qualification/acp-v2/offering.draft.json)
is an SDK-shaped fixed-price fixture for the actual `hello-noodle` graph
(`Idea` string input, `test-model`), not a published or deployable listing. Its
requirements are checked through both the real SDK schema validator and actual
repository registry preparation.

The source lives under `src/ecosystems/acp/`; none of the existing gate, wallet,
HTTP, dispatcher or NEAR code is changed. The SDK is injected into the factory,
so loading the ordinary package does not load the SDK or its wallet dependencies.
The SDK dependency is restricted to `qualification/acp-v2/` and is not added to
the production dependency tree. These sources are qualification building blocks,
not a supported live API.

`createAcpSeller({})` returns an inert handler. Enabling requires
`enabled: true`, `mode: "offline-qualification"`, a non-production process,
explicit economics, SDK, journal, verified job reader, workflow boundary and
one configured offering. All live modes fail. The SDK injection used by the
qualification suite is the real package plus
`hashDeliverable: value => keccak256(toHex(value))`; a test confirms this hash
against the actual SDK EVM submit encoder. `attach(agent)` registers one handler;
it does not create/start an agent, fund jobs, complete/reject jobs or evaluate
its own result. Do not attach a real signing provider to this prototype.

`createNanoWorkflowBoundary` uses the existing `registry.prepareCall`,
`createDispatcher` JSON-RPC `tools/call`, `structuredContent.x402.paymentId`,
`gate.quote`, and `_payment_id` result call. It does not replace the established
Nano x402 downstream path or implement another payment ledger. Its required
injections are deliberately explicit:

- `resolveWorkflowDigest(call)` binds the locally approved graph, never a buyer
  supplied digest; the configured fixed offering must match it.
- `retainCall`/`recoverCall` provide trusted, access-controlled input storage by
  call digest and job idempotency key. The journal does not retain prompts.
- `valueNanoQuote` locks a conservative USD ceiling and rate digest for the exact
  `amountRaw`. The gate's displayed `amountUsd` excludes amount-tag dust; treating
  that display as the full cost would understate the operator's required float.
- `reserveNanoQuote` durably reserves **operator** liquidity for that exact
  downstream quote under `chainId:jobId`. Reservation is not payment proof.
- `confirmNanoPayment` supplies the separately confirmed Nano payment observation;
  the actual gate must also report `paid` before dispatch. ACP escrow never
  fabricates Nano payment or bypasses the gate.
- `publishResult` returns an explicitly customer-shareable artifact on an
  allowlisted HTTPS host and its result digest. Local paths, inline paid output,
  URL credentials, query tokens and fragments are not accepted in ACP receipts.

There is no existing shared production API on `main` for locked quote valuation,
operator liquidity reservation/payment, protected input recovery, or publication.
These injections are required and faked only in tests. Live funding, swaps,
wallet signing, RPC authentication and artifact ACLs are unimplemented. They
need a separately reviewed common integration API; this branch does not depend
on the NEAR owner's unmerged work. No secret/config file is created.

## Durable behavior

One lifetime exclusive file lock protects the job journal from concurrent
writers; each transition is written, fsynced, atomically renamed, then the
parent directory is fsynced **before** the next external effect. Storage write
failure poisons the journal and prevents further effects. A process crash leaves
the `.lock` file in place. Verify that the old process is dead and reconcile
pending effects before an operator removes that stale lock; never automate stale
lock deletion. Store it on a durable local filesystem with these semantics,
not an eventually consistent or shared network filesystem. Size retention and
multi-worker scaling are future work.

The journal is orchestration state, not a USDC/Nano balance. It contains hashes,
public chain provenance, exact quote/reservation identifiers and a bounded
shareable deliverable receipt, rather than raw prompts/model text/errors.
Expected flow:

1. Buyer requirement -> validate and bind one approved graph -> Nano quote ->
   proposed fixed USDC budget.
2. Independently verified funding -> reserve operator float -> recheck funding
   and expiry -> execute the original paid Nano dispatch once.
3. Persist result reference and SDK-compatible receipt hash -> recheck funding
   and expiry -> submit through `JobSession.submit` once.
4. Observe external evaluator decision and release evidence; never call
   `session.complete` or `session.reject`.

Per-job queues serialize replayed/concurrent events. Job identity, graph,
inputs, economics and expiry are bound. The durable intent markers for quote,
budget, reservation, dispatch and submission turn an interrupted/uncertain
outcome into `review_required`; they never auto-retry a potentially charged
operation. A persisted ready artifact can be submitted after restart without
re-running the workflow. Unknown submission can resolve from matching confirmed
`JobSubmitted`, evaluator `JobCompleted` and `PaymentReleased` logs. It cannot
resolve from SSE status alone. This deliberately favors manual review over
claiming exactly-once settlement across two independent networks.

Timeout/cancellation aborts the operation signal and blocks submission. A
callback that ignores abort may still finish an already-issued request; its
outcome stays uncertain, and the boundary checks abort before publishing.
Cancellation does not reverse spend or cancel the on-chain escrow. An expired
job or evaluator rejection retains downstream loss exposure for review. No
refund or release transfer is implemented or inferred. Raw exceptions become
fixed failure codes, with no exception text or buyer payload in diagnostics.

## Onboarding friction and economics

For a future live seller, the official SDK prerequisites include a registered
agent in the Virtuals Service Registry, `walletId`, and a signer added through
the agent's Signers tab. The Privy/Alchemy provider needs the seller wallet
address, signer and configured chain; builder code is optional attribution.
None is created here. A buyer needs a compatible registered wallet/client and
USDC for the job; the seller additionally needs Nano liquidity for the existing
NanoGPT paid workflow. Escrow is not immediately available operator float, so
there are two funding domains and an external evaluator/SLA dependency. The
prototype supports only Base service jobs, one graph, string inputs and an ACP
expiry no later than the downstream quote TTL (currently 15 minutes). A short
SLA and bounded artifact retention are necessary future product choices.

Platform fee values and gas/sponsorship terms are **not established here**.
`platformFeeBps` is required even for offline qualification, and unknown/null
values fail. Actual provider, conversion, network, refund/rejection and USDC/USD
valuation assumptions must be verified before any live economics. The admission
calculation assumes USD parity for USDC; it is an illustrative bound, not a live
pricing oracle or guarantee. There is no accepted live activation path.

For fixed price `P`, explicit ACP fee bound `F`, downstream **customer charge**
ceiling `D`, conversion/slippage bound `X`, and network bound `N`, admission
requires `P - ceil(P*F/10000) - D - X - N >= required margin`. `D` includes the
Nano workflow service's metered cost plus its existing markup and amount dust;
it is a supplier charge to this ACP seller, not our ACP margin. FX/network fees
and platform fees are costs, not our revenue.

The test fixture uses **invented**, non-market terms solely to exercise the
calculation: price $1.00, ACP fee 5% ($0.05), exact downstream ceiling $0.401,
FX bound $0.05, network bound $0.10. Admission cushion is $0.399 before overhead,
rejection losses and valuation changes; the configured margin floor is $0.20.
These are not actual Virtuals fees or Noodle pricing recommendations. Evaluator
rejection after dispatch can lose the entire downstream cost despite an initially
positive admission calculation.

A funded escrow receipt always says `earned: false`. Completed revenue is
recorded only from the confirmed provider `PaymentReleased` amount and matching
submission/evaluator evidence. Even then `profit: null` remains until actual
provider costs, Nano change/refunds, conversion, gas and losses are reconciled.
Estimated margin is never promoted into earned profit.

## Validation and limitations

Install ordinary dependencies with `npm ci --ignore-scripts`, then:

```sh
npm --prefix qualification/acp-v2 ci --ignore-scripts
npm --prefix qualification/acp-v2 test
```

Use Node 24.22.1. The suite uses real SDK `AcpAgent`, `JobSession`, `AssetToken`,
EVM submit encoder and ACP ABI, fake transport/API/chain/provider operations,
and the repository's real dispatcher and Nano gate. No model API, account,
wallet signer, external network or funds are needed. `*.qual.mjs` is explicit
so the normal root suite does not require the optional SDK tree. The [CI recipe](acp-offline-ci.example.yml) is documentation only; it is not
installed as an executable workflow. GitHub rejected the initial branch push
because the existing OAuth credential lacks `workflow` scope. The source-only
draft preserves existing permissions and leaves workflow installation to a
separate authorized change. The recipe uses scripts-disabled installs and no
secrets.

The qualification suite has 29 passing checks. Cases include reordered/replayed/spoofed funding, amount/identity/chain/hook/fork
mismatches, invalid/rebound requirements, expiry during reservation, idempotency
across restart and uncertain effects, ready-result recovery, ignored-abort
completion, downstream failure, uncertain SDK submission, evaluator rejection,
verified revenue and on-chain receipt-hash encoding. This is protocol/offline
qualification, not live compatibility certification.

The isolated SDK tree currently reports 29 npm audit findings (12 low, 6
moderate, 11 high); ordinary root dependencies report zero. This SDK tree is not
loaded by the normal runtime or packed into the npm release. Dependency review,
provider setup and live validation remain prerequisites for any future activation.
