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
const SHARE_FIXTURES = join(FIXTURES, "share"); // golden { name, url, graph } share links (readdir skips subdirs, so these aren't graph tools)

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
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } });
    assert.equal(init.result.serverInfo.name, "nanoodle-mcp");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);

    // -- initialized notification: must produce NO response
    const framesBefore = srv.messages.length;
    srv.notify("notifications/initialized");

    // -- tools/list: one tool per fixture graph, with derived schemas
    const list = await srv.request("tools/list");
    assert.equal(srv.messages.length, framesBefore + 1, "notifications/initialized must not be answered");
    const tools = list.result.tools;
    // one tool per fixture graph, plus the always-present run_noodle share-link tool
    assert.deepEqual(tools.map((t) => t.name).sort(), ["greeting-card", "hello-noodle", "poster", "restyle", "run_noodle"]);

    // media-typed input advertises "file path or https URL"
    const restyle = tools.find((t) => t.name === "restyle");
    assert.match(restyle.inputSchema.properties.Image.description, /file path or https URL/);

    const hello = tools.find((t) => t.name === "hello-noodle");
    // named text node annotates the chain; text-only graph advertises "returns text"
    assert.match(hello.description, /text:Idea -> llm; returns text\./);
    assert.match(hello.description, /NanoGPT/);
    // media sink: model in the parenthetical + the saved-to-disk contract
    const posterTool = tools.find((t) => t.name === "poster");
    assert.match(posterTool.description, /returns image \(test-image-model\) saved to disk \(file path in result\)/);
    assert.equal(hello.inputSchema.type, "object");
    // text node is named "Idea" and is the node's only required input → key "Idea"
    assert.equal(hello.inputSchema.properties.Idea.type, "string");
    // llm system prompt is optional with a baked-in default; its key is sanitized
    // ("System prompt" → "System_prompt") to satisfy clients that enforce
    // ^[a-zA-Z0-9_.-]{1,64}$ on property keys, with the original spelling described
    assert.ok(hello.inputSchema.properties.System_prompt);
    assert.match(hello.inputSchema.properties.System_prompt.description, /System prompt/);
    assert.deepEqual(hello.inputSchema.required, ["Idea"]);
    // required inputs carry a leading "*" designation so the flag survives clients
    // that don't render the schema's `required` array
    assert.match(hello.inputSchema.properties.Idea.description, /^\* required/);
    assert.match(hello.inputSchema.properties.System_prompt.description, /optional/);

    // author-marked optional (fields.optional on the node): out of `required`,
    // described as optional, and still keyed by the node's custom name
    const card = tools.find((t) => t.name === "greeting-card");
    assert.deepEqual(card.inputSchema.required, ["Greeting"]);
    assert.match(card.inputSchema.properties.Greeting.description, /^\* required/);
    assert.match(card.inputSchema.properties.Postscript.description, /optional/);
    assert.doesNotMatch(card.inputSchema.properties.Postscript.description, /required/);
    // no advertised property key may violate the client-enforced pattern
    for (const t of tools) {
      for (const key of Object.keys(t.inputSchema.properties)) {
        assert.match(key, /^[a-zA-Z0-9_.-]{1,64}$/, `tool ${t.name} advertises invalid key "${key}"`);
      }
    }

    // -- tools/call (text output): stubbed chat completion + cost line
    // passing the sanitized key must land on the graph's real "System prompt" input
    const call = await srv.request("tools/call", { name: "hello-noodle", arguments: { Idea: "say pong", System_prompt: "reply with pong" } });
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

    // -- observed cost: the run's price lands in the description, a list_changed
    //    notification (a frame with no id) tells the client to re-list, and the
    //    sidecar persists it for the next server start
    await srv.waitFor((m) => m.method === "notifications/tools/list_changed" && m.id === undefined);
    const relist = await srv.request("tools/list");
    assert.match(relist.result.tools.find((t) => t.name === "hello-noodle").description,
      /balance; last run \$0\.0012\.$/);
    const sidecar = JSON.parse(await readFile(join(outDir, "costs.json"), "utf8"));
    assert.equal(sidecar["hello-noodle"].usd, 0.0012);

    // -- tools/call: an author-optional input can be omitted — the run proceeds with an
    // empty value (local-only graph: text + text → join, no API traffic)
    const cardCall = await srv.request("tools/call", { name: "greeting-card", arguments: { Greeting: "happy launch day" } });
    assert.ok(!cardCall.result.isError, "omitting an optional input should run: " + JSON.stringify(cardCall.result));
    assert.equal(cardCall.result.content[0].text, "happy launch day"); // join drops the empty optional part
    // …while omitting the REQUIRED input is still an invalid-params error
    const cardMissing = await srv.request("tools/call", { name: "greeting-card", arguments: {} });
    assert.equal(cardMissing.error.code, -32602);
    assert.match(cardMissing.error.message, /missing required input.*"Greeting"/);

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
    // wait for the tools/call REPLY specifically — a list_changed notification
    // frame lands on stdout first, so a bare line count would fire early
    child.stdout.on("data", () => {
      if (out.includes('"id":2')) { clearTimeout(t); resolve(); }
    });
  });
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  const files = await readdir(join(cwd, "nanoodle-out"));
  assert.ok(files.includes("costs.json"), "cost sidecar should land in the out dir too");
  const media = files.filter((f) => f !== "costs.json");
  assert.equal(media.length, 1);
  assert.match(media[0], /^poster-Image-.*\.png$/);
});

/* ============================= run_noodle ============================= */

test("run_noodle is always listed, with a url-required schema and the spend warning", async () => {
  const srv = startServer();
  try {
    await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const list = await srv.request("tools/list");
    const rn = list.result.tools.find((t) => t.name === "run_noodle");
    assert.ok(rn, "run_noodle must always be in tools/list");
    assert.deepEqual(rn.inputSchema.required, ["url"]);
    assert.equal(rn.inputSchema.properties.url.type, "string");
    assert.equal(rn.inputSchema.properties.inputs.type, "object");
    assert.match(rn.description, /spends real credit from your API key's balance/);
    assert.match(rn.description, /decode locally/); // documents the no-credentials network note
  } finally {
    await srv.close();
  }
});

test("run_noodle decodes a #g= workflow link offline and runs it with inputs", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-run-"));
  const srv = startServer({ outDir });
  try {
    await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const fx = JSON.parse(await readFile(join(SHARE_FIXTURES, "g-starter.json"), "utf8"));
    // fx.url carries a #g= fragment → decodes with zero network; the run hits the stub.
    const before = apiRequests.length;
    const call = await srv.request("tools/call", { name: "run_noodle", arguments: { url: fx.url, inputs: { Text: "say pong" } } });
    assert.equal(call.error, undefined);
    assert.ok(!call.result.isError, "run should succeed: " + JSON.stringify(call.result));

    // text -> llm -> image: the image output is saved into --out, cost line last
    const saved = call.result.content.find((c) => c.text.includes("saved "));
    assert.ok(saved, "expected a saved-media block: " + JSON.stringify(call.result.content));
    const path = saved.text.replace(/^.*saved /, "");
    assert.ok(path.startsWith(outDir), `saved ${path} should be inside ${outDir}`);
    assert.ok(path.endsWith(".png"));
    assert.ok(/[/\\]run_noodle-/.test(path), "media prefix should be run_noodle: " + path);
    assert.match(call.result.content.at(-1).text, /^cost: \$/);

    // inputs derivation: the friendly "Text" override flowed through to the llm call
    const chat = apiRequests.slice(before).find((r) => r.path === "/api/v1/chat/completions");
    assert.ok(chat, "the run should have hit the chat endpoint");
    assert.equal(chat.json.messages.at(-1).content, "say pong");
    assert.equal(chat.auth, "Bearer test-key");

    // run_noodle is excluded from cost tracking — no sidecar appears
    assert.ok(!(await readdir(outDir)).includes("costs.json"));
  } finally {
    await srv.close();
  }
});

test("run_noodle decodes a #a= app link offline and runs it on saved defaults", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-run-a-"));
  const srv = startServer({ outDir });
  try {
    await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const fx = JSON.parse(await readFile(join(SHARE_FIXTURES, "a-files.json"), "utf8"));
    const call = await srv.request("tools/call", { name: "run_noodle", arguments: { url: fx.url } });
    assert.ok(!call.result.isError, "app-link run should succeed: " + JSON.stringify(call.result));
    const saved = call.result.content.find((c) => c.text.includes("saved "));
    assert.ok(saved && saved.text.endsWith(".png"), "expected a saved image from the app graph");
  } finally {
    await srv.close();
  }
});

test("run_noodle: bad, internal, and unrunnable links come back as tool errors, not crashes", async () => {
  const srv = startServer();
  try {
    await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    // #ga= is the editor↔app internal handoff — refused with a readable message
    const ga = await srv.request("tools/call", { name: "run_noodle", arguments: { url: "https://nanoodle.com/#ga=abc" } });
    assert.equal(ga.error, undefined, "must be a tool error, not a JSON-RPC error");
    assert.equal(ga.result.isError, true);
    assert.match(ga.result.content[0].text, /ga=|internal/i);

    // truncated / non-base64 fragment
    const bad = await srv.request("tools/call", { name: "run_noodle", arguments: { url: "https://nanoodle.com/#g=!!!not-base64" } });
    assert.equal(bad.result.isError, true);

    // a graph that needs a node type this library doesn't have → clear tool error, no spend
    const badGraph = { v: 1, nodes: [{ id: "n1", type: "totally-not-a-node", pos: [0, 0], fields: {} }], links: [] };
    const j = Buffer.from(JSON.stringify(badGraph)).toString("base64url");
    const unk = await srv.request("tools/call", { name: "run_noodle", arguments: { url: "https://nanoodle.com/#j=" + j } });
    assert.equal(unk.result.isError, true);
    assert.match(unk.result.content[0].text, /run headlessly|unknown node type/i);

    // missing url → malformed params (-32602), not a tool-result error
    const noUrl = await srv.request("tools/call", { name: "run_noodle", arguments: {} });
    assert.equal(noUrl.error.code, -32602);

    // inputs of the wrong shape → -32602
    const badInputs = await srv.request("tools/call", { name: "run_noodle", arguments: { url: "#g=x", inputs: "nope" } });
    assert.equal(badInputs.error.code, -32602);
  } finally {
    await srv.close();
  }
});

test("describeRunFailure: leads with the root-cause node, lists the cascade", async () => {
  const { describeRunFailure } = await import("../src/tools.mjs");
  const runError = Object.assign(new Error('run failed — "Image→Video": upstream failed: Image'), {
    result: {
      errors: [
        { nodeId: "n17", name: "LLM", message: "x402 invoice is $0.1082, over the --max-usd cap of $0.1 — raise the cap" },
        { nodeId: "n18", name: "Join", message: "upstream failed: LLM" },
        { nodeId: "n2", name: "Image", message: "upstream failed: Join" },
        { nodeId: "n6", name: "Image→Video", message: "upstream failed: Image" },
      ],
    },
  });
  const out = describeRunFailure(runError);
  assert.match(out.message, /^run failed at "LLM": x402 invoice is \$0\.1082/);
  assert.match(out.message, /downstream never ran: "Join", "Image", "Image→Video"/);
  assert.equal(out.cause, runError, "original RunError stays reachable");

  // no per-node record (network error before the run, ParamsError, …) → untouched
  const plain = new Error("boom");
  assert.equal(describeRunFailure(plain), plain);
  // all errors are cascades (shouldn't happen, but never fabricate a root) → untouched
  const odd = Object.assign(new Error("x"), { result: { errors: [{ nodeId: "a", name: "A", message: "upstream failed: B" }] } });
  assert.equal(describeRunFailure(odd), odd);
});

test("tool descriptions: chain annotations, ×N collapsing, and the returns contract", async () => {
  const { loadTools } = await import("../src/tools.mjs");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-desc-"));
  const graph = (nodes, links) => JSON.stringify({ v: 1, nodes, links });
  const t = (id, name, extra) => ({ id, type: "text", x: 0, y: 0, ...(name ? { name } : {}), fields: { text: "x" }, ...extra });
  const link = (id, from, to) => ({ id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });

  // named nodes (incl. a name with a space) + org-prefixed model + explicit size
  await writeFile(join(dir, "named.json"), graph(
    [
      t("n1", "Feature"),
      t("n2", "Style guide"),
      { id: "n3", type: "join", x: 0, y: 0, fields: {} },
      { id: "n4", type: "llm", x: 0, y: 0, fields: { model: "test-model" } },
      { id: "n5", type: "image", x: 0, y: 0, name: "Mockup", fields: { model: "openai/nano-banana-2-lite", size: "1024x1024" } },
    ],
    [
      link("l1", ["n1", "text"], ["n3", "a"]),
      link("l2", ["n2", "text"], ["n3", "b"]),
      link("l3", ["n3", "text"], ["n4", "prompt"]),
      link("l4", ["n4", "text"], ["n5", "prompt"]),
    ]));
  // adjacent unnamed twins collapse to ×2
  await writeFile(join(dir, "collapse.json"), graph(
    [t("n1"), t("n2"), { id: "n3", type: "join", x: 0, y: 0, fields: {} }, { id: "n4", type: "llm", x: 0, y: 0, fields: { model: "m" } }],
    [link("l1", ["n1", "text"], ["n3", "a"]), link("l2", ["n2", "text"], ["n3", "b"]), link("l3", ["n3", "text"], ["n4", "prompt"])]));
  // variations > 1 → "3× image"; size "auto" stays out of the parenthetical
  await writeFile(join(dir, "variants.json"), graph(
    [t("n1"), { id: "n2", type: "image", x: 0, y: 0, fields: { model: "test-img", size: "auto", variations: "3" } }],
    [link("l1", ["n1", "text"], ["n2", "prompt"])]));
  // mixed text + media sinks → media-only disk note
  await writeFile(join(dir, "mixed.json"), graph(
    [t("n1"), { id: "n2", type: "llm", x: 0, y: 0, fields: { model: "m" } }, { id: "n3", type: "image", x: 0, y: 0, fields: { model: "img-model" } }],
    [link("l1", ["n1", "text"], ["n2", "prompt"]), link("l2", ["n1", "text"], ["n3", "prompt"])]));

  const reg = await loadTools({ dir, apiKey: "test-key", outDir: dir });
  assert.deepEqual(reg.failures, []);
  const desc = Object.fromEntries(reg.tools.map((x) => [x.name, x.description]));

  assert.equal(desc.named,
    "text:Feature -> text:Style guide -> join -> llm -> image:Mockup; " +
    "returns image (nano-banana-2-lite, 1024×1024) saved to disk (file path in result). " +
    "Runs on NanoGPT — every call spends real credit from your API key's balance.");
  assert.equal(desc.collapse,
    "text×2 -> join -> llm; returns text. " +
    "Runs on NanoGPT — every call spends real credit from your API key's balance.");
  assert.equal(desc.variants,
    "text -> image; returns 3× image (test-img) saved to disk (file paths in result). " +
    "Runs on NanoGPT — every call spends real credit from your API key's balance.");
  assert.equal(desc.mixed,
    "text -> llm -> image; returns text + image (img-model); media saved to disk (file path in result). " +
    "Runs on NanoGPT — every call spends real credit from your API key's balance.");
});

test("tool descriptions: the first comment node leads as the tool's intent", async () => {
  const { loadTools } = await import("../src/tools.mjs");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-intent-"));
  const graph = (nodes, links = []) => JSON.stringify({ v: 1, nodes, links });
  const comment = (id, text) => ({ id, type: "comment", x: 0, y: 0, fields: { text, color: "yellow" } });
  const t = (id) => ({ id, type: "text", x: 0, y: 0, fields: { text: "x" } });
  const llm = (id) => ({ id, type: "llm", x: 0, y: 0, fields: { model: "m" } });
  const link = (id, from, to) => ({ id, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] } });
  const wire = [link("l1", ["n1", "text"], ["n2", "prompt"])];
  const TAIL = "Runs on NanoGPT — every call spends real credit from your API key's balance.";

  // comment leads; missing terminal punctuation gets a period; comment stays out of the chain
  await writeFile(join(dir, "commented.json"), graph([comment("c1", "Draft a tagline from a product idea"), t("n1"), llm("n2")], wire));
  // multiline / indented text collapses to single spaces; existing "!" is kept
  await writeFile(join(dir, "multiline.json"), graph([t("n1"), llm("n2"), comment("c1", "  Turn a\n\n  rough idea\tinto copy!  ")], wire));
  // over 200 chars → 197 + "…", which already terminates the sentence
  const long = "word ".repeat(50).trim(); // 249 chars
  await writeFile(join(dir, "long.json"), graph([comment("c1", long), t("n1"), llm("n2")], wire));
  // first comment IN ARRAY ORDER with non-empty text wins; empty ones are skipped
  await writeFile(join(dir, "pick-first.json"), graph([comment("c0", "   "), comment("c1", "Second comment wins."), comment("c2", "Not this one."), t("n1"), llm("n2")], wire));
  // no comment → description starts with the chain, exactly as before
  await writeFile(join(dir, "plain.json"), graph([t("n1"), llm("n2")], wire));
  // comment-only graph: no chain, no outputs — must not crash, intent stands alone
  await writeFile(join(dir, "only-comment.json"), graph([comment("c1", "Just a note")]));

  const reg = await loadTools({ dir, apiKey: "test-key", outDir: dir });
  assert.deepEqual(reg.failures, []);
  const desc = Object.fromEntries(reg.tools.map((x) => [x.name, x.description]));

  assert.equal(desc.commented, `Draft a tagline from a product idea. text -> llm; returns text. ${TAIL}`);
  assert.equal(desc.multiline, `Turn a rough idea into copy! text -> llm; returns text. ${TAIL}`);
  assert.equal(desc.long, `${long.slice(0, 197)}… text -> llm; returns text. ${TAIL}`);
  assert.equal(desc["pick-first"], `Second comment wins. text -> llm; returns text. ${TAIL}`);
  assert.equal(desc.plain, `text -> llm; returns text. ${TAIL}`);
  assert.equal(desc["only-comment"], `Just a note. ${TAIL}`);
});

test("cost sidecar: a run records its price, re-renders the description, and notifies once", async () => {
  const { loadTools } = await import("../src/tools.mjs");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-cost-"));
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-cost-out-"));
  await writeFile(join(dir, "chat.json"), JSON.stringify({
    v: 1,
    nodes: [
      { id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } },
      { id: "n2", type: "llm", x: 0, y: 0, fields: { model: "test-model" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  }));

  const reg = await loadTools({ dir, apiKey: "test-key", baseUrl: apiUrl, outDir });
  let notified = 0;
  reg.onToolsChanged = () => notified++;
  assert.ok(!reg.tools[0].description.includes("last run"), "no cost segment before any run");

  await reg.callTool({ name: "chat", arguments: {} }); // stub charges $0.0012
  assert.equal(notified, 1);
  assert.match(reg.tools[0].description, /balance; last run \$0\.0012\.$/);
  assert.match(reg.listTools().find((t) => t.name === "chat").description, /last run \$0\.0012/);
  const sidecar = JSON.parse(await readFile(join(outDir, "costs.json"), "utf8"));
  assert.equal(sidecar.chat.usd, 0.0012);
  assert.match(sidecar.chat.at, /^\d{4}-\d{2}-\d{2}T/);

  // same price again → description unchanged → no second notification
  await reg.callTool({ name: "chat", arguments: {} });
  assert.equal(notified, 1);

  // a fresh registry picks the recorded cost up at startup
  const reg2 = await loadTools({ dir, apiKey: "test-key", baseUrl: apiUrl, outDir });
  assert.match(reg2.tools[0].description, /last run \$0\.0012\.$/);
});

test("cost sidecar: rendering — zero-trimming, tiny costs, inexact '+', corrupt file ignored", async () => {
  const { loadTools } = await import("../src/tools.mjs");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-render-"));
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-render-out-"));
  await writeFile(join(dir, "chat.json"), JSON.stringify({
    v: 1,
    nodes: [
      { id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } },
      { id: "n2", type: "llm", x: 0, y: 0, fields: { model: "m" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  }));
  const load = async () => (await loadTools({ dir, apiKey: "test-key", outDir })).tools[0].description;
  const at = "2026-07-19T00:00:00.000Z";
  const withRec = async (rec) => {
    await writeFile(join(outDir, "costs.json"), JSON.stringify({ chat: rec }));
    return load();
  };

  assert.match(await withRec({ usd: 0.02, at }), /; last run \$0\.02\.$/);       // 0.0200 → trailing zeros trimmed
  assert.match(await withRec({ usd: 0.1, at }), /; last run \$0\.10\.$/);        // …but never past cents
  assert.match(await withRec({ usd: 0.1234, at }), /; last run \$0\.1234\.$/);
  assert.match(await withRec({ usd: 0.0234, at, exact: false }), /; last run \$0\.0234\+\.$/); // under-reported runs
  assert.match(await withRec({ usd: 0.00005, at }), /; last run <\$0\.0001\.$/); // sub-basis-point runs

  // corrupt or junk sidecars are ignored, never fatal
  await writeFile(join(outDir, "costs.json"), "{not json");
  assert.ok(!(await load()).includes("last run"));
  await writeFile(join(outDir, "costs.json"), JSON.stringify({ chat: { usd: "expensive", at } }));
  assert.ok(!(await load()).includes("last run"));
});

test("extForMedia: mime wins; magic bytes rescue octet-stream media", async () => {
  const { extForMedia } = await import("../src/tools.mjs");
  const ftyp = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0]); // ....ftypisom
  assert.equal(extForMedia(ftyp, "video/mp4"), "mp4");
  assert.equal(extForMedia(ftyp, "application/octet-stream"), "mp4"); // the live LTX video case
  assert.equal(extForMedia(ftyp, null), "mp4");
  assert.equal(extForMedia(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), null), "png");
  assert.equal(extForMedia(new Uint8Array([0xff, 0xd8, 0xff]), ""), "jpg");
  assert.equal(extForMedia(new Uint8Array([1, 2, 3, 4]), null), "bin"); // truly unknown stays bin
});
