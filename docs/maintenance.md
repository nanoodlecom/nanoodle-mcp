# Maintenance admission and draining (preparation)

`src/maintenance.mjs` provides process-local accounting for planned maintenance.
Optional HTTP, wallet and NEAR watcher hooks use this accounting. The barrier is not
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

Before operational use, integration must connect every listener and execution
route, Nano payment polling, NEAR refund queues, Market work, and retries through
actual settlement. No production flag is enabled by these optional hooks.
Maintenance must receive a private acknowledgement of the same token and zero
tracked work before stopping the service. Build releases away from the live
checkout. A zero funding-reservation count alone is insufficient.
