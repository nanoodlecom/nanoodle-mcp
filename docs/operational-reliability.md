# Operational reliability work

Objective: prevent workflow/payment failures from stale nodes, insufficient
liquidity, fees and reservations exceeding available funds, and stuck work;
observe those conditions periodically without running inference.

This is the audit and completion checklist, not a claim that every item is done.
Existing checks: one daily paid custom NEAR canary, quarter-hour public Market
availability, durable Babel alerts to Ember. Those alone do not prove financial
or worker readiness. Source/production baseline: `8357d57`, 2026-11-17.

| Requirement | Evidence required / remaining work |
|---|---|
| Bounded RPC operations and a queue that survives errors | Nano deadlines, malformed state/publish responses, invoice validation and cap protection deployed in PR #122 (`f0ba69b`), 877 tests passed. Ambiguous publishes retain identical-block recovery. Market response-body deadlines are included with the operational monitor. |
| Stale/out-of-sync Nano and NEAR nodes | Check network identity, syncing/finalized head age, lag across independent reads, wallet frontier/confirmation consistency, watcher freshness and backfill. Prevent stale reads from authorizing new work. |
| Funds cover provider invoices and customer/creator liabilities | Audit atomic shared-pool reservations across concurrent runs, price/deposit changes, refunds, author payouts, and Market's deferred revenue. Refuse unaffordable work before inference. |
| Native NEAR gas and USDC refunds remain payable | Check spendable funds after storage, gas at current price, authorized signer, token registration, token balance and queued obligations. USDC liquidity alone cannot pay gas. |
| Per-run and per-job budgets are enforced at payment time | Estimates alone are insufficient. Test unexpected invoice increases, missing/non-finite prices, multiple parallel paid nodes and partially failed runs. |
| Prices and upstream fee assumptions stay current | Validate exchange-rate freshness, public model catalogs, all saved/custom workflow pricing and Market's actual platform fee; stale assumptions must not silently authorize losses. |
| Paid work/refunds/payouts cannot duplicate after ambiguous failures | Verify restart, receipt finality, nonce/frontier conflicts, persisted intents, stale snapshots and competing writers. No blind replacement transactions. |
| Stuck work is visible | Observe old running payments/assignments, pending/failed refunds and creator payouts, polling errors, worker authorization and heartbeat age. Do not execute jobs from a health check. |
| No-inference monitoring is installed and actually runs | Deployed PR #124 (`a9191d1`), 913 CI tests passed. Five-minute timer enabled; automatic 01:55 and 02:00 UTC runs passed all 40 checks. Actual systemd test alert `near_check_161a96f8d6df2e22d31e08c99018ea15df7fca3b` acknowledged by Ember with mcp-recipient receipt. Inventory #28 and deploy #121 record/mirror it. See near-monitoring.md. |
| Monitoring failure is itself detectable | Check stopped/missed timers, disk capacity/state writability, and independent observation of a whole-host/Babel outage. Existing same-host alarms cannot report while the VPS is unavailable. |
| Recovery preserves money state | Follow the inventory/deploy recovery audit: encrypted off-server backups and an isolated restore rehearsal remain unverified. Never start a second wallet writer or an empty ledger to bypass recovery. |

Completion needs targeted failure tests, full regression tests, merged/deployed
changes, live read-only observations, enabled schedules and authenticated alert
receipt. Paid inference is not part of the recurring readiness probes. Record
material remaining limits rather than treating a green public GET as proof.

## Next runtime safety work

The monitor's balance reservations are observations, not enforced runtime leases.
The wallet serializes spends and refuses an individual transfer above its balance,
but several concurrent workflows can still consume funds another run or refund
needs. Bind a per-run funding limit to the approved graph/quote and reserve shared
working capital atomically before inference. Preserve customer and creator debts;
release remaining capacity only after in-flight payments resolve. Provider maximum
prepayments and their eventual refunds must not be confused with final model cost.
Verify that omitted token limits are bounded consistently in pricing and execution.

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

The NEAR pool verifies network identity at startup and the monitor checks head
freshness. Runtime failover still needs freshness/identity revalidation so a frozen
but HTTP-responsive primary does not keep answering while a healthy fallback exists.
The public Nano MCP ingress also needs its own free discovery probe; current discovery
probes target the canonical NEAR listener.

The upstream [x402 endpoint manifest](https://nano-gpt.com/api/v1/x402/endpoints)
lists text/image/data contracts. [Its public x402 page](https://nano-gpt.com/x402)
does not promise stable long-running video support. Our audio/video adapters use
legacy paths; absence from the manifest is not proof they are broken. Check actual
unpaid-quote/status behavior before changing their availability, and add safe probes
where they can detect breakage without running a model. The library's video polling
default is unbounded; qualify explicit hosted run deadlines and cancellation.

Independent whole-host/Babel outage notification and encrypted off-server recovery
with a restore rehearsal are still open. Do not call the overall reliability goal
complete based on the deployed monitoring milestone alone.
