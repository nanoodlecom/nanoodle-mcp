import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { creatorPage } from "../src/creator-site.mjs";
import { serveHttp } from "../src/http.mjs";
import { computePrice, prepareRunNoodle } from "../src/tools.mjs";
import { startMockServer, PNG_B64 } from "../node_modules/nanoodle/tests/harness/mock-server.mjs";
import { WORKED_GRAPH, WORKED_CATALOGS } from "./fixtures/near-fake-chain.mjs";

const author = "nano_1111111111111111111111111111111111111111111111111111hifc8npp";
const link = (id, from, to, port, out = "text") => ({ id, from: { node: from, port: out }, to: { node: to, port } });
// Public example's native node types, ports and topology, with small test defaults.
// Source: https://nanoodle.com/examples/gallery/day-to-night/workflow.json
const native = {
  v: 1, nodes: [
    { id: "p-day", type: "text", name: "Day keyframe · prompt", fields: { text: "Day test default" } },
    { id: "day", type: "image", fields: { model: "meta/muse-image/text-to-image", size: "16:9" } },
    { id: "p-night", type: "text", name: "Night keyframe · instruction", fields: { text: "Night test default" } },
    { id: "night", type: "edit", fields: { model: "meta/muse-image/edit", size: "16:9" } },
    { id: "p-move", type: "text", name: "Transition · motion prompt", fields: { text: "Motion test default" } },
    { id: "clip", type: "ivideo", fields: { model: "minimax/h3-max", resolution: "768p", duration: "5" } },
  ], links: [link("1", "p-day", "day", "prompt"), link("2", "day", "night", "image", "image"),
    link("3", "p-night", "night", "prompt"), link("4", "day", "clip", "image", "image"),
    link("5", "night", "clip", "endframe", "image"), link("6", "p-move", "clip", "prompt")],
};
// An opt-in local file verifies the downloaded public graph without storing it in the repository.
const dayNight = () => ({ ...structuredClone(process.env.CREATOR_NATIVE_EXPORT ? JSON.parse(readFileSync(process.env.CREATOR_NATIVE_EXPORT)) : native), x402: { author } });
const keys = ["Day_keyframe_prompt", "Night_keyframe_instruction"];
const catalogs = {
  image: ["meta/muse-image/text-to-image", "meta/muse-image/edit"].map(id => ({ id, pricing: { currency: "USD", per_image: { "16:9": .011 } } })),
  video: [{ id: "minimax/h3-max", pricing: { currency: "USD", per_second_by_resolution: { "768p": .08 }, default_duration: 5, default_resolution: "768p" } }],
};
async function setup(t) {
  const provider = await startMockServer(); t.after(() => provider.close());
  provider.script("GET /api/v1/image-models", { json: { data: [...catalogs.image, ...WORKED_CATALOGS.image] } });
  provider.script("GET /api/v1/video-models", { json: { data: catalogs.video } });
  provider.script("GET /api/v1/models", { json: { data: WORKED_CATALOGS.chat } });
  provider.script("POST /v1/images/generations", ({ json: { data: [{ b64_json: PNG_B64 }], cost: .011 } }));
  provider.script("POST /api/generate-video", { json: { runId: "test-video", cost: .4 } });
  provider.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "data:video/mp4;base64,AAAA" } } });
  const creators = createHostedWorkflows({ dir: mkdtempSync(join(tmpdir(), "creator-inputs-")), publicBase: "https://near.example", baseUrl: provider.url,
    callTool: async ({ name, arguments: args }) => {
      const priced = await computePrice(args, { baseUrl: provider.url });
      assert.equal(priced.safety.ok, true, JSON.stringify(priced.safety));
      if (name === "price_noodle") return { content: [], structuredContent: { pricing: priced.pricing } };
      const { wf, inputs } = await prepareRunNoodle(args, { baseUrl: provider.url, apiKey: "local-test" });
      wf.client.pollIntervals.video = 1;
      wf.client.timeouts.video = 1000;
      const result = await wf.run(inputs);
      return { content: [], structuredContent: { outputs: Object.keys(result.outputs) } };
    } });
  return { creators, provider };
}
const body = graph => ({ graph, name: "Two keyframes", description: "Start and end keyframe text" });
const posts = provider => provider.requests.filter(r => r.method === "POST");

test("native two-input detection matches free validation, persisted tools and actual mocked executor payloads", async t => {
  const { creators, provider } = await setup(t), graph = dayNight();
  const checked = await creators.check(body(graph));
  assert.deepEqual(Object.keys(checked.schema.properties), keys);
  assert.deepEqual(checked.inputNodeIds, ["p-day", "p-night"]);
  assert.equal(posts(provider).length, 0, "intake never executes models");
  const hosted = await creators.submit(body(graph));
  assert.deepEqual(hosted.schema, checked.schema);
  for (const tool of creators.listTools(hosted.id)) {
    assert.deepEqual(Object.keys(tool.inputSchema.properties).filter(k => !k.startsWith("_")), keys);
  }
  const args = { [keys[0]]: "A red house in daylight", [keys[1]]: "The same red house at night" };
  await creators.callTool(hosted.id, { name: "price_workflow", arguments: args });
  assert.equal(posts(provider).length, 0, "pricing never executes models");
  const result = await creators.callTool(hosted.id, { name: "run_workflow", arguments: args });
  assert.ok(result.structuredContent.outputs.length);
  const images = provider.of("POST /v1/images/generations"), video = provider.of("POST /api/generate-video")[0].json;
  assert.equal(images.length, 2);
  assert.equal(images[0].json.prompt, args[keys[0]]);
  assert.equal(images[1].json.prompt, args[keys[1]]);
  assert.ok(images[1].json.imageDataUrl);
  assert.ok(video.imageDataUrl && video.last_image);
  assert.equal(video.prompt, graph.nodes.find(n => n.id === "p-move").fields.text);
  assert.equal(creators.get(hosted.id).graph.nodes.find(n => n.id === "p-day").fields.text, graph.nodes.find(n => n.id === "p-day").fields.text);
  const restored = createHostedWorkflows({ dir: creators.dir, publicBase: creators.publicBase, baseUrl: provider.url });
  assert.deepEqual(restored.publicView(hosted.id).schema, checked.schema);
});

test("both empty keyframes validate automatically and are independently required at call time", async t => {
  const { creators } = await setup(t), graph = dayNight();
  for (const n of graph.nodes) if (["p-day", "p-night"].includes(n.id)) n.fields.text = "";
  const hosted = await creators.submit(body(graph));
  assert.deepEqual(hosted.schema.required, keys);
  for (const key of keys) await assert.rejects(creators.callTool(hosted.id, { name: "run_workflow", arguments: { [key]: "only one" } }), /Missing workflow input/);
});

test("one customer input stays one; locked, unnamed, disconnected and saved optional defaults stay private", async t => {
  const { creators } = await setup(t), graph = dayNight();
  graph.nodes.find(n => n.id === "p-night").fields.locked = true;
  graph.nodes.push({ id: "unused", type: "text", name: "Unused", fields: { text: "private" } });
  graph.nodes.push({ id: "system", type: "text", fields: { text: "private system" } });
  const hosted = await creators.submit(body(graph));
  assert.deepEqual(Object.keys(hosted.schema.properties), [keys[0]]);
  await creators.callTool(hosted.id, { name: "run_workflow", arguments: { [keys[0]]: "A garden" } });
  await assert.rejects(creators.callTool(hosted.id, { name: "run_workflow", arguments: { Transition_motion_prompt: "overwrite" } }), /Unexpected/);
});

test("choice inputs, optional defaults and colliding safe names map to their own fields", async t => {
  const { creators, provider } = await setup(t), graph = dayNight();
  const first = graph.nodes.find(n => n.id === "p-day"), second = graph.nodes.find(n => n.id === "p-night");
  first.name = "Scene prompt"; second.name = "Scene_prompt";
  const hosted = await creators.submit(body(graph));
  assert.deepEqual(Object.keys(hosted.schema.properties), ["Scene_prompt", "Scene_prompt_2"]);
  await creators.callTool(hosted.id, { name: "run_workflow", arguments: { Scene_prompt: "First", Scene_prompt_2: "Second" } });
  assert.deepEqual(provider.of("POST /v1/images/generations").map(r => r.json.prompt), ["First", "Second"]);
  second.type = "choice"; second.fields = { options: "Night\nWinter", selected: "Night" };
  const chosen = await creators.submit(body(graph));
  assert.deepEqual(chosen.schema.properties.Scene_prompt_2.enum, ["Night", "Winter"]);
  await assert.rejects(creators.callTool(chosen.id, { name: "run_workflow", arguments: { Scene_prompt_2: "unlisted" } }), /Choose one/);
  first.fields.optional = true;
  const optional = await creators.submit(body(graph));
  assert.deepEqual(Object.keys(optional.schema.properties), ["Scene_prompt_2"]);
  const before = provider.of("POST /v1/images/generations").length;
  await creators.callTool(optional.id, { name: "run_workflow", arguments: { Scene_prompt_2: "Winter" } });
  assert.deepEqual(provider.of("POST /v1/images/generations").slice(before).map(r => r.json.prompt), [first.fields.text, "Winter"]);
});

test("legacy records keep all formerly published inputs after restart", async t => {
  const { creators, provider } = await setup(t), graph = dayNight(), record = await creators.submit(body(graph));
  const path = join(creators.dir, "workflows.json"), state = JSON.parse(readFileSync(path));
  delete state.workflows[record.id].inputNodeIds; delete state.workflows[record.id].schema;
  state.workflows[record.id].inputName = "Day keyframe · prompt";
  writeFileSync(path, JSON.stringify(state));
  const restored = createHostedWorkflows({ dir: creators.dir, publicBase: creators.publicBase, baseUrl: provider.url, callTool: async args => ({ content: [], structuredContent: { inputs: args.arguments.inputs } }) });
  assert.deepEqual(Object.keys(restored.publicView(record.id).schema.properties), [...keys, "Transition_motion_prompt"]);
  const result = await restored.callTool(record.id, { name: "run_workflow", arguments: { Transition_motion_prompt: "Legacy motion" } });
  assert.equal(result.structuredContent.inputs["Transition · motion prompt"], "Legacy motion");
});

// Synthetic equivalent of the supplied ComfyUI/LiteGraph v0.4 failure; no private prompts.
const comfy = { last_node_id: 2, last_link_id: 1, version: .4, nodes: [
  { id: 1, type: "CLIPTextEncodeFlux", widgets_values: ["test text", "test text", 3] },
  { id: 2, type: "VAEDecode", widgets_values: [] },
], links: [[1, 1, 0, 2, 0, "CONDITIONING"]], groups: [], config: {}, extra: {} };

test("foreign, malformed, unsafe and image-upload graphs cannot be silently hosted", async t => {
  const { creators, provider } = await setup(t);
  const foreign = process.env.CREATOR_PRIVATE_EXPORT ? JSON.parse(readFileSync(process.env.CREATOR_PRIVATE_EXPORT)) : comfy;
  for (const g of [foreign, { "1": { class_type: "CLIPTextEncode", inputs: { text: "test" } } }]) {
    await assert.rejects(creators.check(body(g)), /ComfyUI\/OpenArt.*native Nanoodle.*Save/);
    await assert.rejects(creators.submit(body(g)), /ComfyUI\/OpenArt/);
  }
  for (const name of ["constructor", "__proto__", "_payment_id"]) {
    const g = dayNight(); g.nodes.find(n => n.id === "p-day").name = name;
    await assert.rejects(creators.submit(body(g)), /reserved|underscore/);
  }
  for (const g of [{ nodes: [null], links: [] }, { nodes: [], links: [{ from: {}, to: {} }] },
    { ...dayNight(), nodes: [...dayNight().nodes, { id: "code", type: "code", fields: { code: "run()" } }] },
    { ...dayNight(), nodes: [...dayNight().nodes, { id: "upload", type: "upload", name: "Photo", fields: {} }] }]) {
    await assert.rejects(creators.submit(body(g)));
  }
  const textNamedImage = dayNight(); textNamedImage.nodes.find(n => n.id === "p-day").name = "Image upload";
  assert.ok((await creators.check(body(textNamedImage))).schema.properties.Image_upload, "text stays text regardless of its display name");
  const upload = { nodes: [{ id: "photo", type: "upload", name: "Day keyframe prompt", fields: {} }], links: [] };
  await assert.rejects(creators.check(body(upload)), /Image upload nodes are not supported/);
  assert.equal(creators.all().length, 0); assert.equal(posts(provider).length, 0);
});

function browser(graph, reply) {
  const events = new Map(), elements = new Map(), requests = [];
  const make = () => ({ value: "", textContent: "", hidden: false, children: [], files: [], reportValidity: () => true,
    replaceChildren() { this.children = []; }, append(item) { this.children.push(item); },
    addEventListener(type, fn) { events.set(`${this.id}:${type}`, fn); } });
  for (const id of ["creator-form", "creator-file", "creator-graph", "creator-name", "creator-description", "creator-inputs", "creator-error", "creator-preview", "creator-check", "creator-host"]) elements.set(id, { ...make(), id });
  elements.get("creator-graph").value = JSON.stringify(graph); elements.get("creator-name").value = "Example";
  vm.runInNewContext(readFileSync(new URL("../assets/creator-site.js", import.meta.url), "utf8"), {
    document: { getElementById: id => elements.get(id), createElement: make },
    fetch: async (path, init) => { requests.push({ path, body: JSON.parse(init.body) }); return { ok: true, json: async () => reply }; },
  });
  return { elements, requests, refresh: () => events.get("creator-graph:input")(), check: () => events.get("creator-check:click")() };
}

test("served browser form has no primary selector, rejects the foreign file locally and reports detected inputs", async () => {
  const html = creatorPage({ publicBase: "https://near.example", creatorScriptUrl: "/creator-site.js" }).body;
  assert.doesNotMatch(html, /Which input takes|id="creator-input"/);
  const p = browser(process.env.CREATOR_PRIVATE_EXPORT ? JSON.parse(readFileSync(process.env.CREATOR_PRIVATE_EXPORT)) : comfy); p.refresh();
  assert.match(p.elements.get("creator-error").textContent, /ComfyUI\/OpenArt/);
  p.check(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.requests.length, 0);
  const ok = browser(native, { schema: { properties: Object.fromEntries(keys.map(k => [k, { type: "string" }])) }, estimatedCostUsd: .422, author });
  ok.refresh(); ok.check(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ok.requests.length, 1); assert.equal(ok.requests[0].body.inputName, undefined);
  assert.match(ok.elements.get("creator-inputs").textContent, /Detected 2 customer inputs/);
  assert.equal(ok.elements.get("creator-error").textContent, "");
});

test("HTTP free check and hosted run page publish the same two fields and actionable errors", async t => {
  const { creators, provider } = await setup(t);
  const server = await serveHttp({ host: "127.0.0.1", port: 0, publicBase: "https://near.example", name: "test", version: "test", listTools: () => [], callTool: async () => ({}), creators, log: () => {} });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, graph) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(graph)) });
  const checked = await (await post("/creators/check", dayNight())).json();
  assert.deepEqual(Object.keys(checked.schema.properties), keys);
  const hosted = await (await post("/creators/workflows", dayNight())).json();
  assert.deepEqual(hosted.schema, checked.schema);
  const page = await (await fetch(base + `/workflows/${hosted.id}`)).text();
  for (const key of keys) assert.ok(page.includes(key));
  assert.ok(!page.includes("Transition_motion_prompt"));
  for (const path of ["/creators/check", "/creators/workflows"]) {
    const failed = await post(path, comfy); assert.equal(failed.status, 400); assert.match((await failed.json()).error, /ComfyUI\/OpenArt/);
  }
  assert.equal(posts(provider).length, 0);
});
