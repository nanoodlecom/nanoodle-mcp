/**
 * --serve: the stdio MCP server over streamable HTTP, plus the human-facing
 * payment surface. One node:http server, zero dependencies:
 *
 *   POST /mcp            MCP streamable HTTP (stateless): one JSON-RPC message in,
 *                        its response out. Notifications → 202. The same
 *                        createDispatcher() that powers stdio handles everything.
 *                        tools/call from an SSE-capable client answers as an
 *                        event stream with progress heartbeats — generations
 *                        and payment waits outlive client tool timeouts.
 *   GET  /               landing page: tool list w/ prices, per-workflow editor links,
 *                        the one-line connect command, self-hosting + author-payout story
 *   GET  /graph/:name.json  a served workflow's raw graph JSON, exactly as loaded
 *   GET  /pay/:id        self-contained pay page — QR code, exact amount, live status
 *   GET  /x402/status/:id  quote status JSON; ?wait=1 long-polls up to 25s
 *   GET  /out/:file      generated media (unguessable filenames), when an outDir is given
 *
 * POST requires Content-Type: application/json — browsers can't send that
 * cross-origin without a CORS preflight, which (with the default localhost
 * bind) is the DNS-rebinding guard. There is no session state to steal and no
 * cookie auth; on a paid server, the payment itself is the authorization.
 */
import http from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { qrModules } from "nanoodle";
import { createDispatcher } from "./server.mjs";

const MAX_BODY = 32 * 1024 * 1024; // media inputs may ride inline as data: URLs

const OUT_MIME = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** QR matrix → crisp inline SVG (one path, viewBox-scaled). */
export function qrSvg(text) {
  const m = qrModules(text);
  const n = m.length;
  const margin = 3;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  }
  const size = n + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const PAGE_CSS = `
  :root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fafafa;--muted:#666;--card:#fff;--edge:#e2e2e2;--ok:#0a8f4a}
  @media(prefers-color-scheme:dark){:root{--fg:#eee;--bg:#141414;--muted:#9a9a9a;--card:#1e1e1e;--edge:#333;--ok:#3ecf7a}}
  *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);
    display:flex;justify-content:center;padding:2rem 1rem}
  main{max-width:44rem;width:100%}
  .card{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:1.5rem;margin:1rem 0}
  h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.05rem}
  .muted{color:var(--muted);font-size:.9rem}
  code,pre{font:.85rem/1.5 ui-monospace,monospace;background:rgba(128,128,128,.12);border-radius:6px}
  code{padding:.1rem .35rem;word-break:break-all}
  pre{padding:.75rem 1rem;overflow-x:auto}
  button{font:inherit;padding:.35rem .8rem;border-radius:8px;border:1px solid var(--edge);background:var(--card);color:var(--fg);cursor:pointer}
  .qr{width:min(280px,80vw);margin:1rem auto;display:block;border-radius:8px;overflow:hidden}
  .amount{font-size:1.6rem;font-weight:600;text-align:center}
  .ok{color:var(--ok)}
  .center{text-align:center}
  ul{padding-left:1.2rem}li{margin:.35rem 0}
`;

const htmlPage = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;

function landingHtml({ name, version, listTools, publicBase, charged, toolInfo = [] }) {
  const tools = listTools().filter((t) => t.name !== "run_noodle");
  const infoByName = new Map(toolInfo.map((t) => [t.name, t]));
  const items = tools.map((t) => {
    const info = infoByName.get(t.name);
    const links = info ? ` <span class="muted">— <a href="${esc(info.editorUrl)}">open in editor</a>` +
      ` · <a href="/graph/${esc(encodeURIComponent(t.name))}.json">graph JSON</a></span>` : "";
    const author = info && info.x402 && info.x402.author
      ? `<div class="muted">author payout: <code>${esc(info.x402.author)}</code></div>` : "";
    return `<li><code>${esc(t.name)}</code>${links}<div class="muted">${esc(t.description)}</div>${author}</li>`;
  }).join("");
  return htmlPage(name, `
    <h1>${esc(name)} <span class="muted">v${esc(version)}</span></h1>
    <p class="muted">AI workflow tools over MCP${charged
      ? " — pay per call in Nano (XNO). No signup, no API key, no card."
      : ""}. Built with <a href="https://nanoodle.com">nanoodle</a>.</p>
    <div class="card"><h2>Connect from Claude Code</h2>
      <pre>claude mcp add --transport http noodles ${esc(publicBase)}/mcp</pre>
      ${charged ? `<p class="muted">Then just ask for what you want. When a tool needs payment, your agent
      shows you a link with a QR code — scan it with any Nano wallet and the result streams back seconds later.
      Failed runs are refunded automatically.</p>
      <p class="muted">What you pay up front is a <strong>deposit</strong>: each run settles at the model's
      metered cost + 20%, and the difference is returned to your wallet on-chain. The 20% is the
      <strong>workflow author's cut</strong>, not a platform fee.</p>` : ""}
    </div>
    <div class="card"><h2>Workflows (${tools.length})</h2>
      <p class="muted">Every workflow is a plain <code>noodle-graph.json</code> — open it in the
      <a href="https://nanoodle.com">nanoodle editor</a> to see exactly how it works, remix it, or run it
      on your own key.</p>
      <ul>${items}</ul></div>
    ${charged ? `<div class="card"><h2>Workflow authors earn the 20%</h2>
      <p class="muted">A graph that declares a Nano address (<code>"x402": {"author": "nano_…"}</code> in its
      JSON) receives the full 20% markup of every paid run, paid out on-chain automatically. The public
      library behind this server is <a href="https://github.com/nanoodlecom/awesome-noodles">awesome-noodles</a> —
      add your workflow there with your address to get listed and earn on every run.</p>
    </div>` : ""}
    <div class="card"><h2>Open source — host your own</h2>
      <p class="muted">This whole stack is MIT-licensed: the
      <a href="https://github.com/nanoodlecom/nanoodle-mcp">server</a>, the
      <a href="https://github.com/nanoodlecom/nanoodle">editor</a>, and every workflow above
      (grab any graph JSON). One command turns your own folder of graphs into a server exactly like this one:</p>
      <pre>npx nanoodle-mcp --graphs ./noodles --serve 8402</pre>
      <p class="muted">Add <code>--charge-usd 0.05 --public-url https://your-host</code> and a Nano wallet to
      charge per call — see the <a href="https://github.com/nanoodlecom/nanoodle-mcp#serve-mode--host-your-noodles-as-a-service---serve">README</a>.</p>
    </div>
  `);
}

function payPageHtml(q) {
  const statusUrl = `/x402/status/${encodeURIComponent(q.id)}?wait=1`;
  return htmlPage(`Pay ${q.amountXno} XNO`, `
    <div class="card center" id="paybox">
      <h1>Pay ${esc(q.amountXno)} XNO <span class="muted">(≈$${esc(q.usd.toFixed(q.usd < 0.01 ? 4 : 2))})</span></h1>
      <p class="muted">for one run of <code>${esc(q.tool)}</code> — scan with any Nano wallet</p>
      <a class="qr" href="${esc(q.uri)}">${qrSvg(q.uri)}</a>
      <p><button onclick="navigator.clipboard.writeText('${esc(q.address)}')">copy address</button>
         <button onclick="navigator.clipboard.writeText('${esc(q.amountXno)}')">copy amount</button></p>
      <p class="muted">Send <strong>exactly ${esc(q.amountXno)} XNO</strong> — the exact amount identifies your payment.<br>
         Address: <code>${esc(q.address)}</code><br>Amount: <code>${esc(q.amountXno)}</code> XNO (<code>${esc(q.amountRaw)}</code> raw)</p>
      <p class="muted" id="status">waiting for payment… settles in about a second</p>
      <p class="muted" id="expiry"></p>
    </div>
    <script>
      const EXP = Date.parse(${JSON.stringify(q.expiresAt)});
      function tickExpiry(){
        const el = document.getElementById("expiry");
        if(!el) return; // paybox was replaced by the paid check
        const s = Math.max(0, Math.floor((EXP - Date.now())/1000));
        el.textContent = s > 0
          ? "quote expires in " + Math.floor(s/60) + ":" + String(s%60).padStart(2,"0")
          : "quote expired — ask your agent for a fresh one";
        if(s > 0) setTimeout(tickExpiry, 1000);
      }
      tickExpiry();
    </script>
    <script>
      async function poll(){
        try{
          const r = await fetch(${JSON.stringify(statusUrl)});
          const j = await r.json();
          if(j.status === "paid" || j.status === "consumed"){
            document.getElementById("paybox").innerHTML =
              '<h1 class="ok">✓ Paid</h1><p>All set — go back to your terminal and tell your agent you paid.</p>';
            return;
          }
          if(j.status === "expired" || j.status === "unknown"){
            document.getElementById("status").textContent = "this quote expired — ask your agent for a fresh one";
            return;
          }
        }catch{}
        setTimeout(poll, 1000);
      }
      poll();
    </script>
  `);
}

/**
 * @param {object} opts
 * @param {string} opts.host  bind address (default 127.0.0.1 — use 0.0.0.0 behind a reverse proxy)
 * @param {number} opts.port
 * @param {object|null} [opts.gate]  charge gate (createChargeGate) — null serves free
 * @param {Array} [opts.toolInfo]  registry.tools — per-tool editorUrl/rawText/x402 for the landing page and /graph/:name.json
 * @param {string|null} [opts.outDir]  when set, /out/<file> serves generated media from it
 * @param {number} [opts.progressMs]  heartbeat interval on streamed tools/call responses
 * @returns {Promise<http.Server>}
 */
export async function serveHttp({
  host = "127.0.0.1",
  port,
  name,
  version,
  listTools,
  callTool,
  instructions,
  gate = null,
  toolInfo = [],
  outDir = null,
  publicBase,
  progressMs = 10_000,
  log = (...a) => console.error(...a),
}) {
  const dispatch = createDispatcher({ name, version, listTools, callTool, instructions, log });
  const graphByName = new Map(toolInfo.filter((t) => t.rawText).map((t) => [t.name, t.rawText]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    };

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
        });
        return res.end();
      }

      if (url.pathname === "/mcp") {
        if (req.method === "GET") return send(405, JSON.stringify({ error: "no server-initiated stream — POST JSON-RPC messages here" }));
        if (req.method !== "POST") return send(405, JSON.stringify({ error: "POST only" }));
        if (!/^application\/json\b/.test(req.headers["content-type"] || "")) {
          return send(415, JSON.stringify({ error: "Content-Type must be application/json" }));
        }
        const chunks = [];
        let len = 0;
        for await (const c of req) {
          len += c.length;
          if (len > MAX_BODY) return send(413, JSON.stringify({ error: "body too large" }));
          chunks.push(c);
        }
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return send(400, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })); }

        /*
         * tools/call from an SSE-capable client streams: heartbeats every
         * progressMs — MCP progress notifications when the client sent a
         * progressToken (clients reset their tool timeout on these), plain SSE
         * comments otherwise (keeps proxies from idling the socket) — then the
         * final response. A generation or payment wait can take minutes; a
         * silent held-open POST is exactly what client timeouts kill.
         */
        const isCall = msg && typeof msg === "object" && msg.method === "tools/call" && msg.id !== null && msg.id !== undefined;
        if (isCall && /\btext\/event-stream\b/i.test(req.headers.accept || "")) {
          const progressToken = msg.params && msg.params._meta ? msg.params._meta.progressToken : undefined;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
          });
          const event = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); };
          const t0 = Date.now();
          const ctx = { streaming: true, status: "working", report(s) { this.status = s; } };
          let ticks = 0;
          const beat = setInterval(() => {
            const line = `${ctx.status} (${Math.round((Date.now() - t0) / 1000)}s elapsed)`;
            if (progressToken !== undefined) {
              event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++ticks, message: line } });
            } else if (!res.writableEnded && !res.destroyed) {
              res.write(`: ${line}\n\n`); // SSE comment — connection warmth without protocol noise
            }
          }, progressMs);
          if (beat.unref) beat.unref();
          try {
            const response = await dispatch(msg, ctx);
            if (response) event(response);
          } finally {
            clearInterval(beat);
            if (!res.writableEnded && !res.destroyed) res.end();
          }
          return;
        }

        const response = await dispatch(msg);
        if (!response) { res.writeHead(202, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
        return send(200, JSON.stringify(response));
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(405, JSON.stringify({ error: "method not allowed" }));

      if (url.pathname === "/") {
        return send(200, landingHtml({ name, version, listTools, publicBase, charged: !!gate, toolInfo }), "text/html; charset=utf-8");
      }

      const graphMatch = url.pathname.match(/^\/graph\/([^/]+)\.json$/);
      if (graphMatch) {
        const raw = graphByName.get(decodeURIComponent(graphMatch[1]));
        if (!raw) return send(404, JSON.stringify({ error: "not found" }));
        return send(200, raw, "application/json; charset=utf-8");
      }

      const payMatch = url.pathname.match(/^\/pay\/([^/]+)$/);
      if (payMatch && gate) {
        const q = gate.quote(decodeURIComponent(payMatch[1]));
        if (!q) return send(404, htmlPage("Not found", "<h1>Unknown or expired payment</h1><p class=\"muted\">Ask your agent for a fresh quote.</p>"), "text/html; charset=utf-8");
        return send(200, payPageHtml(q), "text/html; charset=utf-8");
      }

      const statusMatch = url.pathname.match(/^\/x402\/status\/([^/]+)$/);
      if (statusMatch && gate) {
        const id = decodeURIComponent(statusMatch[1]);
        if (url.searchParams.get("wait")) await gate.waitForPayment(id, 25_000);
        const q = gate.quote(id);
        return send(200, JSON.stringify(q ? { status: q.status, amountRaw: q.amountRaw, expiresAt: q.expiresAt } : { status: "unknown" }));
      }

      const outMatch = url.pathname.match(/^\/out\/([^/]+)$/);
      if (outMatch && outDir) {
        const file = basename(decodeURIComponent(outMatch[1])); // basename() forbids traversal
        const path = join(outDir, file);
        if (!existsSync(path)) return send(404, JSON.stringify({ error: "not found" }));
        const ext = file.split(".").pop().toLowerCase();
        res.writeHead(200, {
          "Content-Type": OUT_MIME[ext] || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "private, max-age=86400",
        });
        if (req.method === "HEAD") return res.end();
        return createReadStream(path).on("error", () => res.destroy()).pipe(res);
      }

      return send(404, JSON.stringify({ error: "not found" }));
    } catch (e) {
      log(`nanoodle-mcp: http error on ${req.method} ${req.url}: ${(e && e.stack) || e}`);
      if (!res.headersSent) send(500, JSON.stringify({ error: "internal error" }));
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}
