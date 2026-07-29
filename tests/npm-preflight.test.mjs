/**
 * Unit tests for the registry-publish preflight — fully offline, no network.
 *
 * The preflight itself (scripts/assert-npm-version.mjs) must talk to npm, so it
 * runs in the publish workflow, not here. What IS testable offline is its
 * decision: given npm's answer, does it let the publish through? These tests
 * pin that, and pin the failure text, because the failure text is the whole
 * value of the check — it has to tell the release engineer to publish to npm
 * first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOnNpm, checkServerJson, npmVersions } from "../scripts/assert-npm-version.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A stand-in for npm's abbreviated packument endpoint. */
const fakeNpm = (byName) => async (url) => {
  const name = decodeURIComponent(url.split("/").pop());
  const doc = byName[name];
  if (!doc) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => doc };
};

test("a version npm has published passes", () => {
  const msg = assertOnNpm({ name: "nanoodle-mcp", version: "0.4.0", versions: ["0.3.0", "0.4.0"], latest: "0.4.0" });
  assert.match(msg, /nanoodle-mcp@0\.4\.0 is on npm/);
});

test("a version npm does NOT have fails, and the message says to publish to npm first", () => {
  assert.throws(
    () => assertOnNpm({ name: "nanoodle-mcp", version: "0.6.0", versions: ["0.3.0", "0.4.0"], latest: "0.4.0" }),
    (err) => {
      assert.match(err.message, /nanoodle-mcp@0\.6\.0 is NOT on npm/);
      assert.match(err.message, /npm has: 0\.3\.0, 0\.4\.0/);
      assert.match(err.message, /1\. npm publish/);
      assert.match(err.message, /2\. re-run this workflow/);
      return true;
    },
  );
});

test("a name npm has never seen fails too", () => {
  assert.throws(
    () => assertOnNpm({ name: "nanoodle-mcp", version: "0.6.0", versions: [], latest: null }),
    /has no published versions/,
  );
});

test("checkServerJson verifies every npm entry against npm's answer", async () => {
  const npm = fakeNpm({ "nanoodle-mcp": { versions: { "0.4.0": {} }, "dist-tags": { latest: "0.4.0" } } });
  const ok = { packages: [{ registryType: "npm", identifier: "nanoodle-mcp", version: "0.4.0" }] };
  assert.deepEqual(await checkServerJson(ok, npm), ["nanoodle-mcp@0.4.0 is on npm (latest: 0.4.0)"]);

  const drifted = { packages: [{ registryType: "npm", identifier: "nanoodle-mcp", version: "0.6.0" }] };
  await assert.rejects(() => checkServerJson(drifted, npm), /0\.6\.0 is NOT on npm/);
});

test("a server.json with no npm entry is a failure, not a silent pass", async () => {
  await assert.rejects(() => checkServerJson({ packages: [] }), /no npm package entry/);
});

test("an npm registry outage fails the check instead of waving the publish through", async () => {
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => npmVersions("nanoodle-mcp", down), /answered 503/);
});

test("the publish workflow actually runs the preflight before it publishes", () => {
  // The check only protects anything if the job runs it, and runs it FIRST.
  const wf = readFileSync(join(root, ".github/workflows/publish-mcp-registry.yml"), "utf8");
  const preflight = wf.indexOf("scripts/assert-npm-version.mjs");
  const publish = wf.indexOf("mcp-publisher publish");
  assert.ok(preflight > 0, "publish-mcp-registry.yml must run scripts/assert-npm-version.mjs");
  assert.ok(publish > 0, "publish-mcp-registry.yml must run mcp-publisher publish");
  assert.ok(preflight < publish, "the npm preflight must run BEFORE mcp-publisher publish");
});
