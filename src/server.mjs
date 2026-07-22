/**
 * Minimal MCP server core — JSON-RPC 2.0, zero dependencies.
 *
 * Protocol surface (the whole point is that this file is small enough to read):
 *   initialize                → protocolVersion + capabilities.tools (listChanged) + serverInfo
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

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

/**
 * Build the transport-free message handler.
 * @param {object} opts
 * @param {string} opts.name        serverInfo.name
 * @param {string} opts.version     serverInfo.version
 * @param {() => Array} opts.listTools
 * @param {(params: object) => Promise<object>} opts.callTool  may throw; err.mcpCode → JSON-RPC error
 * @param {string} [opts.instructions]  server-level guidance surfaced to the client on initialize
 * @param {(...args) => void} [opts.log]
 * @returns {(msg: any, ctx?: object|null) => Promise<object|null>} resolves to a JSON-RPC response,
 *   or null when the message is a notification (or a malformed non-request) and gets no reply.
 *   `ctx` (optional) rides through to callTool — a streaming transport passes { streaming, report }
 *   so long-running tools can surface progress.
 */
export function createDispatcher({ name, version, listTools, callTool, instructions, log = (...a) => console.error(...a) }) {
  const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

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
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      if (method.startsWith("notifications/")) return null; // notifications/initialized, cancelled, ... — never answered
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: listTools() });
      if (method === "tools/call") {
        try {
          return reply(id, await callTool(params, ctx));
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
  const dispatch = createDispatcher({ name, version, listTools, callTool, instructions, log });
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
