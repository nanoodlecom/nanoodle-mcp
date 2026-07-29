#!/usr/bin/env node
/**
 * Registry-publish preflight — NEEDS NETWORK.
 *
 * Publishing this server is two independent steps: `npm publish` puts the
 * tarball on npm, `mcp-publisher publish` points the MCP registry at that
 * tarball. Nothing ties them together, so the registry can be pointed at a
 * version npm has never seen. That is the live state as this is written: the
 * repo says 0.6.0, npm's latest is 0.4.0, and the registry's latest entry is
 * 0.3.0.
 *
 * tests/manifest-versions.test.mjs cannot catch this. It is offline, and every
 * assertion in it compares repo files to each other. It is happy the moment
 * server.json matches package.json, whether or not that version exists on npm.
 *
 * So this script asks npm. Run it in the publish workflow, before
 * `mcp-publisher publish`, and let a failure fail the job.
 *
 *   node scripts/assert-npm-version.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every version npm holds for `name`, plus the current `latest` dist-tag. */
export async function npmVersions(name, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${name.split("/").map(encodeURIComponent).join("/")}`;
  // The abbreviated document is a fraction of the size and carries versions + dist-tags.
  const res = await fetchImpl(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
  if (res.status === 404) return { versions: [], latest: null };
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name} — cannot verify the release, so the publish is not safe to run`);
  const body = await res.json();
  return { versions: Object.keys(body.versions || {}), latest: (body["dist-tags"] || {}).latest || null };
}

/**
 * Throws unless `version` is a real published version of `name`.
 * Pure — pass the npm answer in, so the failure text can be tested offline.
 */
export function assertOnNpm({ name, version, versions, latest }) {
  if (versions.includes(version)) return `${name}@${version} is on npm (latest: ${latest ?? "none"})`;
  const have = versions.length ? versions.join(", ") : "nothing — this name has no published versions";
  throw new Error(
    `${name}@${version} is NOT on npm, so the MCP registry would point at a tarball that does not exist.\n` +
      `  npm has: ${have}\n` +
      `  npm dist-tag latest: ${latest ?? "none"}\n` +
      "\n" +
      "Do this instead, in this order:\n" +
      `  1. npm publish            # from a clean checkout, publishes ${name}@${version}\n` +
      "  2. re-run this workflow   # registry publish, now pointing at a real tarball\n" +
      "\n" +
      "Never run the registry publish first. See PUBLISHING.md.",
  );
}

/** Checks every npm package entry in server.json. Returns the pass lines. */
export async function checkServerJson(server, fetchImpl = fetch) {
  const npmEntries = (server.packages || []).filter((p) => p.registryType === "npm");
  if (!npmEntries.length) throw new Error("server.json has no npm package entry — nothing to verify");
  const lines = [];
  for (const entry of npmEntries) {
    const { versions, latest } = await npmVersions(entry.identifier, fetchImpl);
    lines.push(assertOnNpm({ name: entry.identifier, version: entry.version, versions, latest }));
  }
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  try {
    for (const line of await checkServerJson(server)) console.log(`ok  ${line}`);
    console.log("ok  server.json points at published npm tarballs — safe to publish to the MCP registry");
  } catch (err) {
    console.error(`FAIL  ${err.message}`);
    process.exit(1);
  }
}
