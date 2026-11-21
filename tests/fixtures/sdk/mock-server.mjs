import http from "node:http";

/**
 * Mock NanoGPT server for offline tests. Zero deps (node:http).
 *
 * - Records EVERY request: { method, path, query, headers, json, text, raw } → srv.requests
 * - Scriptable per-route: srv.script("POST /api/v1/chat/completions", handler)
 *   handler = response object | array of response objects (a sequence; the last repeats)
 *           | (req) => response object
 *   response object = { status?=200, headers?={}, json? , body? (string|Buffer), delayMs? }
 *
 * Usage:
 *   const srv = await startMockServer();
 *   srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });
 *   ... run workflow with { baseUrl: srv.url } ...
 *   await srv.close();
 */
export async function startMockServer() {
  const requests = [];
  const scripts = new Map();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, "http://mock");
    let json = null;
    try { json = JSON.parse(raw.toString("utf8")); } catch { /* not JSON (multipart/binary) */ }
    const rec = {
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      json,
      text: raw.toString("utf8"),
      raw,
    };
    requests.push(rec);

    const key = req.method + " " + u.pathname;
    let handler = scripts.get(key);
    if (Array.isArray(handler)) handler = handler.length > 1 ? handler.shift() : handler[0];
    if (typeof handler === "function") handler = await handler(rec);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock: no script for " + key }));
      return;
    }
    if (handler.delayMs) await new Promise((r) => setTimeout(r, handler.delayMs));
    const status = handler.status || 200;
    const headers = { ...handler.headers };
    let body;
    if (handler.json !== undefined) {
      headers["content-type"] = headers["content-type"] || "application/json";
      body = JSON.stringify(handler.json);
    } else {
      body = handler.body != null ? handler.body : "";
    }
    res.writeHead(status, headers);
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Requests for one route key ("POST /path"). */
    of(key) {
      const [method, path] = key.split(" ");
      return requests.filter((r) => r.method === method && r.path === path);
    },
    script(key, handler) { scripts.set(key, handler); return this; },
    reset() { requests.length = 0; scripts.clear(); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* ---- canned bits shared by tests ---- */

/** 1x1 transparent PNG (base64, starts with iVBOR → sniffs image/png). */
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = "data:image/png;base64," + PNG_B64;

/** minimal silent WAV (RIFF header + empty data chunk). */
export const WAV_B64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
export const WAV_DATA_URL = "data:audio/wav;base64," + WAV_B64;

/** Chat-completions response with a text answer + x_nanogpt_pricing cost. */
export function chatJson(text, { costUsd = 0.0012, remainingBalance = 4.5, extra } = {}) {
  return {
    json: {
      choices: [{ message: { content: text } }],
      x_nanogpt_pricing: { costUsd, remainingBalance },
      ...extra,
    },
  };
}

/** Standard workflow options pointing a Workflow at the mock (fast polls, short timeouts). */
export function mockOpts(srv, extra = {}) {
  return {
    apiKey: "test-key",
    baseUrl: srv.url,
    pollIntervals: { video: 10, audio: 5 },
    timeouts: { video: 2000, audio: 1000 },
    quiet: true,
    ...extra,
  };
}
