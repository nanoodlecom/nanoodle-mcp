import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { waitForRecentAppStart } from "../src/probe-startup.mjs";

const recent = () => ({ ActiveState: "active", MainPID: "123", ExecMainStartTimestamp: "@100" });
const health = { active: true, watcher: { listening: true }, funding: { enforced: true, ok: true } };
const config = { site: "https://near.test", nanoSite: "https://nano.test", readStart: recent, now: () => 101_000 };

test("recent restart waits for both listeners and watcher before returning to the full probe", async () => {
  let time = 0, requests = [];
  const result = await waitForRecentAppStart({ ...config, monotonic: () => time, delay: async ms => { time += ms; },
    fetch: async (url, init) => {
      requests.push(url); assert.equal(init.method, undefined); assert.equal(init.redirect, "error");
      if (url.endsWith("/rates")) return new Response("{}");
      if (time === 0) return new Response("starting", { status: 502 });
      return new Response(JSON.stringify(time === 500 ? { ...health, watcher: { listening: false } } : health));
    } });
  assert.deepEqual(result, { attempts: 3, ready: true });
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ["https://nano.test/rates", "https://near.test/near/health"]).flat());
});

test("an old, missing, dead or unobservable app does not postpone a real failure check", async () => {
  const unavailable = () => { throw Error("systemd unavailable"); };
  for (const readStart of [() => ({ ...recent(), ExecMainStartTimestamp: "@1" }),
    () => ({ ...recent(), ActiveState: "failed", MainPID: "0" }), () => ({}), unavailable]) {
    const result = await waitForRecentAppStart({ ...config, readStart,
      fetch: async () => { assert.fail("No warm-up requests outside a recent live start"); } });
    assert.equal(result.attempts, 0);
  }
});

test("persistent startup failures exhaust a bounded grace and cannot return ready", async () => {
  let time = 0;
  const result = await waitForRecentAppStart({ ...config, monotonic: () => time, graceMs: 1000,
    delay: async ms => { time += ms; }, fetch: async () => new Response(JSON.stringify({ ...health, watcher: { listening: false } })) });
  assert.deepEqual(result, { attempts: 2, ready: false });
  assert.equal(time, 1000);
});

test("a stalled HTTP body cannot extend the overall restart grace", async () => {
  const server = createServer((req, res) => { res.writeHead(200); res.write("{"); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = performance.now();
    const result = await waitForRecentAppStart({ ...config, site, nanoSite: site, graceMs: 75 });
    assert.equal(result.ready, false);
    assert.ok(result.attempts > 0);
    assert.ok(performance.now() - start < 2000);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
