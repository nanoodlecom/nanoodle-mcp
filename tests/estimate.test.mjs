/**
 * Guard for the VENDORED cost estimator (src/estimate.mjs, a copy of nanoodle's
 * estimateGraphCost). Canonical coverage lives in nanoodle-js; this is a thin
 * smoke test so an accidental edit to the local copy is caught here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateGraphCost, graphModelKinds } from "../src/estimate.mjs";

const catalogs = {
  chat: [{ id: "glm-5.2", pricing: { prompt: 0.5, completion: 1.5 } }],
  image: [{ id: "flux", pricing: { per_image: { square: 0.02, square_hd: 0.04 } }, supported_parameters: { max_output_images: 4 } }],
  video: [{ id: "vid", pricing: { per_second_by_resolution: { "720p": 0.05 }, default_resolution: "720p", default_duration: 5 } }],
};
const g = (...nodes) => ({ nodes, links: [] });

test("vendored: image is exact and respects the variations clamp", () => {
  const r = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux", size: "square_hd", variations: 99 } }), catalogs);
  assert.equal(r.usd, 0.16);  // 0.04 × min(99, max_output_images=4)
  assert.equal(r.exact, true);
});

test("vendored: video prices per-second × duration and is inexact", () => {
  const r = estimateGraphCost(g({ id: "1", type: "tvideo", fields: { model: "vid", resolution: "720p", duration: 8 } }), catalogs);
  assert.equal(Math.round(r.usd * 100) / 100, 0.4);
  assert.equal(r.exact, false);
});

test("vendored: uncatalogued billable node counts as a lower bound, not $0", () => {
  const r = estimateGraphCost(g(
    { id: "1", type: "image", fields: { model: "flux", size: "square", variations: 1 } },
    { id: "2", type: "tvideo", fields: { model: "gone" } },
  ), catalogs);
  assert.equal(r.usd, 0.02);
  assert.equal(r.priced, 1);
  assert.equal(r.unpriced, 1);
});

test("vendored: empty catalogs never throw", () => {
  const r = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux" } }), {});
  assert.equal(r.priced, 0);
  assert.equal(r.unpriced, 1);
});

test("vendored: graphModelKinds reports only the kinds present", () => {
  assert.deepEqual([...graphModelKinds(g(
    { id: "1", type: "image", fields: {} },
    { id: "2", type: "llm", fields: {} },
    { id: "3", type: "text", fields: {} },   // local → no kind
  ))].sort(), ["chat", "image"]);
});
