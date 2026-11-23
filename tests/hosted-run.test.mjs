import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
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

test("video polling is cancelled even when the library's video timeout is unlimited", { timeout: 10_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstPoll = deferred();
  let polls = 0;
  const wf = new Workflow({ v: 1, nodes: [{ id: "v", type: "tvideo", fields: { model: "example/video", prompt: "a river", duration: "5" } }], links: [] }, {
    apiKey: "fixture", fetch: hostedRunFetch(async url => {
      if (String(url).includes("generate-video")) return Response.json({ runId: "v1" });
      polls++;
      firstPoll.resolve();
      return Response.json({ status: "PROCESSING" });
    }), quiet: true,
  });
  wf.client.pollIntervals.video = 1;
  assert.equal(wf.client.timeouts.video, Infinity);
  const deadline = 60_000;
  const cancelled = assert.rejects(withHostedRun(() => wf.run({}, hostedRunOptions()), deadline), { code: "HOSTED_RUN_TIMEOUT" });
  // Let the mocked submission finish and schedule the first status poll.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1);
  await firstPoll.promise;
  t.mock.timers.tick(deadline - 1);
  await cancelled;
  const stopped = polls;
  t.mock.timers.tick(10);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(polls, stopped);
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

test("a funded workflow preflight refusal reports one terminal failure without executing", async t => {
  const nano = nanoGptMock(); await nano.listen(); t.after(() => nano.close());
  const dir = await mkdtemp(join(tmpdir(), "hosted-preflight-progress-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "poster.json"), JSON.stringify(WORKED_GRAPH));
  const registry = await loadTools({ dirs: [dir], apiKey: "fixture", baseUrl: nano.url, outDir: dir, remote: true });
  const snapshots = [];
  await assert.rejects(registry.callTool({ name: "poster", arguments: { Idea: "a river" } }, {
    fundedMaxUsd: 0.001, workflow: state => snapshots.push(state),
  }), { code: "QUOTE_BUDGET_EXCEEDED" });
  assert.equal(nano.runs(), 0);
  assert.deepEqual(snapshots.map(state => state.status), ["running", "failed"]);
  assert.ok(snapshots.at(-1).finishedAt);
  assert.ok(snapshots.at(-1).nodes.every(node => node.startedAt === undefined));
});

test("hosted saved and custom graphs use a backup key only after an unpaid provider quote", async t => {
  const providerCalls = [];
  let quotes = 0;
  const baseUrl = await server(t, async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/api/v1/chat/completions") {
      res.end(JSON.stringify({ data: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3 } }] }));
      return;
    }
    providerCalls.push({ body, key: req.headers["x-api-key"], x402: req.headers["x-x402"] });
    if (req.headers["x-x402"] === "true") {
      res.writeHead(402);
      res.end(JSON.stringify({ payment: { paymentId: `quote-${++quotes}`, amountUsd: "0.01",
        accepted: [{ scheme: "lightning-l402" }] } }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: "Backup model result" } }],
        x_nanogpt_pricing: { costUsd: 0.008 } }));
    }
  });
  const dir = await mkdtemp(join(tmpdir(), "hosted-backup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const graph = { v: 1, nodes: [{ id: "l", type: "llm", name: "Answer",
    fields: { model: "z-ai/glm-5.3-flash", prompt: "Hello", maxTokens: 32 } }], links: [] };
  await writeFile(join(dir, "backed.json"), JSON.stringify(graph));
  const pool = createRunFunding({ serial: async fn => fn(), balance: async () => 100n, requireScope: true });
  const registry = await loadTools({ dirs: [dir], baseUrl, outDir: dir, hosted: true, remote: true,
    payment: () => assert.fail("unexpected Nano payment"), backupKey: "fixture-key", authorizeBackup: pool.authorizeBackup });
  for (const params of [{ name: "backed", arguments: {} }, { name: "run_noodle", arguments: { graph } }]) {
    const result = await pool.run({ id: params.name, maxUsd: 0.05, maxRaw: 30n }, () => registry.callTool(params));
    assert.match(JSON.stringify(result), /Backup model result/);
  }
  assert.equal(providerCalls.length, 4);
  for (const i of [0, 2]) {
    const [initial, backup] = providerCalls.slice(i, i + 2);
    assert.deepEqual(initial, { body: backup.body, key: undefined, x402: "true" });
    assert.deepEqual(backup, { body: initial.body, key: "fixture-key", x402: undefined });
  }
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
  for (const params of [{ name: "image", arguments: {} }, { name: "run_noodle", arguments: { graph } }]) {
    const snapshots = [];
    await assert.rejects(registry.callTool(params, { workflow: state => snapshots.push(state) }), /hosted execution limit/);
    assert.equal(snapshots[0].status, "running");
    assert.deepEqual(snapshots.filter(state => state.status !== "running").map(state => state.status), ["failed"]);
    assert.equal(snapshots.at(-1).nodes[0].status, "done", "artifact failure preserves the completed model step");
  }
  const runner = createWorkflowRunner({ apiKey: "fixture", baseUrl: base, budgetUsd: 1, runTimeoutMs: 500 });
  const priced = await runner.price({ graph }); assert.equal(priced.ok, true);
  await assert.rejects(runner.run({ pricing: priced.pricing, inputs: priced.inputs, outDir: dir }), /hosted execution limit/);
  assert.equal(models, 3); assert.equal(downloads, 3, "each model completed and each artifact read was cancelled");
});

async function twoMediaOutputs(t, { failSecond = false, publicBase = null } = {}) {
  const downloads = [];
  let base;
  base = await server(t, async (req, res) => {
    if (req.url === "/v1/images/generations") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const name = JSON.parse(body).prompt;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ url: `${base}/${name}.png` }], cost: 0.01 }));
      return;
    }
    if (req.url === "/api/v1/image-models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture/image" }] }));
      return;
    }
    downloads.push(req.url);
    if (failSecond && req.url === "/second.png") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png" }).end("fixture media");
  });
  const outDir = await mkdtemp(join(tmpdir(), "hosted-outputs-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await writeFile(join(outDir, "other-run.png"), "previous result");
  const graph = { v: 1, links: [], nodes: ["first", "second"].map(id => ({
    id, name: id, type: "image", fields: { model: "fixture/image", prompt: id, size: "1024x1024" },
  })) };
  const registry = await loadTools({ dirs: [], apiKey: "fixture", baseUrl: base, outDir, publicBase, remote: true });
  const snapshots = [], terminalFiles = [];
  const run = () => registry.callTool({ name: "run_noodle", arguments: { graph } }, {
    workflow(state) {
      snapshots.push(state);
      if (state.status !== "running") terminalFiles.push(readdirSync(outDir));
    },
  });
  return { run, outDir, downloads, snapshots, terminalFiles };
}

test("a later failed media download discards only the artifacts of that call", async t => {
  const { run, outDir, downloads, snapshots, terminalFiles } = await twoMediaOutputs(t, { failSecond: true, publicBase: "https://artifacts.example" });
  await assert.rejects(run(), /404/);
  assert.deepEqual(downloads, ["/first.png", "/second.png"]);
  assert.deepEqual(await readdir(outDir), ["other-run.png"]);
  assert.equal(await readFile(join(outDir, "other-run.png"), "utf8"), "previous result");
  assert.deepEqual(snapshots.filter(state => state.status !== "running").map(state => state.status), ["failed"]);
  assert.deepEqual(terminalFiles, [["other-run.png"]]);
  assert.ok(snapshots.at(-1).nodes.every(node => node.status === "done"));
});

test("the outer hosted deadline discards completed artifacts before reporting failure", async t => {
  const { run, outDir, snapshots, terminalFiles } = await twoMediaOutputs(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let filesBeforeDeadline, statusBeforeDeadline;
  await assert.rejects(withHostedRun(async () => {
    const result = await run();
    filesBeforeDeadline = await readdir(outDir);
    statusBeforeDeadline = snapshots.at(-1).status;
    t.mock.timers.tick(5_000);
    return result;
  }, 5_000), { code: "HOSTED_RUN_TIMEOUT" });
  assert.equal(filesBeforeDeadline.length, 3, "both artifacts were written before the outer deadline");
  assert.equal(statusBeforeDeadline, "running");
  assert.deepEqual(await readdir(outDir), ["other-run.png"]);
  assert.deepEqual(snapshots.filter(state => state.status !== "running").map(state => state.status), ["failed"]);
  assert.deepEqual(terminalFiles, [["other-run.png"]]);
});
