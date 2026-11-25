# Daily paid MCP check

`scripts/near-check.mjs` exercises the public MCP with one cheap custom text →
LLM workflow and native NEAR. The optional `--two-steps` adds a second LLM to
check data handoff. Each new run uses a random marker and checks the answer,
automatic payment discovery (without transaction hints), streamed node progress,
the finalized refund and receipt arithmetic, replay, and the payment-page result
cache. It also checks MCP initialization, discovery, agent instructions and pricing.

The default limits are $0.001 estimated model cost and 0.01 NEAR deposited per
run. The server's $0.01 minimum deposit is mostly refunded. Actual model cost
plus the service fee must be at most $0.0012 for the check to pass. Network gas
is additional. A cap violation stops before payment; an unexpectedly high final
charge fails the check after settlement. Only a small dedicated payer wallet is
available to this process; it cannot access the merchant key. Funding is manual,
so total losses are also bounded by that wallet's balance.

Before signing, the canary checks the payer's balance, storage requirements,
full-access key and gas prepayment at a single fresh finalized block. A shortfall
leaves the graph ready for a new quote after funding. Any previously signed
payment still follows the same-hash recovery path.

The five-minute operational probe reads the dedicated payer's public balance and
key status and warns when the payer cannot cover the maximum canary deposit,
storage and gas. It derives an implicit account's public key from its account
ID. For a named payer, set `CHECK_PAYER_PUBLIC_KEY` in the canary environment
file. `CHECK_MAX_NEAR` configures the canary's default cap and the monitoring
threshold together. The operational service's payer key file remains inaccessible.

When the successful canary's discovery proof is configured, the five-minute
probe also reads that run's settled payment page, status, event stream, and
result. It checks that the deposit equals the charge plus the refund, verifies
the completed graph in the status and event stream, and compares the result to
the canary marker's SHA-256 digest. Older proofs check the marker format until
the next successful daily canary publishes a digest. The alert omits the
checkout ID, receipt, and output. At the checkout retention limit, the probe
stops reporting a checkout result and continues on-chain discovery for the
lifetime of the proof.

## Installation on the production box

Create a `nanoodle-check` system user. Generate a dedicated key with
`generateNearKey` / `writeKeyFile` from `scripts/near-testnet-lib.mjs`, write it to
`/etc/nanoodle-near-check/payer.json` (root:nanoodle-check, 0640), and fund its
implicit account once. Do not put the merchant credentials into the check's env.
Use a separate `/etc/nanoodle-near-check` directory (root:nanoodle-check, 0750).
Write `/etc/nanoodle-near-check/env` (root:nanoodle-check, 0640):

```sh
CHECK_URL=https://near.nanoodle.com
CHECK_PAYER=<dedicated implicit account>
CHECK_KEY_FILE=/etc/nanoodle-near-check/payer.json
```

Install `ops/nanoodle-near-check.{service,timer}` in `/etc/systemd/system/`, then:

```sh
systemctl daemon-reload
systemctl start nanoodle-near-check.service
systemctl enable --now nanoodle-near-check.timer
systemctl list-timers nanoodle-near-check.timer
```

The timer runs at **09:00 UTC daily**, including one catch-up after downtime.
No automatic service restart is configured. A failure leaves a failed systemd
unit and a redacted `latest.json`. The failure hook alerts Ember over Babel when
the notification setup below is installed.

```sh
systemctl status nanoodle-near-check.service
journalctl -u nanoodle-near-check.service --since yesterday
cat /var/lib/nanoodle-near-check/latest.json
```

## Recovery and manual checks

New canaries use `orca/orcacyber-inkling-2-mini` with reasoning disabled and a
256-token limit. New version-two checkpoints require the model's first text output to
equal a fresh 16-character hexadecimal marker. No decorative prefix is required;
the two-step variant extracts and copies that marker through both models.
The marker checks payment, execution and result delivery without
depending on a thinking model finishing inside a tiny budget. Strict marker,
progress, receipt, refund and replay checks still apply. Retained work keeps its
original graph and signed payment when the script changes; an incorrect result
stays failed and is not automatically rerun or replaced.

State and signed transaction bytes are saved atomically before broadcasting.
Reruns resume the same payment and graph. They never re-sign an ambiguous or
expired transaction or replace an unfinished quote. A completed day performs
free MCP checks and reads the payment page's status and result endpoints. Both
must still return the verified receipt, and the result must contain the exact
canary output. The check reuses the original deposit and performs no inference.
After recovering an older unfinished day, the next invocation can start today's
check. Always run under the same `flock` as the systemd service to avoid overlap.

For a separate manual two-step check, use a separate private state directory:

```sh
flock -n /var/lib/nanoodle-near-check/check.lock \
  node scripts/near-check.mjs --two-steps --state-dir /private/manual-check \
  --payer <account> --key-file /private/payer.json
```

`state.json` contains private quote capabilities and signed transaction bytes;
keep it private. `latest.json` is redacted and contains only verification facts
and public transaction hashes. If a quote expires unpaid or a signed transaction
is rejected, inspect the recorded hash and account on chain before archiving the
state. Do not delete state to blindly retry. If recovery finds a completed run
whose original progress stream was lost, missing live progress correctly fails
the check rather than claiming that streaming was verified.
The server saves text outputs privately before settling, so the same paid
result must remain readable after a restart within the 24-hour window. The
monitor still checks the original marker and receipt. A run settled by a
previous release may lack a saved output. Inspect its canary checkpoint and
on-chain receipt before archiving an interrupted manual check.

The five-minute read-only check reports the retained canary's checkout page,
receipt, graph, event stream and result separately. It can report a missing
result even when the graph or event stream is also missing. Each receipt is
checked against the local deposit, charge and refund records, and the
readable copies must agree. These checks use the existing canary data and
leave payment admission to the funding and watcher checks.

## Babel failure alerts

The same durable outbox also recognizes the manual `nanoodle-backup.service`
and labeled `nanoodle-backup-alert-test.service` drill. Backup messages select
only the systemd invocation/result and a fixed backup stage; they never read
payment reports, archive contents or recovery keys. They ask the operator to
confirm that the app and original timers resumed. This does not install or
schedule a backup, provide an off-server destination, or keep Babel reachable
during loss of the shared VPS.

The five-minute readiness check also verifies backup capture and export age,
offsite copy age, and whether the two proofs cover the same encrypted archive.
A new export has 15 minutes for offsite verification. An overdue generation
raises a backup warning through Babel while payment admission is assessed
independently. The proof files contain a checksum-derived generation ID.
Neither the monitor report nor the alert contains that ID or archive paths.

The check's `OnFailure` starts `nanoodle-near-alert@<failed-unit>.service`.
`scripts/near-alert.mjs` saves a selected-metadata message before attempting
delivery. Each systemd invocation has a stable message ID; network failures and
lost responses retry that ID. `nanoodle-near-alert-retry.timer` drains pending
messages every five minutes. Babel then owns durable delivery and recipient wakes.
Queue acceptance is distinct from Ember's authenticated receipt.
Alerts list admission failures before advisories. The outbox attempts new
blocking alerts first and keeps unreadable records for inspection. An unreadable
record counts as a delivery fault while other messages can still be sent.

Provision a dedicated persistent sender through the Babel operator's approved
process, scoped to a conversation with Ember. Do not copy a native worker's
expiring credential. Keep its token in `/etc/nanoodle-near-check/babel-token`
(root:nanoodle-check, 0640), and write `babel.env` alongside it:

```sh
BABEL_URL=http://127.0.0.1:8403/mcp/v1
BABEL_HOST=babel.255bits.com
BABEL_TOKEN_FILE=/etc/nanoodle-near-check/babel-token
BABEL_SENDER=<dedicated sender ID>
BABEL_CONVERSATION=<dedicated alert conversation>
```

The supplied unit restricts network access to localhost. The Babel credential
has no wallet access. Alert text contains the time, failed stage, service result
and recovery instructions; it excludes prompts, quote capabilities and keys.
Install `ops/nanoodle-near-alert@.service` and
`ops/nanoodle-near-alert-retry.timer`, reload systemd, and enable the retry timer.
Inspect delivery with:

```sh
systemctl status 'nanoodle-near-alert@nanoodle-near-check.service.service'
cat /var/lib/nanoodle-near-check/alerts/latest-delivery.json
```

Test the exact failure path without paying for a workflow:

```sh
systemd-run --unit=nanoodle-near-check-alert-test \
  --property=OnFailure=nanoodle-near-alert@nanoodle-near-check-alert-test.service.service \
  /usr/bin/false
```

This unit's failure is expected. Its alert is explicitly labeled TEST and asks
Ember to claim and acknowledge it. Verify `message_status` for the resulting
message using the sender's own credential. A queued message alone does not prove
receipt. Never acknowledge on Ember's behalf.

The operational probe allows a recently started app up to 45 seconds to initialize
both listeners and the NEAR watcher before running its full check. This applies
only when systemd reports a live app started within the last minute. An old,
missing or failed app is checked immediately. A bounded grace expiring still runs
all normal probes and alerts on failure; it never reports recovery by itself.
These warm-up GET requests execute no workflows or payments. This avoids the
temporary 502 alarm observed just after the planned 2026-11-17 backup drill.

The readiness check reads active Market assignments, then compares each paid
hire with the worker's local state. It flags hires still untracked after five
minutes, remote starts without a corresponding local record, and active
assignments past their Market deadline. It reports if the bounded five-page
scan cannot cover the full queue. The reports and Babel alerts carry fixed
diagnostic codes. They omit assignment IDs and buyer text.

## NEAR AI Market availability every 15 minutes

`scripts/market-check.mjs` makes public GET requests to `market.near.ai`: the
website, platform API, and the four published Nanoodle profiles (song, image,
character, clip) with their default live pricing plans. It checks that profiles
are live, available and not funding-paused. Occupied job slots alone do not
fail a check. The custom-workflow profile is not published yet and is excluded;
add it to `MARKET_HANDLES` after publication.

This is an availability check, not a paid execution test. It uses no credentials,
creates no jobs, runs no inference, and makes no payments. It does not prove an
authenticated worker can complete an assignment. Each failed probe gets up to
three attempts with a two-second pause; each request, including its response
body, has a 12-second deadline. Reports contain selected public status only.

Install `ops/nanoodle-market-check.{service,timer}` alongside the existing check
and alert units, then:

```sh
systemctl daemon-reload
systemctl start nanoodle-market-check.service
systemctl enable --now nanoodle-market-check.timer
TZ=UTC systemctl list-timers nanoodle-market-check.timer
cat /var/lib/nanoodle-near-check/market-latest.json
```

The timer runs at **:00, :15, :30 and :45 UTC** with a catch-up after downtime.
It runs on the same production VPS, `159.195.17.119`, as user `nanoodle-check`;
the unit hides the payer key and Babel token. Failures use the existing Babel
sender, conversation with Ember, private outbox and five-minute alert retry
timer. No additional Babel enrollment or grant is required.

Test the Market failure route without interrupting the actual service:

```sh
systemd-run --unit=nanoodle-market-check-alert-test \
  --property=OnFailure=nanoodle-near-alert@nanoodle-market-check-alert-test.service.service \
  /usr/bin/false
```

The resulting alert explicitly says TEST. As above, verify Ember's authenticated
receipt separately from queue admission.

## Financial and workflow readiness every five minutes

`scripts/operational-check.mjs` runs as `nanoodle-mcp` with its existing config
and filesystem access. It reads public chain data and authenticated read-only
Market assignments, checks free MCP discovery/pricing, and reads local ledgers.
It does not execute models, generate PoW, pay invoices, sign/broadcast transfers,
start/retry jobs, submit bids or change listings. A small unique temporary file
is written, fsynced and removed in the output directory to verify persistence.

Coverage:

- Local media referenced by completed Nano, NEAR, and USDC payments. The
  check uses the server's active media retention period and alerts if a
  recent output is missing, empty, or a symlink. It reads file metadata
  only. Filenames and checkout details stay out of alerts.
- Nano mainnet identity, confirmed wallet height/frontier agreement across
  configured nodes, and the running wallet's fresh multi-peer read enforcement.
  See [Nano RPC freshness](nano-rpc-freshness.md).
- The owned Nano node's confirmation counters, when ledger telemetry is
  enabled. The probe distinguishes a local counter regression, a stalled
  confirmed count and a gap that keeps growing. A widening gap of at least
  50 blocks over at least ten minutes warns even while both counts advance.
  The warning needs two increases and tolerates short plateaus between
  them. A missing sample still warns about unavailable telemetry. Trend
  comparisons can resume from the last valid sample for up to 12 minutes.
  Shrinking lag or a plateau longer than 12 minutes clears the trend. The
  elapsed time comes from the counter observations.
  Wallet read quorum determines Nano payment readiness.
- Recent paid workflow execution failures from the Nano, NEAR/USDC and
  Market ledgers. Two or more failed runs in 30 minutes across these sources
  raise an advisory while payment admission continues. Late or wrong-amount
  transfers and Market jobs declined before execution are excluded.
- NEAR network, syncing, finalized head age and cross-node consistency;
  payment-watcher age/lag and the merchant's current refund-key permission.
  If the watcher is still scanning historical blocks five minutes after the
  first observation, the same alert route reports delayed payment detection.
  The report distinguishes this from a failure to follow the live chain tip.
  The historical canary asks each peer for the existing transaction outcome
  immediately and requires a finalized result. A peer with no record returns
  that status promptly. Timeouts identify the failed step from reading the
  transaction to resolving the receipt.
  Historical blocks must match the requested hash, and recovery records a
  decreasing height bound across restarts. An invalid predecessor leaves
  coverage at the last verified block and marks the watcher unready.
- Current gas/storage costs, native NEAR reserve and USDC registration/balance.
- Retained NEAR and USDC payments must match their replay claims. A missing or
  mismatched claim fails both readiness checks and stops the writer from
  starting with that ledger. Claims for pruned quotes remain valid.
- Enforced [NEAR refund funding](near-refund-funding.md), its fresh health and
  separate NEAR/USDC quote capacity. Fee calculations include the protocol's
  gas purchase floor and complete action costs; paid/running work retains fees
  before its refund outbox entry exists. These add two per-asset probes.
- Balances after customer/creator liabilities and accepted Market work; Market
  revenue is not treated as spendable before settlement. A $2 provider-funding
  buffer and 0.05 NEAR native reserve are checked in addition to recorded debts.
- Stuck paid runs, missing refund/payout intents, pending/permanently failed
  refunds, creator payouts and Market work requiring an operator.
  Nano settlement alerts use the age of the debt and the persisted failed
  attempt count. A restored debt without a creation time starts aging from
  the time it is loaded.
- Fresh private runtime funding telemetry, enforced spend/transfer protection,
  and active scopes older than the configured execution limit plus 15 minutes
  for payment reconciliation. See [hosted deadlines](hosted-execution.md).
- Live exchange-rate freshness, authenticated Market token validity and worker
  liveness. The fee probe uses the worker's 5% ceiling and reports an
  unavailable fee separately from a fee above the ceiling. Listing price and
  Nano funding checks still run at the 5% allowance in either case.
- Active Market assignments have a delivery-window check. It warns when
  delivery is due within ten minutes or the last quarter of a shorter SLA,
  a worker's retry would miss its cutoff, or model work has reached its
  execution cutoff. The report identifies the listing and the fixed outcome.
- For Market jobs waiting to run, the monitor prices the current brief locally
  and checks whether the model cost plus 20% still fits the accepted budget
  and net escrow. It reports unpriceable or underfunded jobs by listing,
  without including buyer text or changing readiness for other jobs. The scan
  reports incomplete coverage when a listing has more than 20 pending jobs.
- Catalog pricing and Market net-price coverage for all four predefined graphs.
  The free MCP check prices a custom two-step graph separately in NEAR and USDC
  against one fresh provider estimate, so a preview failure identifies the
  affected currency.
- Free pricing for the five saved workflows shown on both sites, the paid 3D
  template, and up to eight more fixed-deposit workflows discovered on the Nano
  site. It checks NEAR/USDC denomination and compares advertised Nano deposits
  with the current estimated charge for the published graphs. It reports
  partial coverage if more than eight additional tools are listed. These
  warnings preserve admission for other workflows. Before running a paid saved
  workflow on its Nano wallet, the server also checks the known model estimate
  for the actual inputs against the quote's wallet budget, with any creator
  payout allowance held separately.
- When provider payments use the shared Nano wallet, the monitor checks whether
  that wallet can reserve the saved workflows' advertised Nano, NEAR and USDC
  deposits, the custom sample, the tested Market listing budgets, and enabled
  Market bid ceilings. It uses the sampled Nano rate for the fixed Nano deposits.
  It compares the same run budget against live unreserved funds and the
  independently confirmed balance after obligations. It also checks the
  combined budgets of paid Nano, NEAR and USDC runs still waiting to start,
  using each quote's locked rate. Accepted Market jobs waiting to start are
  included at the sampled Nano rate. If fresh pricing raises a waiting job's
  cost within its escrow, the monitor rechecks the combined queue at that
  higher cost. Running jobs already affect the runtime balance through
  reservations. A creator run includes overhead
  from the largest possible deposit with quote dust. These are per-workflow
  warnings. Quote admission uses the latest healthy funding sample to compare
  the requested workflow's locked Nano budget against wallet funds after
  existing obligations and active reservations. NEAR and USDC quotes include
  the creator payout allowance for the exact displayed payment where applicable.
  Unpaid quotes leave the balance available to existing work. The runtime
  rechecks funding when every run starts.
- NEAR and USDC share an open-quote limit. The check warns at 80% and
  reports both quote lanes unavailable at the limit. The saved-workflow probes
  also check capacity for their current exact payment amounts. Expired quotes
  still hold an amount during the late-refund window. A full amount range
  affects only workloads at that price and denomination.
- Disk/inode headroom and a write/fsync probe; disabled/overdue check timers and
  failed scheduled services, including the paid canary and alert-queue retry.
- The ordinary Nano fallbacks must serve confirmed receivables and continuous
  raw history at the newest confirmed wallet head seen during the probe.
  Each history request uses the head from that node's account read. Raw history
  includes representative changes and epoch blocks. The hosted watcher rejects
  a gap, wrong account, or truncated page before committing coverage. Its
  completed cursor stays on a block that the older, filtered history can find.
- When a quote is waiting and completed Nano coverage is stale, the readiness
  check reports whether a verified backfill cursor advanced in the last two
  minutes. It reports `nano-history-backfill-in-progress` for recent progress
  and `nano-history-backfill-stalled` for an older cursor. Both report Nano
  as unready until completed coverage catches up. The monitor reads this
  evidence from the ledger without spending standby RPC quota.

Install `ops/nanoodle-operational-check.{service,timer}`, reload systemd, start
the service once, inspect its report, then enable the timer. It runs at every
five-minute UTC boundary with a catch-up after downtime. Its four-minute unit
deadline bounds the entire probe. The app needs to be running before the check
can succeed. The unit grants write access only to its report directory and the
output directory needed by the unique persistence probe.

```sh
systemctl start nanoodle-operational-check.service
cat /var/lib/nanoodle-operational-check/latest.json
systemctl enable --now nanoodle-operational-check.timer
TZ=UTC systemctl list-timers nanoodle-operational-check.timer
```

The report contains fixed stage/error codes, timestamps and readiness booleans;
no prompts, assignment bodies, account secrets, raw upstream errors or private
URLs. Its directory is 0755 and `latest.json` is 0644 so the separate Babel alert
user can read this selected report without gaining access to the app's keys.
The report's `admission` fields are readiness observations; this monitor does
not itself enforce per-run reservations or alter the payment gates.

The app retains its most recent shared-wallet funding pause for 15 minutes
after recovery. The readiness probe includes the last failed sample, the
recovery time, and an allowlisted reason when it confirms funding is healthy.
This catches pauses between probes while preserving the current admission
status. The existing alert retry timer queues one recovery notice per observed
pause for Ember, even when the readiness probe succeeds.

Failures use the existing sender/outbox/Ember route. An unchanged incident has
one message ID across timer invocations, with a new reminder after six hours;
recovery followed by another failure is a new incident. Hook delivery retries
remain separate from probe execution. Test the real hook without an outage:

```sh
systemd-run --unit=nanoodle-operational-check-alert-test \
  --property=OnFailure=nanoodle-near-alert@nanoodle-operational-check-alert-test.service.service \
  /usr/bin/false
```

Read the broader [reliability audit](operational-reliability.md) for remaining
runtime prevention and full-host recovery requirements.

Protocol references: [Nano confirmed account fields](https://docs.nano.org/commands/rpc-protocol/#account_info),
[NEAR gas prices](https://docs.near.org/api/rpc/gas) and
[NEAR storage/transaction configuration](https://docs.near.org/api/rpc/protocol).

## Public availability from outside production

The [public availability workflow](../.github/workflows/public-check.yml) runs
on a GitHub-hosted runner every 15 minutes. It checks MCP discovery on the Nano
and both NEAR hostnames, Nano rate freshness, the NEAR watcher and refund funding,
the Babel authentication challenge, and NEAR AI Market's public site, API and
Nanoodle listings. The free `price_noodle` probes check that the decision model
and both branches are priced in NEAR and USDC, and the estimated charge fits
the deposit. The hosted runner also checks rendered preview images on the Nano
hub and NEAR demo. It checks image headers and reads one byte from each audio
or video sample to verify that the player can load a byte range. All probes
use bounded retries and record only check results.
The hosted workflow runs both checks with Node and can still probe Market
during an npm outage. The archival NEAR checks read a published historical
transaction and its block, then check for a known receipt in its account
changes and resolve that receipt to the original transaction and signer.
Each check records both archive results and fails when neither peer can
verify it.
The probes use public discovery, status, pricing and historical reads.
[FastNEAR public transaction fixture](https://docs.fastnear.com/rpc/transaction/tx)

Review the run summary under [public availability in GitHub Actions](https://github.com/nanoodlecom/nanoodle-mcp/actions/workflows/public-check.yml)
or use **Run workflow** to check from a separate network. GitHub routes scheduled
failure notifications to the account that last changed the schedule, according
to its notification settings. Scheduled runs may be delayed or skipped. The
VPS monitors still check wallet balances, agreement between nodes and private
payment state. They send their alerts to Ember through Babel. A whole VPS
outage can interrupt that route, while GitHub can still record the public
failure. [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

The same public probes can also run on Cloudflare as the
`nanoodle-public-availability` Worker. Its configuration in
`ops/cloudflare-public-check.jsonc` schedules the checks every 15 minutes and
exposes no HTTP route. The Worker logs a count and fixed failure codes, and a
failed probe marks the scheduled event failed. Check the Worker's logs or Cron
Events in the Cloudflare dashboard for execution evidence. This deployment has
no notification integration. [Cloudflare Cron Events](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events)

Run the Worker against the production public URLs from the local Workers runtime
before deploying.

```sh
npx wrangler@4.164.0 dev --local --test-scheduled --config ops/cloudflare-public-check.jsonc
curl -fsS 'http://127.0.0.1:8787/cdn-cgi/local/scheduled?format=json'
npx wrangler@4.164.0 deploy --config ops/cloudflare-public-check.jsonc
npx wrangler@4.164.0 tail nanoodle-public-availability --format json
```
