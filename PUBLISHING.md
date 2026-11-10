# Publishing checklist

Release order matters — the MCP registry validates that the npm package
already exists and that its `package.json` proves ownership of the registry
name.

It checks the **exact version**, not just the name. On publish the registry
fetches `https://registry.npmjs.org/<name>/<version>` and reads `mcpName` off
that version's metadata
([`internal/validators/registries/npm.go`](https://github.com/modelcontextprotocol/registry/blob/main/internal/validators/registries/npm.go)).
A version npm has never seen returns 404 and the registry **refuses the entry**
with `publish version 'X' before registering it`. So a wrong-order publish
cannot leave a dangling registry entry — it just fails. Verified on
2026-11-10: `registry.npmjs.org/nanoodle-mcp/0.7.0` → 404 (not published yet),
while `registry.npmjs.org/nanoodle-mcp/0.6.0` → 200.

## 0. Preconditions (do these first)

1. **Repo is public.** The registry entry links here; directories scrape the
   README.
2. **npm publish has landed.** `npm publish` from a clean checkout. The
   published `package.json` must carry the ownership proof (already in this
   repo):

   ```json
   "mcpName": "io.github.nanoodlecom/nanoodle-mcp"
   ```

   The registry rejects the publish if the npm tarball's `mcpName` doesn't
   match `server.json`'s `name`.

## 1. Publish to the official MCP registry

Uses [`mcp-publisher`](https://github.com/modelcontextprotocol/registry)
against `registry.modelcontextprotocol.io`:

```bash
brew install mcp-publisher        # or grab a binary from the registry repo's releases
cd nanoodle-mcp                   # server.json lives at the repo root
mcp-publisher login github        # authorizes the io.github.nanoodlecom/* namespace via org membership
mcp-publisher publish
```

`server.json` is the source of truth for the registry entry. On every release:
bump `version` in **three** places — `package.json`, `server.json` (top-level
`version` AND `packages[0].version`) — then `npm publish`, then
`mcp-publisher publish` again.

Two guards enforce this, and they cover different halves of the problem.

**Offline — `npm test`.** `tests/manifest-versions.test.mjs` fails when the
three version fields disagree, or when `package-lock.json` still records the old
version or the old dependency set. Run `npm install` after the bump so the
lockfile follows. Every assertion in it compares repo files to each other, so it
is happy the moment the files agree — it cannot tell you whether npm has that
version.

**Online — the publish workflow.** `scripts/assert-npm-version.mjs` asks npm
whether `server.json`'s version is really published, and fails the job if it is
not. `.github/workflows/publish-mcp-registry.yml` runs it after the offline
guard and before `mcp-publisher publish`.

This does not rescue you from a broken registry entry; the registry's own
validator already refuses one (above). What it buys is an earlier and plainer
failure: it runs before `mcp-publisher` and before the login round trip, and it
prints the versions npm actually holds plus the 2 commands to run, instead of a
404 from a Go validator. Run it locally any time:

```bash
node scripts/assert-npm-version.mjs
```

**State as of 2026-11-10.** npm's `latest` is 0.6.0 (published 2026-08-13), and
the registry's latest entry is 0.6.0 too. This repo now says **0.7.0**, the
first release with NEAR mode (`--near-merchant`, `run_noodle` with an inline
`graph`, `price_noodle`, `noodle_guide`). 0.7.0 is not on npm and not in the
registry yet, so the preflight above fails today, on purpose, until `npm publish`
lands. Nothing else in the release changes the Nano or BYOK paths.

## 1a. Releasing 0.7.0 (owner actions, in this order)

1. From a clean checkout of the release commit (the `hackathon-submission` tag or
   `main` after it is merged), with Node 22.23.4+, 24.22.1+ or 26.12.1+:

   ```bash
   npm ci && npm test                         # ends with "fail 0"
   npm run simulate:near                      # "PASS: all 35 checks passed"
   npm pack --dry-run                         # src/near/, src/near-gate.mjs, src/custom-workflow.mjs are listed
   ```

2. `npm publish`, then check it landed:

   ```bash
   npm view nanoodle-mcp@0.7.0 version mcpName   # 0.7.0  io.github.nanoodlecom/nanoodle-mcp
   node scripts/assert-npm-version.mjs           # now passes
   ```

3. Registry: run the `publish-mcp-registry` workflow (Actions → publish-mcp-registry →
   Run workflow) on the release commit, or locally `mcp-publisher login github` then
   `mcp-publisher publish`. Then check
   `https://registry.modelcontextprotocol.io/v0/servers?search=nanoodle` lists 0.7.0
   as latest.

4. The Claude Code plugin needs nothing: it runs `npx -y nanoodle-mcp` with a
   NanoGPT key (BYOK), whose behaviour did not change, so its version stays.

Notes for this release:

- The npm package carries the server (`src/`, `bin/`), not `scripts/` or `docs/`:
  the simulations, the testnet scripts, the chain checker and the Agent Market
  worker CLI run from a clone. The README says so.
- `server.json`'s description stays under the registry's 100-character limit
  (it is 99). NEAR payment is an in-band MCP quote paid by a native transfer, not
  x402; do not describe it as x402 anywhere.
- After the release, update the README notes that say "NEAR mode first ships in
  npm version 0.7.0 … run it from a clone" if you want `npx` to be the primary
  route.

## 2. Optional later: the `com.nanoodle/*` namespace

`io.github.nanoodlecom/nanoodle-mcp` works today with plain GitHub auth. If we
ever want the vanity namespace `com.nanoodle/mcp`, that requires domain
verification of nanoodle.com (`mcp-publisher login dns` or `login http` — DNS
TXT record or a well-known HTTP challenge). Not a launch blocker; the GitHub
namespace can stay forever.

## 3. Claude Code plugin — nothing to publish

The plugin marketplace is just this repo (`.claude-plugin/marketplace.json`).
It goes live the moment the repo is public:

```
/plugin marketplace add nanoodlecom/nanoodle-mcp
/plugin install nanoodle@nanoodle
```

Bump `version` in `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` when the plugin's behavior changes — users
only receive plugin updates when that version string changes.
