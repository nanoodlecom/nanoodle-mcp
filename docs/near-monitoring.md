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
unit and a redacted `latest.json`; notification routing is deployment-specific.

```sh
systemctl status nanoodle-near-check.service
journalctl -u nanoodle-near-check.service --since yesterday
cat /var/lib/nanoodle-near-check/latest.json
```

## Recovery and manual checks

State and signed transaction bytes are saved atomically before broadcasting.
Reruns resume the same payment and graph. They never re-sign an ambiguous or
expired transaction or replace an unfinished quote. A completed day performs
free MCP checks and returns the saved paid result, without another deposit.
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
