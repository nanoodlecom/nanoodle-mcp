# Nanoodle on ASI Agentverse (uAgent facade)

An **optional, inactive-by-default** Python sidecar that puts Nanoodle on
[Agentverse](https://agentverse.ai) / ASI:One: a uAgent speaking the
**Agent Chat Protocol** (0.3.0) that runs Nanoodle workflows in chat by
calling a nanoodle-mcp HTTP endpoint (`tools/call`), and returns the
result text plus media links.

This is the SingularityNET/ASI-ecosystem route judged viable in the
marketplace-expansion research (2026-11-19). The native SingularityNET
marketplace route was *not* built: it requires Foundation due diligence,
a signed participation agreement, a PR into the `snet-dapp` React app,
and a heavy snet-daemon + ETCD + Ethereum hosting stack, with no
published traction numbers. Agentverse is where ASI discovery actually
happens today.

Nothing here is live. The agent refuses to start until an operator sets
`NANOODLE_AGENTVERSE_ENABLED=1` and provides a seed via the environment,
and **registration is a separate, deliberate operator step** — see
[RUNBOOK.md](RUNBOOK.md). No wallet is created, no FET is moved, and no
agent is registered by this code, its tests, or its tooling's dry run.

## How it works

```
ASI:One / Agentverse user ──ChatMessage──► uAgent (this sidecar)
                                              │ ack immediately
                                              │ dedup (sender, msg_id)
                                              ▼
                                   nanoodle-mcp HTTP endpoint
                                   (hosted mcp.nanoodle.com/mcp
                                    or a self-hosted --serve)
                                              │
                        ┌─────────────────────┴─────────────────────┐
                        │ endpoint executes (operator-funded)     │ endpoint quotes payment
                        ▼                                           ▼
                   result + media links                  payment deep link (payUrl)
                                                         user pays on Nanoodle's rails,
                                                         replies `paid <payment_id>`,
                                                         agent re-calls with _payment_id
                                                         and returns the results stream
```

Message handling: the handler acknowledges every `ChatMessage` first
(mailbox redelivery is the duplicate case), concatenates `TextContent`
blocks, and answers with a `ChatMessage` ending the session. Runs that
outlive a short wait keep going as background jobs — the caller gets a
job id at once, the finished result is pushed when it lands, and
`status <job_id>` works in between. Duplicate deliveries of the same
message return the cached reply and **never re-run a workflow** (a re-run
would spend money twice).

### Free vs paid — plainly

Agentverse has **no native per-call settlement for external agents**.
This facade invents none:

- **Free previews.** Workflows listed in
  `NANOODLE_AGENTVERSE_FREE_WORKFLOWS` run free *only* when the MCP
  endpoint executes them without a payment quote — i.e. an
  operator-funded BYOK / free-serve endpoint, where the operator is
  paying the model costs. On the hosted pay-per-call endpoint the same
  workflow still returns a payment link, and the reply says so.
- **Full runs.** Anything the endpoint quotes comes back as a payment
  deep link to Nanoodle's existing rails (Nano / NEAR / x402, via the
  endpoint's own quote). The price model is the endpoint's: metered
  model cost + 20%, deposit overage refunded, failed runs refunded.
  This agent holds no wallet and cannot pay on anyone's behalf.

### What users can send

`help`, `list`, `run <workflow>: <input>`,
`run <workflow> {"Input": "value"}`, a nanoodle.com share link
(optionally followed by JSON inputs or `with <input>`),
`status <job_id>`, `paid <payment_id>`. See
[profile/README.md](profile/README.md) — the same text is the Agentverse
profile readme, tuned for ASI:One search ranking.

## Honest traction caveat

This is a **discovery experiment**, not a revenue claim. Agentverse's
headline agent count (2.7M registered agents) is a self-reported
registration number; an independent Almanac audit counted roughly 36k
agents, and there is no documented evidence of independent developers
earning meaningful revenue through Agentverse discovery. The success
signal for this integration is Agentverse analytics — impressions,
queries, and chat starts attributable to ASI:One search — reviewed
before any further investment. If the analytics stay at zero, the honest
outcome is to switch the facade off and record that.

## Layout

| Path | What |
|---|---|
| `nanoodle_agentverse/config.py` | Env-only config; seed never logged or repr'd; placeholders rejected |
| `nanoodle_agentverse/parsing.py` | Chat text → commands (framework-free, fully tested) |
| `nanoodle_agentverse/mcp_client.py` | Minimal MCP HTTP client; injectable transport; payment-quote detection (surfaces `payUrl` only, never the agent-only watch URL) |
| `nanoodle_agentverse/service.py` | Dedup/replay cache, job handling, free/paid classification, reply formatting |
| `nanoodle_agentverse/agent.py` | uAgents wiring: chat protocol, mailbox mode, manifest publication, background delivery |
| `register_agent.py` | Registration tooling — dry-run plan + profile payload; `--execute` is the gated operator step |
| `profile/` | Agentverse profile readme + keywords/tags for ASI:One ranking |
| `protocol-manifest.json` | The published AgentChatProtocol manifest (name/version/digest from `uagents_core`) |
| `tests/` | pytest suite with a mocked MCP endpoint — no network, no uAgents runtime needed except the registration-payload test's package import |

## Run the tests

```bash
cd integrations/agentverse
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest tests -q
# Agent wiring check (needs the pinned runtime):
.venv/bin/pip install -r requirements.txt
.venv/bin/python -c "from nanoodle_agentverse.agent import build_agent; print('imports ok')"
```

The repo's Node suite (`npm test` at the repo root) does not touch this
directory; the sidecar is deliberately self-contained.

## Configuration

See [.env.example](.env.example). Highlights: `NANOODLE_MCP_URL`
(default the hosted endpoint), `NANOODLE_AGENTVERSE_WORKFLOWS`
(allowlist; empty = endpoint decides), `NANOODLE_AGENTVERSE_FREE_WORKFLOWS`,
`NANOODLE_AGENTVERSE_PORT` (default 8001), message-size cap (default
8000 chars — oversized messages are rejected before any endpoint call),
per-call timeout (default 180s server-side; callers are handed a job id
after a 10s short wait instead of hanging).
