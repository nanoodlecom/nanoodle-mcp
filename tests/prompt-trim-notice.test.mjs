/**
 * A trimmed prompt must be disclosed in the tool RESULT.
 *
 * The `nanoodle` >= 0.8.0 runtime caps prompt length: an image or video prompt over
 * the model's limit is cut at a sentence boundary rather than sent to a request that
 * is certain to 400. The library reports every cut twice — an `onProgress` event and
 * a `process.emitWarning`. An MCP client reads neither. It reads the tool result, and
 * stderr belongs to whoever started the server.
 *
 * The call is already paid for by then, in --charge mode with the caller's Nano. So a
 * trim that never reaches the result bills somebody for a run that used a prompt they
 * did not send. These tests hold the disclosure to the result.
 *
 * Offline: a local http stub answers the image route, so nothing spends money.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_CAPS, fitPromptText } from "nanoodle";
import { loadTools } from "../src/tools.mjs";

/** 1x1 transparent PNG — the stub's canned image. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A model with a real cap in the library's own table — read it, never hardcode it. */
const MODEL = "qwen-image-3";
const CAP = PROMPT_CAPS.image[MODEL];

let api, apiUrl;
const seenPrompts = [];

before(async () => {
  api = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      seenPrompts.push(json && json.prompt);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.02 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(() => new Promise((r) => api.close(r)));

/** One graph dir holding a single text -> image graph on a capped model. */
async function capGraphDir() {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-cap-"));
  const graph = {
    v: 1,
    nodes: [
      { id: "n1", type: "text", x: 80, y: 120, name: "Idea", fields: { text: "" } },
      { id: "n2", type: "image", x: 420, y: 100, name: "Poster", fields: { model: MODEL } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  };
  await writeFile(join(dir, "capped.json"), JSON.stringify(graph, null, 2));
  return dir;
}

async function callWith(prompt) {
  const dir = await capGraphDir();
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-out-"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: apiUrl, outDir });
  const res = await registry.callTool({ name: "capped", arguments: { Idea: prompt } });
  const texts = res.content.filter((c) => c.type === "text").map((c) => c.text);
  return { res, texts };
}

test("a trimmed prompt is disclosed in the tool result, with the numbers", async () => {
  assert.ok(Number.isFinite(CAP) && CAP > 0, `the library's table must still cap ${MODEL}`);
  const prompt = "A lighthouse at dawn. ".repeat(60);   // 1320 characters, sentence-ended
  assert.ok(prompt.length > CAP);
  const expected = fitPromptText(prompt, CAP);          // the library's own cut, not a guess

  seenPrompts.length = 0;
  const { texts } = await callWith(prompt);

  // The run really did use the shorter prompt — this is the behaviour being disclosed.
  assert.equal(seenPrompts.length, 1);
  assert.equal(seenPrompts[0], expected);
  assert.ok(expected.length < prompt.length);

  const notice = texts.find((t) => /prompt trimmed/i.test(t));
  assert.ok(notice, `no trim disclosure in the result — got:\n${texts.join("\n")}`);
  assert.match(notice, /"Poster"/);                     // which node
  assert.match(notice, new RegExp(MODEL));              // which model
  assert.match(notice, new RegExp(`\\b${prompt.length}\\b`));    // from
  assert.match(notice, new RegExp(`\\b${expected.length}\\b`));  // to
  assert.match(notice, new RegExp(`\\b${CAP}\\b`));              // the cap itself

  // First block: a caller who reads no further still learns the run changed.
  assert.match(texts[0], /prompt trimmed/i);
});

test("a prompt inside the cap produces no notice at all", async () => {
  const prompt = "A lighthouse at dawn.";
  assert.ok(prompt.length <= CAP);

  seenPrompts.length = 0;
  const { texts } = await callWith(prompt);

  assert.equal(seenPrompts[0], prompt, "an under-cap prompt must go through untouched");
  assert.equal(texts.filter((t) => /prompt trimmed/i.test(t)).length, 0,
    `an untrimmed run must not claim a trim — got:\n${texts.join("\n")}`);
});
