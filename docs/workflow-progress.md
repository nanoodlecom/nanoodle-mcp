# Workflow execution progress

`src/workflow-progress.mjs` adapts the Nanoodle executor's existing
`onProgress` events to one versioned execution snapshot. It is independent of
payment asset, tool name, transport, and DOM. Saved tools and arbitrary
`run_noodle` graphs use the same adapter through the registry's optional
`callTool(params, ctx)` context. `ctx.workflow(snapshot)` observes progress;
listener failures cannot stop paid execution.

Snapshots contain `v: 1`, run status/timestamps, nodes (`id`, `type`, `name`,
`status`, optional timing/provider queue state), and dependency links
(`from`, `to`). States are `pending`, `running`, `done`, `error`, `skipped`,
and `gated`. Comments are omitted. Concurrent branches remain concurrent;
closed gates and skipped nodes retain their executor state. There is no
invented generation percentage. Fields, inputs, output values, raw errors,
and provider job IDs are excluded.

HTTP clients request `Accept: text/event-stream` and set
`params._meta.progressToken` on `tools/call`. Both HTTP and stdio emit
`notifications/progress` with a readable `message`, increasing `progress`,
the original token, and the snapshot under
`params._meta["com.nanoodle/workflow"]`. Payment metadata stays outside tool
arguments, so it does not alter a quote's argument hash. HTTP heartbeats keep
the current step visible during a long provider operation.

The NEAR gate keeps snapshots in memory and includes them in the existing
capability-protected `/near/status/:paymentId` response. A reloaded demo
attaches to a running quote through that status endpoint; it replays the
bound call only after settlement, never executes again. Snapshots are not
written to the server payment ledger. Existing restart/refund guarantees
remain in force.

`src/workflow-view.mjs` is a reusable read-only SVG renderer over that
snapshot. `layoutWorkflow` derives layers from dependencies, so editor
coordinates and named workflow templates are unnecessary. Branches, joins,
wide graphs, keyboard scrolling, text state labels, and reduced motion are
supported. The demo expands it while running and folds it at completion to
make room for the result and receipt summary. Display rounding affects only
human-readable totals; exact amounts remain in payment details.

Regression coverage includes real HTTP paid custom/saved runs with a blocked
provider (progress must arrive before the result), status reattachment,
single execution on replay, stdio notifications, split SSE frames, graph
branch/gate/error states, safe metadata, and restored quote selection.
