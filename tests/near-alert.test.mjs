import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { deliverAlerts, failureEvent, babelClient, EMBER, CHECK_UNIT, TEST_UNIT, MARKET_UNIT, MARKET_TEST_UNIT } from "../scripts/near-alert.mjs";

const invocation = { MONITOR_UNIT: CHECK_UNIT, MONITOR_INVOCATION_ID: "a".repeat(32), MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" };
const setup = () => ({ stateDir: mkdtempSync(join(tmpdir(), "near-alert-")), conversation: "near_check_alerts", sender: "bits255.codex.near_monitor" });

test("failed checks persist before sending; lost responses retry one stable Babel message", async () => {
  const config = setup(), staged = new Map(), requests = []; let loseResponse = true;
  writeFileSync(join(config.stateDir, "latest.json"), JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), stage: "refund", error: "private checkout nq_secret https://private.example/pay", unrelated: "private_key" }));
  const call = async (name, args) => {
    assert.equal(name, "stage_message"); requests.push(args);
    assert.equal(JSON.parse(readFileSync(join(config.stateDir, "alerts", args.message_id + ".json"))).status, "pending");
    if (!staged.has(args.message_id)) staged.set(args.message_id, args);
    if (loseResponse) { loseResponse = false; throw Error("lost response AFTER admission"); }
    return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } };
  };
  assert.equal((await deliverAlerts(config, { env: invocation, call })).ok, false);
  assert.equal((await deliverAlerts(config, { env: {}, call })).ok, true);
  assert.equal(staged.size, 1); assert.deepEqual(requests[0], requests[1]);
  assert.match(requests[0].text, /Stage: refund/);
  assert.doesNotMatch(requests[0].text, /nq_secret|private\.example|private_key/);
  assert.equal((await deliverAlerts(config, { env: invocation, call })).queued, 0, "repeated hooks do not duplicate delivery");
  assert.equal(requests.length, 2);
  await deliverAlerts(config, { env: { ...invocation, MONITOR_INVOCATION_ID: "b".repeat(32) }, call });
  assert.equal(staged.size, 2, "distinct failures get distinct message IDs, even for the same stage");
});

test("OnFailure enqueue-only does not need a working bridge, and retry-only creates no incident", async () => {
  const config = setup(), calls = [];
  const call = async (name, args) => { calls.push(args); return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }; };
  const event = await deliverAlerts(config, { env: invocation, call, enqueueOnly: true });
  assert.equal(event.persisted, true); assert.equal(calls.length, 0);
  assert.equal((await deliverAlerts(config, { env: {}, call })).queued, 1);
  assert.equal((await deliverAlerts(config, { env: {}, call })).queued, 0);
  assert.equal(calls.length, 1);
});

test("test alerts are labeled, ignore stale status, and cannot mistake another unit for the monitor", () => {
  const latest = { ok: false, checkedAt: new Date().toISOString(), stage: "payment" };
  const event = failureEvent({ ...invocation, MONITOR_UNIT: TEST_UNIT }, latest);
  assert.equal(event.test, true); assert.match(event.text, /TEST ALERT/); assert.match(event.text, /not a production outage/); assert.match(event.text, /Stage: service/);
  assert.match(event.text, /claim and acknowledge/);
  assert.equal(failureEvent({}, latest), null);
  assert.throws(() => failureEvent({ ...invocation, MONITOR_UNIT: "other.service" }, latest));
  assert.match(failureEvent(invocation, { ...latest, checkedAt: "2020-01-01T00:00:00Z" }).text, /Stage: service/);
});

test("Market failures use their own report and reach Ember through the existing durable queue", async () => {
  const config = setup(), requests = [];
  writeFileSync(join(config.stateDir, "latest.json"), JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), stage: "refund" }));
  writeFileSync(join(config.stateDir, "market-latest.json"), JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), stage: "listing-nanoodle-song" }));
  const call = async (name, args) => { requests.push(args); return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }; };
  const result = await deliverAlerts(config, { env: { ...invocation, MONITOR_UNIT: MARKET_UNIT }, call, enqueueOnly: true });
  assert.equal(result.persisted, true); assert.equal(requests.length, 0);
  assert.equal((await deliverAlerts(config, { env: {}, call })).queued, 1);
  assert.equal(requests[0].recipient, EMBER); assert.equal(requests[0].conversation_id, config.conversation);
  assert.match(requests[0].text, /every 15 minutes/); assert.match(requests[0].text, /https:\/\/market.near.ai/);
  assert.match(requests[0].text, /Stage: listing-nanoodle-song/); assert.match(requests[0].text, /market-latest.json/);
  assert.doesNotMatch(requests[0].text, /refund|deposit|daily/);
  const drill = failureEvent({ ...invocation, MONITOR_UNIT: MARKET_TEST_UNIT }, {});
  assert.match(drill.text, /TEST ALERT.*Market/); assert.match(drill.text, /not a production outage/);
  assert.notEqual(result.messageId, failureEvent(invocation, {}).messageId, "the two monitors cannot collide");
});

test("drafts and incorrect recipient responses remain pending, without bypassing bridge approval", async () => {
  for (const override of [{ status: "draft" }, { recipient: "other" }]) {
    const config = setup();
    const result = await deliverAlerts(config, { env: invocation, call: async (name, args) => ({ message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued", ...override } }) });
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(readFileSync(join(config.stateDir, "alerts", result.messageId + ".json"))).status, "pending");
  }
});

test("Babel transport uses the dedicated credential, explicit conversation and bounded HTTP request", async () => {
  const config = setup(); config.tokenFile = join(config.stateDir, "token"); config.url = "http://127.0.0.1:8403/mcp/v1"; config.host = "babel.example.com";
  writeFileSync(config.tokenFile, "synthetic_".repeat(8), { mode: 0o600 });
  const call = babelClient(config, async (url, init) => {
    assert.equal(url, config.url); assert.equal(init.headers.host, config.host); assert.match(init.headers.authorization, /^Bearer synthetic_/);
    assert.equal(init.redirect, "error"); assert.ok(init.signal);
    const args = JSON.parse(init.body).params.arguments; assert.equal(args.conversation_id, config.conversation);
    return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }) }] } });
  });
  assert.equal((await deliverAlerts(config, { env: invocation, call })).ok, true);
});

test("the real loopback wire preserves the gateway Host header", async () => {
  const config = setup(); config.tokenFile = join(config.stateDir, "token"); config.host = "babel.example.com";
  writeFileSync(config.tokenFile, "synthetic_".repeat(8), { mode: 0o600 });
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.host, config.host); assert.match(req.headers.authorization, /^Bearer synthetic_/);
    assert.equal(req.headers["x-forwarded-proto"], "https", "the authenticated loopback caller must satisfy the gateway edge contract");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks)).params.arguments;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }) }] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  config.url = `http://127.0.0.1:${server.address().port}/mcp/v1`;
  try { assert.equal((await deliverAlerts(config, { env: invocation })).ok, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
