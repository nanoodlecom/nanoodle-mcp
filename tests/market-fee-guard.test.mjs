import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMarketFeeGuard } from "../src/market/fee-guard.mjs";

test("fee checks share concurrent reads but revalidate the next execution phase", async () => {
  let fee = 500, requests = 0;
  const guard = createMarketFeeGuard({ baseUrl: "https://market.fixture", fetch: async (url, init) => {
    requests++; assert.equal(new URL(url).pathname, "/v1/platform/config");
    const headers = new Headers(init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.get("cache-control"), "no-cache, no-store");
    assert.equal(init.redirect, "error");
    return new Response(JSON.stringify({ platform_fee_bps: fee }));
  } });
  assert.deepEqual(await Promise.all([guard.check(), guard.check()]), [500, 500]);
  assert.equal(requests, 1);
  fee = 800;
  await assert.rejects(guard.check(), { code: "MARKET_FEE_CHANGED" });
  assert.equal(requests, 2);
  fee = 0; assert.equal(await guard.check(), 0, "a lower fee stays within the conservative budget");
});

test("invalid, redirected and oversized fee responses cannot authorize inference", async () => {
  for (const response of [new Response("bad JSON"), new Response("down", { status: 503 }),
    new Response(JSON.stringify({ platform_fee_bps: "500" })), new Response(" ".repeat(33_000)),
    new Response(JSON.stringify({ platform_fee_bps: 10_001 }))]) {
    const guard = createMarketFeeGuard({ baseUrl: "https://market.fixture", fetch: async () => response });
    await assert.rejects(guard.check(), { code: "MARKET_FEE_UNAVAILABLE" });
  }
  assert.throws(() => createMarketFeeGuard({ baseUrl: "https://market.fixture", maxFeeBps: NaN }), /maxFeeBps/);
});

test("a fee body stalled after headers is bounded", { timeout: 5_000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const guard = createMarketFeeGuard({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 500 });
    await assert.rejects(guard.check(), { code: "MARKET_FEE_UNAVAILABLE" });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
