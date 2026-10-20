import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../src/http.mjs";
import { loadTools } from "../src/tools.mjs";
import { mkdtemp, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function pages(toolName, structured) {
  const tool = { name: toolName, description: "Generate reference and parts images.", inputSchema: { type: "object" } };
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "examples", version: "0",
    publicBase: "http://example.test", log: () => {},
    listTools: () => [tool], callTool: async () => { throw new Error("No generation in this test"); },
    toolInfo: [{ ...tool, rawText: "{}", editorUrl: "https://nanoodle.com/#g=test",
      ...(structured ? { card: { intent: tool.description, steps: [{ kind: "image", label: "Image", n: 2 }] } } : {}),
    }],
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return await Promise.all(["/", "/llms.txt"].map(async path => {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      return response.text();
    }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

for (const structured of [true, false]) {
  test(`mounted character workflow exposes playable outcome and local skill (structured=${structured})`, async () => {
    const [html, text] = await pages("character-sprites", structured);
    for (const body of [html, text]) {
      assert.match(body, /Iron Verdict/);
      assert.match(body, /https:\/\/nanoodle\.com\/examples\/iron-verdict\//);
      assert.match(body, /https:\/\/github\.com\/nanoodlecom\/noodle-skills\/tree\/main\/skills\/character-sprites/);
      assert.match(body, /graph generates a character reference and parts sheet/);
      assert.match(body, /local skill bakes animated sprites/);
      assert.match(body, /coding agent adds combat, gravity and game rules/);
    }
    assert.match(html, /href="\/graph\/character-sprites\.json"/);
    assert.match(html, /src="https:\/\/media\.nanoodle\.com\/mcp\/examples\/iron-verdict\.png"/);
    assert.match(text, /graph: http:\/\/example\.test\/graph\/character-sprites\.json/);
  });
}

test("servers without the character workflow do not imply the example tool is mounted", async () => {
  for (const name of ["poster", "constructor"]) {
    for (const body of await pages(name, true)) {
      assert.doesNotMatch(body, /Iron Verdict|character-sprites|give your agent the skill/);
    }
  }
});

for (const name of ["favicon", "fibo-studio-still", "night-market-postcard", "image-model-arena", "edit-a-photo", "combine-images", "photo-to-video", "omni-flash-turntable", "deslop", "render-a-mockup", "sing", "talking-avatar", "idea-to-3d-model", "mix-the-references"]) {
  test(`reviewed ${name} sample links to evidence without inventing a skill`, async () => {
    for (const structured of [true, false]) {
      const [html, text] = await pages(name, structured);
      for (const body of [html, text]) {
        assert.ok(body.includes(`https://nanoodle.com/examples/gallery/#${name}`));
        assert.doesNotMatch(body, /undefined|agent skill:|give your agent the skill|Iron Verdict/);
      }
      assert.match(html, />See sample<\/a>/);
      assert.ok(html.includes(`id="${name}"`));
      if (["deslop", "sing"].includes(name)) assert.ok(!html.includes(`examples/gallery/${name}/preview`));
      else if (["image-model-arena", "photo-to-video", "talking-avatar"].includes(name)) assert.ok(html.includes(`src="https://media.nanoodle.com/mcp/examples/${name}.webp"`));
      else if (name === "idea-to-3d-model") assert.ok(html.includes(`src="https://media.nanoodle.com/mcp/examples/${name}.webp"`));
      else if (name === "mix-the-references") assert.ok(html.includes(`src="https://media.nanoodle.com/mcp/examples/${name}.webp"`));
      else assert.ok(html.includes(`https://nanoodle.com/examples/gallery/${name}/preview.webp`));
      if (name === "sing") {
        assert.match(html, /Audio sample/);
        assert.match(text, /model-assisted audio review, not human listening sign-off/);
      }
      if (name === "talking-avatar") {
        assert.match(html, /Video sample/);
        assert.match(text, /check precise lip-sync timing in playback/);
      }
      if (name === "idea-to-3d-model") {
        assert.match(html, /3D sample/);
        assert.match(text, /holds up from every side/);
        assert.match(text, /go soft at some angles/);
      }
      if (name === "mix-the-references") {
        assert.match(html, /Composite sample/);
        assert.match(text, /names each image by number/);
        assert.match(text, /paper boats from the place reference mostly drop out/);
      }
    }
  });
}

test("sample calls come from saved graph inputs and omit workflows requiring uploads or text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-samples-"));
  let server;
  try {
    const graph = JSON.parse(await readFile(new URL("./fixtures/hello-noodle.json", import.meta.url), "utf8"));
    graph.nodes[0].fields.text = "Rewrite <release notes> for customers & preserve dates.";
    await writeFile(join(dir, "release-notes.json"), JSON.stringify(graph));
    for (const file of ["poster.json", "restyle.json"]) {
      await copyFile(new URL(`./fixtures/${file}`, import.meta.url), join(dir, file));
    }
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    const sampleTool = registry.tools.find(tool => tool.name === "release-notes");
    assert.equal(sampleTool.card.sample.text, graph.nodes[0].fields.text);
    assert.equal(registry.tools.find(tool => tool.name === "poster").card.sample, null);
    assert.equal(registry.tools.find(tool => tool.name === "restyle").card.sample, null);
    await registry.prepareCall({ name: "release-notes", arguments: {} });
    server = await serveHttp({
      host: "127.0.0.1", port: 0, name: "samples", version: "0", publicBase: "http://example.test", log: () => {},
      listTools: () => registry.listTools(), callTool: async () => { throw new Error("No generation in this test"); },
      toolInfo: registry.tools,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(base + "/")).text();
    const text = await (await fetch(base + "/llms.txt")).text();
    assert.match(html, /Try the included sample/);
    assert.match(html, /Rewrite &lt;release notes&gt; for customers &amp; preserve dates/);
    assert.equal((html.match(/Try the included sample/g) || []).length, 1);
    const call = JSON.parse(text.match(/example MCP call .*?: (.+)/)[1]);
    assert.deepEqual(call, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "release-notes", arguments: {} } });
    await registry.prepareCall(call.params);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP tools/list exposes the outcome and local skill beyond the truncated graph comment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-outcome-"));
  try {
    await copyFile(new URL("./fixtures/hello-noodle.json", import.meta.url), join(dir, "character-sprites.noodle-graph.json"));
    await copyFile(new URL("./fixtures/hello-noodle.json", import.meta.url), join(dir, "favicon.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    const tool = registry.listTools().find(tool => tool.name === "character-sprites");
    assert.ok(tool);
    assert.match(tool.description, /Example: Iron Verdict \(https:\/\/nanoodle\.com\/examples\/iron-verdict\/\)/);
    assert.match(tool.description, /local skill bakes animated sprites/);
    assert.match(tool.description, /Agent skill: https:\/\/github\.com\/nanoodlecom\/noodle-skills\/tree\/main\/skills\/character-sprites/);
    assert.doesNotMatch(registry.listTools().find(tool => tool.name === "run_noodle").description, /Iron Verdict/);
    const reviewed = registry.listTools().find(tool => tool.name === "favicon");
    assert.match(reviewed.description, /Example: Reviewed sample \(https:\/\/nanoodle\.com\/examples\/gallery\/#favicon\)/);
    assert.doesNotMatch(reviewed.description, /undefined|Agent skill:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idea-to-3d-model graph mounts as a tool with its reviewed 3D sample", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-3d-"));
  try {
    await copyFile(new URL("./fixtures/hosted/idea-to-3d-model.noodle-graph.json", import.meta.url), join(dir, "idea-to-3d-model.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    const tool = registry.listTools().find(tool => tool.name === "idea-to-3d-model");
    assert.ok(tool);
    assert.ok(tool.inputSchema.properties.Object_idea);
    assert.match(tool.description, /model3d:TRELLIS\.2 → GLB; returns model3d \(trellis-2\/image-to-3d\) saved to disk \(file path in result\)/);
    assert.match(tool.description, /Example: 3D sample \(https:\/\/nanoodle\.com\/examples\/gallery\/#idea-to-3d-model\)/);
    const card = registry.tools.find(tool => tool.name === "idea-to-3d-model").card;
    assert.deepEqual(card.steps.map(step => [step.label, step.n]), [["text", 2], ["llm", 1], ["join", 1], ["image", 1], ["model3d", 1]]);
    assert.equal(card.sample.label, "Object idea");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mix-the-references graph mounts as a tool with its reviewed composite sample", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-mix-"));
  try {
    await copyFile(new URL("./fixtures/hosted/mix-the-references.noodle-graph.json", import.meta.url), join(dir, "mix-the-references.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    const tool = registry.listTools().find(tool => tool.name === "mix-the-references");
    assert.ok(tool);
    for (const input of ["Who_character", "What_they_wear_outfit", "What_they_hold_prop", "Where_place", "Mix_instruction_names_each_image"]) {
      assert.ok(tool.inputSchema.properties[input], input);
    }
    assert.match(tool.description, /edit:Mix · FLUX\.3 Klein Edit; returns image \(flux-3\/klein\/edit-image, 1024×1024\) saved to disk \(file path in result\)/);
    assert.match(tool.description, /Example: Composite sample \(https:\/\/nanoodle\.com\/examples\/gallery\/#mix-the-references\)/);
    const card = registry.tools.find(tool => tool.name === "mix-the-references").card;
    assert.deepEqual(card.steps.map(step => [step.label, step.n]), [["text", 5], ["image", 4], ["edit", 1]]);
    assert.equal(card.sample.label, "Who · character");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("humanize-comment graph mounts as a text tool with a pinned deposit, locked prompts and no sample card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-"));
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    assert.deepEqual(registry.failures, []);
    const tool = registry.listTools().find(tool => tool.name === "humanize-comment");
    assert.ok(tool);
    // writers + decider carry fields.locked and the labels live in join separators:
    // only the three author-facing inputs are args, no system prompts or labels
    assert.deepEqual(Object.keys(tool.inputSchema.properties).filter((k) => k !== "_payment_id").sort(), ["Context", "Draft", "Guidance"]);
    assert.deepEqual(tool.inputSchema.required, ["Draft", "Context"]);
    for (const k of Object.keys(tool.inputSchema.properties)) assert.doesNotMatch(k, /system|label|writer|decider/i);
    assert.match(tool.inputSchema.properties.Guidance.description, /default: "a friendly, specific reply"; optional/);
    assert.match(tool.description, /llm:Decider \(GLM-5\.3\); returns text/);
    // no reviewed, published sample yet, so no example line or card
    assert.doesNotMatch(tool.description, /Example:/);
    const mounted = registry.tools.find(tool => tool.name === "humanize-comment");
    // the charge gate quotes a pinned x402.usd as the deposit (see serve-gate "pinned x402.usd")
    assert.deepEqual(mounted.x402, { usd: 0.0133 });
    assert.equal(mounted.card.sample, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("humanize-comment: a failed writer is skipped and the decider still returns a result", async (t) => {
  const { createServer } = await import("node:http");
  const judgePrompts = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.includes("/chat/completions")) { res.writeHead(404); return res.end(); }
      const body = JSON.parse(raw);
      if (body.model === "deepseek/deepseek-v4.1-flash-1017") { // writer B's host rejects the call
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad request" }));
      }
      let content = "rewrite by " + body.model;
      if (body.model === "z-ai/glm-5.3") {
        judgePrompts.push(body.messages[body.messages.length - 1].content);
        content = JSON.stringify({ winner: "A", text: "rewrite by qwen/qwen3.8-27b-novelist", why: "most human", ranked: [{ writer: "A", faithful: true, disqualified: false, reason: "most human" }, { writer: "C", faithful: true, disqualified: false, reason: "ok" }, { writer: "D", faithful: true, disqualified: true, reason: "banned phrase" }, { writer: "B", faithful: false, disqualified: true, reason: "missing" }] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-run-"));
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
    const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: "Thanks for sharing this.", Context: "We cut CI from 14 to 6 minutes." } });
    assert.notEqual(result.isError, true);
    const text = result.content.map((c) => c.text || "").join("\n");
    assert.match(text, /"winner":"A"/);
    // v2.5 decider output: the ranked list with per-rewrite faithful flags passes through the text output intact
    const json = JSON.parse(result.content.find((c) => /"winner"/.test(c.text || "")).text);
    // single JSON object {winner, text, why, ranked}; ranked always lists all four writers, a skipped one as missing
    assert.deepEqual(Object.keys(json).sort(), ["ranked", "text", "why", "winner"]);
    assert.deepEqual(json.ranked.map((r) => [r.writer, r.faithful, r.disqualified]), [["A", true, false], ["C", true, false], ["D", true, true], ["B", false, true]]);
    assert.equal(json.ranked.find((r) => r.writer === "B").reason, "missing");
    assert.equal(json.ranked.find((r) => r.writer === json.winner).disqualified, false);
    assert.equal(judgePrompts.length, 1);
    assert.match(judgePrompts[0], /\[ORIGINAL\]\nThanks for sharing this\./);
    assert.match(judgePrompts[0], /\[A\]\nrewrite by qwen\/qwen3\.8-27b-novelist/);
    assert.doesNotMatch(judgePrompts[0], /\[B\]/, "the failed writer's block is missing");
    assert.match(judgePrompts[0], /\[C\]\nrewrite by gemma-4-12b-it-starry-ocean/);
    assert.match(judgePrompts[0], /\[D\]\nrewrite by qwen\/qwen3\.8-27b-antislop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
