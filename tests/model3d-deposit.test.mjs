/**
 * idea-to-3d-model went live quoting the flat $0.05 opening deposit while a real
 * run costs about $0.21 (TRELLIS.2 $0.20 + Muse $0.011 + GLM under $0.001), so the
 * operator ate roughly $0.20 per call. The cause: the forecast never loaded the
 * NanoGPT 3D catalog (/api/v1/3d-models), so the TRELLIS.2 node was "unpriced" and
 * the gate fell back to the opening deposit.
 *
 * These tests pin the fix against the real hosted graph fixture and catalog
 * entries trimmed from the public NanoGPT endpoints (2026-10-18). Fully offline
 * against a stub NanoGPT; nothing spends money.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTools, attachEstimates } from "../src/tools.mjs";
import { createChargeGate } from "../src/gate.mjs";

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";

const CATALOGS = {
  "/api/v1/models?detailed=true": [
    { id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3, currency: "USD", unit: "per_million_tokens" } },
  ],
  "/api/v1/image-models": [
    { id: "meta/muse-image/text-to-image", pricing: { per_image: { "1:1": 0.011, auto: 0.011 }, currency: "USD" } },
  ],
  "/api/v1/3d-models": [
    {
      id: "wavespeed-ai/trellis-2/image-to-3d",
      pricing: {
        per_run: 0.2,
        per_run_by_variant: { 512: 0.1, 1024: 0.2, 1536: 0.4, "512+4k-texture": 0.15, "1024+4k-texture": 0.25, "1536+4k-texture": 0.45 },
        default_variant: "1024",
        currency: "USD",
      },
    },
  ],
};

async function startStub({ with3d = true } = {}) {
  const server = http.createServer((req, res) => {
    const data = CATALOGS[req.url];
    if (req.method === "GET" && data && (with3d || req.url !== "/api/v1/3d-models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

async function hostedRegistry(stub) {
  const dir = await mkdtemp(join(tmpdir(), "noodle-3d-dep-"));
  await copyFile(new URL("./fixtures/hosted/idea-to-3d-model.noodle-graph.json", import.meta.url), join(dir, "idea-to-3d-model.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), baseUrl: stub.url, log: () => {} });
  await attachEstimates(registry, { baseUrl: stub.url });
  return { registry, dir };
}

/** The deposit the live gate would quote, read off the decorated tool description. */
function depositUsd(registry) {
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: { rpc: async () => ({ blocks: {}, history: [] }), transfer: async () => "0".repeat(64) },
    usd: 0.05, // the hosted server's flat opening deposit
    xnoUsd: 1.0,
    publicBase: "http://pay.test",
  });
  const tool = gate.wrapRegistry(registry).listTools().find((t) => t.name === "idea-to-3d-model");
  const m = tool.description.match(/\$(\d+(?:\.\d+)?) deposit per call/);
  assert.ok(m, `no deposit in description: ${tool.description}`);
  return Number(m[1]);
}

test("idea-to-3d-model: the forecast prices every node, including TRELLIS.2", async (t) => {
  const stub = await startStub();
  const { registry, dir } = await hostedRegistry(stub);
  t.after(async () => { await stub.close(); await rm(dir, { recursive: true, force: true }); });

  const est = registry.estimates["idea-to-3d-model"];
  assert.ok(est, "a forecast exists");
  assert.equal(est.unpriced, 0, "no billable node is left unpriced (the 3D catalog loaded)");
  assert.equal(est.priced, 3, "llm + image + model3d");
  assert.ok(est.usd >= 0.21 && est.usd < 0.22, `forecast ≈ $0.211, got ${est.usd}`);
});

test("idea-to-3d-model deposit covers its estimated cost + 20% markup", async (t) => {
  const stub = await startStub();
  const { registry, dir } = await hostedRegistry(stub);
  t.after(async () => { await stub.close(); await rm(dir, { recursive: true, force: true }); });

  const est = registry.estimates["idea-to-3d-model"];
  const dep = depositUsd(registry);
  assert.ok(dep >= est.usd * 1.2, `deposit $${dep} must cover forecast $${est.usd.toFixed(4)} + 20%`);
  // and the recorded real run (2026-10-12, awesome-noodles#91: $0.21) + 20%
  assert.ok(dep >= 0.21 * 1.2, `deposit $${dep} must cover the observed $0.21 run + 20%`);
  assert.equal(dep, 0.51); // ceil(0.2111 × 1.2 × 2) — model3d variants differ, so the variance multiplier applies
});

test("control: without the 3D catalog the tool falls back to the $0.05 opening deposit (the live bug)", async (t) => {
  const stub = await startStub({ with3d: false });
  const { registry, dir } = await hostedRegistry(stub);
  t.after(async () => { await stub.close(); await rm(dir, { recursive: true, force: true }); });

  assert.equal(registry.estimates["idea-to-3d-model"].unpriced, 1);
  assert.equal(depositUsd(registry), 0.05);
});
