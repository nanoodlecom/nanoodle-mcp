/**
 * Integration smoke: the `nanoodle` dep (>= 0.7.0) actually exports the cost
 * estimator this server's charge gate depends on. Canonical coverage of the
 * estimator's math lives in nanoodle-js; this just pins the dependency contract
 * so a bad bump can't silently drop the export.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateGraphCost, graphModelKinds } from "nanoodle";

const catalogs = {
  image: [{ id: "flux", pricing: { per_image: { square: 0.02, square_hd: 0.04 } }, supported_parameters: { max_output_images: 4 } }],
  video: [{ id: "vid", pricing: { per_second_by_resolution: { "720p": 0.05 }, default_resolution: "720p", default_duration: 5 } }],
};
const g = (...nodes) => ({ nodes, links: [] });

test("dep exports the estimator functions", () => {
  assert.equal(typeof estimateGraphCost, "function");
  assert.equal(typeof graphModelKinds, "function");
});

test("image is exact and respects the variations clamp", () => {
  const r = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux", size: "square_hd", variations: 99 } }), catalogs);
  assert.equal(r.usd, 0.16);  // 0.04 × min(99, max_output_images=4)
  assert.equal(r.exact, true);
});

test("video prices per-second × duration and is inexact", () => {
  const r = estimateGraphCost(g({ id: "1", type: "tvideo", fields: { model: "vid", resolution: "720p", duration: 8 } }), catalogs);
  assert.equal(Math.round(r.usd * 100) / 100, 0.4);
  assert.equal(r.exact, false);
});

test("uncatalogued billable node counts as a lower bound, not $0", () => {
  const r = estimateGraphCost(g(
    { id: "1", type: "image", fields: { model: "flux", size: "square", variations: 1 } },
    { id: "2", type: "tvideo", fields: { model: "gone" } },
  ), catalogs);
  assert.equal(r.usd, 0.02);
  assert.equal(r.priced, 1);
  assert.equal(r.unpriced, 1);
});

test("graphModelKinds reports only the kinds present", () => {
  assert.deepEqual([...graphModelKinds(g(
    { id: "1", type: "image", fields: {} },
    { id: "2", type: "llm", fields: {} },
    { id: "3", type: "text", fields: {} },   // local → no kind
  ))].sort(), ["chat", "image"]);
});
