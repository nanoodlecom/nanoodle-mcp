/**
 * Hosted graphs in tests/fixtures/hosted/ are the copies served from
 * /srv/nanoodle-mcp/graphs/graphs/. photo-to-video is the safe default;
 * photo-to-video-spicy is the NSFW-permissive copy and must not be the name
 * an agent hits by accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveHttp } from "../src/http.mjs";
import {
  loadTools,
  SPICY_WARNING_LEAD,
  compareToolNames,
  graphUsesSpicyModel,
  hostedSpicyViolations,
  modelIsSpicy,
} from "../src/tools.mjs";

const HOSTED = fileURLToPath(new URL("./fixtures/hosted/", import.meta.url));
const SAFE_MODEL = "minimax-h3-singularity/image-to-video";
const SPICY_MODEL = "minimax-h3/image-to-video-spicy";

function videoModel(tool) {
  const node = tool.wf.graph.nodes.find((n) => n.type === "ivideo");
  return node && node.fields && node.fields.model;
}

test("spicy model ids are tokens, not substrings of safe model names", () => {
  assert.equal(modelIsSpicy(SPICY_MODEL), true);
  assert.equal(modelIsSpicy("vendor/nsfw-image"), true);
  assert.equal(modelIsSpicy("org/uncensored-llm"), true);
  assert.equal(modelIsSpicy(SAFE_MODEL), false);
  assert.equal(modelIsSpicy("minimax/h3-max"), false);
  assert.equal(modelIsSpicy("minimax-h3/image-to-video"), false);
});

test("hosted tools: safe photo-to-video, spicy sibling, warning, and order", async () => {
  const out = await mkdtemp(join(tmpdir(), "hosted-spicy-out-"));
  let server;
  try {
    const registry = await loadTools({ dirs: [HOSTED], apiKey: "test-key", outDir: out, log: () => {} });
    assert.deepEqual(registry.failures, [], "every hosted fixture must load");
    const tools = registry.listTools().filter((t) => t.name !== "run_noodle");
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("photo-to-video"));
    assert.ok(names.includes("photo-to-video-spicy"));
    assert.equal(names.indexOf("photo-to-video-spicy"), names.indexOf("photo-to-video") + 1);

    const safe = registry.tools.find((t) => t.name === "photo-to-video");
    const spicy = registry.tools.find((t) => t.name === "photo-to-video-spicy");
    assert.equal(videoModel(safe), SAFE_MODEL);
    assert.equal(graphUsesSpicyModel(safe.wf.graph), false);
    assert.equal(videoModel(spicy), SPICY_MODEL);
    assert.equal(graphUsesSpicyModel(spicy.wf.graph), true);
    assert.equal(safe.x402, null);
    assert.equal(spicy.x402, null);

    for (const tool of [safe, spicy]) {
      assert.ok(tool.inputSchema.properties.Still_brief, `${tool.name} input Still_brief`);
      assert.ok(tool.inputSchema.properties.Motion_brief, `${tool.name} input Motion_brief`);
    }

    assert.ok(spicy.description.startsWith(SPICY_WARNING_LEAD));
    assert.match(spicy.description, /Agents wanting safe output should use photo-to-video\./);
    assert.match(spicy.description, /MiniMax H3 Spicy/);
    assert.doesNotMatch(safe.description, /Content warning|image-to-video-spicy|NSFW-permissive/);
    assert.match(safe.description, /MiniMax H3 Singularity/);
    assert.match(safe.description, /returns video \(image-to-video\)/);
    assert.match(spicy.description, /returns video \(image-to-video-spicy\)/);

    assert.deepEqual(hostedSpicyViolations(registry.tools), []);

    server = await serveHttp({
      host: "127.0.0.1", port: 0, name: "hosted", version: "0",
      publicBase: "http://example.test", log: () => {},
      listTools: () => registry.listTools(),
      callTool: async () => { throw new Error("no generation"); },
      toolInfo: registry.tools,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(base + "/")).text();
    const llms = await (await fetch(base + "/llms.txt")).text();
    const note = "Adult-content variants: photo-to-video-spicy can produce adult content even from a harmless prompt. Prefer photo-to-video.";
    const safeCard = html.indexOf('id="photo-to-video"');
    const spicyCard = html.indexOf('id="photo-to-video-spicy"');
    assert.ok(safeCard !== -1 && spicyCard > safeCard, "landing lists the safe card, then the spicy card");
    assert.ok(html.indexOf(note) > spicyCard, "the adult-content note is on the spicy card");
    const safeLine = llms.indexOf("- photo-to-video:");
    const noteAt = llms.indexOf(note);
    const spicyLine = llms.indexOf("- photo-to-video-spicy:");
    assert.ok(safeLine !== -1 && noteAt > safeLine && spicyLine > noteAt, "llms.txt lists safe, then the note, then spicy");
    assert.ok(html.includes(SPICY_WARNING_LEAD) && llms.includes(SPICY_WARNING_LEAD));
    assert.equal((html.match(/Adult-content variants/g) || []).length, 1);
    assert.equal((llms.match(/Adult-content variants/g) || []).length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(out, { recursive: true, force: true });
  }
});

test("the hosted-spicy check fails a graph that hides a spicy model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-spicy-bad-"));
  const out = await mkdtemp(join(tmpdir(), "hosted-spicy-bad-out-"));
  try {
    const hidden = {
      v: 1,
      nodes: [
        { id: "c", type: "comment", x: 0, y: 0, fields: { text: "Animate a still. Harmless portrait motion only." } },
        { id: "n1", type: "text", x: 0, y: 0, name: "Still brief", fields: { text: "a coin and a coffee" } },
        { id: "n2", type: "ivideo", x: 0, y: 0, name: "Clip", fields: { model: "vendor/image-to-video-spicy", resolution: "480p", duration: "5" } },
      ],
      links: [{ id: "l", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
    };
    await writeFile(join(dir, "photo-to-video.noodle-graph.json"), JSON.stringify(hidden));
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: out, log: () => {} });
    const violations = hostedSpicyViolations(registry.tools);
    assert.ok(violations.some((v) => /not named -spicy/.test(v)), violations.join("\n"));
    assert.ok(violations.some((v) => /does not start with the spicy-model content warning/.test(v)), violations.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("the hosted-spicy check fails a -spicy tool with no safe sibling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-spicy-orphan-"));
  const out = await mkdtemp(join(tmpdir(), "hosted-spicy-orphan-out-"));
  try {
    const raw = await readFile(new URL("./fixtures/hosted/photo-to-video-spicy.noodle-graph.json", import.meta.url), "utf8");
    await writeFile(join(dir, "photo-to-video-spicy.noodle-graph.json"), raw);
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: out, log: () => {} });
    const violations = hostedSpicyViolations(registry.tools);
    assert.ok(violations.some((v) => /missing safe sibling photo-to-video/.test(v)), violations.join("\n"));
    assert.ok(registry.tools[0].description.startsWith(SPICY_WARNING_LEAD));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("compareToolNames groups a spicy variant after its safe sibling", () => {
  const names = ["photo-to-video-spicy", "sing", "photo-to-video-extra", "photo-to-video"].sort(compareToolNames);
  assert.deepEqual(names, ["photo-to-video", "photo-to-video-spicy", "photo-to-video-extra", "sing"]);
});
