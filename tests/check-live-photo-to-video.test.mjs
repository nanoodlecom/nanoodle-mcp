/**
 * The live photo-to-video check must require one exact video node, not merely
 * reject the word "spicy". Offline: these tests call checkPhotoToVideoGraph
 * with graph objects. The workflow runs the script against mcp.nanoodle.com
 * after deploy; a failure there fails the job and does not roll anything back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FETCH_TIMEOUT_MS,
  checkPhotoToVideoGraph,
  fetchLivePhotoToVideoGraph,
} from "../scripts/check-live-photo-to-video.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const MODEL = "minimax-h3-singularity/image-to-video";
const SPICY = "minimax-h3/image-to-video-spicy";

function graph(videoFields) {
  return {
    nodes: [
      { id: "c-intent", type: "comment", fields: { text: "animate with MiniMax H3 Spicy at 480p" } },
      { id: "n2", type: "image", fields: { model: "meta/muse-image/text-to-image", size: "16:9" } },
      { id: "n3", type: "ivideo", name: "Animated clip", fields: videoFields },
    ],
  };
}

const passingFields = { model: MODEL, resolution: "480p", duration: "5", prompt: "" };

test("a passing graph is minimax-h3-singularity/image-to-video at 480p for 5 seconds", () => {
  const got = checkPhotoToVideoGraph(graph(passingFields));
  assert.deepEqual(got, { model: MODEL, resolution: "480p", duration: "5" });
});

test("a missing model fails", () => {
  const rest = { ...passingFields };
  delete rest.model;
  assert.throws(() => checkPhotoToVideoGraph(graph(rest)), /missing a model/);
  assert.throws(() => checkPhotoToVideoGraph(graph({ ...rest, model: "" })), /missing a model/);
});

test("a wrong model fails, including the spicy model", () => {
  assert.throws(
    () => checkPhotoToVideoGraph(graph({ ...passingFields, model: SPICY })),
    (err) => {
      assert.match(err.message, /minimax-h3\/image-to-video-spicy/);
      assert.match(err.message, /expected minimax-h3-singularity\/image-to-video/);
      return true;
    },
  );
  // A non-spicy wrong model must fail too. Rejecting the substring "spicy" is not the check.
  assert.throws(
    () => checkPhotoToVideoGraph(graph({ ...passingFields, model: "minimax-h3/image-to-video" })),
    /model minimax-h3\/image-to-video \(expected minimax-h3-singularity\/image-to-video\)/,
  );
});

test("a wrong resolution or duration fails", () => {
  assert.throws(
    () => checkPhotoToVideoGraph(graph({ ...passingFields, resolution: "720p" })),
    /resolution "720p" \(expected 480p\)/,
  );
  assert.throws(
    () => checkPhotoToVideoGraph(graph({ ...passingFields, duration: "10" })),
    /duration "10" \(expected "5", 5 seconds\)/,
  );
});

test("the live fetch times out after 20s", () => {
  assert.equal(FETCH_TIMEOUT_MS, 20_000);
});

async function assertTimesOut(run, timeoutMs) {
  const started = Date.now();
  await assert.rejects(run(), (err) => {
    assert.equal(err.name, "TimeoutError");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < timeoutMs + 1000, `took ${elapsed}ms; timeout was ${timeoutMs}ms`);
}

test("a hanging request fails within the timeout", { timeout: 2000 }, async () => {
  const timeoutMs = 40;
  await assertTimesOut(
    () => fetchLivePhotoToVideoGraph("https://mcp.nanoodle.com/graph/photo-to-video.json", {
      timeoutMs,
      fetchImpl: () => new Promise(() => {}),
    }),
    timeoutMs,
  );
});

test("a hanging body fails within the timeout", { timeout: 2000 }, async () => {
  const timeoutMs = 40;
  await assertTimesOut(
    () => fetchLivePhotoToVideoGraph("https://mcp.nanoodle.com/graph/photo-to-video.json", {
      timeoutMs,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: () => new Promise(() => {}),
      }),
    }),
    timeoutMs,
  );
});

test("the deploy workflow runs this script after the ssh deploy", () => {
  const wf = readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8");
  const ssh = wf.indexOf('ssh -i ~/.ssh/deploy_key -o UserKnownHostsFile=~/.ssh/known_hosts root@159.195.17.119 "nanoodle-mcp"');
  const check = wf.indexOf("node scripts/check-live-photo-to-video.mjs");
  assert.notEqual(ssh, -1, "deploy.yml must keep the ssh deploy step");
  assert.ok(check > ssh, "the photo-to-video check must run after the ssh deploy");
  assert.match(wf, /types: \[awesome-noodles-updated\]/);
  assert.match(wf, /cancel-in-progress: false/);
  assert.doesNotMatch(wf, /image-to-video-spicy/);
});
