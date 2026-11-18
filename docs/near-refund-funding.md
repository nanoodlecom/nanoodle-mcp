# NEAR and USDC refund funding

Hosted checkout verifies the merchant's NEAR storage and refund fees before
issuing a quote and again before starting paid model work. USDC balance cannot
pay NEAR gas. The same controller checks fresh refund signing, while the existing
outbox retains the debt and identical signed-transaction retry behavior.

The accounting includes all paid/running deposits, settlement-to-outbox gaps,
failed runs missing a refund intent, and queued/signed/permanently failed refund
debts. Once an outbox record exists it owns that claim; a handoff cannot count
the whole paid deposit again. Creator payouts remain in Nano and use the existing
shared Nano funding controller.

Unpaid quotes are capacity checks and do not lock gas. A free quote request
cannot exhaust the merchant's fee reserve merely by remaining unpaid. Actual
paid obligations are re-read after RPC awaits, and insufficient coverage pauses
execution before any model invoice. The caller keeps the same payment ID and
can resume after funding recovers. A response identifies that pause as retryable;
the browser and daily canary retain the original payment rather than caching a
temporary error as its final result. Finished receipts remain accessible.

## Fee and account proof

Account, access-key and token views are pinned to one fresh finalized block and
must return its matching hash and height. Protocol fees and gas price use that
same block hash. Network identity, storage price,
FullAccess permission and an available nonce are required. The balance must cover
native customer principal, storage, conservative fees for every actual refund,
and the existing 0.05 NEAR operating float before admitting model work. Quotes
also check capacity for one new refund in their chosen asset.

Fee prepayment uses the greater of the block gas price and the protocol's
minimum gas purchase price. It includes receipt/action fees, implicit-account
creation and a full-access key for a native refund, and the FT function-call and
maximum argument-byte fees plus its actual 30 Tgas attachment. A twofold margin
and the protocol's inflation ratio cover movement between observations. The
one-yocto FT attachment is also retained. These are conservative funding needs,
not the final gas burned or a customer surcharge. See the primary
[NEAR gas rules](https://near.github.io/nearcore/architecture/how/gas.html) and
[runtime fee definitions](https://nomicon.io/RuntimeSpec/Fees/).

Actual refunds take priority over new quote requests and may use the operating
float. They still preserve other customers' principal and refund fees. The
admission queue bounds waiting free quotes at 16, prioritizes refunds and paid
runs, and deduplicates background refreshes. Queued quotes recheck watcher/rate
readiness before the final account read and synchronous quote commit.

The refunder uses the key nonce/hash from that verified funding frame when
signing. A blocked fresh signature leaves the existing unsigned debt and does
not consume a nonce. Already signed transfers remain queryable and retry the
same bytes, even while fresh signing is paused.

## Completion and restart

An outgoing result must be FINAL and match the stored transaction hash, sender,
recipient, amount and action. Before removing the refund claim, the controller
resolves its transaction/receipt blocks and persists their maximum height.
Admission cannot reuse an account view older than that outgoing checkpoint.
Completion shares the admission queue, so an already-running read cannot lose
the debt halfway through its snapshot.

The existing NEAR v1 ledger stores two additional metadata fields:
`refundFinalHeight` and `refundFundingV: 1`. First activation resolves recent
legacy completed/refund-failed transactions read-only before marking that
bootstrap complete. Failed proof leaves new admission paused; no legacy refund
or model is automatically repeated. Unknown metadata versions fail closed.

The controller refreshes every 30 seconds and expires its public health after
60 seconds. `/near/health` exposes only enforcement, time, fixed error codes and
coverage/capacity booleans. The five-minute no-inference monitor verifies those
fields and independently reads the actual account, fee floor, obligations and
balances. Its reports show watcher health, unverified or stale refund funding,
confirmed shortfalls and per-asset capacity separately. Unnamed RPC errors can
fall back to the other qualified endpoint on watcher and funding reads. The
monitor never signs, generates work, runs inference or retries a refund.

Offline fixtures cover simultaneous payments, gas/price changes, unavailable
funding, refund priority, exhausted nonces, same-payment resume, false/nonfinal
outcomes, historical RPC snapshots and persistent outgoing-height floors. The
expiry simulator advances the server and stand-in chain clocks together; a
future-dated latest chain head remains an unhealthy-node condition.

This guard trusts the configured chain RPCs and uses a conservative fee margin;
it cannot prevent an external owner withdrawal or arbitrary unquoted transfers.
It does not activate the draft durable Nano journal, fence another process,
provide periodic off-server backups or establish full-server failover.
