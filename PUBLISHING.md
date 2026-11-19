# Publishing Nanoodle MCP

Merges to `main` run the offline suite, then build and install the npm tarball
in a clean directory. The bundle includes the pinned Nanoodle engine. The workflow
publishes a new npm version through Trusted Publishing, then registers the same
version in the official MCP Registry. It skips versions that already exist.

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
SDK archive integrity in [vendor/README.md](vendor/README.md) before merging.
The first eligible merge can publish the already-declared `nanoodle-mcp@0.7.0`.

If npm succeeded and Registry publishing needs a retry, rerun the failed jobs
or dispatch `publish-mcp-registry` on `main`. To verify the exact npm version
independently, run `node scripts/assert-npm-version.mjs`.

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
