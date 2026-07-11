# Publishing checklist

Release order matters — the MCP registry validates that the npm package
already exists and that its `package.json` proves ownership of the registry
name.

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
