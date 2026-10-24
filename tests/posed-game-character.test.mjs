/**
 * posed-game-character: mount, deposit cap, budget skips, and 402 cancel checks.
 * Every NanoGPT response is a local stub. Nothing is paid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, copyFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools, attachEstimates } from "../src/tools.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { paidDeposit, depositFromCharge, SETTLE_MARKUP, openBudget, settledCharge, meteredWithinQuote } from "../src/pay-guard.mjs";
import {
  POSED_TOOL, POSED_SENTENCE_CAP, posedQuoteUsd, posedWorstUsd, posedStageUsd,
  posedFetch, enforceSfwBody, GLM_MODEL, FLUX_MODEL, BRIA_MODEL, RODIN_MODEL,
} from "../src/posed.mjs";

delete process.env.NANOGPT_API_KEY;
delete process.env.NANOGPT_BASE_URL;

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const GRAPH = new URL("./fixtures/hosted/posed-game-character.noodle-graph.json", import.meta.url);

const CATALOGS = {
  "/api/v1/models?detailed=true": [
    { id: GLM_MODEL, pricing: { prompt: 0.1, completion: 0.3, currency: "USD", unit: "per_million_tokens" }, capabilities: { nsfw: false } },
  ],
  "/api/v1/image-models": [
    { id: FLUX_MODEL, pricing: { per_image: { "1024x1024": 0.009, 1024: 0.009 }, currency: "USD" }, capabilities: { nsfw: false } },
    { id: BRIA_MODEL, pricing: { per_image: { auto: 0.03 }, currency: "USD" }, capabilities: { nsfw: false } },
  ],
  "/api/v1/3d-models": [
    {
      id: RODIN_MODEL,
      pricing: {
        per_run: 0.48,
        per_run_by_variant: { standard: 0.48, "extreme-high": 0.96, "standard+highpack": 1.44, "extreme-high+highpack": 1.92 },
        default_variant: "standard",
        currency: "USD",
      },
      capabilities: { nsfw: false },
    },
  ],
};

function invoice(id, usd) {
  return {
    payment: {
      paymentId: id,
      accepted: [{
        scheme: "nano",
        payTo: "nano_1stub",
        maxAmountRequired: "1000",
        maxAmountRequiredUSD: usd,
        completeUrl: `http://x/api/x402/complete/${id}`,
      }],
    },
  };
}

function abortOnNthRead(n) {
  const ac = new AbortController();
  const reason = new Error("cancelled");
  let reads = 0;
  return new Proxy(ac.signal, {
    get(target, prop, receiver) {
      if (prop === "aborted") { reads += 1; return reads >= n; }
      if (prop === "reason") return reason;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function loadPosed(baseUrl) {
  const dir = await mkdtemp(join(tmpdir(), "posed-"));
  await copyFile(GRAPH, join(dir, "posed-game-character.noodle-graph.json"));
  const registry = await loadTools({
    dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), baseUrl, log: () => {},
  });
  return { dir, registry };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("posed-game-character mounts from the graph and describes a quad mesh", async (t) => {
  const { dir, registry } = await loadPosed("http://127.0.0.1:9");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = registry.listTools().find((x) => x.name === POSED_TOOL);
  const raw = await readFile(GRAPH, "utf8");
  assert.ok(tool, "tool is registered from the graph file");
  assert.match(tool.description, /posed and quad-meshed for rigging/);
  assert.match(tool.description, /The SFW safety checker stays on, and NSFW is off by default/);
  assert.doesNotMatch(tool.description, /rig-ready/i);
  assert.doesNotMatch(raw, /rig-ready/i);
  assert.equal(tool.inputSchema.properties.Character.maxLength, POSED_SENTENCE_CAP);
  assert.equal(tool.inputSchema.required, undefined);
  const models = [...raw.matchAll(/"model": "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(models, [GLM_MODEL, FLUX_MODEL, BRIA_MODEL, RODIN_MODEL]);
});

test("a sentence over the cap, a blank sentence, or an nsfw argument is refused before any request", async (t) => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(500); res.end("no"); });
  const port = await listen(server);
  t.after(async () => { server.close(); server.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => registry.callTool({ name: POSED_TOOL, arguments: { nsfw: "yes" } }),
    (e) => e && e.mcpCode === -32602 && /unknown input "nsfw"/.test(e.message));
  await assert.rejects(
    () => registry.prepareCall({ name: POSED_TOOL, arguments: { Character: "   " } }),
    /one sentence/);
  await assert.rejects(
    () => registry.prepareCall({ name: POSED_TOOL, arguments: { Character: "a".repeat(POSED_SENTENCE_CAP + 1) } }),
    /at most 400/);
  await registry.prepareCall({ name: POSED_TOOL, arguments: { Character: "a".repeat(POSED_SENTENCE_CAP) } });
  await registry.prepareCall({ name: POSED_TOOL, arguments: {} });
  assert.equal(hits, 0);
});

test("the deposit is worst-case cost × 1.2 plus the margin, not the variant maximum", async (t) => {
  const server = http.createServer((req, res) => {
    const data = CATALOGS[req.url];
    if (req.method === "GET" && data) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const port = await listen(server);
  t.after(async () => { server.close(); server.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await attachEstimates(registry, { baseUrl: `http://127.0.0.1:${port}`, log: () => {} });
  const graph = registry.tools.find((x) => x.name === POSED_TOOL).wf.graph;
  const worst = posedWorstUsd(graph, registry.catalogs);
  const quote = posedQuoteUsd(graph, registry.catalogs);
  assert.equal(registry.depositCaps[POSED_TOOL], quote);
  assert.equal(quote, depositFromCharge(worst * SETTLE_MARKUP));
  assert.ok(quote > 0.48 * SETTLE_MARKUP, `deposit ${quote} must clear the Rodin stage`);
  assert.ok(quote < 0.8, `deposit ${quote} must not price the $1.92 variant`);
  const stages = posedStageUsd(graph, registry.catalogs);
  assert.equal(stages.mesh, 0.48);
  assert.equal(stages.image, 0.009);
  assert.equal(stages.cut, 0.03);

  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: { rpc: async () => ({ blocks: {}, history: [] }), transfer: async () => "0".repeat(64) },
    usd: 0.05,
    xnoUsd: 1,
    publicBase: "http://pay.test",
    validate: (p) => registry.prepareCall(p),
    log: () => {},
  });
  const wrapped = gate.wrapRegistry(registry);
  const listed = wrapped.listTools().find((x) => x.name === POSED_TOOL);
  assert.match(listed.description, /caps what the customer pays/);
  assert.match(listed.description, /the operator absorbs any provider overrun/);
  assert.match(listed.description, /Direct-wallet spending has no cap/);
  assert.match(listed.description, /posed and quad-meshed for rigging/);
  const quoted = await wrapped.callTool({ name: POSED_TOOL, arguments: {} });
  assert.equal(quoted.structuredContent.x402.amountUsd, quote);
  assert.match(quoted.content[0].text, /This deposit caps what the customer pays/);
  assert.match(quoted.content[0].text, /The operator absorbs any provider overrun/);
  assert.match(quoted.content[0].text, /Direct-wallet spending has no cap/);
  // The locked tier is standard. A catalog whose per_run is the variant maximum must not raise the quote.
  const inflated = posedStageUsd(graph, {
    model3d: [{ id: RODIN_MODEL, pricing: { per_run: 1.92, per_run_by_variant: { standard: 0.48, "extreme-high+highpack": 1.92 }, currency: "USD" } }],
  });
  assert.equal(inflated.mesh, 0.48);
});

test("a missing catalog still quotes the fallback deposit cap", async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const port = await listen(server);
  t.after(async () => { server.close(); server.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await attachEstimates(registry, { baseUrl: `http://127.0.0.1:${port}`, log: () => {} });
  const graph = registry.tools.find((x) => x.name === POSED_TOOL).wf.graph;
  const quote = registry.depositCaps[POSED_TOOL];
  assert.equal(quote, posedQuoteUsd(graph, {}));
  assert.equal(posedStageUsd(graph, {}).mesh, 0.48);
  assert.ok(quote > 0.48 * 1.2 && quote < 0.8);
});

function generationStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      seen.push({ method: req.method, url: req.url, body });
      const send = (status, obj, type = "application/json") => {
        const payload = type === "application/json" ? JSON.stringify(obj) : obj;
        res.writeHead(status, { "content-type": type });
        res.end(payload);
      };
      if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
        send(200, { choices: [{ message: { content: "A teal clockwork fox knight, full body, A-pose." } }], x_nanogpt_pricing: { costUsd: 0.0001 } });
        return;
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        const usd = body && body.model === BRIA_MODEL ? 0.03 : 0.009;
        send(200, { data: [{ b64_json: TINY_PNG }], x_nanogpt_pricing: { costUsd: usd } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/generate-video") {
        send(200, { runId: "run-1", x_nanogpt_pricing: { costUsd: 0.48 } });
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/video/status")) {
        const port = server.address().port;
        send(200, { data: { status: "COMPLETED", output: { kind: "3d", format: "glb", model_url: `http://127.0.0.1:${port}/model.glb` } } });
        return;
      }
      if (req.method === "GET" && req.url === "/model.glb") {
        send(200, Buffer.from("glTF-stub"), "model/gltf-binary");
        return;
      }
      send(404, { error: "not stubbed" });
    });
  });
  return { server, seen };
}

test("a keyed mock run calls the models in order and locks the Rodin body", async (t) => {
  const { server, seen } = generationStub();
  const port = await listen(server);
  t.after(async () => { server.close(); server.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await registry.callTool({ name: POSED_TOOL, arguments: { Character: "A teal clockwork fox knight." } });
  const posts = seen.filter((s) => s.method === "POST").map((s) => s.url);
  assert.deepEqual(posts, [
    "/api/v1/chat/completions",
    "/v1/images/generations",
    "/v1/images/generations",
    "/api/generate-video",
  ]);
  const chat = seen.find((s) => s.url === "/api/v1/chat/completions").body;
  assert.equal(chat.model, GLM_MODEL);
  assert.equal(chat.max_tokens, 200);
  const images = seen.filter((s) => s.url === "/v1/images/generations").map((s) => s.body);
  assert.equal(images[0].model, FLUX_MODEL);
  assert.equal(images[0].size, "1024x1024");
  assert.equal(images[0].n, 1);
  assert.equal(images[1].model, BRIA_MODEL);
  assert.equal(images[1].size, "auto");
  const mesh = seen.find((s) => s.url === "/api/generate-video").body;
  assert.equal(mesh.model, RODIN_MODEL);
  assert.equal(mesh.tier, "Gen-2.5-Medium");
  assert.equal(mesh.quality_and_mesh, "18K Quad");
  assert.equal(mesh.material, "All");
  assert.equal(mesh.hd_texture, false);
  assert.equal(mesh.ta_pose, true);
  assert.equal(mesh.addons, "");
  assert.equal(mesh.is_symmetric, "symmetric");
  for (const body of [chat, ...images, mesh]) {
    assert.notEqual(body.nsfw, true);
    assert.notEqual(body.enable_safety_checker, false);
  }
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /Rodin 2\.5 standard/);
  assert.match(text, /cost: \$0\.5191/);
  const graph = registry.tools.find((x) => x.name === POSED_TOOL).wf.graph;
  const quote = posedQuoteUsd(graph, null);
  assert.ok(result.costUsd * SETTLE_MARKUP <= quote + 1e-9);
});

test("a $0.10 deposit skips Rodin and still returns the paid stages", async (t) => {
  const { server, seen } = generationStub();
  const port = await listen(server);
  t.after(async () => { server.close(); server.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await paidDeposit.run(0.1, () => registry.callTool({ name: POSED_TOOL, arguments: {} }));
  assert.equal(seen.some((s) => s.url === "/api/generate-video"), false);
  const text = result.content.map((c) => c.text).join("\n");
  assert.match(text, /skipped "Rodin 2\.5 standard"/);
  assert.match(text, /remaining deposit cannot cover/);
  assert.ok(Math.abs(result.costUsd - 0.0391) < 1e-9, `cost ${result.costUsd}`);
  assert.equal(result.isError, undefined);
  assert.ok(result.costUsd * SETTLE_MARKUP <= 0.1 + 1e-9);
});

test("a real mesh error still fails the run", async (t) => {
  const seen = [];
  const live = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.url);
      if (req.method === "POST" && req.url === "/api/generate-video") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("rodin down");
        return;
      }
      if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "A fox." } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG }], x_nanogpt_pricing: { costUsd: 0.01 } }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  const port = await listen(live);
  t.after(async () => { live.close(); live.closeAllConnections?.(); });
  const { dir, registry } = await loadPosed(`http://127.0.0.1:${port}`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => registry.callTool({ name: POSED_TOOL, arguments: {} }),
    /rodin down|500/);
});

test("safety flags on a poisoned body are corrected and absent flags stay absent", async () => {
  const poisoned = enforceSfwBody({
    model: FLUX_MODEL,
    nsfw: true,
    enable_safety_checker: false,
    safety_checker: false,
    allow_nsfw: true,
    disable_safety_checker: true,
    uncensored: true,
  });
  assert.equal(poisoned.nsfw, false);
  assert.equal(poisoned.enable_safety_checker, true);
  assert.equal(poisoned.safety_checker, true);
  assert.equal(poisoned.allow_nsfw, false);
  assert.equal(poisoned.disable_safety_checker, false);
  assert.equal(poisoned.uncensored, false);
  const clean = { model: FLUX_MODEL, prompt: "a fox" };
  enforceSfwBody(clean);
  assert.equal(clean.nsfw, undefined);
  assert.equal(clean.enable_safety_checker, undefined);

  let seen = null;
  const fetchImpl = posedFetch({
    stages: { image: 0.009 },
    budget: openBudget(1),
    fetch: async (url, init) => {
      seen = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG }], x_nanogpt_pricing: { costUsd: 0.009 } }), { status: 200 });
    },
  });
  await fetchImpl("http://x/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: FLUX_MODEL, nsfw: true, enable_safety_checker: false, allow_nsfw: true }),
  });
  assert.equal(seen.nsfw, false);
  assert.equal(seen.enable_safety_checker, true);
  assert.equal(seen.allow_nsfw, false);
});

test("posed fetch does not pay when cancelled after the invoice read", async () => {
  const ac = new AbortController();
  const reason = new Error("cancelled");
  let paid = 0;
  const payload = JSON.stringify(invoice("payM", 0.48));
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget: openBudget(2),
    payment: () => { paid += 1; },
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        ac.abort(reason);
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }), { status: 402, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: RODIN_MODEL }),
    signal: ac.signal,
  }), (e) => e === reason || /cancelled/.test(String(e && e.message)));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(paid, 0);
});

test("posed fetch does not pay when cancelled inside the queued payment callback", async () => {
  let paid = 0;
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget: openBudget(2),
    payment: () => { paid += 1; },
    fetch: async () => new Response(JSON.stringify(invoice("payM", 0.48)), {
      status: 402,
      headers: { "content-type": "application/json" },
    }),
  });
  // Read 1 is the check after the body; read 2 is beginPayment's sync check; read 3 is the callback.
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST",
    headers: { "content-type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: RODIN_MODEL }),
    signal: abortOnNthRead(3),
  }), (e) => e && e.paymentNotSent === true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(paid, 0);
});

const x402Headers = { "content-type": "application/json", "x-x402": "true" };

const ONE_XNO = "1" + "0".repeat(30);
const BAD_USD = [
  ["''", ""],
  ["whitespace", "   "],
  ["false", false],
  ["[]", []],
  ["null", null],
  ["missing", undefined],
];

function rawInvoice(id, usd) {
  const accepted = {
    scheme: "nano",
    payTo: "nano_1stub",
    maxAmountRequired: ONE_XNO,
    completeUrl: "http://x/api/x402/complete/" + id,
  };
  if (usd !== undefined) accepted.maxAmountRequiredUSD = usd;
  return { payment: { paymentId: id, accepted: [accepted] } };
}

test("a malformed USD price is not paid, even for a 1 XNO invoice on a tiny budget", async () => {
  for (const [label, usd] of BAD_USD) {
    let paid = 0;
    const budget = openBudget(0.01);
    const fetchImpl = posedFetch({
      stages: { mesh: 0.001 },
      budget,
      payment: () => { paid += 1; },
      fetch: async () => new Response(JSON.stringify(rawInvoice("pay-" + label, usd)), {
        status: 402, headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(fetchImpl("http://x/api/generate-video", {
      method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
    }), (e) => e && e.unknownPrice === true && e.paymentNotSent === true && e.code !== "budget-skip");
    assert.equal(paid, 0, label);
    assert.equal(budget.metered, 0, label);
    assert.equal(fetchImpl.ledger.paidIds.size, 0, label);
    assert.equal(fetchImpl.ledger.unreportedUsd, 0, label);
  }
});

test("an explicit budget parses, and a $0.01 invoice is refused before payment", async () => {
  for (const budgetUsd of ["1e-3", ".001", "0.001", 0.001]) {
    let paid = 0;
    const budget = openBudget(budgetUsd);
    assert.equal(budget.quote, 0.001, String(budgetUsd));
    assert.equal(settledCharge(1, budgetUsd), 0.001, String(budgetUsd));
    assert.ok(Math.abs(meteredWithinQuote(1, budgetUsd) - 0.001 / 1.2) < 1e-12, String(budgetUsd));
    const fetchImpl = posedFetch({
      stages: { mesh: 0.0001 },
      budget,
      payment: () => { paid += 1; },
      fetch: async () => new Response(JSON.stringify(invoice("payCap", 0.01)), {
        status: 402, headers: { "content-type": "application/json" },
      }),
    });
    await assert.rejects(fetchImpl("http://x/api/generate-video", {
      method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
    }), (e) => e && e.budgetRefused === true && e.paymentNotSent === true && e.unknownPrice !== true);
    assert.equal(paid, 0, String(budgetUsd));
    assert.equal(budget.metered, 0, String(budgetUsd));
    assert.equal(fetchImpl.ledger.paidIds.size, 0, String(budgetUsd));
    assert.equal(fetchImpl.ledger.unreportedUsd, 0, String(budgetUsd));
  }
  assert.throws(() => openBudget("nope"), (e) => e && e.budgetRefused === true);
  assert.throws(() => settledCharge(1, "nope"), (e) => e && e.budgetRefused === true);
  assert.equal(settledCharge(1, null), 1.2);
});

test("an explicit USD 0 is a known price and is paid", async () => {
  for (const usd of [0, "0", "0.00"]) {
    let paid = 0;
    const fetchImpl = posedFetch({
      stages: { mesh: 0.001 },
      budget: openBudget(0.01),
      payment: () => { paid += 1; },
      fetch: async (url) => {
        if (String(url).includes("/complete/")) {
          return new Response(JSON.stringify({ runId: "ok", x_nanogpt_pricing: { costUsd: 0 } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rawInvoice("payZero", usd)), {
          status: 402, headers: { "content-type": "application/json" },
        });
      },
    });
    const r = await fetchImpl("http://x/api/generate-video", {
      method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
    });
    assert.equal(r.status, 200, String(usd));
    assert.equal(paid, 1, String(usd));
  }
});

test("an invoice that does not fit at the 1.2 markup is refused, and an accepted invoice counts immediately", async () => {
  let paid = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const budget = openBudget(0.10);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.05, image: 0.01 },
    budget,
    payment: () => { paid += 1; return gate; },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ runId: "run-1", x_nanogpt_pricing: { costUsd: 0.05 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const model = JSON.parse(init.body).model;
      const id = model === RODIN_MODEL ? "payMesh" : "payImg";
      return new Response(JSON.stringify(invoice(id, 0.05)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const first = fetchImpl("http://x/api/generate-video", { method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(paid, 1);
  assert.ok(Math.abs(budget.metered - 0.05) < 1e-9, `reserved ${budget.metered}`);
  await assert.rejects(fetchImpl("http://x/v1/images/generations", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: FLUX_MODEL }),
  }), (e) => e && e.budgetRefused === true && e.paymentNotSent === true);
  assert.equal(paid, 1);
  release();
  await first;
});

test("two invoices that each fit the budget alone cannot both be paid", async () => {
  let paid = 0;
  let releasePay;
  const payGate = new Promise((r) => { releasePay = r; });
  let arrived = 0;
  let releaseFetch;
  const fetchGate = new Promise((r) => { releaseFetch = r; });
  const budget = openBudget(0.10);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.01, image: 0.01 },
    budget,
    payment: () => { paid += 1; return payGate; },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ runId: "run-1", x_nanogpt_pricing: { costUsd: 0.05 } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      arrived += 1;
      if (arrived === 2) releaseFetch();
      else await fetchGate;
      const model = JSON.parse(init.body).model;
      const id = model === RODIN_MODEL ? "payA" : "payB";
      return new Response(JSON.stringify(invoice(id, 0.05)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const mesh = fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
  });
  const image = fetchImpl("http://x/v1/images/generations", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: FLUX_MODEL }),
  });
  const settledP = Promise.allSettled([mesh, image]);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(paid, 1);
  assert.ok(Math.abs(budget.metered - 0.05) < 1e-9, `committed ${budget.metered}`);
  releasePay();
  const settled = await settledP;
  const rejected = settled.filter((s) => s.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.budgetRefused, true);
  assert.equal(paid, 1);
});

test("a paid replay resends the exact billed body, and a later retry cannot replace it", async () => {
  const seen = [];
  const budget = openBudget(2);
  const billed = JSON.stringify({ model: RODIN_MODEL, tier: "Gen-2.5-Medium", note: "billed bytes" });
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget,
    payment: () => {},
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: init.body, paid: headerOf(init.headers, "x-x402-payment-id") });
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      if (headerOf(init.headers, "x-x402-payment-id")) {
        return new Response(JSON.stringify({ runId: "run-1", x_nanogpt_pricing: { costUsd: 0.48 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(invoice("payM", 0.48)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  await fetchImpl("http://x/api/generate-video", { method: "POST", headers: x402Headers, body: billed });
  const replay = seen.find((s) => s.paid === "payM");
  assert.ok(replay, "replay was sent");
  assert.equal(replay.body, billed);
  seen.length = 0;
  await fetchImpl("http://x/api/generate-video", {
    method: "POST",
    headers: { ...x402Headers, "x-x402-payment-id": "payM" },
    body: JSON.stringify({ model: RODIN_MODEL, tier: "CHANGED" }),
  });
  assert.equal(seen[0].body, billed);
  assert.equal(fetchImpl.ledger.bodies.get("payM"), billed);
});

test("the same paymentId is reserved once, and a second request cannot overwrite its body", async () => {
  let paid = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const budget = openBudget(2);
  const firstBody = JSON.stringify({ model: RODIN_MODEL, note: "first" });
  const secondBody = JSON.stringify({ model: RODIN_MODEL, note: "second" });
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget,
    payment: () => { paid += 1; return gate; },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ runId: "run-1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(invoice("payOnce", 0.48)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  const first = fetchImpl("http://x/api/generate-video", { method: "POST", headers: x402Headers, body: firstBody });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(fetchImpl("http://x/api/generate-video", { method: "POST", headers: x402Headers, body: secondBody }), /already paid/);
  assert.equal(paid, 1);
  assert.equal(fetchImpl.ledger.bodies.get("payOnce"), firstBody);
  release();
  await first;
});

test("a synchronous paymentNotSent throw restores the budget so a later stage can pay", async () => {
  let paid = 0;
  const budget = openBudget(0.10);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.01, image: 0.01 },
    budget,
    payment(inv) {
      if (inv.paymentId === "paySync") {
        const e = new Error("wallet refused");
        e.paymentNotSent = true;
        throw e;
      }
      paid += 1;
    },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ runId: "ok", x_nanogpt_pricing: { costUsd: 0.05 } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      const model = JSON.parse(init.body).model;
      const id = model === RODIN_MODEL ? "paySync" : "payLater";
      return new Response(JSON.stringify(invoice(id, 0.05)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
  }), (e) => e && e.paymentNotSent === true && /wallet refused/.test(e.message));
  assert.equal(paid, 0);
  assert.equal(budget.metered, 0);
  assert.equal(fetchImpl.ledger.paidIds.size, 0);
  assert.equal(fetchImpl.ledger.unreportedUsd, 0);
  assert.equal(fetchImpl.ledger.reconcile.length, 0);
  assert.equal(fetchImpl.ledger.costUnknown, false);
  const r = await fetchImpl("http://x/v1/images/generations", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: FLUX_MODEL }),
  });
  assert.equal(r.status, 200);
  assert.equal(paid, 1);
  assert.ok(Math.abs(budget.metered - 0.05) < 1e-9);
});

test("a synchronous throw without paymentNotSent keeps the reservation", async () => {
  let paid = 0;
  const budget = openBudget(0.10);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.01, image: 0.01 },
    budget,
    payment(inv) {
      if (inv.paymentId === "payAmb") throw new Error("rpc down");
      paid += 1;
    },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ runId: "ok", x_nanogpt_pricing: { costUsd: 0.05 } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      const model = JSON.parse(init.body).model;
      const id = model === RODIN_MODEL ? "payAmb" : "payNext";
      return new Response(JSON.stringify(invoice(id, 0.05)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
  }), /rpc down/);
  assert.equal(fetchImpl.ledger.paidIds.has("payAmb"), true);
  assert.equal(fetchImpl.ledger.costUnknown, true);
  assert.ok(fetchImpl.ledger.unreportedUsd > 0);
  assert.ok(Math.abs(budget.metered - 0.05) < 1e-9);
  await assert.rejects(fetchImpl("http://x/v1/images/generations", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: FLUX_MODEL }),
  }), (e) => e && e.budgetRefused === true && e.paymentNotSent === true);
  assert.equal(paid, 0);
  assert.equal(fetchImpl.ledger.paidIds.has("payAmb"), true);
});

test("an error after payment returns keeps the reservation even with paymentNotSent", async () => {
  const budget = openBudget(0.10);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.01, image: 0.01 },
    budget,
    payment: () => {},
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        const e = new Error("complete failed");
        e.paymentNotSent = true;
        throw e;
      }
      const model = JSON.parse(init.body).model;
      const id = model === RODIN_MODEL ? "paySent" : "payNext";
      return new Response(JSON.stringify(invoice(id, 0.05)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
  }), (e) => e && e.paymentNotSent === true && /complete failed/.test(e.message));
  assert.equal(fetchImpl.ledger.paidIds.has("paySent"), true);
  assert.equal(fetchImpl.ledger.costUnknown, true);
  assert.ok(fetchImpl.ledger.unreportedUsd > 0);
  assert.ok(Math.abs(budget.metered - 0.05) < 1e-9);
  await assert.rejects(fetchImpl("http://x/v1/images/generations", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: FLUX_MODEL }),
  }), (e) => e && e.budgetRefused === true);
});

test("a payment error records the invoice and costUnknown before it rejects", async () => {
  const budget = openBudget(2);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget,
    payment: () => { throw new Error("rpc down"); },
    fetch: async () => new Response(JSON.stringify(invoice("payE", 0.48)), { status: 402, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }),
  }), /rpc down/);
  assert.equal(fetchImpl.ledger.costUnknown, true);
  assert.equal(fetchImpl.ledger.reconcile[0].paymentId, "payE");
  assert.equal(fetchImpl.ledger.reconcile[0].amountUsd, 0.48);
  assert.equal(fetchImpl.ledger.reconcile[0].ambiguous, true);
  assert.ok(fetchImpl.ledger.unreportedUsd > 0);
  assert.equal(fetchImpl.ledger.paidIds.has("payE"), true);
});

test("a cancel after the wallet runs records the invoice and costUnknown before it rejects", async () => {
  const ac = new AbortController();
  const budget = openBudget(2);
  const fetchImpl = posedFetch({
    stages: { mesh: 0.48 },
    budget,
    payment: async () => { ac.abort(new Error("cancelled")); },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) throw (init && init.signal && init.signal.reason) || new Error("aborted after payment");
      return new Response(JSON.stringify(invoice("payCancel", 0.48)), { status: 402, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(fetchImpl("http://x/api/generate-video", {
    method: "POST", headers: x402Headers, body: JSON.stringify({ model: RODIN_MODEL }), signal: ac.signal,
  }), /cancelled|aborted after payment/);
  assert.equal(fetchImpl.ledger.costUnknown, true);
  assert.equal(fetchImpl.ledger.reconcile[0].paymentId, "payCancel");
  assert.equal(fetchImpl.ledger.reconcile[0].amountUsd, 0.48);
  assert.equal(fetchImpl.ledger.reconcile[0].status, "aborted after payment");
  assert.equal(fetchImpl.ledger.paidIds.has("payCancel"), true);
  assert.ok(fetchImpl.ledger.unreportedUsd > 0);
});

function headerOf(headers, name) {
  if (!headers) return null;
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
  return hit ? hit[1] : null;
}
