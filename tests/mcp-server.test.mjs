/**
 * End-to-end test: spawn the real server as a child process, point it at fixture
 * graphs and a local node:http NanoGPT stub, and drive the full MCP handshake
 * over stdin/stdout. Fully offline — nothing spends money.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "nanoodle-mcp.mjs");
const FIXTURES = join(here, "fixtures");

/** 1x1 transparent PNG (base64, starts with iVBOR → sniffs image/png). */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/* ---- canned NanoGPT stub (endpoints + response shapes match nanoodle's client) ---- */
let apiServer, apiUrl;
const apiRequests = [];

before(async () => {
  apiServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    apiRequests.push({ method: req.method, path: req.url, json, auth: req.headers.authorization });

    if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        x_nanogpt_pricing: { costUsd: 0.0012, remainingBalance: 4.5 },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.02 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

after(() => new Promise((r) => apiServer.close(r)));

/* ---- tiny MCP client over the child's stdio ---- */
function startServer({ graphs = FIXTURES, outDir, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, "--graphs", graphs, ...(outDir ? ["--out", outDir] : [])], {
    env: { ...process.env, NANOGPT_API_KEY: "test-key", NANOGPT_BASE_URL: apiUrl, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutLines = [];   // every raw line the server ever wrote to stdout
  const messages = [];      // parsed frames
  const waiters = [];
  let stderr = "";
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* pollution — caught by assertions */ }
      messages.push(msg);
      for (const w of [...waiters]) {
        if (msg && w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });

  let nextId = 1;
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const waitFor = (match, ms = 15000) => new Promise((resolve, reject) => {
    const hit = messages.find((m) => m && match(m));
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error("timed out waiting for a response; stderr:\n" + stderr)), ms);
    waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  const request = async (method, params) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return waitFor((m) => m.id === id);
  };
  return {
    child, send, request, waitFor,
    stdoutLines, messages,
    get stderr() { return stderr; },
    notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
    sendRaw: (s) => child.stdin.write(s),
    close: () => new Promise((resolve) => { child.once("exit", resolve); child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); }),
  };
}

/* ================================ tests ================================ */

test("full handshake: initialize → initialized → tools/list → tools/call", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-out-"));
  const srv = startServer({ outDir });
  try {
    // -- initialize (current protocol version is echoed back)
    const init = await srv.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    assert.equal(init.error, undefined);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "nanoodle-mcp");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);

    // -- initialized notification: must produce NO response
    const framesBefore = srv.messages.length;
    srv.notify("notifications/initialized");

    // -- tools/list: one tool per fixture graph, with derived schemas
    const list = await srv.request("tools/list");
    assert.equal(srv.messages.length, framesBefore + 1, "notifications/initialized must not be answered");
    const tools = list.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["hello-noodle", "poster", "restyle"]);

    // media-typed input advertises "file path or https URL"
    const restyle = tools.find((t) => t.name === "restyle");
    assert.match(restyle.inputSchema.properties.Image.description, /file path or https URL/);

    const hello = tools.find((t) => t.name === "hello-noodle");
    assert.match(hello.description, /text -> llm/);
    assert.match(hello.description, /NanoGPT/);
    assert.equal(hello.inputSchema.type, "object");
    // text node is named "Idea" and is the node's only required input → key "Idea"
    assert.equal(hello.inputSchema.properties.Idea.type, "string");
    // llm system prompt is optional with a baked-in default
    assert.ok(hello.inputSchema.properties["System prompt"]);
    assert.deepEqual(hello.inputSchema.required, ["Idea"]);

    // -- tools/call (text output): stubbed chat completion + cost line
    const call = await srv.request("tools/call", { name: "hello-noodle", arguments: { Idea: "say pong" } });
    assert.equal(call.error, undefined);
    assert.ok(!call.result.isError, "run should succeed: " + JSON.stringify(call.result));
    const texts = call.result.content.map((c) => c.text);
    assert.equal(call.result.content.every((c) => c.type === "text"), true);
    assert.equal(texts[0], "pong");
    assert.equal(texts[texts.length - 1], "cost: $0.0012");
    // the stub actually saw the run, with the fixture's model and the caller's input
    const chat = apiRequests.find((r) => r.path === "/api/v1/chat/completions");
    assert.equal(chat.json.model, "test-model");
    assert.equal(chat.auth, "Bearer test-key");
    assert.deepEqual(chat.json.messages.at(-1), { role: "user", content: "say pong" });

    // -- tools/call (media output): image saved into --out, absolute path returned
    const poster = await srv.request("tools/call", { name: "poster", arguments: { Text: "a lighthouse" } });
    assert.ok(!poster.result.isError, JSON.stringify(poster.result));
    const saved = poster.result.content.find((c) => c.text.includes("saved "));
    assert.ok(saved, "expected a saved-media block: " + JSON.stringify(poster.result.content));
    const path = saved.text.replace(/^.*saved /, "");
    assert.ok(path.startsWith(outDir), `saved path ${path} should be inside ${outDir}`);
    assert.ok(path.endsWith(".png"));
    const bytes = await readFile(path);
    assert.deepEqual(bytes, Buffer.from(PNG_B64, "base64"));
    assert.equal(poster.result.content.at(-1).text, "cost: $0.0200");

    // -- tools/call (media input): a local file path is read via mediaFromFile → inline data URL
    const inputPng = join(outDir, "input.png");
    await writeFile(inputPng, Buffer.from(PNG_B64, "base64"));
    const restyled = await srv.request("tools/call", { name: "restyle", arguments: { Image: inputPng } });
    assert.ok(!restyled.result.isError, JSON.stringify(restyled.result));
    const editReq = apiRequests.findLast((r) => r.path === "/v1/images/generations" && r.json && r.json.imageDataUrl);
    assert.ok(editReq, "edit run should post imageDataUrl");
    assert.ok(String(editReq.json.imageDataUrl).startsWith("data:image/png;base64,"), "file path should ride as an inline data URL");

    // -- unknown method → -32601
    const unknown = await srv.request("bogus/method");
    assert.equal(unknown.error.code, -32601);

    // -- unknown tool / malformed args → -32602
    const badTool = await srv.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(badTool.error.code, -32602);
    const badArg = await srv.request("tools/call", { name: "hello-noodle", arguments: { Bogus: "x" } });
    assert.equal(badArg.error.code, -32602);
    const missingArg = await srv.request("tools/call", { name: "hello-noodle", arguments: {} });
    assert.equal(missingArg.error.code, -32602);

    // -- ping → {}
    const pong = await srv.request("ping");
    assert.deepEqual(pong.result, {});

    // -- parse error → -32700 with id null
    srv.sendRaw("this is not json\n");
    const parseErr = await srv.waitFor((m) => m.error && m.error.code === -32700);
    assert.equal(parseErr.id, null);

    // -- stdout carried protocol frames only (every line parsed as JSON-RPC)
    for (let i = 0; i < srv.stdoutLines.length; i++) {
      assert.ok(srv.messages[i] !== null, "stdout pollution (not JSON): " + srv.stdoutLines[i]);
      assert.equal(srv.messages[i].jsonrpc, "2.0", "stdout pollution (not JSON-RPC): " + srv.stdoutLines[i]);
    }
  } finally {
    await srv.close();
  }
});

test("older protocol version from the client is echoed when supported", async () => {
  const srv = startServer();
  try {
    const init = await srv.request("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    const future = await srv.request("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
    assert.equal(future.result.protocolVersion, "2025-06-18");
  } finally {
    await srv.close();
  }
});

test("failed run comes back as isError content, not a protocol error", async () => {
  const srv = startServer({ env: { NANOGPT_BASE_URL: "http://127.0.0.1:1" } }); // nothing listens there
  try {
    await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const call = await srv.request("tools/call", { name: "hello-noodle", arguments: { Idea: "hi" } });
    assert.equal(call.error, undefined, "run failure must not be a JSON-RPC error");
    assert.equal(call.result.isError, true);
    assert.ok(call.result.content[0].text.length > 0);
  } finally {
    await srv.close();
  }
});

test("refuses to start when the graphs directory has no runnable graphs", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-empty-"));
  const child = spawn(process.execPath, [BIN, "--graphs", emptyDir], {
    env: { ...process.env, NANOGPT_API_KEY: "test-key" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 1);
  assert.match(stderr, /no runnable graphs/);
  assert.match(stderr, /no \.json files found/);
});

test("out dir defaults to ./nanoodle-out and media lands there", async () => {
  // run the server with cwd = a temp dir so the default ./nanoodle-out is isolated
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-mcp-cwd-"));
  const child = spawn(process.execPath, [BIN, "--graphs", FIXTURES], {
    cwd,
    env: { ...process.env, NANOGPT_API_KEY: "test-key", NANOGPT_BASE_URL: apiUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "poster", arguments: { Text: "x" } } }) + "\n");
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), 15000);
    child.stdout.on("data", () => {
      if (out.split("\n").filter(Boolean).length >= 2) { clearTimeout(t); resolve(); }
    });
  });
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  const files = await readdir(join(cwd, "nanoodle-out"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^poster-Image-.*\.png$/);
});
