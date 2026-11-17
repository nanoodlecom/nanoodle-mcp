# Run funding controller — integration in progress

The controller is implemented and fault-tested; production gates do not yet pass
funding scopes to it. Do not describe this as enforced production reservations.
The existing five-minute operational check observes financial readiness but does
not grant or enforce a run's spending authority.

`createNanoWallet` exposes `ops.withFunding(terms, execute)` and
`ops.fundingStatus()`. Terms are server-created: a stable run id, a maximum USD
provider prepayment, an exact raw Nano limit, and optional creator overhead.
`runFundingBudget` derives those limits from the quote's locked oracle pair.
For authored workflows it keeps the 20% creator markup outside model authority.
This is a limit on cumulative maximum invoice prepayments, distinct from the
final model cost used in a customer receipt. Provider refunds fund future runs;
they never reset the current run's spend limit.

Admission and invoice authorizations use the wallet's existing block queue.
Concurrent paid nodes inherit one opaque async scope. The wallet captures the
enqueuer's scope before entering the queue, so another caller's queue drainer
cannot substitute its own budget. USD and raw limits are independently enforced;
invoice prices round up against a budget rounded down. Duplicate invoice ids in
one run are refused. Failed or ambiguous payments consume authority. Nested runs
cannot reset a budget, and detached work cannot spend after its scope closes.
Earlier queued payment attempts finish resolving before unused capital releases.

`fundingLiabilities` must synchronously return live customer and creator debts in
raw Nano. Admission rechecks it after waiting on chain reads. All active runs'
unused capital and creator overhead are also held. Legacy unscoped invoices may
not consume these reservations; `requireFunding` can reject them entirely once
every production entry point supplies an approved scope.

Nano checkout and the NEAR/USDC gate have injectable `fundRun` handoffs. The
latter covers both saved and custom workflows. Authority comes from the paid
quote's locked exchange pair, not new caller arguments or a refreshed estimate.
A denied reservation starts no model and uses the existing full-refund path.
Replaying a NEAR/USDC receipt creates no new reservation.

Market services can pass the same `fundRun` plus a current `fundingPair` reader
to every listing runner. Workers supply a stable assignment identity and creator
presence; runners derive authority from that assignment's accepted pricing.
Creator overhead stays within that budget. No future Market revenue is counted
by the funding controller. The host startup configuration does not wire these
handoffs yet.

## Activation requirements still open

- Bind hosted startup's Nano, NEAR/USDC and Market handoffs to the same controller and supply
  live obligation readers. Preserve queued/in-flight settlement amounts, failed
  debts and creator payouts across every handoff. A JSON file read alone is
  insufficient: the Nano gate currently writes snapshots asynchronously.
- Test actual provider maximum quotes for the supported bounded graph payloads,
  including audio/video and humanizer fallback calls. A final cost estimate is
  not proof that upstream maximum prepayments fit a cap.
- Hold Market creator fees inside the net accepted budget; validate the actual
  platform fee before starting work. Deferred Market revenue is not spendable.
- Qualify the durable payment journal and single-writer recovery. This in-memory
  controller is not a replacement for signed transaction intents, fencing,
  ambiguous-send reconciliation or recovery backups. An unresolved publish must
  not become permission to construct another transfer after restart.
- Extend no-inference observations with the active funding reservations and
  qualify the complete default and custom workflow matrix before activation.

The audit remains in [operational-reliability.md](operational-reliability.md).
