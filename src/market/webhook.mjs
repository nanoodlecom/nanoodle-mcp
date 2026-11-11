/**
 * NEAR Agent Market webhooks: the push channel next to the poll loop.
 *
 * The market POSTs a signed event when a listing is hired. Here an event is
 * only a nudge: the handler makes the listing poll at once and never takes
 * state from the event's body. Every rule about which job may run stays in the
 * worker's poll (worker.mjs `tick`), so a hire that arrives by webhook goes
 * through exactly the same checks as one found by polling.
 *
 * One answer matters: a 2xx to `hire.created` makes the market stamp the
 * assignment as started. The worker refuses to run a job it first sees already
 * started, so the handler answers 2xx to `hire.created` only once the poll has
 * written the job's record. Anything else gets 503 and the market sends the
 * event again (after 10 s, 30 s, 90 s, 270 s); the regular poll picks the job
 * up in the meantime.
 *
 * Signature: `X-Market-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Market-Timestamp>.<raw body>")>`.
 * No age check is made on the timestamp: a replayed event can only cause one
 * more poll, and the market says it may deliver a held event late.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** The largest event body read. A brief is at most 10,000 characters; attachments are listed, not embedded. */
export const WEBHOOK_MAX_BODY = 256 * 1024;

/** Events after which there may be work for the worker: poll now. */
const NUDGE_EVENTS = new Set(["hire.changes_requested", "hire.dispute_resolved", "hire.refunded", "message.created"]);

/**
 * @param {{ secret: string, timestamp: unknown, signature: unknown, rawBody: Buffer }} o
 * @returns {boolean}
 */
export function verifyMarketSignature({ secret, timestamp, signature, rawBody }) {
  if (typeof secret !== "string" || !secret) return false;
  if (typeof timestamp !== "string" || !/^\d{1,15}$/.test(timestamp)) return false;
  if (typeof signature !== "string") return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return false;
  const want = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const got = Buffer.from(m[1], "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Read a signing secret from a file: a secret can be installed or replaced without
 * a restart. A secret that was read is kept for `ttlMs`, a miss for `missTtlMs` (so
 * a new file is noticed quickly, and unsigned requests cannot make the server read
 * the disk on each one). Returns null while the file is not there, is empty, or is
 * readable by group or others.
 */
export function secretFileReader(path, { ttlMs = 30_000, missTtlMs = 2_000, now = Date.now } = {}) {
  let at = -Infinity;
  let value = null;
  let problem = null;
  return {
    read() {
      if (now() - at < (value ? ttlMs : missTtlMs)) return value;
      at = now();
      value = null;
      problem = null;
      try {
        const st = statSync(path);
        if ((st.mode & 0o077) !== 0) problem = `secret file ${path} is readable by group or others; chmod 600 it`;
        else value = readFileSync(path, "utf8").trim() || null;
        if (!value && !problem) problem = `secret file ${path} is empty`;
      } catch { problem = `no secret file at ${path}`; }
      return value;
    },
    problem: () => problem,
  };
}

const reply = (status, body) => ({ status, body: JSON.stringify(body) });
const short = (id) => String(id).slice(0, 8);

/**
 * @param {object} o
 * @param {Map<string, { secret: { read: () => string|null, problem: () => string|null }, store: { get: (id: string) => object|null },
 *        poke: () => Promise<void>, active: () => boolean, log: (line: string) => void }>} o.listings  by handle
 * @param {number} [o.waitMs]  how long a `hire.created` waits for the poll before answering 503
 * @returns {(handle: string, headers: object, rawBody: Buffer) => Promise<{ status: number, body: string }>}
 */
export function createWebhookHandler({ listings, waitMs = 8_000 }) {
  const said = new Map(); // handle → the last problem logged, so a retried event does not repeat it
  const once = (handle, log, line) => { if (said.get(handle) !== line) { said.set(handle, line); log(line); } };

  return async function handleWebhook(handle, headers, rawBody) {
    const l = listings.get(handle);
    if (!l) return reply(404, { error: "no such webhook" });
    const secret = l.secret.read();
    if (!secret) {
      once(handle, l.log, `webhook: an event arrived but cannot be checked (${l.secret.problem()}); answered 503, polling carries on`);
      return reply(503, { error: "webhook not configured" });
    }
    if (!verifyMarketSignature({ secret, timestamp: headers["x-market-timestamp"], signature: headers["x-market-signature"], rawBody })) {
      return reply(401, { error: "bad signature" });
    }
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); } catch { return reply(400, { error: "body is not JSON" }); }
    const event = body && typeof body.event === "string" ? body.event : "";

    if (event === "hire.created") {
      const id = body.assignment_id;
      // A hire opened without a job carries no assignment: there is nothing to run.
      if (typeof id !== "string" || !id) return reply(200, { ok: true });
      if (l.store.get(id)) { l.poke().catch(() => {}); return reply(200, { ok: true }); }
      if (!l.active()) {
        once(handle, l.log, "webhook: hired, but this listing is off (no price); answered 503 so the job is not marked started");
        return reply(503, { error: "listing is not taking jobs" });
      }
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(r, waitMs); });
      try { await Promise.race([l.poke(), timeout]); } catch { /* answered below */ } finally { clearTimeout(timer); }
      if (l.store.get(id)) {
        said.delete(handle);
        return reply(200, { ok: true });
      }
      once(handle, l.log, `webhook: assignment ${short(id)} was not on the market's list yet; answered 503, the market sends the event again`);
      return reply(503, { error: "not recorded yet" });
    }

    if (NUDGE_EVENTS.has(event)) l.poke().catch(() => {});
    else if (event === "agent.suspended") l.log(`NEEDS OPERATOR — the market suspended this agent (${String(body.reason || "no reason given").slice(0, 60)}, ${String(body.disposition || "").slice(0, 20)})`);
    // webhook.ping and every other event: acknowledged, nothing to do.
    return reply(200, { ok: true });
  };
}
