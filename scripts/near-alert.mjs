#!/usr/bin/env node
// systemd OnFailure hook + durable retry queue. Only selected metadata enters Babel.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { selectFundingPause } from "../src/funding-report.mjs";
import { atomicJson } from "./near-check.mjs";

export const CHECK_UNIT = "nanoodle-near-check.service";
export const TEST_UNIT = "nanoodle-near-check-alert-test.service";
export const MARKET_UNIT = "nanoodle-market-check.service";
export const MARKET_TEST_UNIT = "nanoodle-market-check-alert-test.service";
export const OPERATIONAL_UNIT = "nanoodle-operational-check.service";
export const OPERATIONAL_TEST_UNIT = "nanoodle-operational-check-alert-test.service";
export const BACKUP_UNIT = "nanoodle-backup.service";
export const BACKUP_TEST_UNIT = "nanoodle-backup-alert-test.service";
export const EMBER = "bits255.dots.ada_20261002";
const safe = value => /^[a-zA-Z0-9_.:-]{1,100}$/.test(value || "") ? value : "unknown";

export function failureEvent(env, latest, now = Date.now()) {
  if (!env.MONITOR_UNIT) return null; // A retry timer never invents another incident.
  if (![CHECK_UNIT, TEST_UNIT, MARKET_UNIT, MARKET_TEST_UNIT, OPERATIONAL_UNIT, OPERATIONAL_TEST_UNIT, BACKUP_UNIT, BACKUP_TEST_UNIT].includes(env.MONITOR_UNIT) || !/^[a-f0-9]{32}$/.test(env.MONITOR_INVOCATION_ID || "")) throw Error("Unrecognized failure invocation");
  const market = [MARKET_UNIT, MARKET_TEST_UNIT].includes(env.MONITOR_UNIT);
  const operational = [OPERATIONAL_UNIT, OPERATIONAL_TEST_UNIT].includes(env.MONITOR_UNIT);
  const backup = [BACKUP_UNIT, BACKUP_TEST_UNIT].includes(env.MONITOR_UNIT);
  const test = [TEST_UNIT, MARKET_TEST_UNIT, OPERATIONAL_TEST_UNIT, BACKUP_TEST_UNIT].includes(env.MONITOR_UNIT);
  const freshFailure = !backup && !test && latest?.ok === false && Math.abs(now - Date.parse(latest.checkedAt)) < 3_600_000;
  const stage = backup ? "backup" : freshFailure ? safe(latest.stage) : "service";
  const issues = Array.isArray(latest?.checks) ? latest.checks : [];
  const eventId = operational && freshFailure && /^[a-f0-9]{32}$/.test(latest.incidentId || "") ? latest.incidentId : env.MONITOR_INVOCATION_ID;
  return { messageId: "near_check_" + createHash("sha256").update(env.MONITOR_UNIT + ":" + eventId).digest("hex").slice(0, 40), test,
    text: [test ? `TEST ALERT — Nanoodle ${backup ? "backup" : operational ? "operational readiness" : market ? "Market" : "NEAR"} check notification drill. This is not a production outage.`
        : backup ? "Nanoodle encrypted recovery backup FAILED (no inference)."
        : operational ? "Nanoodle operational readiness check FAILED (every five minutes, no inference)."
        : market ? "Nanoodle NEAR AI Market availability check FAILED (every 15 minutes)." : "Nanoodle NEAR MCP daily check FAILED.",
      `Site: https://${market ? "market.near.ai" : "near.nanoodle.com"}. Time: ${new Date(now).toISOString()}.`,
      `Stage: ${stage}. systemd result: ${safe(env.MONITOR_SERVICE_RESULT)}; exit: ${safe(env.MONITOR_EXIT_CODE)}/${safe(env.MONITOR_EXIT_STATUS)}.`,
      backup ? "Inspect journalctl -u nanoodle-backup.service and /run/nanoodle-recovery/resume.json on 159.195.17.119."
        : operational ? "Inspect /var/lib/nanoodle-operational-check/latest.json and journalctl -u nanoodle-operational-check.service on 159.195.17.119."
        : `Inspect /var/lib/nanoodle-near-check/${market ? "market-latest.json" : "latest.json"} and journalctl -u ${market ? MARKET_UNIT : CHECK_UNIT} on 159.195.17.119.`,
      backup ? "Confirm the app and its original timers resumed. Preserve payment state and keep the private recovery key off the VPS. This capture executes no models or transfers."
        : operational ? `Issues: ${freshFailure ? issues.filter(c => !c.ok).slice(0, 12).map(c => `${safe(c.stage)}=${safe(c.code)}`).join(", ") || "service" : "service"}. No payment or workflow is executed by this probe. Preserve money state; do not blindly retry transfers or paid jobs.`
        : market ? "Read-only probes cover the Market site, API and four published Nanoodle listings with live pricing. This check does not hire agents or run inference."
        : "Payment state is durable: resume the same run; do not send a replacement deposit blindly.",
      ...(test ? ["Mikkel requested this test. Please claim and acknowledge this message in Babel, then reply to it confirming receipt. No repair or paid workflow is requested."] : []),
    ].join("\n") };
}

function recoveredFundingEvent(latest, now) {
  const checkedAt = Date.parse(latest?.checkedAt);
  const pause = selectFundingPause(latest?.fundingPause, Math.min(now, checkedAt));
  if (latest?.v !== 1 || pause?.recoveredAt == null || !selectFundingPause(pause, now)
      || !Array.isArray(latest.checks) || !latest.checks.some(check => check?.stage === "runtime-funding" && check.ok === true)) return null;
  const id = createHash("sha256").update(`funding-recovery:${pause.lastFailedAt}:${pause.recoveredAt}:${pause.code}`).digest("hex").slice(0, 40);
  return { messageId: "near_check_" + id, test: false, text: [
    "Nanoodle shared wallet funding paused and recovered.",
    `The last failure at ${new Date(pause.lastFailedAt).toISOString()} reported ${pause.code}. Funding recovered at ${new Date(pause.recoveredAt).toISOString()}.`,
    "The read-only probe confirmed wallet funding health. See /var/lib/nanoodle-operational-check/latest.json for other readiness checks. Keep the original deposit for any pending payment.",
  ].join("\n") };
}

// Node's fetch ignores a supplied Host header. Use HTTP for the loopback
// gateway's explicit virtual host; credentials never leave the local machine.
export function babelRequest(input, init) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fetch(input, init);
  return new Promise((resolve, reject) => {
    // The gateway's local listener requires the trusted edge header as well as
    // its Host. This is loopback-only; Bearer authentication remains mandatory.
    const req = httpRequest(url, { method: init.method, headers: { ...init.headers, "x-forwarded-proto": "https" }, signal: init.signal }, res => {
      const chunks = []; let bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; if (bytes > 524288) { req.destroy(Error("Babel response too large")); return; } chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { "content-type": res.headers["content-type"] || "application/json" } })));
    });
    req.on("error", reject); req.end(init.body);
  });
}

export function babelClient(config, request = babelRequest) {
  let id = 0;
  return async (name, args) => {
    const token = readFileSync(config.tokenFile, "utf8").trim();
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw Error("Invalid Babel credential file");
    const response = await request(config.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
        authorization: `Bearer ${token}`, ...(config.host ? { host: config.host } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
    if (!response.ok) throw Error("Babel HTTP request failed");
    const rpc = await response.json();
    if (rpc.error || rpc.result?.isError || !rpc.result?.content?.[0]?.text) throw Error("Babel tool request failed");
    return JSON.parse(rpc.result.content[0].text);
  };
}

export async function deliverAlerts(config, { env = process.env, now = Date.now, call = babelClient(config), enqueueOnly = false } = {}) {
  const dir = join(config.stateDir, "alerts"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  let latest;
  const operationalReportFile = config.operationalReportFile || "/var/lib/nanoodle-operational-check/latest.json";
  const reportFile = !env.MONITOR_UNIT ? (enqueueOnly ? null : operationalReportFile)
    : [BACKUP_UNIT, BACKUP_TEST_UNIT].includes(env.MONITOR_UNIT) ? null
    : [OPERATIONAL_UNIT, OPERATIONAL_TEST_UNIT].includes(env.MONITOR_UNIT) ? operationalReportFile
    : join(config.stateDir, [MARKET_UNIT, MARKET_TEST_UNIT].includes(env.MONITOR_UNIT) ? "market-latest.json" : "latest.json");
  if (reportFile) try { latest = JSON.parse(readFileSync(reportFile)); } catch { /* early exit or timeout */ }
  // The retry service reads successful readiness runs too. It enqueues recovery
  // under the existing alert lock, since OnFailure's ExecStartPre has no lock.
  const event = env.MONITOR_UNIT ? failureEvent(env, latest, now()) : recoveredFundingEvent(latest, now());
  if (event) {
    const file = join(dir, event.messageId + ".json");
    if (!existsSync(file)) atomicJson(file, { ...event, status: "pending", createdAt: new Date(now()).toISOString() });
  }
  if (enqueueOnly) return { ok: true, ...(event ? { messageId: event.messageId, test: event.test, persisted: true } : {}) };
  let failed = 0, queued = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!/^near_check_[a-f0-9]{40}\.json$/.test(name)) continue;
    const file = join(dir, name), item = JSON.parse(readFileSync(file));
    if (item.status !== "pending") continue;
    try {
      const result = await call("stage_message", { recipient: EMBER, conversation_id: config.conversation, message_id: item.messageId, text: item.text });
      const message = result.message;
      if (message?.id !== item.messageId || message?.recipient !== EMBER || (config.sender && message.source !== config.sender)
        || !["queued", "acknowledged"].includes(message.status)) throw Error("Babel has not admitted this alert");
      item.status = "queued"; item.queuedAt = new Date(now()).toISOString(); delete item.lastFailureAt;
      atomicJson(file, item); queued++;
    } catch {
      // Keep the original ID/text even if the bridge queued it but its response was lost.
      item.lastFailureAt = new Date(now()).toISOString(); atomicJson(file, item); failed++;
    }
  }
  const result = { ok: failed === 0, queued, pending: failed, ...(event ? { messageId: event.messageId, test: event.test } : {}) };
  atomicJson(join(dir, "latest-delivery.json"), { ...result, checkedAt: new Date(now()).toISOString() });
  return result;
}

if (import.meta.main) {
  const config = { stateDir: process.env.CHECK_STATE_DIR || "/var/lib/nanoodle-near-check", url: process.env.BABEL_URL,
    host: process.env.BABEL_HOST, tokenFile: process.env.BABEL_TOKEN_FILE, conversation: process.env.BABEL_CONVERSATION, sender: process.env.BABEL_SENDER };
  try {
    const result = await deliverAlerts(config, { enqueueOnly: process.argv.includes("--enqueue-only") }); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ ok: false, error: "Alert could not be queued; inspect the private outbox and retry service" })); process.exitCode = 1; }
}
