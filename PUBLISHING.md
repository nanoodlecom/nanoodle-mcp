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
2026-07-28: `registry.npmjs.org/nanoodle-mcp/0.6.0` → 404, while
`registry.npmjs.org/nanoodle-mcp` → 200.

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

**Version drift as of 2026-07-28.** This repo says 0.6.0. npm's latest is 0.4.0
and npm has never held a 0.5.0 or a 0.6.0. The registry's current entry is
0.3.0. So neither 0.5.0 nor 0.6.0 was ever published anywhere, and the next
release must run `npm publish` first. The preflight above fails today, on
purpose, until it does.

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
