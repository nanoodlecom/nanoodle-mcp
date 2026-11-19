import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MARKET_HANDLES, runMarketCheck } from "../scripts/market-check.mjs";

const setup = () => ({ stateDir: mkdtempSync(join(tmpdir(), "market-check-")), retryMs: 0 });
const agentId = handle => `00000000-0000-0000-0000-${String(MARKET_HANDLES.indexOf(handle) + 1).padStart(12, "0")}`;
function healthy(url, init, fee = 500) {
  assert.equal(init.method, "GET"); assert.equal(init.headers.authorization, undefined);
  assert.equal(init.headers["cache-control"], "no-cache, no-store");
  assert.equal(init.body, undefined); assert.equal(init.redirect, "error"); assert.ok(init.signal);
  const path = new URL(url).pathname;
  if (path === "/") return new Response("<title>NEAR AI Agent Market</title>", { headers: { "content-type": "text/html" } });
  if (path === "/v1/platform/config") return Response.json({ public_host: new URL(url).host, platform_fee_bps: fee });
  const handle = path.split("/").at(-1);
  if (MARKET_HANDLES.includes(handle)) return Response.json({ handle, agent_id: agentId(handle), listing_status: "live", availability: "available", available_now: false, funding_paused: false });
  if (path.endsWith("/pricing-plans")) return Response.json([{ agent_id: path.split("/").at(-2), is_default: true, listing_status: "live", price_amount: "0.03" }]);
  assert.fail(`Unexpected request: ${path}`);
}

test("public site, API and all published listings with live prices pass without credentials, hires or inference", async () => {
  const config = setup(), calls = [];
  const report = await runMarketCheck(config, { fetch: async (...args) => { calls.push(args[0]); return healthy(...args); } });
  assert.equal(report.ok, true); assert.equal(report.checks.length, 6); assert.equal(calls.length, 10);
  assert.deepEqual(report.checks.filter(c => c.handle).map(c => c.handle), MARKET_HANDLES);
  assert.equal(report.checks.at(-1).availableNow, false, "occupied slots are not an outage");
  assert.ok(!calls.some(url => /workflows|assignments|jobs|hire|mcp/.test(url)));
  const file = join(config.stateDir, "market-latest.json");
  assert.deepEqual(JSON.parse(readFileSync(file)), report); assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a transient API failure retries before declaring an outage", async () => {
  let calls = 0;
  const report = await runMarketCheck(setup(), { fetch: async (url, init) => {
    if (url.endsWith("/v1/platform/config") && ++calls === 1) return new Response("temporary", { status: 503 });
    return healthy(url, init);
  } });
  assert.equal(report.ok, true); assert.equal(report.checks.find(c => c.stage === "market-api").attempts, 2);
});

test("independent availability detects a fee increase above the spending guard", async () => {
  let fee = 501;
  const observe = () => runMarketCheck(setup(), { fetch: async (url, init) => healthy(url, init, fee) });
  const increased = await observe();
  assert.equal(increased.ok, false);
  assert.deepEqual(increased.checks.find(c => c.stage === "market-api"),
    { stage: "market-api", ok: false, attempts: 3, error: "market-fee-assumption-changed" });
  fee = 499;
  assert.equal((await observe()).ok, true);
});

test("HTML API fallbacks, unpublished or unfunded listings, and missing live prices fail after bounded retries", async () => {
  for (const [path, replacement, error] of [
    ["/v1/platform/config", () => new Response("<html>private remote diagnostics</html>"), "invalid-json"],
    ["/v1/agents/nanoodle-song", () => new Response("private remote diagnostics", { status: 404 }), "http-404"],
    ["/v1/agents/nanoodle-song", () => Response.json({ handle: "nanoodle-song", agent_id: agentId("nanoodle-song"), listing_status: "paused" }), "listing-not-live"],
    ["/v1/agents/nanoodle-song", () => Response.json({ handle: "nanoodle-song", agent_id: agentId("nanoodle-song"), listing_status: "live", availability: "unavailable_funding", funding_paused: true }), "listing-unavailable"],
    [`/v1/agents/${agentId("nanoodle-song")}/pricing-plans`, () => Response.json([]), "missing-default-price"],
    [`/v1/agents/${agentId("nanoodle-song")}/pricing-plans`, () => Response.json([{ agent_id: agentId("nanoodle-song"), is_default: true, listing_status: "draft", price_amount: "0.03" }]), "invalid-default-price"],
  ]) {
    const config = setup(); let failures = 0;
    const report = await runMarketCheck(config, { fetch: async (url, init) => {
      if (new URL(url).pathname === path) { failures++; return replacement(); }
      return healthy(url, init);
    } });
    assert.equal(report.ok, false); assert.equal(failures, 3);
    assert.equal(report.checks.find(c => !c.ok).error, error);
    assert.doesNotMatch(readFileSync(join(config.stateDir, "market-latest.json"), "utf8"), /private remote diagnostics/);
  }
});

test("connection failures stay redacted and an API body that stalls is timed out", async () => {
  const report = await runMarketCheck({ ...setup(), attempts: 1 }, { fetch: async (url, init) => {
    if (url.endsWith("/v1/platform/config")) throw Error("private proxy address or credential");
    return healthy(url, init);
  } });
  assert.equal(report.ok, false); assert.equal(report.stage, "market-api");
  assert.doesNotMatch(JSON.stringify(report), /private proxy|credential/);
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runMarketCheck({ ...setup(), url: `http://127.0.0.1:${server.address().port}`, attempts: 1, timeoutMs: 100 });
    assert.equal(result.ok, false); assert.ok(result.checks.every(c => c.error === "timeout"));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
