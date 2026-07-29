/**
 * Release-manifest guards — INTERNAL CONSISTENCY ONLY, fully offline.
 *
 * A release restates this server's version in several files, and they drift.
 * package.json said 0.6.0 while server.json still said 0.5.0 in both of its
 * version fields. These tests make that particular drift impossible to commit.
 *
 * Know the limit. Every assertion below compares repo files to each other.
 * Nothing here talks to npm, so all of it passes the moment server.json matches
 * package.json — including when that version was never published. On
 * 2026-07-28 this repo says 0.6.0, npm's latest is 0.4.0, npm has never held a
 * 0.5.0 or a 0.6.0, and the registry's entry is 0.3.0. Every test in this file
 * passes on that state.
 *
 * The check that catches THAT is scripts/assert-npm-version.mjs. It needs the
 * network, so it runs in .github/workflows/publish-mcp-registry.yml before
 * `mcp-publisher publish`, not in `npm test`. Both guards are required; neither
 * one is sufficient.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const pkg = readJson("package.json");
const server = readJson("server.json");
const lock = readJson("package-lock.json");
const plugin = readJson(".claude-plugin/plugin.json");
const market = readJson(".claude-plugin/marketplace.json");

test("server.json version matches package.json", () => {
  assert.equal(
    server.version,
    pkg.version,
    `server.json .version is ${server.version} but package.json is ${pkg.version} — ` +
      "bump both (see PUBLISHING.md)",
  );
});

test("every server.json package entry matches package.json", () => {
  assert.ok(Array.isArray(server.packages) && server.packages.length, "server.json needs a packages array");
  for (const p of server.packages) {
    assert.equal(
      p.version,
      pkg.version,
      `server.json packages[] entry "${p.identifier}" is ${p.version} but package.json is ${pkg.version}`,
    );
  }
});

test("server.json names the npm package this repo publishes", () => {
  const npmEntry = server.packages.find((p) => p.registryType === "npm");
  assert.ok(npmEntry, "server.json needs an npm package entry");
  assert.equal(npmEntry.identifier, pkg.name);
  // The registry rejects a publish whose npm tarball mcpName differs from server.json name.
  assert.equal(pkg.mcpName, server.name);
});

test("package-lock.json records this package's own version", () => {
  // A lockfile left at the previous version means `npm ci` builds the old tree.
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("package-lock.json root deps match package.json deps", () => {
  assert.deepEqual(lock.packages[""].dependencies || {}, pkg.dependencies || {});
});

test("plugin.json and marketplace.json agree on the plugin version", () => {
  // The plugin version is deliberately independent of the npm version (it tracks
  // plugin behavior), but the two manifests that declare it must agree — Claude
  // Code only offers an update when that string changes.
  const listed = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(listed, `marketplace.json has no plugin named "${plugin.name}"`);
  assert.equal(listed.version, plugin.version);
});
