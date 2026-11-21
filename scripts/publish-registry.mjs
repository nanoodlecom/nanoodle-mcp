#!/usr/bin/env node
/**
 * One-command MCP Registry publish — with the brakes on.
 *
 *   npm run publish:registry            # dry run: preflight + print the steps
 *   npm run publish:registry -- --execute   # actually publish (a human's call)
 *
 * Why a wrapper when .github/workflows/publish-mcp-registry.yml exists?
 * The workflow is the normal path (Trusted Publishing on merge). This script
 * is the manual path for a local retry or a first publish from a maintainer
 * machine, and it encodes the two rules that bite:
 *
 *   1. ORDER: npm first, registry second. The registry reads `mcpName` off
 *      registry.npmjs.org/<name>/<version>; a version npm has never seen
 *      404s and the publish is refused. scripts/assert-npm-version.mjs is
 *      the preflight and it runs here BEFORE any login round trip.
 *   2. OWNERSHIP: the `io.github.nanoodlecom/*` namespace is proven by GitHub
 *      OAuth — `mcp-publisher login github` opens a browser device flow and
 *      the GitHub account must have access to the nanoodlecom org repo.
 *      (The vanity `com.nanoodle/*` namespace would need DNS/HTTP domain
 *      proof instead; see PUBLISHING.md §2. Not used here.)
 *
 * Default is dry-run on purpose: publishing is an external submission and
 * stays a deliberate human decision. --execute shells out to the official
 * mcp-publisher CLI (install: https://github.com/modelcontextprotocol/registry
 * — the publish workflow pins v1.8.9).
 *
 * After a successful publish the registry entry cascades: Smithery, PulseMCP
 * and Glama ingest the official registry, so this one publish refreshes them
 * all. Verify afterwards at:
 *   https://registry.modelcontextprotocol.io/v0/servers?search=nanoodle
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServerJson } from "./assert-npm-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");

const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

console.log(`MCP Registry publish — ${server.name}@${server.version}`);
console.log("─".repeat(60));

// Preflight 1 (offline): identity bundle must be in sync with server.json.
const identity = spawnSync("node", [join(root, "scripts/build-identity.mjs"), "--check"], {
  stdio: "inherit",
});
if (identity.status !== 0) {
  console.error("FAIL  identity bundle drifted from server.json — run: npm run build:identity");
  process.exit(1);
}

// Preflight 2 (network): server.json's version must already exist on npm.
try {
  for (const line of await checkServerJson(server)) console.log(`ok  ${line}`);
} catch (err) {
  console.error(`FAIL  ${err.message}`);
  process.exit(1);
}

const steps = [
  ["mcp-publisher", ["login", "github"], "prove io.github.* ownership via GitHub OAuth"],
  ["mcp-publisher", ["publish"], "submit server.json to registry.modelcontextprotocol.io"],
];

if (!execute) {
  console.log("\nDRY RUN — nothing was published. The publish would run:");
  for (const [cmd, args, why] of steps) console.log(`  ${cmd} ${args.join(" ")}   # ${why}`);
  console.log("\nTo publish for real:  npm run publish:registry -- --execute");
  process.exit(0);
}

for (const [cmd, args] of steps) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const run = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (run.error?.code === "ENOENT") {
    console.error(
      "FAIL  mcp-publisher is not installed. Get it from https://github.com/modelcontextprotocol/registry/releases (the publish workflow pins v1.8.9).",
    );
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error(`FAIL  ${cmd} ${args.join(" ")} exited ${run.status}`);
    process.exit(run.status ?? 1);
  }
}
console.log(
  "\nPublished. Verify: https://registry.modelcontextprotocol.io/v0/servers?search=nanoodle",
);
