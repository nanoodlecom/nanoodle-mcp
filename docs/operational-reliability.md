# Operational reliability work

Objective: prevent workflow/payment failures from stale nodes, insufficient
liquidity, fees and reservations exceeding available funds, and stuck work;
observe those conditions periodically without running inference.

This is the audit and completion checklist, not a claim that every item is done.
Existing checks: one daily paid custom NEAR canary, quarter-hour public Market
availability, durable Babel alerts to Ember. Those alone do not prove financial
or worker readiness. Production baseline before the Nano read-guard rollout:
`3a799c8`, 2026-11-17.

| Requirement | Evidence required / remaining work |
|---|---|
| Bounded RPC operations and a queue that survives errors | Nano deadlines, malformed state/publish responses, invoice validation and cap protection deployed in PR #122 (`f0ba69b`), 877 tests passed. Ambiguous publishes retain identical-block recovery. Market response-body deadlines are included with the operational monitor. |
| Stale/out-of-sync Nano and NEAR nodes | NEAR identity, syncing/finalized age, monotonic heads and watcher expiry deployed in PR #125. The [Nano account read guard](nano-rpc-freshness.md) validates mainnet peers, compares current/confirmed account state, rejects regressions and stale negatives, and checks runtime coverage. Nano rollout qualification is recorded below. |
| Funds cover provider invoices and customer/creator liabilities | PR #127 deployed atomic shared-pool reservations and live debt protection across direct runs and Market. Runtime funding telemetry is checked every five minutes. Restore-time signed-intent ambiguity remains a separate open requirement. |
| Native NEAR gas and USDC refunds remain payable | The [refund funding guard](near-refund-funding.md) deployed in PR #133 (`714cde3`) after 1,035 tests. It covers quote/admission/fresh signing, the gas purchase floor, complete action fees and outgoing-height checkpoints. Exact-module live preflight covered both assets; the bounded native canary and all 44 scheduled probes passed. Inventory #33 and deploy #126 record qualification. |
| Per-run and per-job budgets are enforced at payment time | Estimates alone are insufficient. Test unexpected invoice increases, missing/non-finite prices, multiple parallel paid nodes and partially failed runs. |
| Prices and upstream fee assumptions stay current | Validate exchange-rate freshness, public model catalogs, all saved/custom workflow pricing and Market's actual platform fee; stale assumptions must not silently authorize losses. |
| Paid work/refunds/payouts cannot duplicate after ambiguous failures | Verify restart, receipt finality, nonce/frontier conflicts, persisted intents, stale snapshots and competing writers. No blind replacement transactions. |
| Stuck work is visible | Observe old running payments/assignments, pending/failed refunds and creator payouts, polling errors, worker authorization and heartbeat age. Do not execute jobs from a health check. |
| No-inference monitoring is installed and actually runs | Deployed PR #124 (`a9191d1`), 913 CI tests passed. Five-minute timer enabled; automatic 01:55 and 02:00 UTC runs passed all 40 checks. Actual systemd test alert `near_check_161a96f8d6df2e22d31e08c99018ea15df7fca3b` acknowledged by Ember with mcp-recipient receipt. Inventory #28 and deploy #121 record/mirror it. See near-monitoring.md. |
| Monitoring failure is itself detectable | Check stopped/missed timers, disk capacity/state writability, and independent observation of a whole-host/Babel outage. Existing same-host alarms cannot report while the VPS is unavailable. |
| Recovery preserves money state | Follow the inventory/deploy recovery audit: two manual encrypted off-VPS data recovery points and isolated file restores verified. Periodic copies, retention/key escrow and full-host boot rehearsal remain open. The [startup ownership guard](state-ownership.md) adds local kernel locks and a required-existing-state policy in source; deployment qualification remains required. |

Completion needs targeted failure tests, full regression tests, merged/deployed
changes, live read-only observations, enabled schedules and authenticated alert
receipt. Paid inference is not part of the recurring readiness probes. Record
material remaining limits rather than treating a green public GET as proof.

## Next runtime safety work

The monitor observes the reservations enforced by the running app.
The [run funding controller](run-funding.md), PR #127, now binds hosted Nano
checkout, NEAR/USDC saved/custom workflows and Market runners to one wallet queue.
Live obligation readers, in-flight transfer/debt handoffs, disabled-profile
obligations and fresh Market fee guards are implemented. The private runtime
snapshot and separate Nano discovery probe extend the operational check from
40 to 42 checks. PR #127 deployed `bb40a2e` after 985 branch/main CI tests passed.
The manual 04:46 and automatic 04:50 UTC readiness checks passed all 42 probes,
and a bounded two-step native NEAR canary passed payment detection, progress,
result, finalized refund and replay at 04:47 UTC. Inventory PR #30 and deploy
PR #123 record the verified deployment and remaining recovery gaps.

The wallet now preserves shared working capital and customer/creator debts on
its serial queue. Provider maximum prepayments and their eventual refunds remain
distinct from final model cost. Bound token defaults and creator fee handoffs
are tested across saved/custom workflows and deferred Market settlement.

The operational check also compares the balance left after live reservations
and liabilities against the existing $2 working-capital threshold at the
current Nano/USD rate. Crossing this threshold raises an early warning. Each
new run still goes through the wallet's exact budget and balance checks.

Read-only upstream quotes on 2026-11-17 returned 402 (unpaid) for GLM 5.3 Flash:
256 output tokens quoted $0.00008657; 4096 quoted $0.00135377. These are evidence
of that request shape only, not permanent prices or a general reserve policy.
Check the actual bound graph/model options before choosing a cap.

Draft [durable Nano recovery PR #96](https://github.com/nanoodlecom/nanoodle-mcp/pull/96)
qualifies a schema-2 journal against an older base. It is unmerged/unactivated and
has an operational hold for ownership coordination, backups and compatible rollback.
Do not blindly enable it. Review/rebase against current Nano + NEAR/USDC + Market
paths, preserve the current timeout fixes, qualify current-state migration read-only,
and verify backups/restore/fencing before any cutover. Existing JSON sends can have
ambiguous restart outcomes; monitoring does not correct that. Audit ownership locks
before startup money effects and behavior after an unclean reboot.

The hosted NEAR pool now revalidates network identity every 30 seconds and rejects
syncing nodes, heads older than 90 seconds or more than 30 seconds in the future,
malformed head metadata, and regressing latest finalized heights. Unhealthy reads
fail over; semantic negative transaction answers remain authoritative. Historical
payment blocks retain their original verification rules. A timed-out broadcast
still resolves by its existing transaction hash, without constructing a replacement.
The watcher does not advance or refresh its cursor on a stale head. Its cached
health also expires, and new NEAR/USDC quotes pause while monitoring is unhealthy;
existing payment verification, outcomes and refunds remain accessible. Fault tests
cover frozen/syncing/wrong-chain nodes, cached-head expiry and outage recovery.
PR #125 deployed this behavior before the subsequent funding-guard release.

The separate public Nano MCP ingress now has a free discovery probe in addition
to the canonical NEAR listener. It performs initialization and tool discovery,
never a quote requiring payment or an inference call.

The upstream [x402 endpoint manifest](https://api.nano-gpt.com/api/v1/x402/endpoints)
lists text/image/data contracts. [Its public x402 page](https://nano-gpt.com/x402)
does not promise stable long-running video support. Our audio/video adapters use
legacy paths; absence from the manifest is not proof they are broken. Fifteen
unpaid quote samples on 2026-11-17 returned valid 402 invoices for the current
NEAR demos: GLM 5.3 Flash at 96/256/1536/2000/2048/4096 tokens, six image request shapes,
Mureka 9.5 and both five-second H3 video models. No payment/complete request or
inference was made. Check actual unpaid-quote/status behavior before changing
their availability, and add safe probes
where they can detect breakage without running a model. The library's video polling
default is unbounded. The shared [hosted execution deadline](hosted-execution.md)
now covers saved/custom tools, nested built-ins, humanizer transports, Market
runs and output downloads in source. Fault tests include in-flight payment
reconciliation and full-refund/no-repay behavior through the actual server on
Nano, NEAR and USDC. PR #129 deployed `3a799c8` after 995 tests passed. A bounded
two-step native NEAR canary at 05:19 UTC passed progress, result, finalized refund
and replay; the automatic 05:20 UTC readiness check passed all 42 probes.
Inventory PR #31 and deploy PR #124 record that deployment.

The Nano read guard adds a frozen preferred peer to the actual hosted-server
tests. It covers confirmed payment detection, provider sends, refunds and replay
for all three direct payment assets. The complete suite passed 1,013 tests.
Read-only preflight at 06:30 UTC verified the exact module against all four
configured production RPCs and the wallet selected by the running process.
PRs #130–#132 deployed and qualified this behavior; a successful two-step native canary and automatic 42-probe readiness run are recorded in inventory #32/deploy #125.

Independent whole-host/Babel outage notification, periodic encrypted off-server
recovery and full replacement-host rehearsal remain open. Two manual off-VPS
data restore points are verified. Do not call the overall reliability goal
complete based on the deployed monitoring milestone alone.
