import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../src/http.mjs";
import { loadTools } from "../src/tools.mjs";
import { HUMANIZE_INPUT_CAPS, HUMANIZE_FALLBACKS, REASK_TEXT, MAX_REASKS } from "../src/humanize.mjs";
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
    // ESTIMATE, not a hard bound (v2.7): worst case at the ENFORCED input caps (src/humanize.mjs),
    // every writer at its 600-token cap, inputs + system prompts at 3 characters per token,
    // the decider (which reads the Guidance and five 600-token rewrites but no longer copies
    // them: ids, flags, reasons and the winner's text only) replying at its 1600-token cap.
    // Writer C is counted at the worse of Cydonia alone or a billed-but-timed-out Cydonia call
    // plus the Starry Ocean fallback. Near-copy re-asks (writer input + its 600-token answer +
    // REASK_TEXT) are capped at MAX_REASKS (3) per run; the three most expensive are counted.
    // Result: $0.01304480 after the 20% markup, $0.00025520 (about 1.9%) under the $0.0133 pin;
    // $0.01047080 with no re-ask.
    // Above the deposit, the gate (src/gate.mjs settle) charges the customer at most the deposit,
    // pays no change or author payout, and the operator absorbs the provider cost above it.
    // Prices per M tokens (NanoGPT, 20 Oct 2026): GLM-5.3 $0.60/$1.10, Cydonia $0.12/$0.15,
    // Starry Ocean $0.05/$0.25, others $0.10 in and $0.35-$0.60 out.
    const graph = JSON.parse(await readFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), "utf8"));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const judge = byId.get("judge");
    assert.equal(judge.fields.maxTokens, "1600");
    assert.equal(MAX_REASKS, 3);
    const PRICE = { "qwen/qwen3.8-27b-novelist": [0.1, 0.6], "deepseek/deepseek-v4.1-flash-1017": [0.1, 0.6], "TheDrummer/Cydonia-24B-v4.3": [0.12, 0.15], "gemma-4-12b-it-starry-ocean": [0.05, 0.25], "qwen/qwen3.8-27b-antislop": [0.1, 0.6], "inception/mercury-3": [0.1, 0.35] };
    const bytes = (s) => Buffer.byteLength(s, "utf8");
    const { Draft, Context, Guidance } = HUMANIZE_INPUT_CAPS;
    const CPT = 3, W = 600; // characters per token (estimate), writer output cap
    let base = 0;
    const reasks = [];
    for (const id of ["w-a", "w-b", "w-c", "w-d", "w-e"]) {
      const n = byId.get(id);
      assert.equal(n.fields.maxTokens, String(W));
      const inTok = (bytes(n.fields.system) + Draft + Context + Guidance + 2 * bytes(byId.get("j-in").fields.sep)) / CPT;
      const call = ([p, c], extra = 0) => (inTok + extra) * p + W * c;
      const re = (pc) => call(pc, W + bytes(REASK_TEXT) / CPT);
      const P = PRICE[n.fields.model];
      const fb = HUMANIZE_FALLBACKS[n.fields.model];
      if (fb) { base += Math.max(call(P), call(P) + call(PRICE[fb])); reasks.push(Math.max(re(P), re(PRICE[fb]))); }
      else { base += call(P); reasks.push(re(P)); }
    }
    const reask = reasks.sort((a, b) => b - a).slice(0, MAX_REASKS).reduce((a, b) => a + b, 0);
    const seps = ["k1", "k2", "k3", "k4", "k5", "k6", "j-cg"].reduce((a, k) => a + bytes(byId.get(k).fields.sep), 0);
    const judgeUsd = ((bytes(judge.fields.system) + Draft + Context + Guidance + seps) / CPT + 5 * W) * 0.6 + Number(judge.fields.maxTokens) * 1.1;
    const est = (x) => (x / 1e6 * 1.2).toFixed(8);
    assert.equal(est(base + judgeUsd), "0.01047080", "the docs quote this exact estimate (no re-ask)");
    assert.equal(est(base + reask + judgeUsd), "0.01304480", "the docs quote this exact estimate (3 re-asks)");
    assert.equal(mounted.x402.usd, 0.0133);
    assert.ok((base + reask + judgeUsd) / 1e6 * 1.2 <= mounted.x402.usd, "estimate fits the pin");
    assert.equal((mounted.x402.usd - (base + reask + judgeUsd) / 1e6 * 1.2).toFixed(8), "0.00025520", "margin quoted in the docs");
    // the caps are enforced before any money moves and advertised in the schema
    assert.equal(tool.inputSchema.properties.Draft.maxLength, Draft);
    assert.equal(tool.inputSchema.properties.Context.maxLength, Context);
    assert.equal(tool.inputSchema.properties.Guidance.maxLength, Guidance);
    await assert.rejects(registry.prepareCall({ name: "humanize-comment", arguments: { Draft: "x".repeat(Draft + 1), Context: "c" } }),
      (e) => e.mcpCode === -32602 && /"Draft" is 1501 characters; humanize-comment accepts at most 1500/.test(e.message));
    await assert.rejects(registry.prepareCall({ name: "humanize-comment", arguments: { Draft: "d", Context: "c".repeat(Context + 1) } }), /"Context" is 3501 characters.*at most 3500/);
    await assert.rejects(registry.prepareCall({ name: "humanize-comment", arguments: { Draft: "d", Context: "c", Guidance: "g".repeat(Guidance + 1) } }), /"Guidance" is 301 characters/);
    // caps count code points, so a 1500-emoji draft is allowed and 1501 is not
    await registry.prepareCall({ name: "humanize-comment", arguments: { Draft: "😀".repeat(Draft), Context: "c".repeat(Context), Guidance: "g".repeat(Guidance) } });
    await assert.rejects(registry.prepareCall({ name: "humanize-comment", arguments: { Draft: "😀".repeat(Draft + 1), Context: "c" } }), /"Draft" is 1501 characters/);
    assert.equal(mounted.card.sample, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("humanize-comment: model credit and texts come from the writers by id, not from the decider's copy", async (t) => {
  const { createServer } = await import("node:http");
  // exact writer outputs, with characters an LLM likes to "fix" (curly quote, double space, trailing newline; dashes are covered by the v2.7 test)
  const outputs = {
    "qwen/qwen3.8-27b-novelist": "Hey, that\u2019s  a big win, 14 to 6!\n",
    "TheDrummer/Cydonia-24B-v4.3": "Nice cut. What changed first?",
    "qwen/qwen3.8-27b-antislop": "Good work on the CI time.",
    "inception/mercury-3": "14 \u2192 6 min, love it.",
  };
  let judgeCalls = 0;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (body.model === "deepseek/deepseek-v4.1-flash-1017") { // writer B really fails and is skipped (onError: skip)
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unavailable" }));
      }
      let content = outputs[body.model];
      if (body.model === "z-ai/glm-5.3") {
        judgeCalls++;
        // the decider shifts model credit as if the labels slid up past the missing B block,
        // paraphrases texts, ranks a missing writer as eligible and drops E entirely
        content = JSON.stringify({ winner: "C", text: "Nice cut! What changed first?", why: "most human", ranked: [
          { writer: "C", model: "qwen/qwen3.8-27b-antislop", text: "Nice cut! What changed first?", faithful: true, disqualified: false, reason: "fresh" },
          { writer: "A", model: "deepseek/deepseek-v4.1-flash-1017", text: "Hey - that's a big win, 14 to 6!", faithful: true, disqualified: false, reason: "warm" },
          { writer: "B", model: "TheDrummer/Cydonia-24B-v4.3", text: "invented text", faithful: true, disqualified: false, reason: "ok" },
          { writer: "D", model: "inception/mercury-3", text: "Good work on CI time.", faithful: true, disqualified: true, reason: "near-copy" },
        ] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-credit-"));
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
    const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: "Thanks for sharing this.", Context: "We cut CI from 14 to 6 minutes." } });
    assert.notEqual(result.isError, true);
    assert.equal(judgeCalls, 1);
    const json = JSON.parse(result.content.find((c) => /"winner"/.test(c.text || "")).text);
    assert.deepEqual(Object.keys(json), ["winner", "text", "why", "ranked"]);
    assert.equal(json.winner, "C");
    assert.equal(json.text, outputs["TheDrummer/Cydonia-24B-v4.3"], "top-level text is the winner's exact output");
    const by = Object.fromEntries(json.ranked.map((r) => [r.writer, r]));
    assert.deepEqual(json.ranked.map((r) => r.writer), ["C", "A", "B", "D", "E"]);
    assert.deepEqual(Object.fromEntries(json.ranked.map((r) => [r.writer, r.model])), {
      A: "qwen/qwen3.8-27b-novelist", B: "deepseek/deepseek-v4.1-flash-1017", C: "TheDrummer/Cydonia-24B-v4.3",
      D: "qwen/qwen3.8-27b-antislop", E: "inception/mercury-3",
    });
    assert.equal(by.A.text, outputs["qwen/qwen3.8-27b-novelist"], "byte-exact, not the decider's paraphrase");
    assert.equal(by.C.text, outputs["TheDrummer/Cydonia-24B-v4.3"]);
    assert.equal(by.D.text, outputs["qwen/qwen3.8-27b-antislop"]);
    assert.equal(by.E.text, outputs["inception/mercury-3"], "a writer the decider dropped is still listed with its text");
    assert.equal(by.E.disqualified, true);
    // the skipped writer is missing no matter what the decider claimed
    assert.deepEqual([by.B.text, by.B.faithful, by.B.disqualified, by.B.reason], ["", false, true, "missing"]);
    // decider judgements kept where the writer exists
    assert.deepEqual([by.C.disqualified, by.A.disqualified, by.D.disqualified, by.D.reason], [false, false, true, "near-copy"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function runHumanizeWith(t, judgeContent) {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const content = body.model === "z-ai/glm-5.3" ? judgeContent : "rewrite by " + body.model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-fb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: "Thanks for sharing this.", Context: "We cut CI from 14 to 6 minutes." } });
  assert.notEqual(result.isError, true);
  const block = result.content.find((c) => /^\{"winner"/.test(c.text || ""));
  return { json: JSON.parse(block.text), texts: result.content.map((c) => c.text || "") };
}
const HC_MODELS = { A: "qwen/qwen3.8-27b-novelist", B: "deepseek/deepseek-v4.1-flash-1017", C: "TheDrummer/Cydonia-24B-v4.3", D: "qwen/qwen3.8-27b-antislop", E: "inception/mercury-3" };

test("humanize-comment: an unusable decider reply is never passed through; ORIGINAL wins with real writer texts", async (t) => {
  for (const bad of ['{"winner":"A","text":"oops", "ranked":[{"writer":"A"', '{"winner":"A","text":"made up","why":"x"}', "[]", "Sure! Here is my ranking: A"]) {
    const { json, texts } = await runHumanizeWith(t, bad);
    assert.deepEqual(Object.keys(json), ["winner", "text", "why", "ranked"]);
    assert.equal(json.winner, "ORIGINAL");
    assert.equal(json.text, "Thanks for sharing this.");
    assert.deepEqual(json.ranked.map((r) => [r.writer, r.model, r.text, r.faithful, r.disqualified]),
      Object.entries(HC_MODELS).map(([w, m]) => [w, m, "rewrite by " + m, false, true]));
    assert.ok(json.ranked.every((r) => r.reason === "not judged: decider reply unusable"));
    assert.ok(texts.some((x) => /^note: the decider's reply was not valid JSON with a ranked list/.test(x)), "a clear note leads the result");
    assert.ok(!texts.some((x) => x.includes("made up") || x.includes("Sure!")), "nothing of the bad reply is passed through");
  }
});

test("humanize-comment: an entry with faithful:false never wins, even if the decider picks it", async (t) => {
  const e = (w, faithful, disqualified, reason = "ok") => ({ writer: w, model: HC_MODELS[w], text: "x", faithful, disqualified, reason });
  // A is picked but unfaithful (and wrongly not disqualified) → best faithful eligible entry, C, wins
  let { json } = await runHumanizeWith(t, JSON.stringify({ winner: "A", text: "x", why: "most human", ranked: [e("A", false, false, "adds a fact"), e("B", false, false), e("C", true, false), e("D", true, false), e("E", true, true, "near-copy")] }));
  assert.equal(json.winner, "C");
  assert.equal(json.text, "rewrite by " + HC_MODELS.C);
  assert.match(json.why, /picked A, which is not eligible/);
  assert.deepEqual(json.ranked.map((r) => [r.writer, r.faithful, r.disqualified]), [["C", true, false], ["D", true, false], ["A", false, true], ["B", false, true], ["E", true, true]]);
  assert.equal(json.ranked.find((r) => r.writer === "A").reason, "unfaithful: adds a fact");
  // a non-boolean faithful counts as unfaithful too; with nothing eligible left, ORIGINAL wins
  ({ json } = await runHumanizeWith(t, JSON.stringify({ winner: "B", text: "x", why: "w", ranked: [e("B", "true", false), e("A", false, false), e("C", true, true), e("D", true, true), e("E", true, true)] })));
  assert.equal(json.winner, "ORIGINAL");
  assert.equal(json.text, "Thanks for sharing this.");
  assert.ok(json.ranked.every((r) => r.disqualified));
  // the decider's own ORIGINAL pick stands
  ({ json } = await runHumanizeWith(t, JSON.stringify({ winner: "ORIGINAL", text: "x", why: "all near-copies", ranked: ["A", "B", "C", "D", "E"].map((w) => e(w, true, false)) })));
  assert.deepEqual([json.winner, json.text, json.why], ["ORIGINAL", "Thanks for sharing this.", "all near-copies"]);
});

test("humanize-comment v2.7: C falls back on 429 and is credited, dashes are fixed and a near-copy is re-asked before the decider", async (t) => {
  const { createServer } = await import("node:http");
  const DRAFT = "Thanks for sharing this, the drop from 14 to 6 minutes on CI is really great work.";
  const calls = [];
  let judgePrompt = null;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const last = body.messages[body.messages.length - 1].content;
      const reask = body.messages.length > 2 && /copied the draft/.test(last);
      calls.push(body.model + (reask ? " (re-ask)" : ""));
      const ok = (content) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } })); };
      if (body.model === "TheDrummer/Cydonia-24B-v4.3") { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "model overloaded" })); }
      if (body.model === "qwen/qwen3.8-27b-novelist") return ok("Nice one \u2014 14 to 6 is a real cut \u2013 what did you change first?");
      if (body.model === "qwen/qwen3.8-27b-antislop") return ok(reask ? "You took CI from 14 to 6 minutes. Thanks for writing it up." : DRAFT);
      if (body.model === "z-ai/glm-5.3") {
        judgePrompt = last;
        return ok(JSON.stringify({ winner: "C", text: "x", why: "peer voice", ranked: ["C", "A", "D", "B", "E"].map((w) => ({ writer: w, model: "?", text: "x", faithful: true, disqualified: false, reason: "ok" })) }));
      }
      return ok("rewrite by " + body.model);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-v27-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: DRAFT, Context: "We cut CI from 14 to 6 minutes.", Guidance: "Keep the thanks." } });
  assert.notEqual(result.isError, true);
  const texts = result.content.map((c) => c.text || "");
  const json = JSON.parse(texts.find((x) => /^\{"winner"/.test(x)));
  const by = Object.fromEntries(json.ranked.map((r) => [r.writer, r]));
  // C: Cydonia 429 → Starry Ocean answered and is the model credited
  assert.equal(by.C.model, "gemma-4-12b-it-starry-ocean");
  assert.equal(by.C.text, "rewrite by gemma-4-12b-it-starry-ocean");
  assert.equal(json.winner, "C");
  assert.equal(json.text, "rewrite by gemma-4-12b-it-starry-ocean");
  assert.ok(texts.some((x) => /writer C \(TheDrummer\/Cydonia-24B-v4\.3\) did not answer \(HTTP 429\), so gemma-4-12b-it-starry-ocean wrote C's rewrite/.test(x)));
  // the other writers keep their graph models
  assert.deepEqual([by.A.model, by.B.model, by.D.model, by.E.model], ["qwen/qwen3.8-27b-novelist", "deepseek/deepseek-v4.1-flash-1017", "qwen/qwen3.8-27b-antislop", "inception/mercury-3"]);
  // dashes fixed before the decider read them, and the result carries the same text
  assert.equal(by.A.text, "Nice one, 14 to 6 is a real cut, what did you change first?");
  assert.match(judgePrompt, /\[A\] qwen\/qwen3\.8-27b-novelist\nNice one, 14 to 6 is a real cut, what did you change first\?/);
  assert.doesNotMatch(judgePrompt, /[\u2014\u2013]/);
  // D copied the draft → re-asked once; the decider only ever saw the second answer
  assert.equal(by.D.text, "You took CI from 14 to 6 minutes. Thanks for writing it up.");
  assert.match(judgePrompt, /\[D\] qwen\/qwen3\.8-27b-antislop\nYou took CI/);
  assert.ok(!judgePrompt.includes("[D] qwen/qwen3.8-27b-antislop\n" + DRAFT));
  assert.ok(texts.some((x) => /writer D's first rewrite copied the draft \(trigram overlap 1\.00\), so it was re-asked once \(overlap now 0\.\d\d\)/.test(x)));
  assert.deepEqual(calls.filter((c) => /antislop/.test(c)).sort(), ["qwen/qwen3.8-27b-antislop", "qwen/qwen3.8-27b-antislop (re-ask)"]);
  assert.equal(calls.filter((c) => /re-ask/.test(c)).length, 1, "only the near-copy writer is re-asked");
  // the decider sees the Guidance block
  assert.match(judgePrompt, /We cut CI from 14 to 6 minutes\.\n\n=====\n\nKeep the thanks\.\n\n=====\n\n\[ORIGINAL\]\n/);
  // cost: 6 billed writer calls (A, B, Starry, D, D re-ask, E) + decider; the 429 is not billed
  assert.ok(texts.some((x) => x === "cost: $0.0007"), texts.find((x) => /^cost/.test(x)));
});

test("humanizeFetch: timeout fallback, no fallback on 402, no re-ask after the deadline", async () => {
  const { humanizeFetch } = await import("../src/humanize.mjs");
  const record = { A: { model: "a" }, B: { model: "b" }, C: { model: "TheDrummer/Cydonia-24B-v4.3", fallbackModel: "gemma-4-12b-it-starry-ocean" }, D: { model: "d" }, E: { model: "e" } };
  const reply = (content, status = 200) => new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.001 } } : { error: "x" }), { status, headers: { "content-type": "application/json" } });
  const url = "http://x/api/v1/chat/completions";
  const req = (model) => ({ method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) });
  // a primary that never answers is abandoned after primaryTimeoutMs
  let hf = humanizeFetch({ record, draft: "", primaryTimeoutMs: 50, fetch: (u, init) => {
    const m = JSON.parse(init.body).model;
    if (m === "TheDrummer/Cydonia-24B-v4.3") return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    return Promise.resolve(reply("from " + m));
  } });
  let r = await hf.fetch(url, req("TheDrummer/Cydonia-24B-v4.3"));
  assert.equal((await r.json()).choices[0].message.content, "from gemma-4-12b-it-starry-ocean");
  assert.deepEqual(hf.state.fallback.C, { from: "TheDrummer/Cydonia-24B-v4.3", to: "gemma-4-12b-it-starry-ocean", reason: "no answer in 0 s", ok: true });
  assert.equal(hf.state.answered.C, "gemma-4-12b-it-starry-ocean");
  // 402 (x402 payment flow) passes straight through: no fallback
  hf = humanizeFetch({ record, draft: "", fetch: () => Promise.resolve(reply("", 402)) });
  r = await hf.fetch(url, req("TheDrummer/Cydonia-24B-v4.3"));
  assert.equal(r.status, 402);
  assert.deepEqual(hf.state.fallback, {});
  // a near-copy past the re-ask deadline is kept as is (the writer's 60 s budget comes first)
  let t = 0, n = 0;
  hf = humanizeFetch({ record, draft: "one two three four five six", now: () => (t += 40000), fetch: () => { n++; return Promise.resolve(reply("one two three four five six")); } });
  r = await hf.fetch(url, req("d"));
  assert.equal(n, 1);
  assert.deepEqual(hf.state.reasked, {});
  // non-writer models (the decider) and non-chat calls are untouched
  n = 0;
  hf = humanizeFetch({ record, draft: "one two three four five six", fetch: () => { n++; return Promise.resolve(reply("one two three four five six")); } });
  await hf.fetch(url, req("z-ai/glm-5.3"));
  await hf.fetch("http://x/api/v1/models", { method: "GET" });
  assert.equal(n, 2);
  assert.deepEqual(hf.state.answered, {});
});

test("humanize-comment v2.7: at most 3 re-asks per run; a decider reply with ids only still gets exact texts and models", async (t) => {
  const { createServer } = await import("node:http");
  const DRAFT = "Thanks for sharing this, the drop from 14 to 6 minutes on CI is really great work.";
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const reask = body.messages.length > 2;
      calls.push(body.model + (reask ? " (re-ask)" : ""));
      let content = reask ? "Fresh words from " + body.model + " about your CI cut." : DRAFT; // every writer copies the draft
      if (body.model === "z-ai/glm-5.3") content = JSON.stringify({ winner: "B", text: "paraphrase", why: "warm", ranked: ["B", "A", "C", "D", "E"].map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: DRAFT, Context: "We cut CI from 14 to 6 minutes." } });
  const texts = result.content.map((c) => c.text || "");
  assert.equal(calls.filter((c) => /re-ask/.test(c)).length, 3, "re-asks are capped at 3 per run");
  assert.equal(texts.filter((x) => /so it was re-asked once/.test(x)).length, 3);
  assert.equal(texts.filter((x) => /was not re-asked \(the 3-re-ask limit for this run was reached\)/.test(x)).length, 2);
  const json = JSON.parse(texts.find((x) => /^\{"winner"/.test(x)));
  // the decider sent no texts or models: the rebuild fills both from the writers
  assert.equal(json.ranked.length, 5);
  for (const r of json.ranked) {
    assert.equal(typeof r.model, "string");
    assert.ok(r.text === DRAFT || r.text === "Fresh words from " + r.model + " about your CI cut.", r.text);
  }
  assert.equal(json.text, json.ranked.find((r) => r.writer === "B").text, "top-level text is B's exact output, not the decider's paraphrase");
  // 5 writers + 3 re-asks + decider
  assert.ok(texts.includes("cost: $0.0009"), texts.find((x) => /^cost/.test(x)));
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
        content = JSON.stringify({ winner: "A", text: "rewrite by qwen/qwen3.8-27b-novelist", why: "most human", ranked: [{ writer: "A", model: "qwen/qwen3.8-27b-novelist", text: "rewrite by qwen/qwen3.8-27b-novelist", faithful: true, disqualified: false, reason: "most human" }, { writer: "C", model: "TheDrummer/Cydonia-24B-v4.3", text: "rewrite by TheDrummer/Cydonia-24B-v4.3", faithful: true, disqualified: false, reason: "ok" }, { writer: "E", model: "inception/mercury-3", text: "rewrite by inception/mercury-3", faithful: true, disqualified: false, reason: "ok" }, { writer: "D", model: "qwen/qwen3.8-27b-antislop", text: "rewrite by qwen/qwen3.8-27b-antislop", faithful: true, disqualified: true, reason: "near-copy" }, { writer: "B", model: "deepseek/deepseek-v4.1-flash-1017", text: "", faithful: false, disqualified: true, reason: "missing" }] });
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
    // single JSON object {winner, text, why, ranked}; ranked always lists all five writers, a skipped one as missing
    assert.deepEqual(Object.keys(json).sort(), ["ranked", "text", "why", "winner"]);
    assert.deepEqual(json.ranked.map((r) => [r.writer, r.faithful, r.disqualified]), [["A", true, false], ["C", true, false], ["E", true, false], ["D", true, true], ["B", false, true]]);
    assert.equal(json.ranked.find((r) => r.writer === "B").reason, "missing");
    // eligible first: no disqualified:false entry may follow a disqualified one
    const firstDq = json.ranked.findIndex((r) => r.disqualified);
    assert.ok(firstDq === -1 || json.ranked.slice(firstDq).every((r) => r.disqualified), "an eligible entry follows a disqualified one");
    assert.equal(json.ranked.find((r) => r.writer === json.winner).disqualified, false);
    assert.equal(judgePrompts.length, 1);
    assert.match(judgePrompts[0], /\[ORIGINAL\]\nThanks for sharing this\./);
    assert.match(judgePrompts[0], /\[A\] qwen\/qwen3\.8-27b-novelist\nrewrite by qwen\/qwen3\.8-27b-novelist/);
    assert.doesNotMatch(judgePrompts[0], /\[B\]/, "the failed writer's block is missing");
    assert.match(judgePrompts[0], /\[C\] TheDrummer\/Cydonia-24B-v4\.3\nrewrite by TheDrummer\/Cydonia-24B-v4\.3/);
    assert.match(judgePrompts[0], /\[D\] qwen\/qwen3\.8-27b-antislop\nrewrite by qwen\/qwen3\.8-27b-antislop/);
    assert.match(judgePrompts[0], /\[E\] inception\/mercury-3\nrewrite by inception\/mercury-3/);
    assert.equal(json.ranked.length, 5);
    // every ranked entry carries its model name and full text; the decider copies them from the labelled blocks
    for (const r of json.ranked) {
      assert.equal(typeof r.model, "string"); assert.equal(typeof r.text, "string");
      if (r.reason !== "missing") assert.equal(r.text, "rewrite by " + r.model);
    }
    assert.equal(json.ranked.find((r) => r.writer === "E").model, "inception/mercury-3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
