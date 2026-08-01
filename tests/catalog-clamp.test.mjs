/**
 * The MCP used to build every Workflow WITHOUT a catalog, which silently disabled
 * every catalog-driven payload limit the nanoodle library applies — a graph asking
 * for 4 variations from a model that returns 1 was sent (and billed) as n:4.
 *
 * These tests pin the fix on both construction sites: hosted graph tools
 * (attachCatalogs / attachEstimates) and the ad-hoc run_noodle share-link path,
 * plus the two ways the fetch must stay out of the run's way when the endpoint
 * misbehaves — a hard timeout, and a negative cache so an outage costs one round
 * trip per minute rather than one per call.
 * Fully offline against a stub NanoGPT — nothing spends money.
 *
 * Each test gets its OWN stub on its own port: the catalog cache is keyed by base
 * URL, so a fresh port is a cold cache and tests can't prime each other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTools, attachCatalogs, attachEstimates, editorShareUrl } from "../src/tools.mjs";

/** 1x1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const MODEL = "test-image-model";

/** A graph whose image node asks for more variations than the model can return. */
const graphJson = (variations) => JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", type: "text", x: 80, y: 120, fields: { text: "a lighthouse" } },
    { id: "n2", type: "image", x: 420, y: 100, fields: { model: MODEL, variations } },
  ],
  links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
});

/** Stub NanoGPT: the public image catalog (max_output_images: 1) + image generation. */
async function startStub({ catalogStatus = 200, catalogHang = false } = {}) {
  const stub = { imageRequests: [], catalogHits: 0 };
  const hung = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);

    if (req.method === "GET" && req.url === "/api/v1/image-models") {
      stub.catalogHits++;
      // Accept the connection and never answer — the failure mode a plain
      // `.catch()` doesn't cover and node's fetch has no default deadline for.
      if (catalogHang) { hung.push(res); return; }
      if (catalogStatus !== 200) { res.writeHead(catalogStatus); res.end("nope"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      // max_output_images: 1 is the whole point — the clamp reads it.
      res.end(JSON.stringify({
        data: [{
          id: MODEL,
          name: "Test image model",
          pricing: { per_image: { "1024x1024": 0.01 } },
          supported_parameters: { max_output_images: 1, max_input_images: 1 },
        }],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      stub.imageRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.01 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = async () => {
    for (const res of hung) res.destroy(); // never-answered requests: nothing will ever end them
    const closed = new Promise((r) => server.close(r));
    server.closeAllConnections?.(); // and keep-alive sockets would hold close() open for keepAliveTimeout
    await closed;
  };
  return stub;
}

/**
 * A temp dir holding one graph file, plus a registry pointed at a fresh stub.
 * `catalogTimeoutMs` / `log` go to the registry, everything else to the stub.
 */
async function fixture(variations, { catalogTimeoutMs, log, ...stubOpts } = {}) {
  const stub = await startStub(stubOpts);
  const dir = await mkdtemp(join(tmpdir(), "nd-cat-"));
  const text = graphJson(variations);
  await writeFile(join(dir, "poster.json"), text);
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: stub.url, outDir: dir, catalogTimeoutMs, log });
  return { dir, text, registry, stub };
}

test("hosted graph: variations clamp to the catalog's max_output_images", async (t) => {
  const { registry, stub } = await fixture(4);
  t.after(() => stub.close());

  // Control: with no catalog attached, the graph's 4 goes out verbatim — the old behavior.
  await registry.callTool({ name: "poster", arguments: {} });
  assert.equal(stub.imageRequests.length, 1);
  assert.equal(stub.imageRequests[0].n, 4, "unclamped baseline: a catalog-less Workflow sends what the graph asked for");

  // With catalogs attached, the library clamps to what the model can actually return.
  stub.imageRequests.length = 0;
  const catalogs = await attachCatalogs(registry, { baseUrl: stub.url });
  assert.ok(Array.isArray(catalogs.image) && catalogs.image.length, "image catalog loaded");
  assert.equal(registry.tools[0].wf.catalog, catalogs, "the tool's Workflow got the catalog");

  await registry.callTool({ name: "poster", arguments: {} });
  assert.equal(stub.imageRequests.length, 1);
  assert.equal(stub.imageRequests[0].n, 1, "n clamped to max_output_images — no paying for surplus images");
});

test("attachEstimates attaches catalogs too (charge mode gets the clamp)", async (t) => {
  const { registry, stub } = await fixture(4);
  t.after(() => stub.close());

  await attachEstimates(registry, { baseUrl: stub.url });
  assert.ok(registry.catalogs && registry.catalogs.image, "catalogs stashed on the registry");
  assert.equal(registry.tools[0].wf.catalog, registry.catalogs);
  assert.ok(registry.estimates.poster, "still forecasts cost from the same fetch");

  await registry.callTool({ name: "poster", arguments: {} });
  assert.equal(stub.imageRequests[0].n, 1);
});

test("run_noodle: a share link's variations are clamped too", async (t) => {
  const { registry, text, stub } = await fixture(4);
  t.after(() => stub.close());

  await registry.callTool({ name: "run_noodle", arguments: { url: editorShareUrl(text) } });
  assert.equal(stub.imageRequests.length, 1);
  assert.equal(stub.imageRequests[0].n, 1, "the ad-hoc link path builds its Workflow with a catalog");
});

test("run_noodle reuses the cached catalog instead of refetching per call", async (t) => {
  const { registry, text, stub } = await fixture(2);
  t.after(() => stub.close());

  const url = editorShareUrl(text);
  await registry.callTool({ name: "run_noodle", arguments: { url } });
  assert.equal(stub.catalogHits, 1, "first call fetched the catalog");
  await registry.callTool({ name: "run_noodle", arguments: { url } });
  assert.equal(stub.catalogHits, 1, "second call served from cache");
  assert.deepEqual(stub.imageRequests.map((r) => r.n), [1, 1]);
});

test("run_noodle: a catalog endpoint that never answers can't stall the run", async (t) => {
  const lines = [];
  const { registry, text, stub } = await fixture(2, { catalogHang: true, catalogTimeoutMs: 300, log: (l) => lines.push(l) });
  t.after(() => stub.close());

  const t0 = Date.now();
  await registry.callTool({ name: "run_noodle", arguments: { url: editorShareUrl(text) } });
  const ms = Date.now() - t0;

  assert.equal(stub.catalogHits, 1, "the fetch was attempted");
  assert.ok(ms < 3000, `run finished in ${ms}ms — the fetch is abandoned at the timeout, not left hanging`);
  assert.equal(stub.imageRequests.length, 1, "the run still happened");
  assert.equal(stub.imageRequests[0].n, 2, "unclamped, i.e. today's behavior — degraded, not blocked");
  assert.match(lines.join("\n"), /no response in 300ms/, "and the caller hears why the limits are missing");
});

test("a failed catalog is negative-cached: a second run inside the TTL refetches nothing", async (t) => {
  const lines = [];
  const { registry, text, stub } = await fixture(2, { catalogStatus: 503, log: (l) => lines.push(l) });
  t.after(() => stub.close());

  const url = editorShareUrl(text);
  await registry.callTool({ name: "run_noodle", arguments: { url } });
  assert.equal(stub.catalogHits, 1, "first run paid the failing round trip");

  await registry.callTool({ name: "run_noodle", arguments: { url } });
  assert.equal(stub.catalogHits, 1, "second run inside the failure TTL didn't retry — an outage isn't billed per call");
  assert.equal(lines.length, 1, "and doesn't repeat the same warning every run");
  assert.deepEqual(stub.imageRequests.map((r) => r.n), [2, 2], "both runs completed, unclamped");
});

test("an unreachable catalog is best-effort: the run still happens, unclamped", async (t) => {
  const { registry, stub } = await fixture(3, { catalogStatus: 503 });
  t.after(() => stub.close());

  const lines = [];
  const catalogs = await attachCatalogs(registry, { baseUrl: stub.url, log: (l) => lines.push(l) });
  assert.deepEqual(catalogs, {}, "nothing loaded");
  assert.equal(registry.tools[0].wf.catalog, null, "no half-built catalog installed");
  assert.match(lines.join("\n"), /image catalog/);

  await registry.callTool({ name: "poster", arguments: {} });
  assert.equal(stub.imageRequests[0].n, 3, "degrades to today's behavior rather than failing the run");
});
