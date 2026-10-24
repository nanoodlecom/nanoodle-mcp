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
/** Covers the request and reading the body. Tests pass a shorter timeoutMs. */
export const FETCH_TIMEOUT_MS = 20_000;

const ATTEMPTS = 5;
const PAUSE_MS = 3000;

function timeoutError(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

/**
 * AbortSignal.timeout() uses an unref'd timer, so a fetch that never settles
 * lets the process exit before the deadline. A ref'd timer on an AbortController
 * keeps the deadline alive through the request and the body read.
 */
function startTimeout(timeoutMs) {
  const controller = new AbortController();
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  const timer = setTimeout(() => controller.abort(err), timeoutMs);
  timer.ref();
  return {
    signal: controller.signal,
    done() { clearTimeout(timer); },
  };
}

/** Reject when `signal` aborts, including when `promise` never settles. */
function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(timeoutError(signal));
  return new Promise((resolve, reject) => {
    const fail = () => reject(timeoutError(signal));
    signal.addEventListener("abort", fail, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", fail);
        if (signal.aborted) fail();
        else resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", fail);
        reject(err);
      },
    );
  });
}

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

/**
 * Fetch one graph. One AbortSignal stays active through the request and
 * res.text(), so a hung connection and a hung body both fail at timeoutMs.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function fetchLivePhotoToVideoGraph(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const timeout = startTimeout(timeoutMs);
  const { signal } = timeout;
  try {
    const res = await untilAbort(
      Promise.resolve().then(() => fetchImpl(url, {
        headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        signal,
      })),
      signal,
    );
    if (!res || res.ok !== true) throw new Error(`fetch failed: HTTP ${res && res.status != null ? res.status : "no response"}`);
    if (res.body && typeof res.body.cancel === "function") {
      signal.addEventListener("abort", () => {
        res.body.cancel(signal.reason).catch(() => {});
      }, { once: true });
    }
    const text = await untilAbort(Promise.resolve().then(() => res.text()), signal);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("photo-to-video response is not JSON");
    }
  } finally {
    timeout.done();
  }
}

async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let last = "photo-to-video check did not run";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const url = `${LIVE_GRAPH_URL}?deploy-check=${attempt}`;
    try {
      const graph = await fetchLivePhotoToVideoGraph(url);
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
