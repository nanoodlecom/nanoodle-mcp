/**
 * Minimal MCP server core — JSON-RPC 2.0, no package dependencies.
 *
 * Protocol surface (the whole point is that this file is small enough to read):
 *   initialize                → protocolVersion + capabilities.tools (listChanged) + serverInfo
 *                               (serverInfo.commit is the git short sha when this checkout has one)
 *   notifications/initialized → no response (notifications never get one)
 *   ping                      → {}
 *   tools/list                → tools from the registry
 *   tools/call                → registry.callTool(); run failures become isError content
 *   anything else             → -32601 (requests only)
 *
 * createDispatcher() is the transport-free core: one JSON-RPC message in, one
 * response (or null) out. serveMcp() wraps it in newline-delimited stdio;
 * src/http.mjs wraps the same dispatcher in streamable HTTP for --serve.
 *
 * stdio mode: stdout carries protocol frames ONLY (one JSON object per line).
 * All logging → stderr.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { explicitNsfwFlag } from "./nsfw.mjs";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

/** Package root (parent of src/) — `git -C` here, not process.cwd(), so a server started elsewhere still reports its own checkout. */
const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

let cachedCommit;
/**
 * Short git SHA of this checkout (at least 7 hex digits), or null when git
 * can't answer (packaged install with no .git). Cached for the process.
 * Pass `commit` into createDispatcher / serveHttp to override.
 */
export function gitShortSha() {
  if (cachedCommit !== undefined) return cachedCommit;
  try {
    const sha = execFileSync("git", ["-C", PKG_ROOT, "rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    cachedCommit = /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    cachedCommit = null;
  }
  return cachedCommit;
}

/** Mcp-Session-Id, or "" when missing / not a single short string. */
function sessionIdOf(ctx) {
  const raw = ctx && ctx.sessionId;
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string") return "";
  const t = s.trim();
  if (!t || t.length > 200) return "";
  return t;
}

/** params.nsfw when the key was sent, else undefined (so a missing key is not a flag). */
function paramsNsfw(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  return Object.prototype.hasOwnProperty.call(params, "nsfw") ? params.nsfw : undefined;
}

/**
 * Build the transport-free message handler.
 * @param {object} opts
 * @param {string} opts.name        serverInfo.name
 * @param {string} opts.version     serverInfo.version
 * @param {string|null} [opts.commit]  serverInfo.commit — short git sha. Omit to read this checkout; null to suppress.
 * @param {() => Array} opts.listTools
 * @param {(params: object, ctx?: object|null) => Promise<object>} opts.callTool  may throw; err.mcpCode → JSON-RPC error
 * @param {string} [opts.instructions]  server-level guidance surfaced to the client on initialize
 * @param {boolean} [opts.rememberSessionNsfw]  stdio only. initialize params.nsfw === true opts this
 *   one connection in. Leave false on a shared HTTP dispatcher — one caller's initialize must not
 *   enable NSFW for every later caller. HTTP sessions are keyed by ctx.sessionId instead.
 * @param {(...args) => void} [opts.log]
 * @returns {(msg: any, ctx?: object|null) => Promise<object|null>} resolves to a JSON-RPC response,
 *   or null when the message is a notification (or a malformed non-request) and gets no reply.
 *   `ctx` (optional) rides through to callTool — a streaming transport passes { streaming, report }
 *   so long-running tools can surface progress. The dispatcher sets ctx.sessionNsfw from the
 *   explicit session latch; a caller-supplied sessionNsfw is overwritten.
 */
export function createDispatcher({ name, version, commit, listTools, callTool, instructions, rememberSessionNsfw = false, log = (...a) => console.error(...a) }) {
  const sha = commit === undefined ? gitShortSha() : (commit || null);
  const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  // Stdio is one caller. HTTP must not use this latch — it shares one dispatcher.
  let connectionNsfw = false;
  /** sessionId → true, only after initialize with an explicit nsfw: true. */
  const sessionNsfw = new Map();

  const sessionOn = (ctx) => {
    const sid = sessionIdOf(ctx);
    return (rememberSessionNsfw && connectionNsfw) || (sid !== "" && sessionNsfw.get(sid) === true);
  };

  return async function dispatch(msg, ctx = null) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
      // includes JSON-RPC batches — removed from MCP as of 2025-06-18
      return fail(null, -32600, "invalid request — expected a single JSON-RPC 2.0 object");
    }
    const { id, method, params } = msg;
    const isRequest = "id" in msg && id !== null && id !== undefined;
    if (typeof method !== "string") {
      return isRequest ? fail(id, -32600, "invalid request — missing method") : null;
    }

    try {
      if (method === "initialize") {
        // Only the explicit flag. clientInfo, a prompt, or a spicy model name cannot opt the session in.
        const flag = explicitNsfwFlag(paramsNsfw(params));
        const sid = sessionIdOf(ctx);
        if (flag === true && sid) {
          if (sessionNsfw.size >= 1024) sessionNsfw.delete(sessionNsfw.keys().next().value);
          sessionNsfw.set(sid, true);
        } else if (flag === false && sid) {
          sessionNsfw.delete(sid);
        }
        if (rememberSessionNsfw) {
          if (flag === true) connectionNsfw = true;
          else if (flag === false) connectionNsfw = false;
        }
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name, version, ...(sha ? { commit: sha } : {}) },
          ...(instructions ? { instructions } : {}),
        });
      }
      if (method.startsWith("notifications/")) return null; // notifications/initialized, cancelled, ... — never answered
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: listTools() });
      if (method === "tools/call") {
        try {
          const nextCtx = { ...(ctx && typeof ctx === "object" ? ctx : {}), sessionNsfw: sessionOn(ctx) };
          return reply(id, await callTool(params, nextCtx));
        } catch (e) {
          if (e && e.mcpCode) return fail(id, e.mcpCode, e.message); // malformed args → -32602
          // the tool ran and failed (RunError, missing key, network, ...) → tool-level error result
          return reply(id, { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true });
        }
      }
      return isRequest ? fail(id, -32601, `method not found: ${method}`) : null;
    } catch (e) {
      log(`nanoodle-mcp: internal error handling ${method}: ${(e && e.stack) || e}`);
      return isRequest ? fail(id, -32603, "internal error: " + ((e && e.message) || e)) : null;
    }
  };
}

/**
 * @param {object} opts
 * @param {import("stream").Readable} [opts.input]  defaults to process.stdin
 * @param {import("stream").Writable} [opts.output] defaults to process.stdout
 * @param {string} opts.name        serverInfo.name
 * @param {string} opts.version     serverInfo.version
 * @param {() => Array} opts.listTools
 * @param {(params: object) => Promise<object>} opts.callTool  may throw; err.mcpCode → JSON-RPC error
 * @param {(...args) => void} [opts.log]  stderr logger
 * @param {() => void} [opts.onClose]     called when stdin ends (default: exit 0)
 */
export function serveMcp({
  input = process.stdin,
  output = process.stdout,
  name,
  version,
  listTools,
  callTool,
  instructions,
  log = (...a) => console.error(...a),
  onClose = () => process.exit(0),
}) {
  const write = (msg) => output.write(JSON.stringify(msg) + "\n");
  // One stdio connection is one caller, so initialize nsfw: true may stick for this process.
  const dispatch = createDispatcher({ name, version, listTools, callTool, instructions, rememberSessionNsfw: true, log });
  const handle = async (msg) => {
    const response = await dispatch(msg);
    if (response) write(response);
  };

  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      // async fire-and-forget: responses go out in completion order, matched by id
      handle(msg).catch((e) => log("nanoodle-mcp: unhandled error: " + ((e && e.stack) || e)));
    }
  });
  input.on("end", onClose);

  // Tool descriptions can change mid-session (observed costs) — the host pushes
  // notifications/tools/list_changed through this. Notifications carry no id.
  return {
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
  };
}
