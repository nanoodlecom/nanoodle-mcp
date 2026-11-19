import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workflow } from "nanoodle";
import { withHostedRun, hostedRunOptions, hostedRunTimeout, hostedRunFetch } from "../src/hosted-run.mjs";
import { createRunFunding } from "../src/run-funding.mjs";
import { loadTools } from "../src/tools.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const untilAbort = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
async function server(t, handler) {
  const value = createServer(handler);
  await new Promise(resolve => value.listen(0, "127.0.0.1", resolve));
  t.after(() => { value.closeAllConnections(); return new Promise(resolve => value.close(resolve)); });
  return `http://127.0.0.1:${value.address().port}`;
}

test("nested tools retain one deadline; local unhosted work has no imposed timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const plain = { x: 1 }; assert.equal(hostedRunOptions(plain), plain);
  assert.equal(hostedRunTimeout("1800000"), 1_800_000);
  for (const value of [null, false, 0, -1, Infinity, "1e6", "", "86400001"]) assert.throws(() => hostedRunTimeout(value));
  const run = withHostedRun(async () => {
    const outer = hostedRunOptions().signal;
    await withHostedRun(async () => {
      assert.equal(hostedRunOptions().signal, outer);
      await untilAbort(outer);
    }, 60_000);
  }, 20);
  t.mock.timers.tick(20);
  await assert.rejects(run, { code: "HOSTED_RUN_TIMEOUT" });
});

test("late callbacks cannot start more requests after a successful or cancelled run", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const timeout of [false, true]) {
    const go = deferred(); let late, requests = 0;
    const request = hostedRunFetch(async () => { requests++; return Response.json({ ok: true }); });
    const run = withHostedRun(async () => {
      late = go.promise.then(() => request("https://example.test"));
      if (timeout) await untilAbort(hostedRunOptions().signal);
    }, 20);
    if (timeout) { t.mock.timers.tick(20); await assert.rejects(run, { code: "HOSTED_RUN_TIMEOUT" }); } else await run;
    go.resolve();
    await assert.rejects(late, { code: timeout ? "HOSTED_RUN_TIMEOUT" : "HOSTED_RUN_CLOSED" });
    assert.equal(requests, 0);
  }
});

test("request and response-body stalls are bounded, including an adapter ignoring abort", async t => {
  const base = await server(t, (req, res) => {
    if (req.url === "/body") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); }
  });
  for (const path of ["/headers", "/body"]) {
    await assert.rejects(withHostedRun(async () => {
      const response = await hostedRunFetch()(base + path); await response.json();
    }, 100), { code: "HOSTED_RUN_TIMEOUT" });
  }
  let cancelled = false;
  const request = hostedRunFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await assert.rejects(withHostedRun(async () => (await request(base)).arrayBuffer(), 20), { code: "HOSTED_RUN_TIMEOUT" });
  assert.equal(cancelled, true);
});

test("streaming responses preserve the final URL, headers and clone semantics", async t => {
  const base = await server(t, (req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/actual" }); res.end(); }
    else if (req.url === "/binary") { res.writeHead(200, { "content-type": "audio/mpeg", "x-cost": "0.02" }); res.end(Buffer.from([0, 127, 128, 255])); }
    else { res.writeHead(200, { "content-type": "application/json", "x-cost": "0.01" }); res.end('{"ok":true}'); }
  });
  await withHostedRun(async () => {
    const response = await hostedRunFetch()(base + "/redirect");
    assert.equal(response.url, base + "/actual"); assert.equal(response.redirected, true);
    assert.equal(response.headers.get("x-cost"), "0.01");
    const copy = response.clone(); assert.equal(copy.url, response.url);
    const third = copy.clone(); assert.equal(third.url, response.url);
    assert.deepEqual(await response.json(), { ok: true }); assert.deepEqual(await copy.json(), { ok: true });
    assert.deepEqual(await third.json(), { ok: true });
    const binary = await hostedRunFetch()(base + "/binary");
    assert.equal(binary.headers.get("content-type"), "audio/mpeg"); assert.equal(binary.headers.get("x-cost"), "0.02");
    assert.deepEqual(Buffer.from(await binary.arrayBuffer()), Buffer.from([0, 127, 128, 255]));
  }, 5_000);
});

test("synchronous work cannot extend its deadline by delaying timer callbacks", async () => {
  let requests = 0;
  const request = hostedRunFetch(async () => { requests++; return Response.json({ ok: true }); });
  await assert.rejects(withHostedRun(async () => {
    const end = performance.now() + 15;
    while (performance.now() < end) { /* deliberate short event-loop stall */ }
    await request("https://example.test");
  }, 5), { code: "HOSTED_RUN_TIMEOUT" });
  assert.equal(requests, 0);
});

test("video polling is cancelled even when the library's video timeout is unlimited", async () => {
  let polls = 0;
  const wf = new Workflow({ v: 1, nodes: [{ id: "v", type: "tvideo", fields: { model: "example/video", prompt: "a river", duration: "5" } }], links: [] }, {
    apiKey: "fixture", fetch: hostedRunFetch(async url => {
      if (String(url).includes("generate-video")) return Response.json({ runId: "v1" });
      polls++; return Response.json({ status: "PROCESSING" });
    }), quiet: true,
  });
  wf.client.pollIntervals.video = 1;
  assert.equal(wf.client.timeouts.video, Infinity);
  await assert.rejects(withHostedRun(() => wf.run({}, hostedRunOptions()), 50), /hosted execution limit/);
  const stopped = polls;
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(polls, stopped); assert.ok(polls > 0);
});

test("timing out waits for an in-flight payment before releasing its reservation", async t => {
  const nano = nanoGptMock({ walletPayments: true }); await nano.listen(); t.after(() => nano.close());
  const entered = deferred(), release = deferred(); let payments = 0, finished = false;
  let tail = Promise.resolve();
  const serial = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
  const pool = createRunFunding({ serial, balance: async () => 10n ** 30n, requireScope: true });
  const wf = new Workflow(WORKED_GRAPH, { apiKey: null, baseUrl: nano.url, fetch: hostedRunFetch(), quiet: true,
    payment: async invoice => {
      pool.authorize(pool.capture(), invoice, 10n ** 30n); payments++;
      entered.resolve(); await release.promise; nano.settleWalletInvoice(invoice.paymentId);
    } });
  const run = pool.run({ id: "timeout-payment", maxUsd: 1, maxRaw: 10n ** 30n }, () => withHostedRun(async () => {
    const signal = hostedRunOptions().signal;
    const result = wf.run({ Idea: "a river" }, hostedRunOptions()); result.catch(() => {});
    await entered.promise; await untilAbort(signal);
    assert.equal(pool.snapshot().activeRuns, 1); assert.equal(finished, false);
    release.resolve(); return result;
  }, 1_000));
  run.finally(() => { finished = true; }).catch(() => {});
  await assert.rejects(run, /hosted execution limit/);
  assert.equal(payments, 1); assert.equal(nano.runs(), 0, "no completion request starts inference after the deadline");
  assert.equal(pool.snapshot().activeRuns, 0);
});

test("saved, custom and Market execution use the same hosted timeout", async t => {
  const nano = nanoGptMock(); await nano.listen(); t.after(() => nano.close());
  const dir = await mkdtemp(join(tmpdir(), "hosted-deadline-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const graph = { v: 1, nodes: [{ id: "l", type: "llm", name: "Answer", fields: { model: "z-ai/glm-5.3-flash", prompt: "HOLD", maxTokens: 32 } }], links: [] };
  await writeFile(join(dir, "held.json"), JSON.stringify(graph));
  const registry = await loadTools({ dirs: [dir], apiKey: "fixture", baseUrl: nano.url, outDir: dir, remote: true, runTimeoutMs: 200 });
  for (const params of [{ name: "held", arguments: {} }, { name: "run_noodle", arguments: { graph } }]) {
    await assert.rejects(registry.callTool(params), /hosted execution limit/);
  }
  const runner = createWorkflowRunner({ apiKey: "fixture", baseUrl: nano.url, budgetUsd: 1, runTimeoutMs: 200 });
  const priced = await runner.price({ graph }); assert.equal(priced.ok, true);
  await assert.rejects(runner.run({ pricing: priced.pricing, inputs: priced.inputs, outDir: dir }), /hosted execution limit/);
});

test("the Market assignment can shorten the actual hosted run deadline", { timeout: 5_000 }, async t => {
  const started = deferred();
  const nano = nanoGptMock({ beforeChat: () => started.resolve() });
  await nano.listen();
  t.after(() => nano.close());
  const dir = await mkdtemp(join(tmpdir(), "market-sla-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const graph = { v: 1, nodes: [{ id: "l", type: "llm", fields: { model: "z-ai/glm-5.3-flash", prompt: "HOLD", maxTokens: 32 } }], links: [] };
  const runner = createWorkflowRunner({ apiKey: "fixture", baseUrl: nano.url, budgetUsd: 1, runTimeoutMs: 30_000 });
  const priced = await runner.price({ graph });
  assert.equal(priced.ok, true);
  const args = { pricing: priced.pricing, inputs: priced.inputs, outDir: dir };
  const before = nano.runs();
  await assert.rejects(runner.run({ ...args, executionDeadlineAt: Date.now() - 1 }), { code: "MARKET_SLA_TOO_CLOSE" });
  assert.equal(nano.runs(), before);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = runner.run({ ...args, executionDeadlineAt: Date.now() + 2_000 });
  const cancelled = assert.rejects(run, /hosted execution limit/);
  await started.promise;
  t.mock.timers.tick(2_000);
  await cancelled;
});

test("the deadline includes output downloads after the model has completed", async t => {
  let models = 0, downloads = 0, base;
  base = await server(t, (req, res) => {
    if (req.url === "/media.png") {
      downloads++; res.writeHead(200, { "content-type": "image/png" }); res.write("partial image"); return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/v1/image-models")) return res.end(JSON.stringify({ data: [{ id: "fixture/image", pricing: { per_image: { "1024x1024": 0.01 }, currency: "USD" } }] }));
    if (req.url === "/v1/images/generations") { models++; return res.end(JSON.stringify({ data: [{ url: base + "/media.png" }], cost: 0.01 })); }
    res.statusCode = 404; res.end("{}");
  });
  const dir = await mkdtemp(join(tmpdir(), "hosted-output-deadline-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const graph = { v: 1, nodes: [{ id: "i", type: "image", fields: { model: "fixture/image", prompt: "a river", size: "1024x1024" } }], links: [] };
  await writeFile(join(dir, "image.json"), JSON.stringify(graph));
  const registry = await loadTools({ dirs: [dir], apiKey: "fixture", baseUrl: base, outDir: dir, remote: true, runTimeoutMs: 500 });
  await assert.rejects(registry.callTool({ name: "image", arguments: {} }), /hosted execution limit/);
  const runner = createWorkflowRunner({ apiKey: "fixture", baseUrl: base, budgetUsd: 1, runTimeoutMs: 500 });
  const priced = await runner.price({ graph }); assert.equal(priced.ok, true);
  await assert.rejects(runner.run({ pricing: priced.pricing, inputs: priced.inputs, outDir: dir }), /hosted execution limit/);
  assert.equal(models, 2); assert.equal(downloads, 2, "both engines completed and the artifact read was cancelled");
});
