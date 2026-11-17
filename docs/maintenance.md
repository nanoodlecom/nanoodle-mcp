# Maintenance admission and draining

The CLI supplies one process-wide barrier to its HTTP listeners, wallets,
payment gates, settlement queues and Market service. This branch is not deployed.
The root deployment hook and backup service still need the private drain
acknowledgement and controller integration described below.

A configured operator-owned JSON file closes admission. Its schema is:

```json
{"v":1,"token":"0123456789abcdef0123456789abcdef","operation":"deploy","revision":"0123456789abcdef0123456789abcdef01234567"}
```

For `backup`, the revision must be `null`. Configure the absolute canonical path
with `NANOODLE_MAINTENANCE_FILE`. Ownership defaults to UID 0; a self-hosting
operator may explicitly set `NANOODLE_MAINTENANCE_OWNER_UID`. The file must be
readable by the app. Its canonical parent and the file must belong to that UID
and must not be group- or world-writable. Symlinks, hardlinks, non-regular files,
unknown fields and oversized state are rejected.

A valid absent flag permits work. Unreadable or unsafe state fails closed. A
retained flag refuses startup before wallet recovery or signing. It does not
expire: the operator must explicitly remove it after completing or reconciling
maintenance. Tokens and counts are private control telemetry, never payment
authority. With no configured flag the CLI still accounts for work and drains
its signal-triggered shutdown.

`capture(fn, kind)` synchronously registers work, including queued tasks. Its
callback executes once and releases its registration only when its promise
finishes. Only unstarted callbacks may be cancelled. `run(fn, kind)` immediately
executes a captured callback. Accepted work may start nested settlement after
admission closes. Detached callbacks cannot reuse a completed parent's permission.
Synchronous ledger intents use `assertAdmitted()`.

HTTP POSTs stay registered through both their actual handler lifetime and the
response's finish/close event. Disconnecting does not cancel a workflow. An ended
but backpressured result is still in flight. New POSTs receive HTTP 503 with a
same-payment-ID retry instruction. Read-only status GETs remain available during
a pause and their streams can close during shutdown after paid responses finish.

The Nano wallet counts queued publications and funded runs through reservation
release. Its gate tracks scans, websocket observations, settlement callbacks and
queued state writes. State snapshots synchronize a private regular temporary
file, rename it atomically and synchronize the directory. `persistenceStatus()`
reports failure separately from an idle count. A later successful complete
snapshot clears that error. Paused read-only lookups do not prune state.

NEAR refunds and Nano creator payouts register nonce/publication queue entries
before waiting. Pauses do not consume attempts, sign new transactions or change
existing signed bytes. Accepted settlement continues through FINAL verification
and ledger updates. An unadmitted creator intent is refused synchronously.

Market assignments remain counted through concurrency waits, model work,
uploads, submission and final durable updates. Paused polls keep the loop open
for resume. Catalog refresh and bid passes are tracked, and shared stores stay
locked until those passes and assignment loops finish.

Money-event logs use a shared private append writer. Queued appends remain
counted through file and directory synchronization. A lost event latches a
failure; later appends cannot repair the missing entry. The existing five-second
funding report selects aggregate write health and pauses new checkout admission
on a failed state/log write. It runs no inference. Normal pending writes do not
make the service unhealthy, but must finish before maintenance stops it.

`close()` irreversibly closes local admission for process shutdown.
`waitForIdle()` requires closed admission and cannot await its own active scope.
The CLI installs signal handlers before async initialization. A separate startup
lifetime keeps late resources accounted for without granting startup's permission
to new network callbacks. SIGTERM/SIGINT wait for startup, Market work, payment
observation, workflows, settlement, log/state writes and paid response flushing.
Repeated signals wait for the same shutdown. The old 20-second exit timer is
removed. The host's service manager must allow this drain to finish.

Before operational use, the root controller must hold its maintenance lock and
keep the external flag present while qualifying a fresh private acknowledgement
from the same live process, for the same token, zero operations and healthy fully
flushed state. That acknowledgement/controller is not implemented yet. Build
releases away from the live checkout, then integrate deployment and backup
stop/resume handling. A zero funding-reservation count alone is insufficient.
The durable recovery journal and its independent cutover/rollback review remain
separate; these lifecycle changes do not activate it.
