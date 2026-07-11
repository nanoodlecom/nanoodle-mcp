/**
 * Minimal MCP stdio server — newline-delimited JSON-RPC 2.0, zero dependencies.
 *
 * Protocol surface (the whole point is that this file is small enough to read):
 *   initialize                → protocolVersion + capabilities.tools + serverInfo
 *   notifications/initialized → no response (notifications never get one)
 *   ping                      → {}
 *   tools/list                → tools from the registry
 *   tools/call                → registry.callTool(); run failures become isError content
 *   anything else             → -32601 (requests only)
 *
 * stdout carries protocol frames ONLY (one JSON object per line). All logging → stderr.
 */

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

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
  log = (...a) => console.error(...a),
  onClose = () => process.exit(0),
}) {
  const write = (msg) => output.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(msg) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
      // includes JSON-RPC batches — removed from MCP as of 2025-06-18
      return fail(null, -32600, "invalid request — expected a single JSON-RPC 2.0 object");
    }
    const { id, method, params } = msg;
    const isRequest = "id" in msg && id !== null && id !== undefined;
    if (typeof method !== "string") {
      if (isRequest) fail(id, -32600, "invalid request — missing method");
      return;
    }

    try {
      if (method === "initialize") {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return reply(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      }
      if (method.startsWith("notifications/")) return; // notifications/initialized, cancelled, ... — never answered
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: listTools() });
      if (method === "tools/call") {
        try {
          return reply(id, await callTool(params));
        } catch (e) {
          if (e && e.mcpCode) return fail(id, e.mcpCode, e.message); // malformed args → -32602
          // the tool ran and failed (RunError, missing key, network, ...) → tool-level error result
          return reply(id, { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true });
        }
      }
      if (isRequest) return fail(id, -32601, `method not found: ${method}`);
    } catch (e) {
      log(`nanoodle-mcp: internal error handling ${method}: ${(e && e.stack) || e}`);
      if (isRequest) fail(id, -32603, "internal error: " + ((e && e.message) || e));
    }
  }

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
        fail(null, -32700, "parse error");
        continue;
      }
      // async fire-and-forget: responses go out in completion order, matched by id
      handle(msg).catch((e) => log("nanoodle-mcp: unhandled error: " + ((e && e.stack) || e)));
    }
  });
  input.on("end", onClose);
}
