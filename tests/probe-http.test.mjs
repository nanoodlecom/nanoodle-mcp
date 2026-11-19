import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createProbeFetch } from "../src/probe-http.mjs";

test("a probe bounds oversized bodies and cancels their stream", async () => {
  let cancelled = false;
  const request = createProbeFetch({ maxBytes: 32, fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(request("https://example.test"), /response-too-large/);
  assert.equal(cancelled, true);
});

test("probes time out stalled bodies and never follow authenticated redirects", async () => {
  let followed = false;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/target" }); res.end(); return; }
    if (req.url === "/target") followed = true;
    res.writeHead(200, { "content-type": "application/json" }); res.write("{");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, request = createProbeFetch({ timeoutMs: 50 });
  try {
    await assert.rejects(request(base + "/stall"), e => ["TimeoutError", "AbortError"].includes(e.name));
    await assert.rejects(request(base + "/redirect", { headers: { authorization: "Bearer private-test-token" } }));
    assert.equal(followed, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
