# State-machine audit — 6 November 2026

Scope: `nanoodlecom/nanoodle-mcp`, main at `dbbb1bde01a2c3ce03cd4cfc60cc78e3f08a57ad`, plus the release configuration and the seams used by the existing integration drafts. The vendored executor is an external boundary; this audit does not substitute for its owning repository's audit. No live workflow, payment, model inference, package publication, account enrollment, or protocol activation was performed to reproduce a finding.

This patch repairs concrete request, privacy, retention and recovery transitions. It does **not** establish exactly-once settlement across process crashes. The remaining financial recovery findings below are explicit release/integration constraints.

## Inventory

| Machine / source | States and transitions | Invariants / evidence |
|---|---|---|
| CLI configuration (`bin/nanoodle-mcp.mjs`) | parse → validate → select key/wallet → load graphs → initialize catalogs/gate → listen; invalid config → exit | Key precedence and optional wallet import; charge mode requires funded wallet. Existing CLI, GPL-boundary and manifest tests. |
| Graph admission (`tools.mjs`) | scan dirs → parse graph → derive schema → accept/skip; duplicate names → suffix | Earlier directory wins, reserved builtin/share names survive; `mcp-server`, chip-kind and estimate tests. |
| Input preparation (`tools.mjs`, `subnano.mjs`, `humanize.mjs`) | malformed → reject before quote; valid → resolve/clip inputs → executable call | Remote callers cannot read local paths. Hosted pricing checks precede payment instructions. Input, content-URL and hold tests. |
| Catalog/cache refresh (`tools.mjs`) | missing/fresh/stale/in-flight fetch → success cache or timed failure cache → next refresh | Fetch deadline, failure TTL, stale fallback and model payload clamps; catalog-clamp tests. No durable model catalog. |
| Cost observation (`tools.mjs`) | completed run → last cost/high-water update → temp write → rename → changed description | Best-effort informational sidecar; concurrent writes have unique temp names. A crash or reordered rename can lose the latest observation; it is not a settlement ledger. |
| JSON-RPC dispatch (`server.mjs`) | decode → validate envelope/id → request dispatch or notification suppression → result/error | Idless/invalid-id calls now cannot run or spend. `0` and empty string remain valid IDs. Existing handshake/error tests plus audit regression. |
| stdio transport (`server.mjs`) | partial line → complete JSON → concurrent dispatch → completion-order reply; EOF → drain accepted calls → close | EOF now waits for accepted workflow outcomes before default process exit. Protocol output remains JSON lines. |
| HTTP admission (`http.mjs`) | origin/content-type/body validation → parse → JSON/SSE dispatch → response | Browser Origin must equal configured public origin for `/mcp`; native no-Origin clients work. Cross-origin preflight cannot authorize spending. Routing no longer trusts Host as its URL base. |
| Result SSE (`http.mjs`) | admitted socket → heartbeat/progress → final result/close; disconnect → release socket resources while run continues | Capacity and heartbeat release happen once on disconnect or completion; disconnect does not cancel/repeat a paid workflow. Regression verifies slot accounting while an earlier workflow finishes. |
| Payment status/watch (`http.mjs`, `gate.mjs`) | unknown/pending → waiter → paid/consumed/expired/refunded → terminal instructions and stream close | One shared payment scanner. Timeout/abort now removes the waiter and its timer; response disconnect aborts a watch or long-poll wait immediately. |
| Browser pay page (`http.mjs`) | SSE → status update; SSE failure → long polling; terminal → stop | Refunded is now terminal: removes payment instructions, closes EventSource and prevents a fast repeated-poll loop. Browser script executed with a fixture DOM in the audit test. |
| Rate oracle (`gate.mjs`) | static or missing/cache stale → shared probe → fresh pair; failure → stale pair or refuse quote | Exact raw/nano-USD pair; no invoice paid by the probe; oracle and exact-money tests. Probe currently lacks a total request deadline. |
| Quote identity/admission (`gate.mjs`) | valid call → unique amount bucket/hash/id → pending → paid or expired | Tool/args hash binds the payment ID; tag unique among retained quotes; quote TTL 15 minutes. Async persistence is not yet an effect barrier (see gaps). |
| Quote retention (`gate.mjs`) | pending → expired; completed → replay window → prune; paid/in-flight → retained | Now preserves unclaimed payments and unfinished runs beyond ordinary retention. New outcomes start the replay window at completion; legacy records retain their old timestamp fallback. |
| Payment detection (`gate.mjs`) | receivable scan / received-history walk / websocket confirmation → match amount → paid; late match → refund | Scan exclusion and owed-send `sending` guard prevent concurrent scans/sends. Burst/history and retry-backoff tests. Restart/backlog gap reproduced below. |
| Scan scheduling (`gate.mjs`) | idle → scanning → timer; failure → exponential delay; new quote → prompt scan | Websocket changes cadence; ordinary watchers do not reset failure backoff. Existing regression tests exercise both and owed-only scan suppression. |
| Websocket connection (`gate.mjs`) | absent → opening → subscribed → disconnected/error → poll fallback/lazy reconnect | Secret-bearing URL redaction and polling safety net. Not a durable source of payment detection; reconnect callbacks have no permanent shutdown lifecycle. |
| Workflow claim/replay (`gate.mjs`) | paid → consumed + shared Promise → result/error; duplicate call → await/replay | Concurrent callers share one in-process run. Media pointers can replay after restart; paid text is memory-only and regenerated after restart. This is not durable exactly-once execution. |
| Successful settlement (`gate.mjs`) | model cost → clamp cost/markup/change → transfer(s) → success or owed retry | Integer raw math, quote-rate binding, author cap. A restarted text regeneration uses original settlement figures and moves no further change/author funds. In-flight send durability remains open. |
| Failed run / refund (`gate.mjs`) | provider error → refund in flight → refunded or owed retry → redacted persisted error | Recovery failure after an already settled text run now returns an operator-recovery error without refunding the deposit again. Original first-run failures retain automatic refunds. |
| Owed sends (`gate.mjs`) | queued/backoff → sending → sent/remove or retry → manual give-up | In-process exclusion and restored refund markers are covered by existing tests. Ambiguous sends and crash windows still need a durable operation identity; 100-attempt give-up removes the obligation and only logs it. |
| Gate snapshot/restore (`gate.mjs`) | mutation → queued snapshot → temp write → rename → restore/migrate | Corrupt/unreadable state now fails startup closed, preserving the recovery file; missing first-run file is allowed. Legacy results/errors are scrubbed. Write failures remain best-effort and rename is not a durable transaction with external effects. |
| Wallet queue/frontier (`wallet.mjs`) | urgent/housekeeping enqueue → drain → cached/fresh frontier → signed send/receive → advance or invalidate | Single signer queue, payment priority, receive sweep yielding, stronger work thresholds. Existing x402-wallet tests cover queue survival, frontier refresh, failover and received refunds. No process-wide/multiworker signer lock or durable signed-send journal. |
| Wallet RPC / publish recovery (`wallet.mjs`) | read failure → failover; explicit throttle → failover; ambiguous publish → same-block recovery; authoritative rejection → fail or one stale rebuild | Same signed-block recovery is tested; it is bounded and can still return uncertainty to an upper layer that treats every failure as safe to resend. Most reads/publishes lack a total deadline. |
| Work generation (`wallet.mjs`) | precompute → threshold-aware cache → consume; remote timeout/failure → next source → optional local CPU work | Cache bounded, receive work cannot satisfy send, local CPU disabled in recommended hosted configuration. Work/queue tests. |
| Humanize writer (`humanize.mjs`) | primary → answer/slow/error → eligible fallback → bounded re-ask/guard → accepted/rejected candidate | Per-run workflow/fetch state isolates concurrent runs. Fallback stops after ambiguous payment; output caps, keep/ending/title guards and long-context tests. Existing humanizer changes preserved. |
| Humanize spend/invoice (`humanize.mjs`) | hold → atomic in-process invoice-ID claim → committed payment → confirmed/ambiguous/late → metered reconciliation | Budget checked again inside queued payment callback; first billed body retained; late settlement counted without using expired output. `paymentNotSent` is required to release a known-not-sent commitment. Extensive x402/hold tests. Memory-only across process loss. |
| Humanize decider/review (`humanize.mjs`, `humanize-deposit.mjs`) | admitted → decider → strict verdict / truncation/error → repair or fitting-candidate review → result/refusal | Output and reasoning caps, pricing ceiling fallback/refusal, combined abort/deadline and conservative payment state; humanize-v28, long-context, x402 and deposit tests. |
| Subnano pipeline (`subnano.mjs`) | refine → humanize → postability gate → funny score; insufficient remaining hold → partial result; failure → tool error | Per-stage budget checks and capped settlement; negative postability verdict still returns the comment as specified. Existing subnano tests. |
| SFW/video pipeline (`subnano.mjs`) | validate media → load → sample frames → per-frame decision → aggregate/error/partial | Bounded media bytes, no local paths over HTTP, no off-switch; video subprocess deadline/group kill and ffmpeg dependency tests. |
| Public media fetch (`subnano.mjs`) | parse → DNS/all-address validation → pinned public IP → manual redirect → bounded body → done/destroy | One deadline covers DNS and every hop; late DNS does not send; socket destroyed on timeout/size/rejection; existing adversarial subnano-bound tests. |
| Artifact lifecycle (`tools.mjs`, `http.mjs`, `sweep.mjs`) | materialize bytes → unique output file → unguessable URL → fetch or TTL deletion | Public serving now admits only regular media files through a non-following descriptor; ledger/state/tmp/unknown extensions, directories and symlinks return 404. Shared media allow-list retains binary fallback. Sweep skips bookkeeping and tolerates unlink races. |
| Hosted release (`.github/workflows/deploy.yml`) | main push → forced per-app deploy → fast-forward checkout → service restart → is-active | Hosted service auto-deploys independently of the test workflow. PR checks must be green before merge. npm/MCP registry publication is separate and manual; this audit does not invoke it. |

## Reproduced repairs

`tests/state-audit.test.mjs` adds eleven focused cases. All eleven were reproduced against the original implementation: ten failed in a combined baseline run, and the EOF case failed after its assertion was tightened to wait for the actual end event. Repaired cases cover:

1. Payment state/ledger/staging exposure through the public artifact endpoint, including symlink escape.
2. Idless or invalid-ID `tools/call` executing side effects.
3. Full-deposit refund after an already settled text regeneration fails.
4. Pruning an unclaimed paid quote; preserving its replay after late completion.
5. Abandoned payment wait and socket/heartbeat capacity cleanup.
6. Corrupt money state silently becoming an empty fresh ledger.
7. Browser preflight/cross-origin requests reaching a spending endpoint.
8. Refunded pay pages never terminating their monitoring loop.
9. stdio EOF exiting before accepted workflow results are delivered.

The tests use fixture accounts, local HTTP, scripted providers and temporary files. They do not broadcast blocks or invoke inference. Full suite: Node 24.22.1 and CI's checksum-pinned ffmpeg 7.0.2, `NANOODLE_OFFLINE=1 npm test`. The single offline skip is the existing public landing-image network check. Exact tested commit and final CI/deploy receipts belong in the PR/release report.

Origin and disconnect behavior follows the [MCP 2025-06-18 transport requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): validate Origin; treat a disconnected transport independently from workflow cancellation.

## Payment recovery regression checks

Run `node scripts/audit-payment-recovery.mjs` to check payment recovery with
synthetic wallet and ledger fixtures. The tests exercise quote durability,
resumable confirmed Nano history, restart recovery for signed refunds,
customer change and creator payouts, funding checks just before publication,
and duplicate transfer detection across the shared wallet. They neither use
real wallet credentials nor invoke inference.

Nano records a durable execution claim before opening a provider budget.
When a writer restarts with an unfinished claim, it records a failure and
full-deposit refund intent together. An unused payment remains ready for
its first run. A paid quote from before execution claims requires
reconciliation if its outcome is absent. Its funds stay reserved.
The scheduled check reports those holds and claims beyond their deadlines.

The Nano writer records outgoing intent with the payment outcome and saves
the exact signed block before publication. Retries reconcile that block.
A replacement requires a confirmed competing block on the same account
and predecessor. The monitor flags unsigned debts created by the old writer
and blocks claimed by more than one obligation. Preserve old debts as
liabilities and reconcile them against the chain before any further transfer.
Current settlements also retain the expected recipient and confirmation for
each outgoing leg. Missing or incomplete evidence keeps the balance reserved
and preserves the quote for reconciliation. The writer holds any restored
send whose amount or recipient conflicts with its settlement.

NEAR and USDC refunds also match the payer, asset and token contract. The
ledger preserves every uncovered remainder and the gas needed to send it.
A transaction hash belongs to one refund, including hashes retained from
nonce renewal. If two refunds claim one hash, both balances stay reserved
and their retries stay on hold until the records are reconciled.
NEAR and Market creator payouts cover only the matching recipient and
amount. Restored outbox entries that disagree with the original obligation
stay held with their signed bytes. The payment and assignment records remain
available after ordinary retention until their financial evidence matches.

The Nano gate and creator payout ledger still share one wallet writer.
Activation and rollback require the guarded release procedure. A writer
without signed-transfer recovery cannot safely retry a ledger that contains
unfinished signed intents.

## Existing work and release boundary

Inspected open work without merging, publishing or changing its branches:

| PR | Exact inspected head | Relationship |
|---|---|---|
| #89 A2A | `bdd9fd3f0262e68ef61e167c8a049a2237eaf34b` | Offline façade using canonical gate; durable orchestration/result recovery remains integration work. |
| #90 MCP compatibility | `ff79a0aface64a35cafb25f5bc044a9f44a3fcb1` | Opt-in separate compatibility package; no main activation. |
| #91 multi-network x402 | `3032c7d130df1c6794fee0e8172897a3e22579e0` | Inactive ingress explicitly requires a shared durable funding/settlement/dispatch authority. |
| #92 ACP | `0bdcd4fcc5b11a22a53be01faa0a40a32bf973f0` | Inactive seller qualification and journal; no live job/payment activation. |

Other existing workflow/content PRs were inventoried and left unchanged. Direct peer coordination could not be established: task-list/history bridge reads did not return, and this task's Babel native-session helper reported that its startup mailbox was not prepared. No enrollment/authentication flow was restarted. This is a coordination blocker for the larger shared-authority redesign, not a reason to overwrite other owners' drafts.

Before release, read-only checks verified `https://mcp.nanoodle.com/version` at `dbbb1bd`, active service `/srv/nanoodle-mcp/app`, output state outside the checkout at `/srv/nanoodle-mcp/out`, and valid v2 restore records. Aggregate state: 10 already-settled paid text records, 4 refunded, 3 expired, 0 owed, 0 unfinished consumed, 0 paid-unsettled. No customer arguments, output bodies, account identifiers or payment amounts were returned in release-check output. The deploy command fast-forwards the app and restarts its service. Rollback should revert the patch on main and redeploy while preserving `/srv/nanoodle-mcp/out`; never delete or reset the state file, and never bypass the new fail-closed reader by starting an empty gate.
