# A2A paid workflow facade: offline qualification

This branch qualifies an **A2A 1.0 JSON-RPC** application adapter with the
**official `@a2a-js/sdk` 1.3.0**. There is no listener, public AgentCard,
marketplace registration, wallet setup, deployment or live payment. The AgentCard
URL must end in `.invalid` and every constructor/operation requires
`mode: 'offline-fixture'`; `NODE_ENV=production` is refused. No runtime CLI imports
these modules. The SDK is pinned as a development dependency for this review.

## Verified sources and compatibility

Checked 2026-11-03 against primary sources:

- [Official JavaScript SDK](https://github.com/a2aproject/a2a-js) and
  [its README](https://github.com/a2aproject/a2a-js/blob/main/README.md): 1.0 stable,
  JSON-RPC, REST and gRPC, with an opt-in 0.3 compatibility layer.
- [Official Python SDK](https://github.com/a2aproject/a2a-python): implements 1.0,
  with 0.3 compatibility. A Python companion is unnecessary for this Node repo.
- [Current specification](https://a2a-protocol.org/latest/specification/) and
  [versioned 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/):
  task/context/message identity, authentication, cancellation and task lifecycle.
- The package lock records the installed SDK's exact version and integrity.
  Main repo base: `98e426254a038c90fcaa14a42881ace6bb8c7278`.

Only 1.0 JSON-RPC is advertised and tested. 0.3, REST, gRPC, streaming, task
listing, push notifications, external agent compatibility and conformance-suite
certification are **not qualified** by this branch. The offline roundtrip uses
real SDK client serialization and JSON-RPC server dispatch over an injected
in-process fetch byte boundary. It does not prove a live HTTP/auth deployment.

## Existing canonical integration seam

`createOfflineChargeBoundary({ gate, registry })` uses the actual
`createChargeGate` from `src/gate.mjs`, not the unmerged NEAR modules:

| Operation | Existing implementation |
| --- | --- |
| Allowlisted tool discovery | `gate.wrapRegistry(registry).listTools()` |
| Argument validation | `registry.prepareCall({name, arguments})` |
| Quote creation | wrapped `callTool` **without** `_payment_id` |
| Payment readiness | `gate.quote(quoteId)`, checking tool and `status === 'paid'` |
| Paid dispatch | wrapped `callTool` with the same arguments and canonical `_payment_id` |
| Execution, detection, settlement, refunds | existing gate/registry/wallet implementation |

The adapter never invokes the raw executor, verifies a client claim of payment,
changes canonical402, replaces NanoGPT's downstream Nano x402 payment hook,
converts tokens, reserves balances, or implements a second payment ledger.

Payment here is the **Noodle application contract**, carried in structured A2A
parts. This is not an invented native A2A payment standard or a claim of generic
A2A x402 compatibility. A future funded-account or other x402 ingress must inject
a reviewed canonical quote/reservation/dispatch boundary; it cannot authorize
execution by placing `paid: true` in an A2A message. Main has no shared durable
reservation API yet. This branch does not silently depend on NEAR's separate
unmerged implementation.

## Identity, ordering and durability

The trusted host supplies an SDK `ServerCallContext` with an authenticated
principal and tenant. **The host must authenticate both**, including the
principal's tenant membership; assigning identity from message metadata or an
unvalidated path is unsafe. All task status, cancellation and results use the
same hashed `(tenant, principal)` ownership scope. Caller-supplied body `tenant`
is rejected. Unknown and other-owner tasks produce the same task-not-found error.

An operator provides an explicit subset of existing registry workflows, including
a SHA256 digest of each actual, pinned graph. The operator is responsible for
computing these digests from its loaded graph files and keeping that registry
immutable. `run_noodle` and caller payment metadata are refused. Skills never
come from arbitrary URLs, prompts, external discovery or a client workflow list.

A new message quotes `{action:'quote',name,arguments}`. A continuation sends
`{action:'run',name,arguments,quoteId}` with the returned task ID and context ID
(and a new message ID). The same message ID is an idempotent retry only with the
same payload/task/context. Arguments, graph digest, owner, task/context mapping,
quote and canonical job ID remain bound. Main's gate has no separate job ID;
`jobId` therefore equals its canonical quote ID, explicitly.

`openA2ABindings` uses a separate SQLite WAL database with FULL synchronization,
private file permissions, transactionally unique owner/message IDs and compare
and set phase transitions. It stores only orchestration IDs, hashes, phases and
receipt provenance. It stores **no payment amounts, balances, proofs, credentials,
prompts or outputs**. Configure an absolute path, one facade process per DB,
with default maximum 10,000 tasks and 100,000 messages; exceeding capacity fails
closed. Do not delete this file or run multiple facades against it. A future
service needs coordinated workers, quotas, retention and database migration.

Quote issuance intent and dispatch intent are persisted before awaiting an
external effect. On restart, an unfinished intent is shown as `uncertain` with
`reconciliationRequired: true`. No automatic quote regeneration or redispatch
occurs. This deliberately favors avoiding duplicate spend over automatic
recovery, including the narrow crash between quote creation and recording its ID.
The current canonical gate can replay some text runs after a restart; this facade
never invokes that replay after its own durable dispatch intent was recorded.

No remote event-ingestion API is exposed. Duplicate or reordered quote/run/status/
cancel requests cannot rewind a terminal state. Read-only status polls do not
start execution. This is a polling qualification, not event-stream exactly-once
or cross-process exactly-once delivery.

## Cancellation, timeout and receipts

- Before dispatch, cancellation prevents the local A2A task from ever dispatching,
  including a quote returning late or cancellation racing validation.
- The existing gate has no quote-cancel/refund API. **Local cancellation does not
  cancel a payment or promise a refund.** A paid canceled task needs canonical
  operator reconciliation; the facade never moves money to approximate a refund.
- After dispatch begins, `CancelTask` returns TaskNotCancelable, rather than
  asserting that running provider work or settlement stopped.
- Every boundary wait has a bounded deadline (default 2 seconds for fixtures,
  configurable 1–30,000 ms). Dispatch receives an AbortSignal. The current gate
  does not implement cooperative cancellation, so a timeout means unknown outcome,
  not failed/refunded/not-spent. Late completions do not overwrite uncertainty.
- Uncertain tasks are an A2A interrupted state (`INPUT_REQUIRED`) with an explicit
  reconciliation marker. They reject another run and cannot be locally canceled.
- A completed receipt binds task/context, full request binding, canonical quote
  and SHA256 of the returned canonical result. It is **adapter provenance**, not
  cryptographic proof of chain settlement or an independent cost attestation.
  The gate's own receipt text remains part of a successful result.
- Raw provider failure strings are replaced by a fixed failure category. A failure
  receipt hashes the original canonical outcome; it does not hash the sanitized
  displayed error. A failed task does not itself attest a completed refund.
- Outputs remain in memory only. After restart, a completed task retains its
  receipt and reports `outputUnavailable: true`; it does not rerun to regenerate
  user content. A production result-retention/download policy remains future work.

## Onboarding friction and economics

A user needs an A2A 1.0 JSON-RPC client, host-issued authentication/tenant context,
the offline application's structured workflow schema and stable message IDs.
After quoting, the user needs a Nano wallet with the exact canonical amount;
this qualification returns the gate's canonical Nano URI/address/amount, not a
new wallet service. The operator needs existing loaded graph files, graph digests,
the canonical gate and its normal provider/payment dependencies. A2A transport
discovery alone does not make payment automatic or remove wallet onboarding.

The existing gate quotes a deposit and ordinarily settles at metered model cost
plus 20%, with canonical change/refund handling and request caps where applicable.
Provider cost is separate from that markup. At a hypothetical provider cost of
$0.01, an uncapped 20% markup is $0.002: customer charge $0.012, and gross markup
is about 16.7% of that charge, before hosting, support, float, refunds and other
costs. If the graph has an author payout, the gate assigns markup to its author;
that amount is **not automatically our margin**. Deposit caps and absorbed
provider overruns can further reduce or reverse operator contribution. This
adapter adds no A2A fee and makes no revenue, marketplace or adoption guarantee.

## Offline validation

Run with Node 24.22.1 and `npm ci`:

```sh
NANOODLE_OFFLINE=1 node --test tests/a2a-offline.test.mjs
NANOODLE_OFFLINE=1 npm test
```

The A2A suite uses the official SDK client and JSON-RPC transport handler, the
actual canonical charge gate, and scripted chain/provider fixtures. No account
registration, credentials, real RPC, transfers, settlement or paid inference is
used. Covered: quote/pay/run/status, tenant/principal isolation, request/context/
quote substitution, duplicates, out-of-order requests, cancellation before/during/
after dispatch, cooperative timeout signal, late completion, restart intents,
receipt integrity, output privacy, safe errors and bounded storage.

Live enablement remains explicitly out of scope: authenticated HTTP hosting,
provider cancellation, canonical quote cancellation/refund coordination, durable
result delivery and operator reconciliation must be reviewed before deployment.

Validation on this branch (2026-11-03): **15/15 A2A tests** pass; complete
`NANOODLE_OFFLINE=1 npm test`: **419 tests, 418 passed, 1 skipped, 0 failed**.
Node: 24.22.1. ffmpeg: CI's pinned 7.0.2 static archive, verified SHA256
`abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67`.
The first broad attempt lacked ffmpeg and had three environment failures;
installing that existing test dependency resolved all three. The sandbox's
subprocess runner crashed independently, so the complete suite ran outside it.
