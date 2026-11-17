import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMarketClient, MarketApiError } from "../src/market/client.mjs";

test("a Market body that stalls after its headers is bounded and remains an uncertain outcome", async () => {
  let calls = 0, stall = true;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer private-test-token");
    res.writeHead(200, { "content-type": "application/json" });
    if (stall) res.write("{"); else res.end(JSON.stringify({ assignments: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createMarketClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: "private-test-token", timeoutMs: 50 });
    await assert.rejects(client.listAssignments(), e => e instanceof MarketApiError && e.uncertain && e.status === 200 && !e.message.includes("private-test-token"));
    assert.equal(calls, 1, "the transport must not retry a possibly effective operation itself");
    stall = false;
    assert.deepEqual(await client.listAssignments(), []);
    assert.equal(calls, 2, "the bounded failure leaves the client usable");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
