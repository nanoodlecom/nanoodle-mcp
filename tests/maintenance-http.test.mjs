import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHttp } from "../src/http.mjs";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work", arguments: {} } };
async function world(t, callTool) {
  const dir = await mkdtemp(join(tmpdir(), "http-maintenance-")), file = join(dir, "flag.json");
  const maintenance = createMaintenanceBarrier({ file, ownerUid: process.getuid() });
  const server = await serveHttp({ host: "127.0.0.1", port: 0, publicBase: "http://example.test", name: "test", version: "0",
    listTools: () => [{ name: "work", description: "test work", inputSchema: { type: "object" } }], callTool,
    maintenance, log: () => {}, progressMs: 10 });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { maintenance, base,
    pause: () => writeFile(file, JSON.stringify({ v: 1, token: "a".repeat(32), operation: "backup", revision: null }), { mode: 0o600 }),
    post: (body = call, options = {}) => fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...options.headers },
      body: typeof body === "string" ? body : JSON.stringify(body), ...options }),
  };
}

test("HTTP admission rejects new calls during maintenance while accepted work and status GETs continue", async t => {
  const entered = deferred(), finish = deferred(); let executions = 0;
  const w = await world(t, async () => { executions++; entered.resolve(); await finish.promise; return { content: [{ type: "text", text: "finished" }] }; });
  const first = w.post(); await entered.promise;
  await w.pause();
  assert.equal(w.maintenance.snapshot().counts.request, 1);
  const refused = await w.post();
  assert.equal(refused.status, 503); assert.equal(refused.headers.get("Retry-After"), "5");
  const error = (await refused.json()).error;
  assert.equal(error.executionNotStarted, true); assert.match(error.message, /same payment ID; do not pay again/);
  assert.equal((await fetch(w.base + "/version")).status, 200);
  assert.equal(executions, 1);
  finish.resolve(); const response = await first;
  assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /finished/);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});

test("disconnecting a streamed HTTP call cannot hide its still-running workflow from drain", async t => {
  const entered = deferred(), finish = deferred(), completed = deferred();
  const w = await world(t, async () => {
    entered.resolve(); await finish.promise; completed.resolve(); return { content: [{ type: "text", text: "finished" }] };
  });
  const controller = new AbortController();
  const response = await w.post(call, { headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, signal: controller.signal });
  const reading = response.text().catch(() => {});
  await entered.promise; controller.abort(); await reading;
  await w.pause();
  assert.equal(w.maintenance.snapshot().activeOperations, 1);
  finish.resolve(); await completed.promise;
  // Allow the HTTP handler's finally and scope release to complete.
  await new Promise(r => setImmediate(r));
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});

test("invalid requests and tool failures release HTTP operation registrations", async t => {
  const w = await world(t, async () => { throw Error("fixture tool failure"); });
  assert.equal((await w.post("{")).status, 400);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
  const response = await w.post(); await response.text();
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});
