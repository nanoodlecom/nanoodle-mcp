# Nano RPC account freshness

The private `out/funding-health.json` includes `nanoRpc.checkpoint`: the network
genesis, public account, highest observed account head and highest confirmed
head, each with its hash and block count. Locally published unconfirmed heads
remain in that floor; lagging peers cannot lower it. The report selects these
fields explicitly and remains 0600 and inaccessible through `/out`. The public
operational report contains only the checkpoint probe's status code.

Capture a fresh healthy checkpoint while the original writer is still running
and idle, then fence it before a migration or replacement. Compare the new
confirmed account view and block ancestry against that floor. A missing,
wrong-wallet, conflicting or behind-floor view must stop the handoff. This
telemetry is an input to an operator handoff; it is not a durable journal,
an automatic restore mechanism or permission to run two wallet writers.

Hosted paid tools and Market workers enable the shared wallet's read guard.
`NANO_RPC_URL` / `--nano-rpc` accepts one to eight distinct, comma-separated
endpoints. Configure independently operated mainnet nodes: with multiple endpoints,
each account read needs at least two readable mainnet peers. An explicitly single
endpoint retains validation and monotonic account checks but has no independent
peer comparison. Ordinary local wallet use keeps its existing opt-in behavior.

Each endpoint must expose the confirmed mainnet genesis block and modern
`account_info` fields, including current and confirmed frontier, height, balance,
representative and `confirmed_receivable`. Network identity expires after
30 seconds and is rechecked. Read requests, including their bodies, have a
2.5-second limit per request; configured shorter RPC limits still apply.

HTTP 429 and numeric or string 429 errors inside HTTP 200 responses put that
peer into cooldown. The read guard honors JSON `retry_after` seconds and HTTP
`Retry-After` seconds/date hints, as described in the
[provider's retry guidance](https://docs.nano.to/rate-limits). Without a longer
hint, repeated refusals back off from 30 seconds to five minutes; provider hints
are bounded to 30 days, covering observed multi-day IP penalties. Successful
account or block reads reset that escalation.
Cooling peers receive no read or publish attempts. Other qualified peers keep
serving, and the required independent-peer minimum stays the same.

Reads fan out to qualified peers. The wallet selects the newest consistent
account height; at the same head, the greater confirmed pending total wins over
a stale empty view. It rejects malformed amounts, conflicting heads/balances,
regression below an observed or locally published head, and unknown unconfirmed
heads. A local published chain can continue while its confirmations arrive.
An unavailable quorum pauses new spending rather than treating an outage as an
empty account. This is a freshness check over trusted RPCs, not a Byzantine
consensus protocol or a guarantee when all configured nodes are frozen together.

Receivable scans request confirmed sends only. A short complete pending page
must agree with that peer's atomic confirmed pending total. History scans expose
only confirmed entries so the payment cursor cannot advance past an unconfirmed
receive. Block outcome reads consult the qualified peers: a positive confirmation
wins over a stale negative response, and partial outages cannot establish that a
block is absent. State-block contents must hash to the requested block ID.

The account cache expires within 30 seconds. New publications prefer peers that
reported the newest selected account view. Publication still follows the existing
ambiguous-outcome policy; this read guard does not persist signed transaction
intents, fence competing processes or make legacy restart recovery safe.
Those require the separate durable recovery work.

The private funding snapshot includes only peer counts and the last successful
read time. Missing coverage, stale reads or network-identity failure make funding
health fail and pause new quotes. The existing five-minute readiness monitor
checks runtime enforcement as well as each peer's mainnet identity and confirmed
account view. It performs no inference, work generation, signing or publication.
No endpoint URLs or credentials are included in that report.

Private funding telemetry additionally selects a configuration digest and
cooldown peer indices/deadlines. The monitor verifies that the digest matches its
own ordered endpoint configuration before using those indices. A fresh known
cooldown remains a reported `nano-rpc-rate-limited` degradation without another
upstream request. Invalid metadata or changed configuration cannot hide a peer
failure. The monitor still queries the other peers and independently verifies
their frontier agreement and available quorum; loss of quorum closes admission.

Offline tests include a real hosted server with a frozen preferred peer and two
current peers. Nano, NEAR and USDC saved/custom runs, timeout refunds and replay
all use that fixture. The frozen peer returns empty pending/history lists and
stale negative block lookups; new sends use the current observed peers.

Pre-deployment read-only verification on 2026-11-17 at 06:30 UTC used the exact
module against the running service's wallet and all four configured endpoints.
All four proved mainnet and returned readable account views; the current block
was confirmed, history contained ten confirmed entries, and the chain balance
matched the private runtime snapshot. No wallet writer or inference was started.
