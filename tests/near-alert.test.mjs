import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { deliverAlerts, failureEvent, babelClient, EMBER, CHECK_UNIT, TEST_UNIT, MARKET_UNIT, MARKET_TEST_UNIT, OPERATIONAL_UNIT, OPERATIONAL_TEST_UNIT, BACKUP_UNIT, BACKUP_TEST_UNIT } from "../scripts/near-alert.mjs";

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

test("operational incidents deduplicate across timer invocations and disclose only selected safe issue codes", async () => {
  const config = setup(), requests = [];
  config.operationalReportFile = join(config.stateDir, "operational.json");
  const report = { v: 1, ok: false, checkedAt: new Date().toISOString(), stage: "nano-liquidity", incidentId: "c".repeat(32),
    admission: { nano: false, near: true, usdc: true, market: false },
    checks: [{ stage: "nano-liquidity", ok: false, code: "insufficient", token: "PRIVATE_CREDENTIAL", message: "PRIVATE_CUSTOMER_TEXT" }] };
  writeFileSync(config.operationalReportFile, JSON.stringify({ ...report, invocationId: invocation.MONITOR_INVOCATION_ID }));
  const call = async (name, args) => { requests.push(args); return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }; };
  const first = await deliverAlerts(config, { env: { ...invocation, MONITOR_UNIT: OPERATIONAL_UNIT }, call });
  const next = { ...invocation, MONITOR_UNIT: OPERATIONAL_UNIT, MONITOR_INVOCATION_ID: "d".repeat(32) };
  writeFileSync(config.operationalReportFile, JSON.stringify({ ...report, invocationId: next.MONITOR_INVOCATION_ID }));
  const second = await deliverAlerts(config, { env: next, call });
  assert.equal(first.messageId, second.messageId); assert.equal(requests.length, 1);
  assert.match(requests[0].text, /every five minutes/); assert.match(requests[0].text, /nano-liquidity=insufficient/);
  assert.match(requests[0].text, /admission checks failed for Nano, Market/);
  assert.doesNotMatch(requests[0].text, /PRIVATE_|token|CUSTOMER/);
  const drill = failureEvent({ ...invocation, MONITOR_UNIT: OPERATIONAL_TEST_UNIT }, { checks: "malformed" });
  assert.match(drill.text, /TEST ALERT.*operational readiness/); assert.match(drill.text, /not a production outage/);
});

test("a peer advisory cannot stand in for an operational monitor crash or missing report", () => {
  const now = Date.now();
  const env = { ...invocation, MONITOR_UNIT: OPERATIONAL_UNIT };
  const report = { v: 1, ok: false, checkedAt: new Date(now).toISOString(), stage: "nano-node-1",
    invocationId: env.MONITOR_INVOCATION_ID, incidentId: "c".repeat(32), admission: { nano: true, near: true, usdc: true, market: true },
    checks: [{ stage: "nano-node-1", ok: false, code: "nano-rpc-rate-limited", domains: [] }] };
  const advisory = failureEvent(env, report, now);
  assert.match(advisory.text, /readiness advisory.*passed their admission checks/);
  assert.match(advisory.text, /nano-node-1=nano-rpc-rate-limited/);
  assert.doesNotMatch(advisory.text, /recovery/);
  const next = { ...env, MONITOR_INVOCATION_ID: "b".repeat(32) };
  for (const [current, stale] of [
    [next, report],
    [env, { ...report, invocationId: undefined }],
    [{ ...env, MONITOR_SERVICE_RESULT: "timeout", MONITOR_EXIT_CODE: "killed", MONITOR_EXIT_STATUS: "TERM" }, report],
    [env, { ...report, checkedAt: new Date(now - 3_600_000).toISOString() }],
  ]) {
    const failure = failureEvent(current, stale, now);
    assert.notEqual(failure.messageId, advisory.messageId);
    assert.match(failure.text, /readiness could not be verified/);
    assert.match(failure.text, /Stage: service/);
    assert.doesNotMatch(failure.text, /nano-node-1|readiness advisory|passed their admission/);
  }
});

test("admission failures lead an alert when older advisories exceed its issue limit", () => {
  const now = Date.now(), env = { ...invocation, MONITOR_UNIT: OPERATIONAL_UNIT };
  const report = { v: 1, ok: false, checkedAt: new Date(now).toISOString(), stage: "backup-capture-freshness",
    invocationId: env.MONITOR_INVOCATION_ID, admission: { nano: true, near: false, usdc: false, market: true },
    checks: [...Array.from({ length: 15 }, (_, index) => ({
      stage: `advisory-${index}`, code: "warning", ok: false, domains: [],
    })), { stage: "near-payment-watcher", code: "near-watcher-stale", ok: false, domains: ["near", "usdc"] }] };
  const event = failureEvent(env, report, now);
  assert.equal(event.priority, "failure");
  assert.match(event.text, /admission checks failed for NEAR, USDC/);
  assert.match(event.text, /Stage: near-payment-watcher/);
  assert.match(event.text, /Issues: near-payment-watcher=near-watcher-stale, advisory-0=warning/);
  assert.doesNotMatch(event.text, /advisory-11=/);
});

test("a blocking alert can pass older advisories and unreadable outbox records", async t => {
  const config = setup(), now = Date.now(), requests = [];
  t.after(() => rmSync(config.stateDir, { recursive: true, force: true }));
  config.operationalReportFile = join(config.stateDir, "operational.json");
  const writeReport = (env, near, incidentId) => writeFileSync(config.operationalReportFile, JSON.stringify({
    v: 1, checkedAt: new Date(now).toISOString(), ok: false, invocationId: env.MONITOR_INVOCATION_ID, incidentId,
    stage: near ? "backup-capture-freshness" : "near-payment-watcher",
    admission: { nano: true, near, usdc: near, market: true },
    checks: [{ stage: near ? "backup-capture-freshness" : "near-payment-watcher", code: "failed", ok: false,
      domains: near ? [] : ["near", "usdc"] }],
  }));
  const advisoryEnv = { ...invocation, MONITOR_UNIT: OPERATIONAL_UNIT };
  writeReport(advisoryEnv, true, "a".repeat(32));
  const advisory = await deliverAlerts(config, { env: advisoryEnv, enqueueOnly: true });
  const alerts = join(config.stateDir, "alerts"), badPath = join(alerts, `near_check_${"0".repeat(40)}.json`);
  writeFileSync(badPath, "{ unreadable");
  const mismatch = join(alerts, `near_check_${"1".repeat(40)}.json`);
  writeFileSync(mismatch, JSON.stringify({ messageId: advisory.messageId, status: "pending", text: "mismatched record" }));
  const env = { ...advisoryEnv, MONITOR_INVOCATION_ID: "b".repeat(32) };
  writeReport(env, false, "b".repeat(32));
  const call = async (_name, args) => {
    requests.push(args);
    if (requests.length === 1) throw Error("temporary bridge failure");
    return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } };
  };
  const first = await deliverAlerts(config, { env, call });
  assert.deepEqual(requests.map(args => args.message_id), [first.messageId, advisory.messageId]);
  assert.deepEqual([first.ok, first.queued, first.pending, first.invalid], [false, 1, 1, 2]);
  assert.equal(readFileSync(badPath, "utf8"), "{ unreadable");
  assert.match(readFileSync(mismatch, "utf8"), /mismatched record/);
  const retry = await deliverAlerts(config, { env: {}, call });
  assert.deepEqual(requests[2], requests[0], "a retry keeps the same ID and text");
  assert.deepEqual([retry.ok, retry.queued, retry.pending, retry.invalid], [false, 1, 0, 2]);
});

test("a large alert outbox preserves and rotates pending failures after a bounded retry", async t => {
  const config = setup();
  t.after(() => rmSync(config.stateDir, { recursive: true, force: true }));
  let at = Date.now(), unavailable = true;
  const requests = [], firstRequest = new Map();
  const now = () => at;
  for (let n = 1; n <= 12; n++) {
    await deliverAlerts(config, { env: { ...invocation, MONITOR_UNIT: MARKET_UNIT,
      MONITOR_INVOCATION_ID: n.toString(16).padStart(32, "0") }, now, enqueueOnly: true });
  }
  const call = async (_name, args) => {
    requests.push(args.message_id);
    if (firstRequest.has(args.message_id)) assert.deepEqual(args, firstRequest.get(args.message_id));
    else firstRequest.set(args.message_id, args);
    if (unavailable) throw Error("synthetic Babel outage");
    return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } };
  };
  const deliver = () => deliverAlerts(config, { env: {}, call, now });
  const first = await deliver();
  assert.deepEqual([requests.length, first.ok, first.pending], [8, false, 12]);
  at += 300_000;
  const second = await deliver();
  assert.deepEqual([requests.length, second.ok, second.pending], [16, false, 12]);
  assert.equal(new Set(requests).size, 12, "an outage does not starve alerts outside the first batch");

  unavailable = false;
  const partial = await deliver();
  assert.deepEqual([partial.ok, partial.queued, partial.pending], [false, 8, 4]);
  const recovered = await deliver();
  assert.deepEqual([recovered.ok, recovered.queued, recovered.pending], [true, 4, 0]);
});

test("drafts and incorrect recipient responses remain pending, without bypassing bridge approval", async () => {
  for (const override of [{ status: "draft" }, { recipient: "other" }]) {
    const config = setup();
    const result = await deliverAlerts(config, { env: invocation, call: async (name, args) => ({ message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued", ...override } }) });
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(readFileSync(join(config.stateDir, "alerts", result.messageId + ".json"))).status, "pending");
  }
});

test("backup failures and drills use fixed metadata instead of a payment or Market report", async () => {
  const config = setup(), requests = [];
  const latest = { ok: false, checkedAt: new Date().toISOString(), stage: "PRIVATE_REFUND_STAGE", error: "PRIVATE_ARCHIVE_KEY" };
  writeFileSync(join(config.stateDir, "latest.json"), JSON.stringify(latest));
  const env = { ...invocation, MONITOR_UNIT: BACKUP_UNIT };
  const call = async (_name, args) => { requests.push(args); return { message: { id: args.message_id, recipient: EMBER, source: config.sender, status: "queued" } }; };
  const queued = await deliverAlerts(config, { env, call, enqueueOnly: true });
  assert.equal(queued.persisted, true); assert.equal(requests.length, 0);
  assert.equal((await deliverAlerts(config, { env: {}, call })).queued, 1);
  assert.equal(requests[0].recipient, EMBER); assert.equal(requests[0].conversation_id, config.conversation);
  assert.match(requests[0].text, /backup FAILED/); assert.match(requests[0].text, /Stage: backup/);
  assert.match(requests[0].text, /resume.json/); assert.match(requests[0].text, /no models or transfers/);
  assert.doesNotMatch(requests[0].text, /PRIVATE_|daily check|latest.json|replacement deposit/);
  assert.equal((await deliverAlerts(config, { env, call })).queued, 0);
  const drill = failureEvent({ ...env, MONITOR_UNIT: BACKUP_TEST_UNIT }, latest);
  assert.equal(drill.test, true); assert.match(drill.text, /TEST ALERT.*backup/);
  assert.match(drill.text, /not a production outage/); assert.match(drill.text, /claim and acknowledge/);
  assert.notEqual(drill.messageId, queued.messageId);
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
