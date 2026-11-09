// Itemized pricing for custom workflows: the per-node lines must add up to the
// engine's own estimateGraphCost for the same graph and catalog, and the
// deposit must use the same expression as the Nano rail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateGraphCost, Workflow } from "nanoodle";
import {
  priceGraph, depositUsdFor, refusalsForQuote, assertGraphSafe, applyInputs,
  DEFAULT_CHAT_OUTPUT_TOKENS, SERVICE_FEE_RATE,
} from "../src/custom-workflow.mjs";

const link = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

// The doc's worked example (docs/near-payments.md).
const WORKED = {
  v: 1,
  nodes: [
    { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
    { id: "n2", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write one vivid image prompt for the idea. Reply with the prompt only." } },
    { id: "n3", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024" } },
  ],
  links: [link("l1", "n1", "text", "n2", "prompt"), link("l2", "n2", "text", "n3", "prompt")],
};
const WORKED_CATALOGS = {
  chat: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3 } }],
  image: [{ id: "blackforestlabs/flux-3/klein/text-to-image", pricing: { per_image: { "1024x1024": 0.009 } } }],
};

// Entries copied from NanoGPT's public catalog endpoints (/api/v1/models?detailed=true,
// /image-models, /video-models, /audio-models, /3d-models), trimmed to the fields the
// estimator reads. Prices are a snapshot; the tests only need realistic shapes.
const CATALOGS = {
  chat: [
    { id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3, currency: "USD", unit: "per_million_tokens" } },
    { id: "z-ai/glm-5.3-uncensored", pricing: { prompt: 1.25, completion: 2.25, currency: "USD", unit: "per_million_tokens" } },
    { id: "qwen/qwen3.5-omni-flash", pricing: { currency: "USD", unit: "per_million_tokens", note: "varies_by_modality" } },
  ],
  image: [
    { id: "blackforestlabs/flux-3/klein/text-to-image", pricing: { per_image: { "768x768": 0.008, "1024x1024": 0.009, "1536x1536": 0.011, "2048x2048": 0.014, "4096x4096": 0.036 }, currency: "USD" }, supported_parameters: { max_output_images: 4 } },
    { id: "blackforestlabs/flux-3/klein/edit-image", pricing: { per_image: { "768x768": 0.008, "1024x1024": 0.009, "1536x1536": 0.011, "2048x2048": 0.014, "4096x4096": 0.036 }, currency: "USD" }, supported_parameters: { max_output_images: 4 } },
  ],
  video: [
    { id: "bytedance/seedance-2.5-spicy", pricing: { currency: "USD", variant: "spicy", per_second_by_resolution: { "480p": 0.18, "720p": 0.36, "1080p": 0.9, "4k": 1.8 }, default_duration: 5, min_duration: 4, max_duration: 15, default_resolution: "720p" } },
    { id: "kling-v26-pro", pricing: { currency: "USD", per_duration: { 5: 0.35, 10: 0.7 }, unit: "per_video", audio_multiplier: 2 } },
  ],
  audio: [
    { id: "elevenlabs/eleven-v4", pricing: { per_thousand_chars: 0.136, currency: "USD" } },
    { id: "elevenlabs/music", pricing: { per_second: 0.01, minimum: 0, currency: "USD" }, supported_parameters: { min_duration: 5, max_duration: 300 } },
    { id: "Whisper-Large-V3", pricing: { per_minute: 0.000495, currency: "USD" } },
    { id: "elevenlabs/audio-isolation", pricing: { per_second: 0.002016666666666667, minimum: 0.00121, currency: "USD" } },
  ],
  model3d: [
    { id: "tripo3d/v2.5", pricing: { per_run: 0.36, per_run_by_variant: { default: 0.36 }, default_variant: "default", currency: "USD" } },
    { id: "meshy/t2", pricing: { per_run: 0.6, per_run_by_variant: { "textured:static": 0.6, "geometry:static": 0.2 }, currency: "USD" } },
  ],
};

/**
 * The pricing copy as docs/near-payments.md describes it, rebuilt independently
 * here (small graphs only: bounds become real strings): inputs applied, an llm
 * without maxTokens gets DEFAULT_CHAT_OUTPUT_TOKENS, and every wired text field
 * holds its longest possible value (text value; join = a + b + sep; llm output
 * = maxTokens x 4 chars; decide output = 256 chars). decide adds its wired text
 * to the question; tts/music prompts are capped at the model's max_chars.
 */
function documentedCopy(wf, inputs, catalogs) {
  const g = applyInputs(wf, inputs);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const n of g.nodes) if (n.type === "llm" && !(Number(n.fields.maxTokens) > 0)) n.fields.maxTokens = DEFAULT_CHAT_OUTPUT_TOKENS;
  const into = (id, port) => g.links.filter((l) => l.to.node === id && l.to.port === port);
  const out = (id) => {
    const n = byId.get(id), f = n.fields || {};
    if (n.type === "text") return String(f.text ?? "").length;
    if (n.type === "join") return wired(id, "a") + wired(id, "b") + String(f.sep ?? " ").length;
    if (n.type === "llm") return Number(f.maxTokens) * 4;
    if (n.type === "decide") return 256;
    return 0;
  };
  const wired = (id, port) => Math.max(0, ...into(id, port).map((l) => out(l.from.node)));
  const copy = structuredClone(g);
  for (const n of copy.nodes) {
    const f = n.fields;
    const has = (port) => into(n.id, port).length > 0;
    const entry = (catalogs.audio || []).find((m) => m.id === f.model);
    if (n.type === "llm") {
      if (has("prompt")) f.prompt = "x".repeat(wired(n.id, "prompt"));
      if (has("system")) f.system = "x".repeat(wired(n.id, "system"));
    } else if (n.type === "decide") {
      f.question = String(f.question || "") + "x".repeat(wired(n.id, "text"));
    } else if (n.type === "tts" || n.type === "music") {
      let c = has("prompt") ? wired(n.id, "prompt") : String(f.prompt || "").length;
      const mc = entry && entry.supported_parameters && entry.supported_parameters.max_chars;
      if (mc) c = Math.min(c, mc);
      f.prompt = "x".repeat(c);
    }
  }
  return copy;
}

function assertReconciles(graph, catalogs, inputs = {}) {
  const wf = assertGraphSafe(graph, { inputs });
  const p = priceGraph(wf, catalogs, { inputs });
  const full = estimateGraphCost(documentedCopy(wf, inputs, catalogs), catalogs);
  const sum = p.items.reduce((s, i) => s + i.usd, 0);
  assert.ok(Math.abs(sum - full.usd) < 1e-12, `items ${sum} vs engine ${full.usd}`);
  assert.ok(Math.abs(p.estimatedCostUsd - full.usd) < 1e-12);
  assert.equal(p.items.length, full.priced);
  assert.equal(p.unpriced.length, full.unpriced);
  assert.equal(p.fixedPrice, p.items.length > 0 && full.exact);
  return p;
}

test("worked example: itemized exactly as the doc shows", () => {
  const inputs = { Idea: "a lighthouse at dawn" };
  const wf = assertGraphSafe(WORKED, { inputs });
  const p = priceGraph(wf, WORKED_CATALOGS, { inputs });
  assert.equal(p.items.length, 2);
  const [llm, img] = p.items;
  assert.equal(llm.nodeId, "n2");
  assert.equal(llm.type, "llm");
  assert.equal(llm.model, "z-ai/glm-5.3-flash");
  assert.ok(Math.abs(llm.usd - 0.0006223) < 1e-12, String(llm.usd));
  assert.equal(llm.basis, "up to 223 input + 2000 output tokens (maxTokens; usually less)");
  assert.equal(llm.fixedPrice, false);
  assert.equal(img.nodeId, "n3");
  assert.equal(img.usd, 0.009);
  assert.equal(img.basis, "1 image at 1024x1024 (fixed price)");
  assert.equal(img.fixedPrice, true);
  assert.ok(Math.abs(p.estimatedCostUsd - 0.0096223) < 1e-12);
  assert.ok(Math.abs(p.likelyChargeUsd - 0.01154676) < 1e-12);
  assert.equal(p.fixedPrice, false);
  assert.equal(p.headroom, 2);
  assert.equal(p.depositUsd, 0.03);
  assert.equal(p.serviceFeeRate, SERVICE_FEE_RATE);
  assert.deepEqual(p.unpriced, []);
});

test("worked example: item sum equals estimateGraphCost on the full pricing copy", () => {
  assertReconciles(WORKED, WORKED_CATALOGS, { Idea: "a lighthouse at dawn" });
});

test("reconciles: chat only, image only, video, audio chain, 3D, decide, and a mixed graph", () => {
  const graphs = {
    chat: { nodes: [
      { id: "a", type: "llm", fields: { model: "z-ai/glm-5.3-uncensored", system: "s".repeat(500), prompt: "hello", maxTokens: 300 } },
      { id: "b", type: "llm", fields: { model: "z-ai/glm-5.3-flash" } },
    ], links: [link("1", "a", "text", "b", "prompt")] },
    image: { nodes: [
      { id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "2048x2048", variations: "3", prompt: "p" } },
      { id: "e", type: "edit", fields: { model: "blackforestlabs/flux-3/klein/edit-image", size: "768x768", prompt: "q" } },
    ], links: [link("1", "i", "image", "e", "image")] },
    video: { nodes: [
      { id: "v", type: "tvideo", fields: { model: "bytedance/seedance-2.5-spicy", duration: "8", resolution: "1080p", prompt: "p" } },
      { id: "k", type: "tvideo", fields: { model: "kling-v26-pro", prompt: "p" } },
    ], links: [] },
    audio: { nodes: [
      { id: "s", type: "tts", fields: { model: "elevenlabs/eleven-v4", prompt: "Hello there, ".repeat(20) } },
      { id: "m", type: "music", fields: { model: "elevenlabs/music", prompt: "lofi", duration: "45" } },
    ], links: [] },
    model3d: { nodes: [
      { id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024", prompt: "a chair" } },
      { id: "m", type: "model3d", fields: {} },
      { id: "m2", type: "model3d", fields: { model: "meshy/t2", prompt: "a table" } },
    ], links: [link("1", "i", "image", "m", "image")] },
    decide: { nodes: [
      { id: "i1", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024", prompt: "a" } },
      { id: "i2", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024", prompt: "b" } },
      { id: "d", type: "decide", fields: { model: "z-ai/glm-5.3-flash", question: "Which is better?" } },
    ], links: [link("1", "i1", "image", "d", "img1"), link("2", "i2", "image", "d", "img2")] },
    mixed: { nodes: [
      { id: "t", type: "text", name: "Topic", fields: { text: "" } },
      { id: "w", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write a short script." } },
      { id: "s", type: "tts", fields: { model: "elevenlabs/eleven-v4" } },
      { id: "p", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1536x1536" } },
      { id: "v", type: "ivideo", fields: { model: "bytedance/seedance-2.5-spicy", prompt: "slow zoom" } },
      { id: "c", type: "comment", fields: { text: "a note" } },
    ], links: [link("1", "t", "text", "w", "prompt"), link("2", "w", "text", "s", "prompt"), link("3", "t", "text", "p", "prompt"),
      link("4", "p", "image", "v", "image")] },
  };
  for (const [name, g] of Object.entries(graphs)) {
    const p = assertReconciles(g, CATALOGS, name === "mixed" ? { Topic: "tides" } : {});
    assert.ok(p.items.length > 0, name);
    for (const i of p.items) {
      assert.ok(i.usd > 0 && Number.isFinite(i.usd), `${name}/${i.nodeId}`);
      assert.ok(i.basis.length > 5);
    }
  }
});

test("item bases describe the estimator's quantities", () => {
  const g = { nodes: [
    { id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "2048x2048", variations: "3", prompt: "p" } },
    { id: "v", type: "tvideo", fields: { model: "bytedance/seedance-2.5-spicy", duration: "8", resolution: "1080p", prompt: "p" } },
    { id: "s", type: "tts", fields: { model: "elevenlabs/eleven-v4", prompt: "x".repeat(250) } },
    { id: "m", type: "music", fields: { model: "elevenlabs/music", prompt: "lofi", duration: "45" } },
    { id: "t", type: "model3d", fields: { prompt: "a cup" } },
  ], links: [] };
  const p = priceGraph(assertGraphSafe(g), CATALOGS);
  const by = Object.fromEntries(p.items.map((i) => [i.nodeId, i]));
  assert.equal(by.i.basis, "3 images at 2048x2048 (fixed price)");
  assert.ok(Math.abs(by.i.usd - 0.042) < 1e-12);
  assert.equal(by.v.basis, "8s video at catalog price (varies)");
  assert.ok(Math.abs(by.v.usd - 7.2) < 1e-9);
  assert.equal(by.s.basis, "up to 250 characters at catalog price");
  assert.equal(by.m.basis, "about 45s of audio at catalog price (varies)");
  assert.equal(by.t.basis, "one 3D model at catalog price");
  assert.equal(by.t.model, "(default)");
  assert.equal(by.t.usd, 0.36);
});

test("inputs increase the chat node's input tokens", () => {
  const wf = assertGraphSafe(WORKED);
  const short = priceGraph(wf, WORKED_CATALOGS, { inputs: { Idea: "x" } }).items[0];
  const long = priceGraph(wf, WORKED_CATALOGS, { inputs: { Idea: "x".repeat(4000) } }).items[0];
  assert.ok(long.usd > short.usd);
  const tok = (b) => Number(/up to (\d+) input/.exec(b)[1]);
  assert.ok(tok(long.basis) - tok(short.basis) >= 999, `${short.basis} -> ${long.basis}`);
  // the schema-safe / lower-case key form works too
  const lower = priceGraph(wf, WORKED_CATALOGS, { inputs: { idea: "x".repeat(4000) } }).items[0];
  assert.equal(lower.usd, long.usd);
});

test("maxTokens is respected when set; when absent the default is priced AND written into the graph that runs", () => {
  const mk = (maxTokens) => {
    const fields = { model: "z-ai/glm-5.3-flash", prompt: "hi" };
    if (maxTokens !== undefined) fields.maxTokens = maxTokens;
    return assertGraphSafe({ nodes: [{ id: "l", type: "llm", fields }], links: [] });
  };
  const set = priceGraph(mk(100), WORKED_CATALOGS).items[0];
  assert.match(set.basis, /\+ 100 output tokens/);
  assert.match(set.basis, /^up to 201 input/); // round(2 / 4) + 200
  assert.ok(Math.abs(set.usd - (0.1 * 201 + 0.3 * 100) / 1e6) < 1e-15);
  for (const absent of [undefined, ""]) {
    const p = priceGraph(mk(absent), WORKED_CATALOGS);
    assert.match(p.items[0].basis, /\+ 2000 output tokens/, String(absent));
    assert.equal(p.boundGraph.nodes[0].fields.maxTokens, 2000);
  }
  // the default never exceeds the model's own max output
  const small = { chat: [{ id: "z-ai/glm-5.3-flash", max_output_tokens: 512, pricing: { prompt: 0.1, completion: 0.3 } }] };
  assert.equal(priceGraph(mk(undefined), small).boundGraph.nodes[0].fields.maxTokens, 512);
});

/* ---------------- the run is bound to what was priced ---------------- */

const GPT5PRO = { chat: [{ id: "openai/gpt-5-pro", context_length: 400000, max_output_tokens: 128000, pricing: { prompt: 15, completion: 120 } }] };

/** Run a graph with the real engine against a stub provider; returns every request body. */
async function bodiesOf(graph, catalogs, inputs) {
  const bodies = [];
  const fetch = async (url, init) => {
    if (init && init.body) bodies.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("stop", { status: 500 });
  };
  const wf = new Workflow(graph, { apiKey: "k", quiet: true, catalog: catalogs, fetch });
  try { await wf.run(inputs); } catch { /* the stub refuses; only the request matters */ }
  return bodies;
}

test("an llm with no maxTokens runs with max_tokens = what was priced (operator cost is bounded)", async () => {
  const g = assertGraphSafe({ nodes: [{ id: "n1", type: "llm", name: "Essay", fields: { model: "openai/gpt-5-pro", prompt: "" } }], links: [] });
  const inputs = { Essay: "Write a 60,000-word novel. Do not stop early." };
  const p = priceGraph(g, GPT5PRO, { inputs });
  const unbound = await bodiesOf(g, GPT5PRO, inputs);
  assert.equal(unbound[0].body.max_tokens, undefined, "the engine alone sends no limit");
  const bound = await bodiesOf(p.boundGraph, GPT5PRO, inputs);
  assert.equal(bound[0].body.max_tokens, 2000);
  assert.match(p.items[0].basis, /\+ 2000 output tokens/);
  // priced at that limit: 2000 * $120/M = $0.24 of output
  assert.ok(p.estimatedCostUsd >= 0.24);
});

test("wired text is priced at its longest: tts fed by a join of two inputs, capped at the model's max_chars", () => {
  const audio = [{ id: "elevenlabs/eleven-v4", pricing: { per_thousand_chars: 0.136 }, supported_parameters: { max_chars: 10000 } }];
  const g = assertGraphSafe({ nodes: [
    { id: "a", type: "text", name: "Part A", fields: { text: "" } },
    { id: "b", type: "text", name: "Part B", fields: { text: "" } },
    { id: "j", type: "join", fields: { sep: " " } },
    { id: "s", type: "tts", fields: { model: "elevenlabs/eleven-v4", voice: "Rachel" } },
  ], links: [link("1", "a", "text", "j", "a"), link("2", "b", "text", "j", "b"), link("3", "j", "text", "s", "prompt")] });
  const small = priceGraph(g, { audio }, { inputs: { "Part A": "x".repeat(100), "Part B": "y".repeat(100) } });
  assert.equal(small.items[0].basis, "up to 201 characters at catalog price");
  const big = priceGraph(g, { audio }, { inputs: { "Part A": "x".repeat(20000), "Part B": "y".repeat(20000) } });
  assert.equal(big.items[0].basis, "up to 10000 characters at catalog price");
  assert.ok(Math.abs(big.estimatedCostUsd - 1.36) < 1e-9, String(big.estimatedCostUsd));
});

test("decide is priced on the text it judges, not only its question", () => {
  const chat = [{ id: "anthropic/claude-opus-4.1", context_length: 200000, pricing: { prompt: 15, completion: 75 } }];
  const g = assertGraphSafe({ nodes: [
    { id: "t", type: "text", name: "Doc", fields: { text: "" } },
    { id: "d", type: "decide", fields: { model: "anthropic/claude-opus-4.1", mode: "yesno", question: "Is it good?" } },
  ], links: [link("l", "t", "text", "d", "text")] });
  const a = priceGraph(g, { chat }, { inputs: { Doc: "x".repeat(10) } });
  const b = priceGraph(g, { chat }, { inputs: { Doc: "x".repeat(20000) } });
  assert.ok(b.estimatedCostUsd - a.estimatedCostUsd >= (4997 * 15) / 1e6 - 1e-9, `${a.estimatedCostUsd} -> ${b.estimatedCostUsd}`);
});

test("LLM output feeding later prompts is priced at the upstream maxTokens; a fan-in is capped at the context length", () => {
  const chat = [
    { id: "openai/gpt-oss-20b", context_length: 131072, pricing: { prompt: 0.04, completion: 0.15 } },
    { id: "anthropic/claude-opus-4.1", context_length: 200000, pricing: { prompt: 15, completion: 75 } },
  ];
  const K = 19, OUT = 16000;
  const nodes = [{ id: "t", type: "text", name: "Topic", fields: { text: "" } },
    { id: "f", type: "llm", fields: { model: "anthropic/claude-opus-4.1", maxTokens: "10", system: "Summarise." } }];
  const links = [];
  for (let i = 0; i < K; i++) {
    nodes.push({ id: "a" + i, type: "llm", fields: { model: "openai/gpt-oss-20b", maxTokens: String(OUT), system: "Write at length." } });
    links.push(link("ta" + i, "t", "text", "a" + i, "prompt"));
  }
  let prev = "a0";
  for (let i = 1; i < K; i++) {
    nodes.push({ id: "j" + i, type: "join", fields: { sep: "\n" } });
    links.push(link("pa" + i, prev, "text", "j" + i, "a"), link("pb" + i, "a" + i, "text", "j" + i, "b"));
    prev = "j" + i;
  }
  links.push(link("jf", prev, "text", "f", "prompt"));
  const p = priceGraph(assertGraphSafe({ nodes, links }), { chat }, { inputs: { Topic: "ships" } });
  const final = p.items.find((i) => i.nodeId === "f");
  // 19 x 16000 tokens > 200k context: capped at the context length
  assert.match(final.basis, /^up to 2002\d\d input \+ 10 output tokens/, final.basis);
  assert.ok(final.usd > 2.9, String(final.usd));
  assert.deepEqual(refusalsForQuote(p).map((r) => r.code), ["DEPOSIT_TOO_HIGH"]);
});

const STORY = {
  id: "longstories/story-fast",
  pricing: { currency: "USD", unit: "per_second", per_second: { "480p": 0.132, "720p": 0.144 } },
  supported_parameters: { parameters: { duration: { type: "select", default: "30", options: [{ value: "30" }, { value: "60" }] }, resolution: { default: "480p" } } },
};

test("video is priced at the duration the run will send (the catalog default), and runs with that duration and the priced model", async () => {
  const g = assertGraphSafe({ nodes: [{ id: "v", type: "tvideo", name: "Clip", fields: { model: "longstories/story-fast" } }], links: [] });
  const p = priceGraph(g, { video: [STORY] }, { inputs: { Clip: "a cat" } });
  assert.equal(p.boundGraph.nodes[0].fields.duration, "30");
  assert.equal(p.items[0].basis, "30s video at catalog price (varies)");
  assert.ok(Math.abs(p.estimatedCostUsd - 3.96) < 1e-9, String(p.estimatedCostUsd));
  const sent = await bodiesOf(p.boundGraph, { video: [STORY] }, { Clip: "a cat" });
  const post = sent.find((b) => /generate-video/.test(b.url));
  assert.equal(post.body.model, "longstories/story-fast");
  assert.equal(String(post.body.duration), "30");
});

test("a model whose catalog price is set by a live quote is refused, naming node and model", () => {
  const live = { ...STORY, pricing: { ...STORY.pricing, note: "List prices. The exact price comes from a live quote before the video starts." } };
  const g = assertGraphSafe({ nodes: [{ id: "v", type: "tvideo", name: "Clip", fields: { model: "longstories/story-fast", duration: "30", prompt: "x" } }], links: [] });
  const r = refusalsForQuote(priceGraph(g, { video: [live] }), { maxDepositUsd: 100 });
  assert.deepEqual(r.map((x) => x.code), ["LIVE_PRICED_MODEL"]);
  assert.match(r[0].message, /node "Clip" \(tvideo\) uses model "longstories\/story-fast", whose exact price is only set by a live provider quote/);
});

test("music without a duration runs with the priced 30 s (clamped to the model's range)", () => {
  const g = assertGraphSafe({ nodes: [{ id: "m", type: "music", fields: { model: "elevenlabs/music", prompt: "lofi" } }], links: [] });
  const p = priceGraph(g, CATALOGS);
  assert.equal(p.boundGraph.nodes[0].fields.duration, 30);
  assert.equal(p.items[0].basis, "about 30s of audio at catalog price (varies)");
});

test("an unpriced 'no model' node gets an actionable refusal", () => {
  const p = priceGraph(assertGraphSafe({ nodes: [{ id: "l", type: "llm", name: "LLM", fields: { prompt: "hi" } }], links: [] }), WORKED_CATALOGS);
  const r = refusalsForQuote(p);
  assert.equal(r[0].code, "UNPRICED_NODE");
  assert.equal(r[0].message, 'node "LLM" (llm) has no model set; set fields.model to a chat model listed by noodle_guide');
});

test("an unpriceable model is listed, refused by refusalsForQuote naming node and model, and still reconciles", () => {
  const g = { nodes: [
    { id: "o", type: "llm", name: "Omni", fields: { model: "qwen/qwen3.5-omni-flash", prompt: "hi" } },
    { id: "g", type: "llm", name: "Ghost", fields: { model: "no/such-model", prompt: "hi" } },
    { id: "n", type: "image", name: "Blank", fields: { prompt: "x" } },
    { id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024", prompt: "ok" } },
  ], links: [] };
  const p = assertReconciles(g, CATALOGS);
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.unpriced.map((u) => [u.nodeId, u.model]), [["o", "qwen/qwen3.5-omni-flash"], ["g", "no/such-model"], ["n", "(default)"]]);
  assert.match(p.unpriced[0].reason, /pricing shape the estimator does not recognise/);
  assert.match(p.unpriced[1].reason, /missing from the NanoGPT chat catalog/);
  assert.match(p.unpriced[2].reason, /no model is set/);
  const r = refusalsForQuote(p);
  assert.deepEqual(r.map((x) => x.code), ["UNPRICED_NODE", "UNPRICED_NODE", "UNPRICED_NODE"]);
  assert.match(r[0].message, /node "Omni" \(llm\) uses model "qwen\/qwen3\.5-omni-flash", which this server cannot price/);
  assert.match(r[2].message, /node "Blank" \(image\) has no model set; set fields\.model to a image model/);
  assert.equal(r[1].nodeId, "g");
  assert.equal(r[1].model, "no/such-model");
});

test("a missing catalog is CATALOG_UNAVAILABLE", () => {
  const p = priceGraph(assertGraphSafe(WORKED), { image: WORKED_CATALOGS.image });
  assert.equal(p.unpriced.length, 1);
  const r = refusalsForQuote(p);
  assert.equal(r[0].code, "CATALOG_UNAVAILABLE");
  assert.match(r[0].message, /chat model catalog could not be loaded/);
});

test("image-only graph: fixedPrice true, headroom 1.25", () => {
  const g = { nodes: [{ id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "4096x4096", prompt: "x" } }], links: [] };
  const p = priceGraph(assertGraphSafe(g), CATALOGS);
  assert.equal(p.fixedPrice, true);
  assert.equal(p.headroom, 1.25);
  assert.equal(p.depositUsd, Math.max(0.01, Math.ceil(0.036 * 1.2 * 1.25 * 100) / 100));
  assert.equal(p.depositUsd, 0.06);
});

test("a graph with no paid nodes: zero cost, the $0.01 minimum deposit", () => {
  const p = priceGraph(assertGraphSafe({ nodes: [{ id: "t", type: "text", fields: { text: "hi" } }], links: [] }), CATALOGS);
  assert.equal(p.estimatedCostUsd, 0);
  assert.equal(p.items.length, 0);
  assert.equal(p.fixedPrice, false);
  assert.equal(p.depositUsd, 0.01);
});

test("depositUsdFor matches the Nano gate's expression", () => {
  const gate = (basis, exact) => Math.max(0.01, Math.ceil(basis * 1.2 * (exact ? 1.25 : 2) * 100) / 100);
  for (const v of [0, 0.0001, 0.0041, 0.0096223, 0.01, 0.02, 0.123456, 0.5, 0.8333, 1, 3.14159, 12.5]) {
    for (const exact of [true, false]) assert.equal(depositUsdFor(v, exact), gate(v, exact), `${v} ${exact}`);
  }
});

test("DEPOSIT_TOO_HIGH when the deposit exceeds the server maximum", () => {
  const g = { nodes: [{ id: "v", type: "tvideo", fields: { model: "bytedance/seedance-2.5-spicy", duration: "10", resolution: "4k", prompt: "x" } }], links: [] };
  const p = priceGraph(assertGraphSafe(g), CATALOGS);
  assert.equal(p.depositUsd, 43.2);
  const r = refusalsForQuote(p);
  assert.deepEqual(r.map((x) => x.code), ["DEPOSIT_TOO_HIGH"]);
  assert.equal(r[0].message.split(" — ")[0], "this workflow needs a $43.2 deposit; this server accepts at most $2");
  assert.deepEqual(refusalsForQuote(p, { maxDepositUsd: 50 }), []);
  assert.deepEqual(refusalsForQuote(priceGraph(assertGraphSafe(WORKED), WORKED_CATALOGS)), []);
});

test("priceGraph does not modify the graph it is given", () => {
  const wf = assertGraphSafe(WORKED);
  const before = JSON.stringify(wf);
  priceGraph(wf, WORKED_CATALOGS, { inputs: { Idea: "abc" } });
  assert.equal(JSON.stringify(wf), before);
});
