/**
 * NEAR Agent Market stand-in for the market worker's tests and simulation.
 *
 * MARKET_SCHEMAS is copied from https://market.near.ai/openapi.json
 * ("agents-market API", version 2.0.0, read 2026-11-09): the request and
 * response schemas of the worker routes the adapter uses, with the annotation keys
 * `description` and `example(s)` removed (a property named `description` is
 * kept) and nothing else changed. The mock answers in exactly
 * those shapes and checks what it receives against them.
 *
 * Behaviour that is not in the schemas follows the market's worker guides
 * (https://market.near.ai/skill/flows/worker-lifecycle.md and
 * /skill/reference/agent-api.md): start is idempotent; one progress report per
 * 30 s (409 progress_report_too_soon with retry_after); messages are
 * idempotent by clientRequestId; files are reserved, PUT to a presigned URL
 * with no extra headers, then completed; an identical resubmission while
 * `submitted` is a no-op; decline needs a reason and refunds the buyer.
 */
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const MARKET_SCHEMAS = Object.freeze({
  "MyAssignmentsResponse": {"type":"object","required":["assignments"],"properties":{"assignments":{"type":"array","items":{"$ref":"#/components/schemas/MyAssignmentItem"}}}},
  "MyAssignmentItem": {"type":"object","required":["assignment","job"],"properties":{"assignment":{"$ref":"#/components/schemas/JobAssignment"},"autoAcceptAt":{"type":["string","null"],"format":"date-time"},"job":{"$ref":"#/components/schemas/WorkerJobBrief"},"latestMessage":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/LatestMessageBrief"}]}}},
  "JobAssignment": {"type":"object","required":["assignmentId","jobId","workerAgentId","status","escrowAmount","escrowToken","slaSeconds","slaDeadlineAt","acceptanceWindowDays","createdAt","updatedAt"],"properties":{"acceptanceWindowDays":{"type":"integer","format":"int32"},"assignmentId":{"type":"string","format":"uuid"},"bidId":{"type":["string","null"],"format":"uuid"},"cancelDetail":{"type":["string","null"]},"cancelReason":{"type":["string","null"]},"createdAt":{"type":"string","format":"date-time"},"deliverableHash":{"type":["string","null"]},"deliverableUrl":{"type":["string","null"]},"escrowAmount":{"type":"string"},"escrowToken":{"type":"string"},"finalizedAt":{"type":["string","null"],"format":"date-time"},"jobId":{"type":"string","format":"uuid"},"slaDeadlineAt":{"type":"string","format":"date-time"},"slaSeconds":{"type":"integer","format":"int32"},"startedAt":{"type":["string","null"],"format":"date-time"},"status":{"$ref":"#/components/schemas/AssignmentStatus"},"submittedAt":{"type":["string","null"],"format":"date-time"},"updatedAt":{"type":"string","format":"date-time"},"workerAgentId":{"type":"string","format":"uuid"}}},
  "AssignmentStatus": {"type":"string","enum":["in_progress","submitted","accepted","disputed","dispute_resolved","cancelled"]},
  "WorkerJobBrief": {"type":"object","required":["jobId","title","description","tags","jobKind","status","attachments"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}},"description":{"type":"string"},"entriesCloseAt":{"type":["string","null"],"format":"date-time"},"jobId":{"type":"string","format":"uuid"},"jobKind":{"$ref":"#/components/schemas/JobKind"},"status":{"$ref":"#/components/schemas/JobStatus"},"tags":{"type":"array","items":{"type":"string"}},"title":{"type":"string"}}},
  "JobKind": {"type":"string","enum":["standard","instant","competition"]},
  "JobStatus": {"type":"string","enum":["open","filling","in_progress","completed","closed"]},
  "AttachmentBrief": {"type":"object","required":["id","filename","contentType","byteSize","sha256","createdAt","downloadUrl"],"properties":{"byteSize":{"type":"integer","format":"int64"},"contentType":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"downloadUrl":{"type":"string"},"filename":{"type":"string"},"id":{"type":"string","format":"uuid"},"sha256":{"type":"string"}}},
  "LatestMessageBrief": {"type":"object","required":["senderSide","origin","body","truncated","attachments","createdAt"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}},"body":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"origin":{"$ref":"#/components/schemas/MessageOrigin"},"senderSide":{"type":"string"},"truncated":{"type":"boolean"}}},
  "MessageOrigin": {"type":"string","enum":["direct","axi","mcp","platform"]},
  "StartAssignmentResponse": {"type":"object","required":["startedAt"],"properties":{"startedAt":{"type":"string","format":"date-time"}}},
  "DeclineAssignmentRequest": {"type":"object","properties":{"detail":{"type":["string","null"]},"reason":{"oneOf":[{"type":"null"},{"$ref":"#/components/schemas/WorkerCancelReason"}]}}},
  "WorkerCancelReason": {"type":"string","enum":["rejected","failed"]},
  "ReportProgressRequest": {"type":"object","required":["message"],"properties":{"message":{"type":"string"},"percent":{"type":["integer","null"],"format":"int32","maximum":100,"minimum":0}}},
  "WorkerProgressReport": {"type":"object","required":["assignmentId","message","reportedAt"],"properties":{"assignmentId":{"type":"string","format":"uuid"},"message":{"type":"string"},"percent":{"type":["integer","null"],"format":"int32"},"reportedAt":{"type":"string","format":"date-time"}}},
  "SendMessageRequest": {"type":"object","required":["body"],"properties":{"attachmentIds":{"type":"array","items":{"type":"string","format":"uuid"}},"body":{"type":"string"},"clientRequestId":{"type":["string","null"]}}},
  "AssignmentMessage": {"type":"object","required":["messageId","assignmentId","senderAccountId","origin","body","createdAt"],"properties":{"assignmentId":{"type":"string","format":"uuid"},"body":{"type":"string"},"createdAt":{"type":"string","format":"date-time"},"messageId":{"type":"string","format":"uuid"},"origin":{"$ref":"#/components/schemas/MessageOrigin"},"senderAccountId":{"type":"string","format":"uuid"},"senderAgentId":{"type":["string","null"],"format":"uuid"}}},
  "ReserveFileRequest": {"type":"object","required":["filename","byteSize"],"properties":{"byteSize":{"type":"integer","format":"int64"},"filename":{"type":"string"},"link":{"type":"boolean"}}},
  "ReserveFileResponse": {"type":"object","required":["fileId","uploadUrl","directUploadUrl","byteSize","expiresInSecs"],"properties":{"byteSize":{"type":"integer","format":"int64"},"directUploadUrl":{"type":"string"},"expiresInSecs":{"type":"integer","format":"int64","minimum":0},"fileId":{"type":"string","format":"uuid"},"fileUrl":{"type":["string","null"]},"uploadUrl":{"type":"string"}}},
  "CompleteFileResponse": {"type":"object","required":["fileId","filename","byteSize","sha256","contentType"],"properties":{"byteSize":{"type":"integer","format":"int64"},"contentType":{"type":"string"},"fileId":{"type":"string","format":"uuid"},"filename":{"type":"string"},"sha256":{"type":"string"}}},
  "SubmitRequest": {"type":"object","required":["deliverableMarkdown"],"properties":{"deliverableMarkdown":{"type":"string"},"files":{"type":"array","items":{"type":"string"}}}},
  "ThreadMessage": {"allOf":[{"$ref":"#/components/schemas/AssignmentMessage"},{"type":"object","required":["attachments"],"properties":{"attachments":{"type":"array","items":{"$ref":"#/components/schemas/AttachmentBrief"}}}}]},
});

/* ------------------------------------------------------------------ */
/* A small validator for the schema subset above                      */
/* ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/**
 * Check a value against a schema of MARKET_SCHEMAS. `strict` also flags
 * object keys the schema does not name (used for request bodies, so a typo in
 * a field name fails the test instead of being silently ignored).
 * @returns {string[]} problems, empty when the value conforms
 */
export function validate(schemaOrName, value, { strict = false } = {}) {
  const check = (s, v, p) => {
    if (s && s.$ref) s = MARKET_SCHEMAS[s.$ref.split("/").pop()];
    if (!s || typeof s !== "object") return [];
    if (s.allOf) return s.allOf.flatMap((x) => check(x, v, p));
    if (s.oneOf) return s.oneOf.some((x) => check(x, v, p).length === 0) ? [] : [`${p}: matches none of oneOf`];
    const errs = [];
    if (s.type) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const t = typeOf(v);
      if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${p}: expected ${types.join("|")}, got ${t}`];
    }
    if (s.enum && !s.enum.includes(v)) errs.push(`${p}: ${JSON.stringify(v)} not in ${s.enum.join("|")}`);
    if (typeof v === "string" && s.format === "uuid" && !UUID.test(v)) errs.push(`${p}: not a uuid`);
    if (typeof v === "string" && s.format === "date-time" && Number.isNaN(Date.parse(v))) errs.push(`${p}: not a date-time`);
    if (typeof v === "number" && s.minimum != null && v < s.minimum) errs.push(`${p}: below ${s.minimum}`);
    if (typeof v === "number" && s.maximum != null && v > s.maximum) errs.push(`${p}: above ${s.maximum}`);
    if (typeOf(v) === "object") {
      for (const k of s.required || []) if (!(k in v)) errs.push(`${p}: missing required ${k}`);
      const props = s.properties || {};
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) errs.push(...check(props[k], x, `${p}.${k}`));
        else if (strict && s.properties) errs.push(`${p}: unknown field ${k}`);
      }
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...check(s.items, x, `${p}[${i}]`)));
    return errs;
  };
  return check(typeof schemaOrName === "string" ? { $ref: `#/components/schemas/${schemaOrName}` } : schemaOrName, value, "$");
}

/* ------------------------------------------------------------------ */
/* The market stand-in                                                 */
/* ------------------------------------------------------------------ */

export const MOCK_TOKEN = "aat_" + "0123456789abcdef".repeat(2);
const MAX_MARKDOWN = 256 * 1024;
const MAX_FILE = 100 * 1024 * 1024;

/**
 * In-process NEAR Agent Market stand-in over real HTTP (127.0.0.1, random port).
 * Worker-side routes follow the OpenAPI subset above; every request body is
 * checked against its request schema (strictly) and every JSON answer against
 * its response schema, and anything off is recorded in `violations`.
 *
 * Buyer-side helpers (hire, requestChanges, accept, cancel) change the state
 * directly, as the website would. `fault()` makes the next matching request
 * fail: `drop` handles it and then cuts the connection with no answer (the
 * request took effect, the caller cannot know), `status` answers an error
 * without handling it.
 */
export function createMarketMock({ token = MOCK_TOKEN, now = () => Date.now() } = {}) {
  const agentId = randomUUID();
  const ownerAccountId = randomUUID();
  const rows = new Map(); // assignmentId -> { assignment, job, latestMessage, messages, progress, versions, lastProgressAt }
  const files = new Map(); // fileId -> { fileId, filename, byteSize, token, link, bytes, completed, jobId }
  const requests = [];
  const violations = [];
  const faults = [];
  let url = null;
  let server = null;
  const iso = (ms = now()) => new Date(ms).toISOString();

  function hire({ title = "nanoodle workflow", description, priceUsd = "1.000000000000", escrowToken = "USD", slaSeconds = 3600, jobKind = "instant" }) {
    const t = now();
    const assignmentId = randomUUID();
    const jobId = randomUUID();
    rows.set(assignmentId, {
      assignment: {
        assignmentId, jobId, workerAgentId: agentId, bidId: null, status: "in_progress",
        escrowAmount: priceUsd, escrowToken, slaSeconds, slaDeadlineAt: iso(t + slaSeconds * 1000),
        acceptanceWindowDays: 3, createdAt: iso(t), updatedAt: iso(t),
        startedAt: null, submittedAt: null, deliverableUrl: null, deliverableHash: null,
        cancelReason: null, cancelDetail: null, finalizedAt: null,
      },
      job: { jobId, title, description, tags: ["workflow"], jobKind, status: "in_progress", attachments: [], entriesCloseAt: null },
      latestMessage: null, autoAcceptAt: null,
      messages: [], progress: [], versions: [], lastProgressAt: 0, refunded: false, seq: rows.size,
    });
    return assignmentId;
  }

  const touch = (r) => { r.assignment.updatedAt = iso(); };
  const pushMessage = (r, side, body, extra = {}) => {
    const m = {
      messageId: randomUUID(), assignmentId: r.assignment.assignmentId,
      senderAccountId: side === "worker" ? ownerAccountId : randomUUID(), senderAgentId: side === "worker" ? agentId : null,
      origin: "direct", body, createdAt: iso(), attachments: [], senderSide: side, ...extra,
    };
    r.messages.push(m);
    r.latestMessage = { senderSide: side, origin: "direct", body: body.slice(0, 4000), truncated: body.length > 4000, attachments: [], createdAt: m.createdAt };
    return m;
  };

  function requestChanges(id, body) {
    const r = rows.get(id);
    r.assignment.status = "in_progress";
    r.assignment.slaDeadlineAt = iso(now() + r.assignment.slaSeconds * 1000 + 1000 * (r.versions.length + 1));
    r.autoAcceptAt = null;
    touch(r);
    pushMessage(r, "buyer", body);
  }
  function accept(id) {
    const r = rows.get(id);
    r.assignment.status = "accepted";
    r.assignment.finalizedAt = iso();
    touch(r);
  }
  function cancel(id) {
    const r = rows.get(id);
    r.assignment.status = "cancelled";
    r.assignment.cancelReason = "buyer_cancelled";
    r.assignment.finalizedAt = iso();
    r.refunded = true;
    touch(r);
  }

  const publicAssignment = (r) => {
    const a = { ...r.assignment };
    if (a.deliverableUrl) a.deliverableUrl = `/v1/assignments/${a.assignmentId}/deliverable/raw`;
    return a;
  };
  const item = (r) => ({ assignment: publicAssignment(r), job: { ...r.job }, latestMessage: r.latestMessage, autoAcceptAt: r.autoAcceptAt });

  function resolveFileRef(ref) {
    const s = String(ref);
    for (const f of files.values()) {
      if (f.fileId === s || f.token === s || (f.link && s === `${url}/files/${f.token}/${f.filename}`)) return f;
    }
    return null;
  }

  function contentTypeOf(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", glb: "model/gltf-binary", md: "text/markdown", txt: "text/plain" }[ext] || "application/octet-stream";
  }

  /** Route one request. Returns { status, json?, headers? }. */
  function route(method, path, query, body, headers) {
    const err = (status, code, message, extra = {}) => ({ status, json: { error: code, ...(message ? { message } : {}), ...extra } });
    const bodyCheck = (schema) => {
      const v = validate(schema, body, { strict: true });
      if (v.length) { violations.push(`${method} ${path} request: ${v.join("; ")}`); return err(400, "validation_error", v.join("; ")); }
      return null;
    };

    let m;
    const storage = /^\/_storage\/([0-9a-f-]{36})$/.exec(path);
    if (storage && method === "PUT") {
      const f = files.get(storage[1]);
      if (!f) return { status: 404, text: "NoSuchUpload" };
      if (headers.authorization) violations.push("PUT to the presigned upload URL carried an Authorization header");
      if (!Buffer.isBuffer(body) || body.length !== f.byteSize) return { status: 400, text: `expected exactly ${f.byteSize} bytes` };
      f.bytes = Buffer.from(body);
      return { status: 200, text: "" };
    }
    if (method === "GET" && (m = /^\/files\/([^/]+)\/(.+)$/.exec(path))) {
      const f = [...files.values()].find((x) => x.token === m[1] && x.completed && x.link);
      return f ? { status: 200, raw: f.bytes, headers: { "content-type": contentTypeOf(f.filename) } } : { status: 404, text: "not found" };
    }

    if (headers.authorization !== `Bearer ${token}`) return err(401, "unauthorized");

    if (method === "GET" && path === "/v1/agents/me/assignments") {
      const status = query.get("status") || "in_progress";
      const limit = query.has("limit") ? Number(query.get("limit")) : 50;
      const offset = query.has("offset") ? Number(query.get("offset")) : 0;
      if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100) || !(Number.isInteger(offset) && offset >= 0)) return err(400, "validation_error", "limit 1..=100, offset >= 0");
      const statuses = MARKET_SCHEMAS.AssignmentStatus.enum;
      if (status !== "all" && !statuses.includes(status)) return err(400, "validation_error", "bad status filter");
      const list = [...rows.values()].filter((r) => status === "all" || r.assignment.status === status).sort((a, b) => b.seq - a.seq);
      return { status: 200, json: { assignments: list.slice(offset, offset + limit).map(item) }, schema: "MyAssignmentsResponse" };
    }

    if ((m = /^\/v1\/assignments\/([^/]+)\/(start|decline|progress|messages|submit)$/.exec(path)) && method === "POST") {
      const r = rows.get(m[1]);
      if (!r) return err(404, "not_found");
      const a = r.assignment;
      switch (m[2]) {
        case "start": {
          if (a.status !== "in_progress" && !a.startedAt) return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'started'`);
          if (!a.startedAt) { a.startedAt = iso(); touch(r); }
          return { status: 200, json: { startedAt: a.startedAt }, schema: "StartAssignmentResponse" };
        }
        case "decline": {
          const bad = bodyCheck("DeclineAssignmentRequest"); if (bad) return bad;
          if (!body.reason) return err(400, "validation_error", "an agent's decline needs a reason");
          if (r.job.jobKind === "competition") return err(400, "competition_entry");
          if (a.status !== "in_progress") return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'cancelled'`);
          if (body.reason === "rejected" && a.deliverableUrl) return err(400, "validation_error", "rejected after a delivery");
          if (body.detail != null && body.detail.length > 1000) return err(400, "validation_error", "detail over 1000 characters");
          a.status = "cancelled"; a.cancelReason = body.reason; a.cancelDetail = body.detail ?? null; a.finalizedAt = iso();
          r.refunded = true; touch(r);
          return { status: 200, json: publicAssignment(r), schema: "JobAssignment" };
        }
        case "progress": {
          const bad = bodyCheck("ReportProgressRequest"); if (bad) return bad;
          const msg = body.message.trim();
          if (msg.length < 1 || msg.length > 280) return err(400, "validation_error", "message 1-280 characters");
          if (a.status !== "in_progress") return err(400, "invalid_state_transition");
          const since = now() - r.lastProgressAt;
          if (r.lastProgressAt && since < 30_000) {
            const ra = Math.ceil((30_000 - since) / 1000);
            return { status: 409, json: { error: "progress_report_too_soon", message: "one report per 30 seconds", retry_after: ra }, headers: { "retry-after": String(ra) } };
          }
          r.lastProgressAt = now();
          const rep = { assignmentId: a.assignmentId, message: msg, percent: body.percent ?? null, reportedAt: iso() };
          r.progress.push(rep);
          return { status: 200, json: rep, schema: "WorkerProgressReport" };
        }
        case "messages": {
          const bad = bodyCheck("SendMessageRequest"); if (bad) return bad;
          if (a.status === "cancelled" || a.status === "accepted") return err(400, "invalid_state_transition");
          if (body.clientRequestId) {
            const prev = r.messages.find((x) => x.clientRequestId === body.clientRequestId);
            if (prev && prev.body !== body.body) return err(400, "validation_error", "clientRequestId reused with other text");
            if (prev) { const { senderSide, clientRequestId, ...wire } = prev; return { status: 201, json: wire, schema: "ThreadMessage" }; }
          }
          const msg = pushMessage(r, "worker", body.body, { clientRequestId: body.clientRequestId || null });
          const { senderSide, clientRequestId, ...wire } = msg;
          return { status: 201, json: wire, schema: "ThreadMessage" };
        }
        case "submit": {
          const bad = bodyCheck("SubmitRequest"); if (bad) return bad;
          const md = body.deliverableMarkdown;
          const size = Buffer.byteLength(md);
          if (size < 1 || size > MAX_MARKDOWN) return err(400, "invalid_deliverable", "1 byte to 256 KiB");
          const listed = body.files || [];
          const resolved = [];
          for (const [i, ref] of listed.entries()) {
            const f = resolveFileRef(ref);
            if (!f || !f.completed) return err(400, "invalid_attachment", `files[${i}]: unknown or unconfirmed`);
            if (f.jobId && f.jobId !== a.jobId) return err(400, "invalid_attachment", `files[${i}]: it is part of another job`);
            resolved.push(f);
          }
          if (resolved.length > 5) return err(400, "invalid_attachment", "at most 5 files");
          if (resolved.reduce((n, f) => n + f.byteSize, 0) > MAX_FILE) return err(400, "invalid_attachment", "files over 100 MiB together");
          const hash = createHash("sha256").update(md).digest("hex");
          const fileSet = resolved.map((f) => f.fileId).sort().join(",");
          const last = r.versions[r.versions.length - 1];
          if (a.status === "submitted" && last && last.hash === hash && last.fileSet === fileSet) {
            return { status: 200, json: publicAssignment(r), schema: "JobAssignment" }; // identical resubmission: a no-op
          }
          if (a.status !== "in_progress" && a.status !== "submitted") return err(400, "invalid_state_transition", `cannot transition from '${a.status}' to 'submitted'`);
          for (const f of resolved) f.jobId = a.jobId;
          r.versions.push({ version: r.versions.length + 1, markdown: md, hash, fileSet, files: resolved.map((f) => f.fileId), at: iso() });
          a.status = "submitted"; a.submittedAt = iso(); a.deliverableHash = hash; a.deliverableUrl = `deliverables/${a.assignmentId}/v${r.versions.length}.md`;
          r.autoAcceptAt = iso(now() + 3 * 86_400_000);
          touch(r);
          return { status: 200, json: publicAssignment(r), schema: "JobAssignment" };
        }
      }
    }

    if (method === "POST" && path === "/v1/files") {
      const bad = bodyCheck("ReserveFileRequest"); if (bad) return bad;
      if (!(Number.isInteger(body.byteSize) && body.byteSize > 0)) return err(400, "invalid_byte_size");
      if (body.byteSize > MAX_FILE) return err(413, "payload_too_large");
      if (/\.(exe|msi|dmg|sh|bat)$/i.test(body.filename)) return err(400, "invalid_file_type");
      const fileId = randomUUID();
      const tok = randomBytes(12).toString("hex");
      files.set(fileId, { fileId, filename: body.filename, byteSize: body.byteSize, token: tok, link: !!body.link, bytes: null, completed: false, jobId: null });
      return {
        status: 201,
        json: {
          fileId, byteSize: body.byteSize, expiresInSecs: 1800,
          uploadUrl: `${url}/_sink/${fileId}`, directUploadUrl: `${url}/_storage/${fileId}`,
          fileUrl: body.link ? `${url}/files/${tok}/${body.filename}` : null,
        },
        schema: "ReserveFileResponse",
      };
    }
    if ((m = /^\/v1\/files\/([^/]+)\/complete$/.exec(path)) && method === "POST") {
      const f = files.get(m[1]);
      if (!f) return err(404, "not_found");
      if (f.completed) return err(409, "upload_not_pending");
      if (!f.bytes) return err(400, "upload_incomplete");
      f.completed = true;
      return {
        status: 200,
        json: { fileId: f.fileId, filename: f.filename, byteSize: f.byteSize, sha256: createHash("sha256").update(f.bytes).digest("hex"), contentType: contentTypeOf(f.filename) },
        schema: "CompleteFileResponse",
      };
    }
    if ((m = /^\/v1\/files\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const f = files.get(m[1]);
      if (!f) return err(404, "not_found");
      if (f.jobId) return err(409, "file_bound");
      files.delete(m[1]);
      return { status: 204 };
    }
    return err(404, "not_found", `mock: no route for ${method} ${path}`);
  }

  async function onRequest(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, "http://x");
    let body;
    const isJson = /json/.test(req.headers["content-type"] || "");
    if (isJson) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = undefined; } } else body = raw.length ? raw : undefined;
    const entry = { method: req.method, path: u.pathname, query: u.search, body: isJson ? body : (raw.length ? `<${raw.length} bytes>` : undefined), auth: !!req.headers.authorization, at: now() };
    requests.push(entry);

    const fi = faults.findIndex((f) => f.method === req.method && f.path.test(u.pathname));
    const fault = fi >= 0 ? faults[fi] : null;
    if (fault && --fault.times <= 0) faults.splice(fi, 1);
    if (fault && fault.mode === "status") {
      entry.fault = `status ${fault.status}`;
      res.writeHead(fault.status, { "content-type": "application/json" });
      res.end(JSON.stringify(fault.body || { error: "internal_error" }));
      return;
    }
    const out = route(req.method, u.pathname, u.searchParams, body, req.headers);
    entry.status = out.status;
    if (out.schema && out.status < 300) {
      const v = validate(out.schema, out.json);
      if (v.length) violations.push(`${req.method} ${u.pathname} response: ${v.join("; ")}`);
    }
    if (fault && fault.mode === "drop") {
      entry.fault = "response dropped";
      req.socket.destroy(); // the request took effect; the caller never hears back
      return;
    }
    if (out.raw) { res.writeHead(out.status, out.headers || {}); res.end(out.raw); return; }
    if (out.json !== undefined) {
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers || {}) });
      res.end(JSON.stringify(out.json));
      return;
    }
    res.writeHead(out.status, { "content-type": "text/plain" });
    res.end(out.text || "");
  }

  return {
    agentId,
    rows,
    files,
    requests,
    violations,
    hire, requestChanges, accept, cancel,
    get url() { return url; },
    /** Make the next `times` requests matching method + path fail. mode "drop" (handled, no answer) or "status". */
    fault({ method, path, mode = "drop", status = 503, body = null, times = 1 }) {
      faults.push({ method, path, mode, status, body, times });
    },
    /** Requests matching method + path (a RegExp). */
    calls(method, path) { return requests.filter((r) => r.method === method && path.test(r.path)); },
    async listen() {
      server = http.createServer((req, res) => { onRequest(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch { /* gone */ } }); });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${server.address().port}`;
      return url;
    },
    async close() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      server = null;
    },
  };
}
