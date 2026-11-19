# Agent identity: one source of truth, every registry

nanoodle-mcp shows up in agent directories under one identity. This document
is the map: which file feeds which surface, how they stay in sync, and the
exact refresh procedure when something changes.

## The bundle

| File | Surface | Source |
|---|---|---|
| `server.json` | Official MCP Registry (`io.github.nanoodlecom/nanoodle-mcp`) — cascades to Smithery, PulseMCP and Glama, which ingest the official registry | **Source of truth** (hand-edited, with `package.json`) |
| `agent-card.json` | A2A Agent Card — serve at `https://mcp.nanoodle.com/.well-known/agent-card.json` | Generated from `server.json` |
| `agent-registration.json` | ERC-8004 (Ethereum/Base) and Solana 8004 registration file — serve at `https://mcp.nanoodle.com/.well-known/agent-registration.json`, use as the `agentURI` when registering | Generated from `server.json` |

Generation is deterministic and checked: `npm run build:identity` regenerates
the two derived files from `server.json`; `tests/identity.test.mjs` regenerates
them in memory on every `npm test` and fails on drift. Edit `server.json` (or
the extras in `scripts/build-identity.mjs` — skills, payment rails), regenerate,
commit all three files together.

`server.json` itself is validated against the official registry schema
(vendored at `tests/fixtures/mcp-server.schema.json`, checked by
`tests/server-schema.test.mjs`).

## Honesty constraints baked into the bundle

- **A2A:** the card is a discovery document. The hosted server's live wire
  protocol is MCP (streamable HTTP); no A2A task interface is live yet, and
  the card declares that in its `live-transport` capability extension rather
  than claiming one.
- **ERC-8004:** `registrations` is empty — no on-chain registration has been
  made. Registering is a human decision (it costs gas and mints an ERC-721
  identity); when it happens, fill in the returned `{agentId, agentRegistry}`
  pair in `scripts/build-identity.mjs`'s output — via the generator, not by
  hand-editing the JSON.
- **Payment destinations:** the only real identifier in the bundle is the
  NEAR merchant account `nanoodle.near` (live since 2026-11-13). Base and
  Solana USDC payTo values and the Nano payTo are explicit `REPLACE_WITH_*`
  placeholders; a test fails if anything address-shaped appears in their
  place without a deliberate, reviewed change. Base/Solana x402 ingress is
  qualified offline only and stays `status: "pending"` until the durable
  payment-authority work lands.

## Where nanoodle is listed (state verified 2026-11-19)

| Surface | State |
|---|---|
| NEAR Agent Market (market.near.ai) | Live — 4 listings under "Noodle" (image $0.03, song $0.30, clip $0.34, character $0.06); see docs/near-agent-market.md |
| Official MCP Registry | Live but stale — latest entry is 0.6.0 with a pre-NEAR description; repo is at 0.7.0 (see refresh procedure) |
| npm | `nanoodle-mcp` latest = 0.6.0; 0.7.0 not yet published |
| Smithery / PulseMCP / Glama | Inherit the official registry entry — refreshed automatically by a registry publish |
| A2A directories / ERC-8004 explorers (8004scan, 8004.org) | Not yet — needs the card served at the well-known URL, then (for 8004) an on-chain registration |

## Refresh procedure

Version skew is the failure mode this procedure exists to prevent. The
registry **refuses** a version npm has never seen (it reads `mcpName` off the
npm tarball), so the order is fixed:

1. **Bump** `package.json` + `server.json` together (`tests/manifest-versions.test.mjs`
   guards the agreement), `npm install`, `npm test`.
2. **Regenerate identity:** `npm run build:identity`; commit the derived files.
3. **Publish to npm** — normally the Trusted Publishing workflow on merge
   (see PUBLISHING.md). Verify: `node scripts/assert-npm-version.mjs`.
4. **Publish to the registry** — normally `.github/workflows/publish-mcp-registry.yml`;
   manually, the one command is:

   ```bash
   npm run publish:registry -- --execute
   ```

   (Without `--execute` it is a dry run: identity drift check, npm preflight,
   and the exact `mcp-publisher login github` + `mcp-publisher publish` steps
   it would run. Ownership of the `io.github.*` namespace is proven by that
   GitHub OAuth login.)
5. **Verify** the new entry is `isLatest`:
   `https://registry.modelcontextprotocol.io/v0/servers?search=nanoodle`
6. **Serve the identity files** from the hosted server at their well-known
   URLs (deployment step, tracked separately from this repo change).

## Serving the derived files

The hosted server (or the site in front of it) should serve:

- `agent-card.json` → `GET /.well-known/agent-card.json`, `Content-Type: application/json`
- `agent-registration.json` → `GET /.well-known/agent-registration.json`, same type

Both files are static and change only on a release, so any static route or
file read at startup is fine; they must be the checked-in files, not a second
hand-maintained copy.
