# Payment writer ownership and required startup state

The CLI takes process-lifetime Linux `flock` locks before invoking wallet
callbacks, loading workflows, sweeping output files, resuming refunds or
starting Market workers. Scopes cover the Nano account, NEAR network/merchant,
hosted output directory and Market state root. A second process using the same
scope fails immediately, even with a different HTTP port or output directory.
A stdio Nano wallet also takes its account lock. The standalone Market CLI takes
the same Market-root lock as the in-server worker.

The locks use `/usr/bin/flock` from util-linux; wallet and hosted paid/Market CLI
modes require Linux. Key-only stdio/free HTTP use without Market needs no locks.
The helper inherits an already opened descriptor, and the parent retains the
kernel lock after the helper exits. Normal exit, SIGKILL and reboot close those
descriptors; no PID-file deletion or stale-PID takeover is needed. See the primary
[Linux flock semantics](https://man7.org/linux/man-pages/man2/flock.2.html).

Default files live under the OS user's home at
`.local/state/nanoodle-mcp/writer-locks/`. HOME/XDG overrides do not change that
default. `NANOODLE_WRITER_LOCK_DIR` can select an absolute directory, but **every
writer using these accounts/state must use the same namespace and OS user**.
Files must be private, regular, singly linked and owned by that user; the
0700 directory cannot be a symlink. Resource names are hashed into filenames.
Neither keys nor prompts are written to lock files or passed to the helper.

Never delete, replace or restore these lock files to force takeover. The app
checks their inode/ownership before queued wallet work, signatures and RPCs,
and in its funding telemetry. Loss pauses new quotes and wallet activity.
These are advisory local locks for cooperating CLI processes, not a barrier
against root, programs that ignore locking, a separately configured namespace,
or another server. Fence the old VM before restoring and activating a replacement.
Do not use an unqualified network filesystem for the lock directory.

## Production requires the existing financial recovery set

Set `NANOODLE_STATE_POLICY=/etc/nanoodle-mcp/state-policy.json` in the service's
operator environment. This read-only versioned JSON policy pins effective
account identities, output/Market roots and all catalog handles. It must be
owned by root or the service user, not group/world writable, and not a symlink.
For example (use the actual public Nano account, never a signing key):

```json
{
  "v": 1,
  "outDir": "/srv/nanoodle-mcp/out",
  "nanoAddress": "nano_<merchant-public-address>",
  "chargeNano": true,
  "near": { "merchant": "nanoodle.near", "network": "mainnet" },
  "marketRoot": "/srv/nanoodle-mcp/market-state",
  "marketHandles": ["nanoodle-song", "nanoodle-image", "nanoodle-character", "nanoodle-clip", "nanoodle-workflows"]
}
```

Use `nanoAddress: null` without a Nano wallet, `chargeNano: false` without the
Nano checkout, `near: null` without that rail, and `marketRoot: null` plus an
empty handle list without workers. A single-listing worker uses `[""]` for its
root state file. The policy must match the effective configuration; a changed
account, root or catalog requires operator review of its recovery state.

Startup requires existing valid JSON/schema envelopes for every configured
checkout ledger and Market assignment file, including unpublished/disabled
catalog profiles. It checks the NEAR ledger's network/merchant. No missing file
is initialized, repaired or copied. The individual ledger owners also reject
ENOENT when opening state in this mode, and disk funding fallback remembers the
required files even if a whole profile directory disappears.

The initial envelope check does not replace each ledger owner's detailed record
validation, chain reconciliation or a durable transaction journal. It cannot
detect that an otherwise valid recovery snapshot is stale. Keep policy and
financial files together in encrypted backups; keys plus Git are insufficient.
An older backup without this policy needs explicit reconciliation and policy
restoration before startup. A standalone Market CLI refuses this policy: use the
one in-server production worker and shared wallet queue.

Fresh development installations can omit the policy to create their first state.
Enable it for an established production deployment after verifying the complete
existing files, before accepting more paid work. Do not generate empty files to
make the check pass. Without the policy, existing public ledger constructors
retain their deliberate first-run behavior.

The private `funding-health.json` includes only `writerProtection.enforced` and
`writerProtection.requiredState` booleans, checked within the existing five-minute
runtime-funding probe. Missing/disabled protection fails readiness; schedules
and healthy probe count are unchanged. These checks run no inference, signing,
publication or PoW. Local startup errors remain visible in systemd/readiness;
an independent observer is still needed during a whole-server/Babel outage.


## Starting a verified release while admission remains paused

Draft source supports a process-bound startup handoff; it is not deployed and
has no installed root controller yet. With only `NANOODLE_MAINTENANCE_FILE`
configured, a retained or unsafe pause still refuses startup before wallet
initialization or recovery. A pause never expires or reopens by itself.

A future root controller may also configure
`NANOODLE_MAINTENANCE_STARTUP_FILE` as a separate file beside the pause. On a
valid retained pause, the app waits up to two minutes for that file without
initializing wallets, making provider requests or opening HTTP listeners.
Missing permission does not infer consent. An unsafe permit, changed flag
(including an identical replacement inode), orphan permit or deadline refuses
startup and leaves both operator files alone.

The permit is root-owned, service-group readable and not group/world writable.
Its version-one object binds the complete operator request to Linux PID, UID,
boot ID and process start ticks, plus the canonical release path, full revision
and sealed-tree hash. The app compares those fields to its own kernel identity
and the root-owned, read-only `.nanoodle-release.json` attestation. The root
controller must independently verify the complete immutable tree and intended
service command before issuing permission; a reported Git SHA or an app-written
health frame is insufficient. Graphs and MCP arguments cannot configure this.

Authorized initialization is counted as accepted work while request entry and
routine background passes still check closed admission. Only explicit startup
recovery scopes can resume recorded obligations and initialize listing metadata.
An interrupted NEAR run is refunded under its existing recovery rules, never
rerun. Listener and polling callbacks cannot borrow initialization permission,
even while initialization is still pending. After initialization, the permit
gives no permission to a new request or background pass.

Recovery can sign and publish previously owed refunds or creator payouts. Once
that permission is granted, financial state must never be restored to an older
snapshot. The future root controller must keep the pause through fresh process-
bound write/writer/required-state qualification, remove its known startup permit,
and explicitly reopen only that verified process. A failed or uncertain startup
must retain maintenance state for reconciliation; neither a timeout nor a failed
health check authorizes financial rollback or a blind restart into older code.

Local fixtures exercise identity reuse, changed request/release, unsafe files,
waiting/replacement/deadline behavior and callback isolation. The real CLI also
starts against a local NEAR chain with a previously interrupted paid quote: two
separate authorized startups send exactly one full refund, execute no model,
and keep both the payment watcher and MCP admission paused. These fixtures use
synthetic release attestations and throwaway keys, not a production release or
real funds. Root release selection, permission issuance, resume journaling and
legacy-process first cutover still require qualification before activation.
