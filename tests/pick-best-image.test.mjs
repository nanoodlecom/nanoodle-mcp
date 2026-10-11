/**
 * Hosted pick-best-image graph: loads as one tool, then a mocked run (local
 * NanoGPT stub only — no payments, no live API) returns the winner, the three
 * candidates, and the pick probabilities.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";

/** 1x1 transparent PNG. The stub returns it for every image call. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const GRAPH = new URL("./fixtures/hosted/pick-best-image.noodle-graph.json", import.meta.url);

test("pick-best-image loads as a tool and a mocked run returns the winner and probabilities", async () => {
  const requests = [];
  const api = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    requests.push({ method: req.method, path: req.url, json });

    if (req.method === "POST" && req.url === "/v1/images/generations") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], cost: 0.02 }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/decisions") {
      // Same answer both orders. decideMergeOrders remaps by position, so the
      // middle candidate (shown second in both the forward and reversed asks)
      // stays the winner at 70%.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        answers: {
          answer: {
            type: "choice",
            choice: "image_2",
            confidence: 0.7,
            probabilities: { image_1: 0.15, image_2: 0.7, image_3: 0.15 },
          },
        },
        usage: { input_tokens: 400, output_tokens: 0, cost: 0.000004 },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), "pick-best-"));
  try {
    await copyFile(GRAPH, join(dir, "pick-best-image.noodle-graph.json"));
    const registry = await loadTools({
      dirs: [dir],
      apiKey: "test-key",
      baseUrl,
      outDir: join(dir, "out"),
      log: () => {},
    });
    const listed = registry.listTools().find((t) => t.name === "pick-best-image");
    assert.ok(listed, "graph filename becomes the tool name");
    assert.match(listed.description, /Picks the best of three cheap, fast image variants for a brief, or for a subject plus a style\./);
    assert.match(listed.description, /decide:Pick the best/);
    assert.match(listed.description, /returns the winning image, 3 candidate images, and pick probabilities/);
    assert.equal(listed.inputSchema.required, undefined);
    const props = listed.inputSchema.properties;
    assert.ok(props.Brief);
    assert.ok(props.Subject);
    assert.ok(props.Style);
    assert.match(props.Brief.description, /optional/);
    assert.match(props.Brief.description, /a red paper lantern over a quiet canal at dusk/);
    assert.match(props.Subject.description, /optional/);
    assert.match(props.Style.description, /optional/);
    const tool = registry.tools.find((t) => t.name === "pick-best-image");
    assert.deepEqual(tool.x402, { usd: 0.05 });
    const pick = tool.wf.graph.nodes.find((n) => n.id === "pick");
    assert.equal(pick.fields.mode, "pick");
    assert.equal(pick.fields.model, "perplexity/pplx-decider-v1.1-27b");

    const before = requests.length;
    const brief = "a glass fox in a linen suit";
    const result = await registry.callTool({ name: "pick-best-image", arguments: { Brief: brief } });
    const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
    const blob = texts.join("\n");
    assert.match(blob, /^image 2$/m, "Decide's label names the winning candidate");
    assert.match(blob, /probabilities: Candidate 1 15%; Candidate 2 70% \(winner\); Candidate 3 15%/);
    assert.match(blob, /Winner: saved \//);
    for (const name of ["Candidate 1", "Candidate 2", "Candidate 3"]) {
      assert.match(blob, new RegExp(name + ": saved /"));
    }
    assert.match(blob, /cost: \$0\.0600\b/);
    const winnerPath = blob.match(/Winner: saved (\S+)/)[1];
    const winner = await readFile(winnerPath);
    assert.equal(winner[0], 0x89, "winner file is a PNG");
    assert.equal(String.fromCharCode(...winner.subarray(1, 4)), "PNG");

    const mine = requests.slice(before);
    assert.deepEqual(mine.map((r) => r.path).sort(), [
      "/api/v1/decisions",
      "/api/v1/decisions",
      "/v1/images/generations",
      "/v1/images/generations",
      "/v1/images/generations",
    ]);
    const images = mine.filter((r) => r.path === "/v1/images/generations");
    const byModel = Object.fromEntries(images.map((r) => [r.json.model, r.json]));
    assert.equal(byModel["krea-2/turbo"].seed, 101);
    assert.equal(byModel["krea-2/turbo"].size, "square");
    assert.equal(byModel["hidream-i1-fast"].seed, 202);
    assert.equal(byModel["hidream-i1-fast"].size, "1024x1024");
    assert.equal(byModel["flux-schnell"].seed, 303);
    assert.equal(byModel["flux-schnell"].size, "1024x1024");
    for (const img of images) assert.equal(img.json.prompt, brief);
    for (const dec of mine.filter((r) => r.path === "/api/v1/decisions")) {
      assert.equal(dec.json.model, "perplexity/pplx-decider-v1.1-27b");
      assert.equal(dec.json.questions.answer.type, "choice");
      assert.equal(dec.json.questions.answer.instructions, "Which image best matches the brief?");
      assert.equal(dec.json.state[0], brief);
    }

    // The other input shape: a subject plus a style, with the sample brief cleared.
    const alt = await registry.callTool({
      name: "pick-best-image",
      arguments: { Brief: "", Subject: "a glass fox", Style: "linen suit, studio light" },
    });
    const altBlob = alt.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.match(altBlob, /probabilities: Candidate 1 15%; Candidate 2 70% \(winner\); Candidate 3 15%/);
    assert.match(altBlob, /Winner: saved \//);
    const altImages = requests.slice(mine.length + before).filter((r) => r.path === "/v1/images/generations");
    assert.equal(altImages.length, 3);
    for (const img of altImages) {
      assert.equal(img.json.prompt, "a glass fox\n\nlinen suit, studio light");
      assert.doesNotMatch(img.json.prompt, /paper lantern/);
    }
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
