# Shared Nano run funding

Hosted wallet-funded Nano checkout, NEAR/USDC saved and custom workflows, and
Market workers use one controller on the wallet's block queue. A run reserves
working capital before inference. Each provider invoice must fit both its
cumulative USD maximum and its exact raw Nano maximum. Terms come from the paid
quote or accepted job; caller arguments cannot grant spending authority.

`createNanoWallet` exposes `ops.withFunding(terms, execute)` and
`ops.fundingStatus()`. Server-created terms contain a stable run identity, a
maximum USD prepayment, an exact raw Nano limit and optional creator overhead.
The quote's locked exchange pair determines these limits. Creator markup stays
outside model authority. Provider maximum prepayments differ from final model
cost: a provider refund increases future spendable capital and never resets the
current run's cap. Failed or ambiguous payments still consume authority.

Concurrent nodes inherit one opaque async scope. The wallet captures the
enqueuer's scope before entering the queue, so another caller's queue drainer
cannot substitute its budget. Duplicate invoice identities, nested runs and
detached work after scope closure are refused. Earlier queued payment attempts
finish resolving before unused capital releases. Omitted saved-workflow token
limits are bound consistently with pricing.

Live ledger owners supply customer refunds, in-flight Nano sends and creator
debts. Completed work hands its earned creator claim to the ledger before its
funding scope closes. Disabled Market profiles still contribute their recorded
debts through read-only disk fallback. Exhausted refund retries remain held
liabilities requiring reconciliation. Malformed state cannot become zero debt.
All Nano transfers, including refunds and payouts, preserve other runs' reserved
capital. A trusted ledger owner may consume its own recorded claim; graph JSON
cannot provide that authority.

Market revenue is deferred and never counted as cash. New creator terms stay
within the accepted workflow's priced budget. Workers verify the current public
platform fee before accepting/starting inference, and bidders verify it before
bidding. A fee above the pricing allowance refuses new work; an unavailable fee
check backs off. A completed answer is not reused for a later execution phase.

The private `out/funding-health.json` snapshot selects aggregate counts and raw
amounts, is mode 0600, and is excluded from public artifact delivery and sweeping.
It is telemetry, never financial authority. New quotes pause when it reports an
unfunded pool or unavailable state. Quote admission also expires 60 seconds
after the last healthy refresh, using a monotonic clock. A refresh stuck on the
wallet queue cannot leave checkout enabled indefinitely; a new healthy refresh
is required to resume. Expiry preserves existing debt accounting and settlement.
A failed snapshot write also pauses Nano
authorizations; read-only recovery can resume after storage recovers. The
five-minute operational check requires fresh enforcement telemetry, tests its
own atomic balance against liabilities plus reservations, and flags old scopes.
It also checks both public MCP listeners without executing a workflow.

## Verification and remaining recovery limits

Offline tests exercise actual hosted Nano, NEAR and USDC saved/custom calls
through provider 402 invoices and wallet block publication fixtures. Other fault
tests cover concurrent budgets, oversize/malformed invoices, debt handoffs,
creator fees, exhausted refunds, changed/unavailable Market fees, storage
failure/recovery and private telemetry. These fixtures spend no real money and
run no inference. Read-only upstream sample quotes also cover the current five
NEAR demos' text, image, music and video models. Sample prompts are not a proof
of every possible user input or permanent provider prices.

This controller holds reservations in memory. It does not replace a durable
signed-intent journal, a fenced single writer, ambiguous-send reconciliation,
encrypted off-server backups or a restore rehearsal. Completed Nano text
payments cannot regenerate inference after restart just because result text was
not retained; their financial receipt remains available. Interrupted unsettled
work and ambiguous legacy sends still require the recovery audit. Never start a
second writer or discard state to bypass an unresolved payment.

Track deployment evidence and the remaining service-wide requirements in
[operational-reliability.md](operational-reliability.md).
