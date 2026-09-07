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
    assert.match(html, /src="https:\/\/nanoodle\.com\/examples\/iron-verdict\/screenshot.png"/);
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

for (const name of ["favicon", "fibo-studio-still", "night-market-postcard", "image-model-arena", "edit-a-photo", "combine-images", "photo-to-video", "omni-flash-turntable", "deslop", "render-a-mockup", "sing", "talking-avatar"]) {
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
      else assert.ok(html.includes(`https://nanoodle.com/examples/gallery/${name}/preview.webp`));
      if (name === "sing") {
        assert.match(html, /Audio sample/);
        assert.match(text, /model-assisted audio review, not human listening sign-off/);
      }
      if (name === "talking-avatar") {
        assert.match(html, /Video sample/);
        assert.match(text, /check precise lip-sync timing in playback/);
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
