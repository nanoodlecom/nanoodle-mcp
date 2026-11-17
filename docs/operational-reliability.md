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
| Bounded RPC operations and a queue that survives errors | Nano reads and body reads now have deadlines; malformed state/publish responses, invalid invoices and cap bypasses are refused. Identical-block recovery after an ambiguous publish is retained. Local regression: 877 tests pass; production rollout still requires verification. |
| Stale/out-of-sync Nano and NEAR nodes | Check network identity, syncing/finalized head age, lag across independent reads, wallet frontier/confirmation consistency, watcher freshness and backfill. Prevent stale reads from authorizing new work. |
| Funds cover provider invoices and customer/creator liabilities | Audit atomic shared-pool reservations across concurrent runs, price/deposit changes, refunds, author payouts, and Market's deferred revenue. Refuse unaffordable work before inference. |
| Native NEAR gas and USDC refunds remain payable | Check spendable funds after storage, gas at current price, authorized signer, token registration, token balance and queued obligations. USDC liquidity alone cannot pay gas. |
| Per-run and per-job budgets are enforced at payment time | Estimates alone are insufficient. Test unexpected invoice increases, missing/non-finite prices, multiple parallel paid nodes and partially failed runs. |
| Prices and upstream fee assumptions stay current | Validate exchange-rate freshness, public model catalogs, all saved/custom workflow pricing and Market's actual platform fee; stale assumptions must not silently authorize losses. |
| Paid work/refunds/payouts cannot duplicate after ambiguous failures | Verify restart, receipt finality, nonce/frontier conflicts, persisted intents, stale snapshots and competing writers. No blind replacement transactions. |
| Stuck work is visible | Observe old running payments/assignments, pending/failed refunds and creator payouts, polling errors, worker authorization and heartbeat age. Do not execute jobs from a health check. |
| No-inference monitoring is installed and actually runs | Add bounded read-only readiness checks on a short interval, reports, actionable durable alerts, recovery/deduplication behavior, and fault-injection proof through the actual failure route. |
| Monitoring failure is itself detectable | Check stopped/missed timers, disk capacity/state writability, and independent observation of a whole-host/Babel outage. Existing same-host alarms cannot report while the VPS is unavailable. |
| Recovery preserves money state | Follow the inventory/deploy recovery audit: encrypted off-server backups and an isolated restore rehearsal remain unverified. Never start a second wallet writer or an empty ledger to bypass recovery. |

Completion needs targeted failure tests, full regression tests, merged/deployed
changes, live read-only observations, enabled schedules and authenticated alert
receipt. Paid inference is not part of the recurring readiness probes. Record
material remaining limits rather than treating a green public GET as proof.
