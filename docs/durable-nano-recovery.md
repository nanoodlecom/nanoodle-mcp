# Durable Nano recovery — review candidate

This implements the three payment-recovery gaps recorded in the [state-machine audit](state-machines-2026-11-06.md): unjournaled settlement sends, fresh transfers after ambiguous send failures, and lost startup/history cursors. **The option is off by default. No production configuration, payment record, credential, permission, wallet transfer or protocol draft was changed to qualify it.**

`--recovery-db /absolute/path/recovery.sqlite` explicitly selects the new authority. The CLI passes the **same store** to the Nano wallet and charge gate. Without the flag the existing runtime and v2 JSON path remain in use. An opted-in wallet refuses the old transfer-without-operation-ID API.

This is a Nano recovery authority. It does not advertise or implement the multi-asset `nanoodle-x402-boundary/v2` contract and does not activate A2A, ACP, Base, Solana, marketplace integrations or package publication.

## Durable transitions

SQLite schema **2** uses WAL and `synchronous=FULL`; all metadata changes use `BEGIN IMMEDIATE` transactions. Database creation is private by default, schema initialization is atomic, and unknown/incomplete schemas fail closed rather than silently recreating financial tables. Existing file permissions are not changed. The containing directory is synchronized at initialization. A failed or uncertain commit poisons that writer instance; it cannot authorize later effects until reopened and reconciled.

| Record | Transition / invariant |
|---|---|
| Gate snapshot | Revision compare-and-set prevents another stale in-memory gate from overwriting newer payment/execution state. |
| Settlement/refund plan | Quote settlement state and every payout intent commit in one transaction before any outgoing effect. One immutable operation ID per quote and money-event category. |
| Wallet account operation | `intent → submitted → completed`, or `submitted → uncertain → completed`. Account, recipient and raw amount remain bound to the same ID. |
| Signed send/receive | Exact signed block, hash and prior balance commit before publishing. Competing workers use the stored winner. No keys are persisted. |
| Completion | Requires the configured RPC's confirmed block proof, matching hash, amount and signed-block binding. A `process` response alone cannot complete the operation. |
| Retry | An unsigned intent may be prepared again because publish was never admitted. A submitted/uncertain operation performs **read-only reconciliation**; it never creates a replacement send. A completed operation replays its durable hash. |
| Paid admission | An unresolved account send, legacy owed send or unresolved execution prevents issuing another paid quote. Existing paid calls stay unconsumed while the wallet is blocked. |
| Account writer slot | Every send and receive claims the same durable account slot before preparation and retains it through confirmation. A persisted generation token fences callbacks from an earlier ownership cycle. Competing actors for the same logical operation share one signed-block submission grant. |
| Workflow receipt | Change is reported as queued for return; workflow success does not claim the outgoing transfer is confirmed. This wording also applies in legacy mode. |
| Owed completion | The wallet completion tombstone survives before the gate removes its owed record. A crash in that gap replays completion without another publish. |
| Give-up | The obligation remains `review_required`; reaching the retry limit never deletes it. Legacy unknown sends remain `legacy_uncertain` and are not automatically retried. |
| Workflow execution | Execution intent commits before provider invocation. Interrupted execution requires recovery. Completed text output is not persisted and is **not regenerated after restart**. Media pointers and redacted errors retain their existing privacy boundary. |
| Incoming payment | A consumed source-send hash has one durable quote owner. The payment claim and paid quote state commit atomically. Quote amount buckets remain reserved after ordinary quote pruning. |

Stored signatures authorize the original exact block; they are treated as financial recovery material even though no secret key is present. New databases are created with mode 0600. The database, WAL and SHM belong on persistent storage outside the checkout and outside any public artifact-serving path. The existing `/out/` extension allow-list also refuses these files.

Ordinary Nano RPC calls in journal mode have a total 30-second abort deadline. Existing work-source deadlines remain separate. Confirmation is a trust claim from the configured RPC, checked against the locally signed block; these tests do not prove live node honesty, network finality, or infrastructure power-loss guarantees.

## History and restart recovery

A first activation captures a bounded receivable baseline and history marker before admitting new quotes. It refuses quoting if the baseline is malformed or fills the 500-entry window, since completeness cannot then be established. Existing receivable hashes are reserved as baseline records. Concurrent first quoters share a single baseline operation.

Each history page retains an immutable target marker, newest-seen head and continuation. Reaching the 1,000-entry per-scan cap saves the continuation **without advancing the target marker**. The next scan, including after restart, resumes the unfinished walk. Payment consumption can replay a page safely because the source-send hash has a durable owner.

A matching receive is resolved through confirmed receive and source-send `block_info` records. The receive must belong to this wallet and the source send must target it; hashes and amount must match. Missing/unconfirmed/mismatched proof stops the walk before its checkpoint advances. Previously consumed source sends are ignored across receivable/history observations.

This preserves the existing Nano amount-as-memo contract. It does not invent authenticated payer intents where the chain carries none, or authorize matching arbitrary historical amounts. Existing legacy quotes require the explicit migration policy below. Unknown RPC pagination semantics, pruned history, disappearing markers, and contradictory node evidence remain reconciliation events; no transfer is inferred from an incomplete scan.

## Legacy migration and rollback

A read-only planning helper emits aggregate metadata only:

```sh
node scripts/inspect-payment-migration.mjs /path/to/gate-state.json
```

It does not open a journal, call RPC, sign, write a file, expose identifiers or initiate any financial effect. New journal mode reads the existing v2 file as an import source and leaves its bytes unchanged. It writes sanitized v3 records into the canonical database.

- Legacy paid/unfinished records cannot prove whether provider execution already occurred. They become recovery-required records; there is no automatic workflow, full refund or text regeneration.
- Legacy expired/pending records do not authorize automatic historical attribution or late refunds. Pending legacy quotes become expired/recovery-required; the operator reconciles any associated incoming payment separately.
- Legacy owed sends have no persisted signed-block proof. They stay retained as `legacy_uncertain`, with no new wallet operation or automatic transfer.
- Existing completed media results and known refunded outcomes retain replay semantics. All imported quote amount buckets are reserved.

The read-only production inspection for this task found v2 state with 10 already-settled paid text records, four refunded, three expired, zero owed, zero unsettled paid and zero unfinished consumed records. Their identifiers, amounts, input/output content and keys were not returned. The new journal/import path was not run against that file and no live journal was created.

**Before activation**, ordinary source rollback is unchanged because the flag is absent and JSON remains authoritative. **After activation**, JSON is only the preserved import source and becomes stale. Never restore it as a current ledger, delete the database/WAL, remove the flag to downgrade, or start an older financial writer. Roll back only to a journal-aware build compatible with this schema. Keeping the explicit flag on an older binary causes startup to fail closed because the flag is unknown; this protects data but does not preserve availability. An operator recovery plan and exact-head release review must accept this constraint before activation.

A signed operation that was committed but never published can remain unresolved when the node has no record of it. This candidate intentionally does not rebroadcast during reconciliation. Any later rebroadcast must use the **exact stored signed block** under separately authorized financial recovery; preparing another transfer is unsafe. No live rebroadcast command is provided here.

## Existing owners and integration boundaries

The following draft heads were rechecked and remain unchanged:

| Draft | Head | Boundary preserved |
|---|---|---|
| A2A #89 | `bdd9fd3f0262e68ef61e167c8a049a2237eaf34b` | Canonical gate remains payment/execution authority; no new listener/card or adapter activation. |
| MCP #90 | `ff79a0aface64a35cafb25f5bc044a9f44a3fcb1` | Separate opt-in compatibility package remains untouched. |
| x402 #91 | `3032c7d130df1c6794fee0e8172897a3e22579e0` | Required multi-network request funding/reservation/dispatch contract remains unimplemented by this Nano-only change. |
| ACP #92 | `0bdcd4fcc5b11a22a53be01faa0a40a32bf973f0` | Its orchestration journal is not a Nano settlement ledger; no SDK/signer/job activation. |

The task-list/history and Personal Context owner-retrieval calls did not return. This task's native Babel mailbox was previously reported unprepared; no replacement enrollment or borrowed mailbox was used to message peers. Draft contracts and current heads were inspected directly, but direct owner coordination and independent exact-head review are still release blockers. The parent task should route this candidate to the existing owners/reviewer before merge or activation.

## Validation

`tests/durable-recovery.test.mjs` exercises the real gate, real wallet adapter, temporary SQLite stores, real local Nano signing/hash/signature checks and scripted RPCs. No Nano node or model endpoint is contacted. Coverage includes lost replies, actual SIGKILL, transaction failures before/after commit, stale writers, two-worker contention, altered signed bindings, confirmation mismatch, atomic settlement plans, restart between wallet and gate completion, interrupted execution, legacy import without transfers, payment-hash/amount uniqueness, malformed/full baselines and restart at the history cap.

Run with Node 24.22.1 and Node 22.23.4:

```sh
node --test tests/durable-recovery.test.mjs
NANOODLE_OFFLINE=1 npm test
```

The full suite requires CI's pinned ffmpeg/ffprobe. Its only intended offline skip is the existing external landing-image check. The normal GPL import-boundary tests remain enforced: only wallet and gate import `nanocurrency`; the recovery coordinator receives those crypto functions from the wallet. No dependency, workflow permission or package-version change is required.

Local qualification of this candidate: **34/34 recovery tests** on Node 22.23.4; full Node 24.22.1 offline suite **453 total, 452 passed, one existing external-image skip, zero failures**. CI receipts and the exact review head are recorded in the draft PR. No independent release clearance or production activation is implied by these tests.

Release incident: the first short-refspec push resolved to main under the account’s existing `push.default=tracking` configuration and upstream-main tracking. Commit `1086cd6` was automatically deployed with the recovery flag absent. It was reverted by `ef5da94a7eb165f9c773f2df0ecce8b007292bdc`, restoring the exact approved #95 source tree. Read-only checks found no recovery database, unchanged v2 payment aggregates (10 paid, four refunded, three expired, zero owed), and no activation/configuration change. This candidate was then reapplied on a separate branch using an explicit full destination refspec. The incident does not constitute independent release review or activation clearance.

Rollback receipts: [deployment ef5da94](https://github.com/nanoodlecom/nanoodle-mcp/actions/runs/42276722247) and [restored-source CI](https://github.com/nanoodlecom/nanoodle-mcp/actions/runs/42276722307) succeeded. The recovery candidate remains [draft PR #96](https://github.com/nanoodlecom/nanoodle-mcp/pull/96) for independent review.

## Independent-review correction: receive exclusion and receipts

The reviewer reproduced a race at the prior `fb2946a` head: one wallet paused in `receivable`, another committed a signed send and paused publishing, and the first published a competing receive. The send then forked and remained uncertain. The author independently reproduced that sequence with two SQLite handles and real wallet instances. A second deferred-publish fixture reproduced a success receipt falsely claiming returned change. Both tests failed before this correction.

Receives now use the same durable block coordinator as sends, including signed intent, one submission grant and confirmed read-only recovery. Outgoing preparation cannot receive funds while holding a send slot: short-balance funding completes separately journaled receives before claiming the outgoing slot. The early outgoing guard remains, and the coordinator enforces exclusion again at the durable boundary across every await. Lost receive replies retain the account slot and must reconcile before any outgoing operation proceeds.

Account slots retain a monotone generation even when vacant. Submission and unsigned release require the generation granted by `beginSend`; a callback from an earlier cycle cannot publish or unlock a later owner, including when the logical operation ID is reused after an unsigned failure. Missing slots for unresolved signed operations fail startup closed.

The earlier unfenced schema-1 candidate is refused without changing its records. There is no automatic downgrade, table recreation or schema-1 migration. Production has never enabled either journal schema, and migration/rollback clearance remains required. New regressions cover the exact receive/send race, stale-generation ABA, two receive workers, unknown receive recovery across restart, short-balance funding order, schema-1 preservation, missing account-slot preservation, and truthful queued-change receipts.
