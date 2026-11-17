# Durable Nano recovery: current-source integration

This is an **inactive integration candidate**, based on production `246ef51`
and the reviewed foundation in [draft #96](https://github.com/nanoodlecom/nanoodle-mcp/pull/96)
(`5e47182`). Production still uses its existing JSON authorities. No canonical
journal, production flag or schema migration has been activated. The current
version-one production startup policy deliberately refuses journal activation;
a qualified migration policy, monitoring, backups and rollback are still required.

## Authority before effects

`--recovery-db <absolute-path>` explicitly selects journal mode. The CLI derives
the public wallet identity and takes the account/state kernel locks before
opening SQLite or constructing wallet callbacks. SQLite closes before the locks
are released at normal exit. Shared pool reservations, per-run budgets, invoice
limits, RPC/body deadlines, mainnet read comparisons and writer checks remain
active in journal mode.

The database commits sanitized gate snapshots, incoming-payment ownership,
quote-amount reservations, execution intent and outgoing operation bindings.
Every send and receive claims the same account slot. A signed block commits
before publication; slot generations fence stale callbacks. Retries of a signed
operation reconcile the original hash read-only, and a completed operation
returns its stored hash. Unknown proof retains the slot and debt. There is no
automatic replacement block, workflow regeneration or blanket legacy refund.

Provider invoice identities include their origin and invoice ID. Nano gate
change/refund/author operations use payment-specific identities. NEAR/USDC and
Market creator outboxes use the same wallet journal; a failed outbox checkpoint
after confirmation replays that operation instead of paying again. A pre-journal
creator signed block cannot silently become a fresh journal payment. Creator
payouts remain Nano; customer NEAR/USDC refunds retain their existing same-asset
signed transaction outbox and finalized funding checkpoints.

## Schema and stale-node protection

This integration uses **journal schema 3**, binding the database to one Nano
account. The old schema-1/schema-2 candidates are refused without altering their
records; no automatic conversion or downgrade is provided. Unsafe permissions,
symlinks and multiply linked database files are refused. No signing keys,
prompts, outputs or raw provider errors belong in the journal.

The protected CLI requires mainnet peer comparisons and confirmed block heights.
Completion atomically persists the greatest confirmed account height before
releasing its slot. After restart, the read guard loads that checkpoint before
reading an account, so lagging peers cannot authorize a fork from an older view.
The fixture reproduced a second publish attempt with two frozen account peers
before this correction; the persisted checkpoint prevents it. Same-height hash
conflicts and regressing heights cannot replace the known floor.

The protected freshness mode is durable. It cannot be downgraded by opening a
wallet without read protection, or enabled over a populated unqualified journal
without reconciliation. The low-level coordinator's synthetic tests can use an
unprotected empty store; that does not qualify it as a production restore source.
The observed Node 22.23.4 and Node 24.22.1 runtimes both embed SQLite 3.53.4.

Receipts say change is queued while confirmation is unresolved. A completed
journal proof may supply its transaction hash; absence of proof must not be
presented as returned change. Stopping a gate's watcher now awaits its in-flight
scan, pending direct transfers and queued persistence.

## Legacy state and recovery

`scripts/inspect-payment-migration.mjs` is a read-only aggregate planner. It opens
no journal, contacts no RPC and performs no signing, inference or writes.
The production observation at 2026-11-17 09:34:25 UTC found v2 JSON with 57 settled
paid records, two expired, zero unsettled paid/unfinished consumed and zero owed.
These are an observation, not permanent migration authorization.

Journal import preserves the JSON bytes and financial metadata. Unfinished or
unprovable historical runs stay recovery-required. Completed text cannot be
regenerated after privacy stripping. Legacy expired/pending quotes cannot
silently claim historical payments or trigger new refunds. Source-send ownership
and reserved amount buckets survive result pruning and restart.

After activation, the old JSON import source is stale. Keep the journal flag
through rollback and use a build compatible with schema 3. Never delete the DB,
revive old JSON authority or start an older financial writer to restore service.
Fence the original VM before a replacement, even with local locks in place.

SQLite's WAL is part of durable state: copying the database alone can lose
committed transactions. Backup must use a supported consistent snapshot or stop
all writers and preserve the required files together. Read-only observation must
not use an immutable connection to a changing live database. See the primary
[SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Qualification and remaining cutover work

Offline fixtures cover lost replies, actual SIGKILL, concurrent send/receive
writers, stale slot generations, atomic settlement, replay, privacy, historical
payment attribution, budget/obligation changes, creator checkpoint failures,
wrong account/schema/permissions and the persisted stale-peer floor. The actual
server fixture runs both legacy and journal modes across Nano, NEAR and USDC
saved/custom graphs, creator payments, timeouts/full refunds and no-repay replay,
with a frozen preferred peer. No node or model endpoint is contacted.

```sh
node --test tests/durable-recovery.test.mjs tests/state-ownership.test.mjs
node --test tests/x402-wallet.test.mjs
npm test
```

Before production activation, finish and verify:

1. A versioned production policy pinning the canonical existing DB, its account,
   schema and legacy import. Qualify the actual current-state migration and a
   schema-3-compatible rollback without modifying production authority.
2. A bounded runtime reconciler for signed operations and private recovery
   telemetry observed by the no-inference monitor. An unresolved account must
   pause new work while existing debt remains recoverable; readiness must never
   sign or infer.
3. Canonical gate obligations during startup/disabled rails, before any worker
   or creator outbox can spend. Preserve all current NEAR funding protections.
4. Consistent encrypted DB/WAL backup, isolated restore, full-host fencing/boot
   rehearsal and independent backup freshness/outage notification.
5. Current-source independent review and owner/interface coordination through
   Ember. The historical review of #96 does not review this new integration.

The original #96 and integration drafts #89–#92 remain unchanged. No A2A, ACP,
multi-network payment SDK or storefront activation is implied by this work.
The overall operational reliability goal remains active.
