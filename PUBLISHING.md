# Publishing Nanoodle MCP

Merges to `main` run the offline suite, then build and install the npm tarball
in a clean directory. The bundle includes the pinned Nanoodle engine. The workflow
publishes through Trusted Publishing on version-changing main pushes or an
explicit main dispatch. It then registers that same npm version in the official
MCP Registry. Each publishing job skips an already registered version.

## Prepare a release

Bump the version in `package.json`, `server.json`, and the npm package entry in
`server.json`. Run `npm install` to update the lockfile and `npm test` to check the
release manifests. Open a release PR with those changes.

The Registry reads the exact npm version and uses its `mcpName` to verify that
the package belongs to `io.github.nanoodlecom/nanoodle-mcp`. The workflow verifies
npm before submitting the Registry entry.

**Offline — `npm test`.** `tests/manifest-versions.test.mjs` fails when the
three version fields disagree, or when `package-lock.json` still records the old
version or the old dependency set. Run `npm install` after the bump so the
lockfile follows.

The npm package carries the server (`src/`, `bin/`) and assets. Run the
simulations, testnet scripts, chain checker and Agent Market worker CLI from a
clone.

## Set up publishing

In the existing npm package settings, add the GitHub Trusted Publisher for
`nanoodlecom/nanoodle-mcp`, workflow `test.yml`, and environment `npm`. Enable
direct `npm publish`. The GitHub `npm` environment accepts the `main` branch.

For the first release with the re-pinned executor, run
`npm view nanoodle@0.13.1 dist.integrity` and compare the result with the public
SDK archive integrity in [vendor/README.md](vendor/README.md). To publish the
already-declared `nanoodle-mcp@0.7.0`, dispatch the `test` workflow on `main`
with version `0.7.0` after enabling the npm Trusted Publisher.

If npm succeeded and Registry publishing needs a retry, rerun the failed jobs
or dispatch `publish-mcp-registry` on `main` with the already published version.
To verify the exact npm version independently, run
`node scripts/assert-npm-version.mjs`.

A manual local publish (dry run by default) wraps the same preflight plus the
`mcp-publisher` steps in one command: `npm run publish:registry` — see
[docs/agent-identity.md](docs/agent-identity.md) for the full identity/refresh
picture, including the A2A agent card and ERC-8004 registration generated from
`server.json`.

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
