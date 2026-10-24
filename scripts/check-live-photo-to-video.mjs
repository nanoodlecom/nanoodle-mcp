#!/usr/bin/env node
/**
 * Post-deploy check for the live photo-to-video graph.
 *
 * The served graph's video node (type ivideo) must be
 * minimax-h3-singularity/image-to-video at 480p for 5 seconds
 * (fields.resolution "480p", fields.duration "5"). Any other model,
 * including minimax-h3/image-to-video-spicy, fails. Comment text is
 * ignored — the curated note still says "Spicy".
 *
 * A failing run exits non-zero so the deploy job goes red. It does not
 * roll the box back. The SSH deploy step has already finished.
 *
 *   node scripts/check-live-photo-to-video.mjs
 */
import { pathToFileURL } from "node:url";

export const LIVE_GRAPH_URL = "https://mcp.nanoodle.com/graph/photo-to-video.json";
export const EXPECTED_MODEL = "minimax-h3-singularity/image-to-video";
export const EXPECTED_RESOLUTION = "480p";
/** Graph field `duration`. The string "5" is five seconds. */
export const EXPECTED_DURATION = "5";

const ATTEMPTS = 5;
const PAUSE_MS = 3000;

/**
 * Judge one graph object. Returns the video node's model, resolution, and
 * duration when they match. Throws a message naming what was wrong.
 * @param {object} graph
 * @returns {{ model: string, resolution: string, duration: string }}
 */
export function checkPhotoToVideoGraph(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : null;
  if (!nodes) throw new Error("photo-to-video graph has no nodes array");
  const videos = nodes.filter((n) => n && n.type === "ivideo");
  if (videos.length === 0) throw new Error("photo-to-video graph has no video node");
  if (videos.length !== 1) {
    throw new Error(`photo-to-video graph has ${videos.length} video nodes; expected 1`);
  }
  const fields = videos[0].fields && typeof videos[0].fields === "object" ? videos[0].fields : {};
  const model = fields.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("photo-to-video video node is missing a model");
  }
  const problems = [];
  if (model !== EXPECTED_MODEL) {
    problems.push(`model ${model} (expected ${EXPECTED_MODEL})`);
  }
  if (fields.resolution !== EXPECTED_RESOLUTION) {
    const got = fields.resolution === undefined ? "(missing)" : JSON.stringify(fields.resolution);
    problems.push(`resolution ${got} (expected ${EXPECTED_RESOLUTION})`);
  }
  if (fields.duration !== EXPECTED_DURATION) {
    const got = fields.duration === undefined ? "(missing)" : JSON.stringify(fields.duration);
    problems.push(`duration ${got} (expected "${EXPECTED_DURATION}", 5 seconds)`);
  }
  if (problems.length) throw new Error(`photo-to-video video node: ${problems.join("; ")}`);
  return { model, resolution: fields.resolution, duration: fields.duration };
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let last = "photo-to-video check did not run";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const url = `${LIVE_GRAPH_URL}?deploy-check=${attempt}`;
    try {
      const res = await fetch(url, {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
      const graph = await res.json();
      const got = checkPhotoToVideoGraph(graph);
      console.log(`photo-to-video video node: ${got.model} ${got.resolution} duration ${got.duration} (5 seconds)`);
      return;
    } catch (err) {
      last = err && err.message ? err.message : String(err);
      console.error(`attempt ${attempt}: ${last}`);
      if (attempt < ATTEMPTS) await pause(PAUSE_MS);
    }
  }
  console.error(last);
  console.error("check failed the job; it does not roll the deploy back");
  process.exit(1);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) await main();
