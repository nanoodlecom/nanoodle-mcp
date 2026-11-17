# Maintenance admission and draining (preparation)

`src/maintenance.mjs` provides process-local accounting for planned maintenance.
Optional HTTP, wallet, payment-gate, settlement and Market hooks use this accounting. The barrier is not
connected to the production CLI, deployment hook or backup service yet.
Do not use its presence as evidence that a server can be stopped safely.

A configured, operator-owned JSON file closes admission. Its schema is:

```json
{"v":1,"token":"0123456789abcdef0123456789abcdef","operation":"deploy","revision":"0123456789abcdef0123456789abcdef01234567"}
```

For `backup`, the revision must be `null`. A valid absent control file permits
work; unreadable or unsafe state fails closed. The flag does not expire. The
operator must explicitly remove it after completing or reconciling maintenance.
The file and its canonical parent must be owned by the configured operator UID,
without group or world write permission. Symlinks, hardlinks, non-regular files,
unknown fields and oversized state are rejected. Tokens and operation counts are
private control telemetry, never payment authority.

`capture(fn, kind)` synchronously registers work, including tasks waiting in a
wallet queue. The returned callback executes once and releases its registration
only when its promise finishes. Only unstarted callbacks may be cancelled.
`run(fn, kind)` immediately executes a captured callback. Accepted work may start
nested settlement operations after admission closes. Detached callbacks cannot
reuse a completed parent's permission.

When supplied a barrier, the HTTP listener registers POST handlers before
reading the request body. A disconnected caller does not release the scope of a
still-running workflow. New POSTs receive HTTP 503 with a same-payment-ID retry
instruction. Read-only GETs, including payment status, remain available.

The Nano wallet captures queued publications before yielding and keeps funded
runs registered through reservation release. Read-only funding telemetry stays
available during maintenance and does not count itself as financial work. The
NEAR watcher pauses new scans and its `stop()` waits for an in-flight scan and
payment observation to finish. Explicit ticks do not restart a stopped watcher.

Nano gate scans and websocket observations are admitted through the same
barrier. Its settlement callbacks and queued state writes remain registered
until the receipt or retry debt reaches the state file. `persistenceStatus()`
reports write failures separately from an idle count; an idle writer with a
failed last snapshot is unsafe to stop. A later successful complete snapshot
clears that error. Read-only quote lookups do not prune state while paused.

NEAR refunds and Nano creator payouts capture their nonce/publication queue
entries before waiting. A pause does not consume retry attempts, sign new
transactions or alter an existing signed intent. Accepted settlement continues
through FINAL verification and ledger updates. A new unadmitted payout intent
is refused synchronously.

Market polls retain assignment scopes through waiting for a concurrency slot,
model work, uploads, submission and their final durable state. Paused polls keep
the loop open for resume. Catalog refresh and bid passes are tracked, and shared
stores stay locked until those passes and assignment loops finish.

`close()` irreversibly closes process-local admission for shutdown, including
when the external flag is later removed. `waitForIdle()` requires closed
admission and cannot be called from an operation that would await itself. It
never cancels accepted work. With only an external pause, the operator must keep
the flag and maintenance lock held while qualifying and acting on a drain.

Before operational use, integration must connect every CLI listener, wallet,
gate, retry loop and Market service to the same barrier, then retain their
handles for graceful process shutdown. No production flag is enabled by these
optional hooks. The existing CLI shutdown has not been replaced yet.
Maintenance must receive a fresh private acknowledgement from the same live
process, for the same token, zero tracked work and healthy fully flushed state
before stopping the service. Build releases away from the live
checkout. A zero funding-reservation count alone is insufficient.
