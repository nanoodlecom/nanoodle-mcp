/**
 * NEAR Agent Market REST client for the worker side (an `aat_` agent token).
 *
 * Endpoints and field names follow https://market.near.ai/openapi.json
 * ("agents-market API" 2.0.0) and the worker guides at
 * https://market.near.ai/skill/flows/worker-lifecycle.md:
 *
 *   GET  /v1/agents/me/assignments?status&limit&offset   { assignments: [{ assignment, job, latestMessage }] }
 *   POST /v1/assignments/{id}/start                      { startedAt }            (idempotent)
 *   POST /v1/assignments/{id}/decline   { reason: "rejected"|"failed", detail }  (full buyer refund)
 *   POST /v1/assignments/{id}/progress  { message, percent? }                    (1 per 30 s)
 *   POST /v1/assignments/{id}/messages  { body, clientRequestId? }               (idempotent by id)
 *   POST /v1/files                      { filename, byteSize, link }  -> { fileId, directUploadUrl, uploadUrl, fileUrl }
 *   PUT  <directUploadUrl>              exactly byteSize bytes, no extra headers
 *   POST /v1/files/{id}/complete
 *   DELETE /v1/files/{id}
 *   POST /v1/assignments/{id}/submit    { deliverableMarkdown, files? }
 *
 * The token is held in a closure and is never logged, echoed or put in an
 * error message. It is sent only to the configured base URL, never to an
 * upload URL.
 */

export class MarketApiError extends Error {
  /**
   * @param {string} message
   * @param {object} f
   * @param {number|null} f.status     HTTP status, or null when no response arrived
   * @param {string|null} f.code       the body's `error` code, when it has one
   * @param {boolean} f.uncertain      true when the request may have taken effect (no response, timeout, 5xx)
   * @param {number|null} f.retryAfter seconds, from `retry_after` or the Retry-After header
   */
  constructor(message, { status = null, code = null, uncertain = false, retryAfter = null } = {}) {
    super(message);
    this.name = "MarketApiError";
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
    this.retryAfter = retryAfter;
  }
  /** Worth retrying unchanged later: no answer, a 5xx, or a 429. */
  get retryable() {
    return this.status == null || this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
const seg = (id) => {
  const s = String(id ?? "");
  if (!UUID_RE.test(s)) throw new TypeError(`not an id: ${JSON.stringify(s).slice(0, 80)}`);
  return encodeURIComponent(s);
};

/**
 * @param {object} o
 * @param {string} o.baseUrl     e.g. https://market.near.ai
 * @param {string} o.token       aat_… agent token
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.timeoutMs] per request (default 30 s; uploads 10 min)
 */
export function createMarketClient({ baseUrl, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000, uploadTimeoutMs = 600_000 }) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new TypeError("createMarketClient needs an http(s) baseUrl");
  if (typeof token !== "string" || !token.trim()) throw new TypeError("createMarketClient needs an agent token");
  const base = baseUrl.replace(/\/+$/, "");
  const auth = `Bearer ${token.trim()}`;

  async function call(method, path, body, { expect = [200, 201, 204] } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { authorization: auth, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      throw new MarketApiError(`${method} ${path}: no response (${e && e.name === "AbortError" ? "timeout" : "network error"})`, { uncertain: true });
    } finally {
      clearTimeout(timer);
    }
    let text = "";
    try { text = await res.text(); } catch {
      throw new MarketApiError(`${method} ${path}: response body lost`, { status: res.status, uncertain: true });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!expect.includes(res.status)) {
      const code = json && typeof json.error === "string" ? json.error : null;
      const msg = json && typeof json.message === "string" ? json.message : (code || text.slice(0, 200));
      const ra = json && Number.isFinite(+json.retry_after) ? +json.retry_after
        : Number.isFinite(+res.headers.get("retry-after")) && res.headers.get("retry-after") !== null ? +res.headers.get("retry-after") : null;
      throw new MarketApiError(`${method} ${path}: HTTP ${res.status}${code ? ` ${code}` : ""}${msg && msg !== code ? `: ${String(msg).slice(0, 300)}` : ""}`, {
        status: res.status, code, uncertain: res.status >= 500, retryAfter: ra,
      });
    }
    return json;
  }

  return {
    baseUrl: base,

    /** One page of the agent's assignments (`status` defaults to in_progress on the server). */
    async listAssignments({ status = null, limit = 50, offset = 0 } = {}) {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      q.set("limit", String(limit));
      q.set("offset", String(offset));
      const r = await call("GET", `/v1/agents/me/assignments?${q}`);
      if (!r || !Array.isArray(r.assignments)) throw new MarketApiError("GET /v1/agents/me/assignments: unexpected response shape", { status: 200, uncertain: false });
      return r.assignments;
    },

    /** Every in_progress row (pages of 100, at most `maxPages`). */
    async listActionable({ maxPages = 10 } = {}) {
      const out = [];
      for (let p = 0; p < maxPages; p++) {
        const rows = await this.listAssignments({ status: "in_progress", limit: 100, offset: p * 100 });
        out.push(...rows);
        if (rows.length < 100) break;
      }
      return out;
    },

    /** The row for one assignment in any status, or null (searches `status=all`, newest first). */
    async findAssignment(id, { maxPages = 20 } = {}) {
      for (let p = 0; p < maxPages; p++) {
        const rows = await this.listAssignments({ status: "all", limit: 100, offset: p * 100 });
        const hit = rows.find((r) => r && r.assignment && r.assignment.assignmentId === id);
        if (hit) return hit;
        if (rows.length < 100) return null;
      }
      return null;
    },

    /** One page of the public job board: jobs still taking bids, newest first. */
    async listBoard({ q = null, kind = "standard", limit = 100, offset = 0 } = {}) {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (kind) p.set("kind", kind);
      p.set("sort", "recent");
      p.set("limit", String(limit));
      p.set("offset", String(offset));
      const r = await call("GET", `/v1/jobs/board?${p}`);
      if (!r || !Array.isArray(r.jobs)) throw new MarketApiError("GET /v1/jobs/board: unexpected response shape", { status: 200, uncertain: false });
      return r.jobs;
    },
    /** Bid on a board job as this agent. `amount` is a decimal string in the job's token. */
    placeBid: (jobId, { amount, proposal, slaSeconds = null }) => call("POST", `/v1/jobs/${seg(jobId)}/bids`, {
      amount: String(amount), proposal: String(proposal).slice(0, 8000), ...(Number.isInteger(slaSeconds) ? { slaSeconds } : {}),
    }),

    start: (id) => call("POST", `/v1/assignments/${seg(id)}/start`),
    decline: (id, { reason, detail }) => call("POST", `/v1/assignments/${seg(id)}/decline`, { reason, detail: String(detail || "").slice(0, 1000) }),
    progress: (id, { message, percent = null }) => call("POST", `/v1/assignments/${seg(id)}/progress`, {
      message: String(message).trim().slice(0, 280),
      ...(Number.isInteger(percent) ? { percent: Math.max(0, Math.min(100, percent)) } : {}),
    }),
    message: (id, { body, clientRequestId = null }) => call("POST", `/v1/assignments/${seg(id)}/messages`, {
      body: String(body),
      ...(clientRequestId ? { clientRequestId: String(clientRequestId).slice(0, 128) } : {}),
    }),
    submit: (id, { deliverableMarkdown, files = [] }) => call("POST", `/v1/assignments/${seg(id)}/submit`, {
      deliverableMarkdown, ...(files.length ? { files } : {}),
    }),

    reserveFile: ({ filename, byteSize }) => call("POST", "/v1/files", { filename, byteSize, link: true }),
    completeFile: (fileId) => call("POST", `/v1/files/${seg(fileId)}/complete`),
    deleteFile: (fileId) => call("DELETE", `/v1/files/${seg(fileId)}`),

    /**
     * PUT the bytes to the reserve call's presigned `directUploadUrl`: exactly
     * byteSize bytes and no extra headers (no Authorization: the URL is the
     * credential, and the token must never leave the market's own origin).
     */
    async uploadBytes(reservation, bytes) {
      const target = reservation.directUploadUrl || reservation.uploadUrl;
      if (typeof target !== "string" || !target) throw new MarketApiError("file reservation has no upload URL", { status: 200 });
      const url = new URL(target, base + "/").toString();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), uploadTimeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { method: "PUT", body: bytes, signal: ac.signal });
      } catch (e) {
        throw new MarketApiError(`upload: no response (${e && e.name === "AbortError" ? "timeout" : "network error"})`, { uncertain: true });
      } finally {
        clearTimeout(timer);
      }
      try { await res.arrayBuffer(); } catch { /* body is irrelevant */ }
      if (res.status < 200 || res.status >= 300) {
        throw new MarketApiError(`upload: HTTP ${res.status}`, { status: res.status, uncertain: res.status >= 500 });
      }
    },
  };
}
