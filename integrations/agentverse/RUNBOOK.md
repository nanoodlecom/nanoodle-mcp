# Runbook — registering the Nanoodle agent on Agentverse (operator only)

**Status: NOT EXECUTED.** Everything below is the prepared path. The
actual registration is Mikkel's go: it requires an Agentverse account, an
Agentverse API key, and an agent wallet funded with FET. Do not run the
execute step from an automated job.

## What registration involves (from Fetch.ai / Agentverse docs)

- The agent framework is **uAgents** (`uagents==0.25.5`, Python
  3.10–3.13); the chat surface is the **Agent Chat Protocol 0.3.0**
  (`uagents_core.contrib.protocols.chat`), which is what ASI:One speaks.
- An agent's identity derives from its **seed phrase**: same seed, same
  `agent1q…` address, forever. Lose the seed, lose the identity. The seed
  lives only in the operator's secret store and in the
  `NANOODLE_AGENTVERSE_SEED` environment variable — never in this repo.
- **Mailbox mode** (`mailbox=True`) lets a locally run agent receive
  Agentverse/ASI:One messages while offline messages queue in the
  Agentverse mailbox. No public endpoint or port-forward is needed.
- **Almanac registration**: on startup the agent registers on the Almanac
  API and then the Almanac contract (Fetch.ai blockchain), publishing the
  chat protocol manifest (`publish_manifest=True`). Contract registration
  **charges a fee in FET** and registrations expire by block height, so
  the agent wallet needs a small ongoing FET balance; the agent
  re-registers automatically while it runs. Check the current fee in the
  Almanac registration docs before funding — do not trust any number
  written here to stay current.
- **Profile**: name, description, readme, keywords and tags drive
  ASI:One search ranking. Prepared copy lives in `profile/` and is what
  `register_agent.py` assembles.

## Steps

1. **Accounts.** Sign in to [agentverse.ai](https://agentverse.ai) with
   the account that will own the agent; create an Agentverse API key in
   the dashboard. (Optionally create an ASI:One account/key for testing
   from chat.asi1.ai.)
2. **Seed.** Generate a seed phrase offline (e.g. with the uAgents CLI /
   `Identity.generate()` on an air-gapped shell), store it in the secret
   store, and export it as `NANOODLE_AGENTVERSE_SEED`. Never paste it
   into a file in this repo; `.env` is git-ignored but the secret store
   is the right home.
3. **Dry run.** `python register_agent.py` — prints the derived agent
   address, the profile payload keys, and this plan. No network writes,
   no registration, no funds moved.
4. **Fund.** Send a small amount of FET to the derived agent address
   (the dry run prints it) to cover the Almanac registration fee and
   renewals. This is a spend — it happens only on the operator's go.
5. **Execute.** With the seed + `NANOODLE_AGENTVERSE_ENABLED=1` exported:
   `NANOODLE_AGENTVERSE_REGISTER_CONFIRM=REGISTER python register_agent.py --execute`
   — or equivalently run `python -m nanoodle_agentverse.agent`. Watch the
   startup log for `Registration on Almanac API successful`,
   `Manifest published successfully: AgentChatProtocol`, and
   `Successfully registered as mailbox agent in Agentverse`. In the
   Agentverse inspector, Connect → Mailbox if prompted.
6. **Profile.** In the Agentverse dashboard, open the agent profile:
   confirm the name/handle (`@nanoodle` suggested; if taken, use
   `@nanoodle-workflows` and record the choice in the marketplace
   ledger), paste
   `profile/README.md` as the readme, and set the keywords/tags from
   `profile/profile.json`.
7. **Endpoint choice.** Decide which MCP endpoint the live agent calls:
   the hosted pay-per-call endpoint (every full run returns a payment
   link) or a self-hosted `--serve` instance (operator-funded; enables
   real free previews). Set `NANOODLE_MCP_URL` accordingly, plus the
   workflow allowlist / free-preview list.
8. **Verify as a stranger.** From ASI:One Chat, find the agent by
   searching its keywords, send `help`, `list`, one free preview (if
   configured), and one paid run end-to-end (pay the link, reply
   `paid <payment_id>`, receive the result). Confirm Agentverse analytics
   show the impressions/queries.
9. **Review gate.** After 2–4 weeks, read the analytics. Discovery that
   produces no queries is a result too: switch off
   (`NANOODLE_AGENTVERSE_ENABLED=0`) and record the outcome in the
   marketplace ledger rather than letting a zombie agent linger.

## Safety notes

- The agent spends money only through the MCP endpoint it points at:
  operator-funded endpoints spend the operator's NanoGPT balance on every
  executed run. Keep the workflow allowlist tight and free previews
  small.
- Duplicate chat deliveries are deduped for 24h per (sender, message id)
  and never re-run a workflow.
- If the seed is ever suspected leaked: stop the agent, generate a new
  seed (new address), re-register, and update the profile — the old
  identity cannot be rotated in place.
