// Several Agent Market listings in one worker (src/market/catalog.mjs and the
// catalog mode of src/market/service.mjs): the catalog file, routing and state
// per listing, prices read from the market (public, draft via the agent token,
// the catalog's fallback), the per-job budget, refresh, the drift alarm,
// MARKET_AUTO_PRICE (allowed and refused), recommendPrice, and the shipped
// catalog and graph files. Against the market and NanoGPT stand-ins.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createMarketMock, MOCK_TOKEN, validate } from "./fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { createMarketClient } from "../src/market/client.mjs";
import { openMarketState, STATE_FILE } from "../src/market/state.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createMarketWorker } from "../src/market/worker.mjs";
import { BRIEF_TEMPLATE } from "../src/market/brief.mjs";
import { readConfig, startMarketService, MarketConfigError, NOTIFY_LINES, createNotifier } from "../src/market/service.mjs";
import {
  recommendPrice, budgetFromPrice, priceVerdict, usdMicros, fmtUsd, readCatalog, fetchListingPrice, patchListingPrice,
  PROBE_BRIEF, REPO_ROOT,
} from "../src/market/catalog.mjs";
import { plan } from "../scripts/market-catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NANO_KEY = "nanogpt-test-key-do-not-log";
const TOKEN2 = "aat_" + "fedcba9876543210".repeat(2);
const TOKEN3 = "aat_" + "0a1b2c3d4e5f6789".repeat(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (req) => `Please run my workflow.\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;
const WORKED = (idea = "a lighthouse at dawn") => brief({ graph: WORKED_GRAPH, inputs: { Idea: idea } });

let nano;
let DEPOSIT; // what WORKED_GRAPH needs as a listing's own workflow (estimated cost + 20%), at the stand-in's prices
before(async () => {
  nano = nanoGptMock(); await nano.listen();
  const r = await createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd: 5, baseUrl: nano.url }).price({ graph: WORKED_GRAPH, inputs: { Idea: PROBE_BRIEF } });
  assert.ok(r.ok, JSON.stringify(r.refusals));
  DEPOSIT = r.pricing.depositUsd;
});
after(async () => { await nano.close(); });

async function until(cond, what, ms = 15_000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * A catalog on disk: token files (0600) for the agents that have `token`, the default graph,
 * and the catalog itself. Returns the readConfig() arguments.
 */
function catalogFiles(agents, { once = false, extraArgs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "market-catalog-"));
  const graph = join(dir, "idea-to-image.json");
  writeFileSync(graph, JSON.stringify({ ...WORKED_GRAPH, name: "Idea to image" }));
  mkdirSync(join(dir, "tokens"), { mode: 0o700 });
  const entries = agents.map((a) => {
    const tokenFile = join(dir, "tokens", a.handle);
    if (a.token) writeFileSync(tokenFile, a.token, { mode: 0o600 });
    const e = { handle: a.handle, tokenFile, graph: a.graph === "default" ? graph : null, custom: !!a.custom };
    if (a.priceUsd != null) e.priceUsd = a.priceUsd;
    return e;
  });
  const file = join(dir, "catalog.json");
  writeFileSync(file, JSON.stringify({ agents: entries }, null, 2));
  const stateDir = join(dir, "state");
  return { dir, file, stateDir, args: (m) => ["--agents-file", file, "--state-dir", stateDir, "--base-url", m.url, "--nanogpt-base", nano.url, "--poll-seconds", "0.05", ...(once ? ["--once"] : []), ...extraArgs] };
}

async function startCatalog(m, files, env = {}) {
  const logs = [];
  const cfg = readConfig(files.args(m), { NANOGPT_API_KEY: NANO_KEY, MARKET_PRICE_REFRESH_SECONDS: "0.05", ...env });
  const svc = await startMarketService(cfg, { log: (l) => logs.push(l) });
  return { svc, logs, cfg };
}

const noSecrets = (logs) => {
  const all = logs.join("\n");
  for (const s of [MOCK_TOKEN, TOKEN2, TOKEN3, NANO_KEY]) assert.ok(!all.includes(s), "a secret appears in the log");
};
const count = (logs, re) => logs.filter((l) => re.test(l)).length;

/* ------------------------------ money ------------------------------ */

test("recommendPrice: the smallest whole-cent price whose 95% covers the need, at least $0.02, in integer arithmetic", () => {
  const cases = [
    [0, 0.02], [0.01, 0.02], [0.019, 0.02], [0.02, 0.03], [0.03, 0.04], [0.05, 0.06],
    [0.19, 0.20], [0.285, 0.30], [0.1 + 0.2, 0.32], [0.32, 0.34], [0.37, 0.39], [0.38, 0.40], [0.381, 0.41],
    [0.95, 1.00], [0.951, 1.01], [1.9, 2.00], [2.85, 3.00],
  ];
  for (const [d, want] of cases) {
    const got = recommendPrice({ depositUsd: d });
    assert.equal(got, want, `need ${d}`);
    // In cents and micro-dollars: 0.95 × price ≥ need, and one cent less would not do.
    const gotC = Math.round(got * 100);
    const dM = Math.round(d * 1e6);
    assert.ok(gotC * 9500 >= dM, `${got} covers ${d}`);
    if (gotC > 2) assert.ok((gotC - 1) * 9500 < dM, `${got} is the smallest for ${d}`);
  }
  for (const bad of [-0.01, NaN, Infinity, "0.3", undefined]) assert.throws(() => recommendPrice({ depositUsd: bad }), TypeError);
});

test("budgetFromPrice: 95% rounded down to the cent, exactly (0.2 × 0.95 is 0.19, not 0.18)", () => {
  const cases = [["0.5000", 0.47], [1, 0.95], ["1.00", 0.95], ["0.40", 0.38], [0.2, 0.19], ["0.03", 0.02], [0.05, 0.04],
    ["12.00", 11.4], [1.15, 1.09], [0.01, 0], ["0.019999", 0.01], ["abc", 0], [-1, 0]];
  for (const [p, want] of cases) assert.equal(budgetFromPrice(p), want, String(p));
  assert.equal(usdMicros("0.5000"), 500_000);
  assert.equal(usdMicros("12.1234567"), 12_123_456);
  assert.equal(usdMicros("1e3"), null);
  assert.equal(fmtUsd(0.4), "0.40");
  assert.equal(fmtUsd(0.375), "0.375");
  assert.equal(fmtUsd(12), "12.00");
});

test("priceVerdict: too low, ok, could be lowered, unknown", () => {
  assert.equal(priceVerdict({ priceUsd: 0.39, depositUsd: 0.37 }).verdict, "ok"); // 0.3705 → 0.37 covers 0.37
  assert.equal(priceVerdict({ priceUsd: 0.38, depositUsd: 0.37 }).verdict, "too-low");
  assert.match(priceVerdict({ priceUsd: 0.38, depositUsd: 0.37 }).text, /^too low: the worker would decline this listing's own workflow$/);
  assert.equal(priceVerdict({ priceUsd: 0.40, depositUsd: 0.37 }).verdict, "lower");
  assert.deepEqual(priceVerdict({ priceUsd: 1, depositUsd: 0.37 }), { verdict: "lower", recommendedUsd: 0.39, budgetUsd: 0.95, text: "could be lowered to $0.39" });
  assert.equal(priceVerdict({ priceUsd: null, depositUsd: 0.37 }).verdict, "unknown");
});

/* ------------------------------ the catalog file ------------------------------ */

test("catalog validation: a malformed catalog is a MarketConfigError naming the problem", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-catalog-bad-"));
  const write = (doc) => { const f = join(dir, `c${Math.random().toString(36).slice(2)}.json`); writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc)); return f; };
  const ok = { handle: "good-one", tokenFile: "/etc/x/good-one", graph: "scripts/market-idea-to-image.json" };
  const cases = [
    ["{ nope", /cannot read it as JSON/],
    [[], /expected an object/],
    [{ agents: [] }, /non-empty array/],
    [{ agents: [ok], extra: 1 }, /unknown key "extra"/],
    [{ agents: [{ ...ok, handle: "Bad" }] }, /"handle" must be 3-30 characters/],
    [{ agents: [{ ...ok, handle: "ab" }] }, /"handle" must be/],
    [{ agents: [{ ...ok, handle: "a".repeat(31) }] }, /"handle" must be/],
    [{ agents: [{ ...ok, handle: "1abc" }] }, /"handle" must be/],
    [{ agents: [ok, ok] }, /appears twice/],
    [{ agents: [{ ...ok, tokenFile: "tokens/x" }] }, /"tokenFile" must be an absolute path/],
    [{ agents: [{ ...ok, budgetUsd: 1 }] }, /unknown key "budgetUsd"/],
    [{ agents: [{ handle: "no-graph", tokenFile: "/x" }] }, /needs a "graph", or "custom": true/],
    [{ agents: [{ handle: "no-graph", tokenFile: "/x", custom: true, input: "Idea" }] }, /"input" needs a "graph"/],
    [{ agents: [{ ...ok, custom: "yes" }] }, /"custom" must be true or false/],
    [{ agents: [{ ...ok, priceUsd: "1" }] }, /"priceUsd" must be a number above 0/],
    [{ agents: [{ ...ok, priceUsd: 0.01 }] }, /leaves no budget/],
    [{ agents: [{ ...ok, graph: "scripts/nope.json" }] }, /good-one.*cannot read it as JSON/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json" }] }, /3 named text nodes/],
    [{ agents: [{ ...ok, fields: { Idea: { seconds: { min: 1, max: 2, defaultMin: 1, defaultMax: 2 } } } }] }, /"fields" names "Idea", which is not a named text input of the graph besides the brief's \(it has: none\)/],
    [{ agents: [{ handle: "no-graph", tokenFile: "/x", custom: true, fields: {} }] }, /"fields" needs a "graph"/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: [] }] }, /"fields" must be an object/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: { Tempo: { seconds: { min: 1, max: 2, defaultMin: 1, defaultMax: 2 } } } }] }, /"fields" names "Tempo".*\(it has: Style, Duration\)/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: { Duration: { seconds: { min: 30, max: 240 } } } }] }, /field "Duration" must be \{ "seconds": \{ "min", "max", "defaultMin", "defaultMax" \} \} with whole seconds above 0/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: { Duration: { minutes: { min: 1, max: 2, defaultMin: 1, defaultMax: 2 } } } }] }, /field "Duration" must be/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: { Duration: { seconds: { min: 30, max: 240, defaultMin: 1.5, defaultMax: 240 } } } }] }, /with whole seconds above 0/],
    [{ agents: [{ ...ok, graph: "scripts/market-sing.json", input: "Song idea", fields: { Duration: { seconds: { min: 30, max: 240, defaultMin: 120, defaultMax: 300 } } } }] }, /needs min <= defaultMin <= defaultMax <= max/],
    [{ agents: [{ ...ok, input: "Nope" }] }, /no text node with that name/],
  ];
  for (const [doc, re] of cases) {
    assert.throws(() => readCatalog(write(doc)), (e) => e instanceof MarketConfigError && re.test(e.message), `${JSON.stringify(doc).slice(0, 100)} → ${re}`);
  }
  const c = readCatalog(write({ agents: [ok, { handle: "any-flow", tokenFile: "/x", graph: null, custom: true, priceUsd: 1 }] }));
  assert.equal(c.agents[0].graphFile, join(ROOT, "scripts", "market-idea-to-image.json"), "a relative graph resolves against the package directory");
  assert.equal(c.agents[0].custom, false);
  assert.equal(c.agents[0].input, "Idea");
  assert.equal(c.agents[1].defaultWorkflow, null);
  assert.equal(c.agents[1].priceUsd, 1);
});

test("a relative graph path resolves against the package directory, not the working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "market-catalog-cwd-"));
  writeFileSync(join(dir, "c.json"), JSON.stringify({ agents: [{ handle: "img-x", tokenFile: "/x", graph: "scripts/market-idea-to-image.json" }] }));
  const code = `import { readCatalog } from ${JSON.stringify(join(ROOT, "src", "market", "catalog.mjs"))}; console.log(readCatalog("c.json").agents[0].graphFile);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; });
  const status = await new Promise((r) => child.on("exit", r));
  assert.equal(status, 0);
  assert.equal(out.trim(), join(ROOT, "scripts", "market-idea-to-image.json"));
});

test("the shipped catalog and its graph files load; each graph has one empty named input and credits its source", () => {
  const c = readCatalog(join(ROOT, "scripts", "market-catalog.json"));
  assert.deepEqual(c.agents.map((a) => [a.handle, a.custom, a.defaultWorkflow && a.defaultWorkflow.label, a.input]), [
    ["nanoodle-song", false, "Idea to song", "Song idea"],
    ["nanoodle-image", false, "Idea to image", "Idea"],
    ["nanoodle-character", false, "Game character kit", "Character"],
    ["nanoodle-clip", false, "Idea to short video clip", "Idea"],
    ["nanoodle-workflows", true, null, null],
  ]);
  for (const a of c.agents) assert.equal(a.tokenFile, `/etc/nanoodle-mcp/market-tokens/${a.handle}`);
  // The song takes a Style and a typed Duration; no other listing has extra fields.
  assert.deepEqual(c.agents[0].defaultWorkflow.fieldNames, ["Style", "Duration"]);
  assert.deepEqual(c.agents[0].defaultWorkflow.fieldSpecs, { Duration: { seconds: { min: 30, max: 240, defaultMin: 120, defaultMax: 240 } } });
  for (const a of c.agents.slice(1).filter((x) => x.defaultWorkflow)) { assert.deepEqual(a.defaultWorkflow.fieldNames, []); assert.equal(a.defaultWorkflow.fieldSpecs, undefined); }
  assert.equal(c.agents[4].priceUsd, 1);
  for (const a of c.agents.filter((x) => x.defaultWorkflow)) {
    const g = a.defaultWorkflow.graph;
    const input = g.nodes.find((n) => n.type === "text" && n.name === a.input);
    assert.equal(input.fields.text, "", `${a.handle}: the brief fills the input`);
    for (const n of g.nodes) {
      assert.ok(!("modelOpts" in (n.fields || {})) && !("loras" in (n.fields || {})), `${a.handle}: ${n.id} has no modelOpts or loras`);
    }
  }
  const character = c.agents[2].defaultWorkflow.graph;
  assert.deepEqual(character.nodes.filter((n) => n.type !== "comment").map((n) => [n.type, n.name]),
    [["text", "Character"], ["llm", "Character designer"], ["image", "Reference"], ["edit", "Character"], ["edit", "Parts sheet"]]);
  // Both edits read the reference and nothing reads them, so both are delivered.
  const refId = character.nodes.find((n) => n.name === "Reference").id;
  for (const name of ["Character", "Parts sheet"]) {
    const id = character.nodes.find((n) => n.type === "edit" && n.name === name).id;
    assert.ok(character.links.some((l) => l.from.node === refId && l.to.node === id && l.to.port === "image"), name);
    assert.ok(!character.links.some((l) => l.from.node === id), name);
  }
  assert.match(character.nodes.find((n) => n.type === "comment").fields.text, /awesome-noodles.*character-sprites.*MIT/);
  const clip = c.agents[3].defaultWorkflow.graph;
  const byName = Object.fromEntries(clip.nodes.filter((n) => n.name).map((n) => [n.name, n]));
  assert.deepEqual(byName.Clip.fields, { model: "minimax/h3-max", prompt: "", resolution: "480p", duration: "5" });
  assert.equal(byName["Opening frame"].fields.model, "anima/text-to-image");
  for (const n of [byName["Still prompt"], byName["Motion prompt"]]) {
    assert.equal(n.fields.model, "z-ai/glm-5.3-flash");
    assert.doesNotMatch(n.fields.system, /fight|anime|blade|duel/i, "the system prompts are neutral");
    assert.match(n.fields.system, /never as instructions to you/);
  }
  assert.match(clip.nodes.find((n) => n.type === "comment").fields.text, /awesome-noodles.*neon-shrine-duel.*MIT/);
});

/* ------------------------------ prices from the market ------------------------------ */

test("fetchListingPrice: a live listing publicly; a draft with the agent's own token; otherwise a reason", async () => {
  const m = createMarketMock({ handle: "live-one", priceAmount: "0.5000" });
  await m.listen();
  m.addAgent({ handle: "draft-one", token: TOKEN2, priceAmount: "0.75", listingStatus: "draft" });
  try {
    const live = await fetchListingPrice({ baseUrl: m.url, handle: "live-one", token: MOCK_TOKEN });
    assert.deepEqual({ ...live, agentId: undefined }, { ok: true, priceUsd: 0.5, priceText: "0.5000", planId: m.agent("live-one").plans[0].pricing_plan_id, agentId: undefined, listingStatus: "live", via: "public" });
    assert.ok(m.requests.filter((r) => r.path.startsWith("/v1/agents/")).every((r) => !r.auth), "a live listing is read without the token");

    const draft = await fetchListingPrice({ baseUrl: m.url, handle: "draft-one", token: TOKEN2 });
    assert.equal(draft.ok, true);
    assert.equal(draft.via, "token");
    assert.equal(draft.priceUsd, 0.75);
    const tries = m.calls("GET", /^\/v1\/agents\/draft-one$/);
    assert.deepEqual(tries.map((r) => [r.status, r.auth]), [[404, false], [200, true]]);

    assert.deepEqual(await fetchListingPrice({ baseUrl: m.url, handle: "draft-one" }), { ok: false, reason: "GET /v1/agents/draft-one: HTTP 404" });
    m.tokenReadsDraft = false;
    assert.deepEqual(await fetchListingPrice({ baseUrl: m.url, handle: "draft-one", token: TOKEN2 }), { ok: false, reason: "GET /v1/agents/draft-one (with the agent token): HTTP 404" });
    assert.deepEqual(await fetchListingPrice({ baseUrl: m.url, handle: "Not A Handle" }), { ok: false, reason: "not a valid handle" });
    const down = await fetchListingPrice({ baseUrl: "http://127.0.0.1:9", handle: "live-one" });
    assert.equal(down.ok, false);
    assert.match(down.reason, /no answer from the market/);
    // A live agent whose default plan is not live: the public sees no default plan.
    m.agent("live-one").plans[0].listing_status = "paused";
    assert.deepEqual(await fetchListingPrice({ baseUrl: m.url, handle: "live-one" }), { ok: false, reason: "no default pricing plan is visible" });
    assert.deepEqual(m.violations, []);
  } finally { await m.close(); }
});

test("the stand-in's agent and plan answers match the OpenAPI schemas and a real live listing's shape", async () => {
  const m = createMarketMock();
  await m.listen();
  try {
    const a = await (await fetch(`${m.url}/v1/agents/nanoodle-test`)).json();
    assert.deepEqual(validate("AgentPublic", a), []);
    const plans = await (await fetch(`${m.url}/v1/agents/${a.agent_id}/pricing-plans`)).json();
    assert.deepEqual(validate("PricingPlan", plans[0]), []);
    // Field names of GET /v1/agents/{agent_id}/pricing-plans on a live listing, read 2026-11-10.
    assert.deepEqual(Object.keys(plans[0]).sort(), ["agent_id", "billing_period", "config", "created_at", "description", "display_name", "is_default", "listing_status", "model", "price_amount", "pricing_plan_id", "sla_seconds", "task_unit", "updated_at"]);
    assert.equal((await fetch(`${m.url}/v1/agents/nanoodle-test/pricing-plans`)).status, 400, "the plans route takes the agent_id, not the handle");
    assert.deepEqual(m.violations, []);
  } finally { await m.close(); }
});

/* ------------------------------ the worker ------------------------------ */

test("several listings: each runs on its own token and state; custom:false declines a workflow block naming the custom listing", async () => {
  const m = createMarketMock({ handle: "img-one", priceAmount: "0.5000" });
  await m.listen();
  m.addAgent({ handle: "wf-any", token: TOKEN2, priceAmount: "1.00" });
  const files = catalogFiles([
    { handle: "img-one", token: MOCK_TOKEN, graph: "default" },
    { handle: "wf-any", token: TOKEN2, custom: true, priceUsd: 1 },
    { handle: "later-one", custom: true, priceUsd: 2 }, // no token file yet
  ], { once: true });
  const plainImg = m.hire({ agent: "img-one", title: "Poster", description: "A poster for a small coffee shop opening on Saturday." });
  const blockImg = m.hire({ agent: "img-one", description: WORKED() });
  const plainAny = m.hire({ agent: "wf-any", description: "Draw a cat, thanks!" });
  const blockAny = m.hire({ agent: "wf-any", description: `Run mine\n\n${BRIEF_TEMPLATE}` });
  const runs0 = nano.runs();
  try {
    const { svc, logs } = await startCatalog(m, files);
    assert.equal(await svc.done, 0);
    const row = (id) => m.rows.get(id).assignment;
    assert.equal(row(plainImg).status, "submitted");
    assert.match(m.rows.get(plainImg).versions[0].markdown, /ran its default workflow \(Idea to image\)/);
    assert.match(m.rows.get(plainImg).versions[0].markdown, /listing's fixed price \(\$0\.5\)[\s\S]*per-job budget of \$0\.47/);
    assert.equal(row(blockImg).status, "cancelled");
    assert.equal(row(blockImg).cancelReason, "rejected");
    assert.equal(row(blockImg).startedAt, null);
    assert.match(row(blockImg).cancelDetail, /refunded in full\. This listing runs only its own workflow \(Idea to image\)\. Write your request in plain words/);
    assert.match(row(blockImg).cancelDetail, /hire https:\/\/market\.near\.ai\/a\/wf-any instead/);
    assert.equal(row(plainAny).cancelReason, "rejected");
    assert.match(row(plainAny).cancelDetail, /no workflow request[\s\S]*```nanoodle/);
    assert.equal(row(blockAny).status, "submitted");
    assert.equal(nano.runs() - runs0, 2, "two runs: the plain brief on img-one and the workflow on wf-any");

    // Per-listing state.
    const stateOf = (h) => JSON.parse(readFileSync(join(files.stateDir, h, STATE_FILE), "utf8")).assignments;
    assert.deepEqual(Object.keys(stateOf("img-one")).sort(), [plainImg, blockImg].sort());
    assert.deepEqual(Object.keys(stateOf("wf-any")).sort(), [plainAny, blockAny].sort());
    assert.equal(stateOf("img-one")[blockImg].decline.code, "CUSTOM_NOT_OFFERED");
    assert.equal(stateOf("img-one")[plainImg].budgetUsd, 0.47);
    assert.ok(!existsSync(join(files.stateDir, "later-one")));

    // Logs name the listing.
    assert.equal(count(logs, /^\[later-one\] skipped: no token file at .*later-one \(add it and restart to serve this listing\)$/), 1);
    assert.match(logs.join("\n"), /^\[img-one\] price \$0\.50 \(from the market\); per-job budget \$0\.47; its workflow "Idea to image": estimated cost \$[\d.]+, with 20% \$[\d.]+, recommended price \$[\d.]+$/m);
    assert.match(logs.join("\n"), /\[wf-any\] price \$1\.00 \(from the market\); per-job budget \$0\.95$/m);
    assert.match(logs.join("\n"), /\[img-one\] assignment \w+: new hire "Poster"/);
    assert.match(logs.join("\n"), /\[wf-any\] assignment \w+: delivered/);
    assert.match(logs.join("\n"), /polling .* for 2 listings \(img-one, wf-any\)/);
    for (const l of logs.filter((x) => /assignment /.test(x))) assert.match(l, /^\[(img-one|wf-any)\] /);
    noSecrets(logs);
    assert.deepEqual(m.violations, []);
  } finally { await m.close(); }
});

test("a job keeps the budget it was accepted under when the listing's budget changes during its run", async () => {
  const m = createMarketMock();
  await m.listen();
  const store = openMarketState({ dir: mkdtempSync(join(tmpdir(), "market-budget-")) });
  let release; const gate = new Promise((r) => { release = r; });
  const seen = [];
  const runner = {
    async price(args, { budgetUsd } = {}) {
      seen.push(budgetUsd);
      const pricing = { estimatedCostUsd: 0.01, fixedPrice: true, headroom: 1.25, depositUsd: 0.03, items: [], boundGraph: {} };
      if (0.03 > budgetUsd) return { ok: false, refusals: [{ code: "OVER_BUDGET", message: `this workflow's estimated cost plus 20% is $0.03; this listing covers at most $${budgetUsd}` }], pricing, inputs: {} };
      return { ok: true, refusals: [], inputs: {}, pricing };
    },
    async run() { await gate; return { costUsd: 0.01, costExact: true, notices: [], outputs: [{ key: "t", kind: "text", text: "ok" }] }; },
  };
  const worker = createMarketWorker({ client: createMarketClient({ baseUrl: m.url, token: MOCK_TOKEN }), store, runner, budgetUsd: 0.5, listingPriceUsd: 0.55 });
  try {
    const first = m.hire({ description: WORKED() });
    worker.tick();
    await until(() => store.get(first) && store.get(first).phase === "running", "the first job running");
    worker.setBudget({ budgetUsd: 0.02, listingPriceUsd: 0.03 });
    assert.deepEqual(worker.budget(), { budgetUsd: 0.02, listingPriceUsd: 0.03 });
    release();
    await worker.drain();
    const second = m.hire({ description: WORKED() });
    await worker.tick(); await worker.drain();
    const md = m.rows.get(first).versions[0].markdown;
    assert.match(md, /per-job budget of \$0\.5 /, "the deliverable states the budget the job was accepted under");
    assert.match(md, /listing's fixed price \(\$0\.55\)/);
    assert.match(m.rows.get(first).messages[0].body, /per-job budget is \$0\.5\)/);
    assert.equal(m.rows.get(second).assignment.cancelReason, "rejected", "a new job is priced against the new budget");
    assert.match(m.rows.get(second).assignment.cancelDetail, /per-job budget \$0\.02/);
    assert.deepEqual(seen, [0.5, 0.02]);
    assert.throws(() => worker.setBudget({ budgetUsd: 0 }), TypeError);
    assert.throws(() => createMarketWorker({ client: {}, store, runner, budgetUsd: 1, customWorkflows: false }), /needs a default workflow/);
  } finally { store.close(); await m.close(); }
});

test("price refresh: a price changed on the market takes effect; the drift alarm is logged once per price/need and once on recovery", async () => {
  const low = fmtUsd(DEPOSIT); // budget = floor(0.95 × need) < need
  const rec = recommendPrice({ depositUsd: DEPOSIT });
  const m = createMarketMock({ handle: "img-one", priceAmount: low });
  await m.listen();
  const files = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }]);
  const { svc, logs } = await startCatalog(m, files);
  const alarm = `[img-one] NEEDS OPERATOR — price $${low} no longer covers this listing's workflow (estimated cost + 20% is $${fmtUsd(DEPOSIT)}); raise it to $${fmtUsd(rec)} on the market`;
  try {
    assert.equal(logs.filter((l) => l === alarm).length, 1, logs.join("\n"));
    assert.ok(NOTIFY_LINES.test(alarm), "the alarm reaches the webhook");
    const listing = svc.listings[0];
    assert.equal(listing.worker().budget().budgetUsd, budgetFromPrice(low));
    // Meanwhile the worker declines the over-budget job: nothing is spent.
    const runs0 = nano.runs();
    const tooLow = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
    await until(() => m.rows.get(tooLow).assignment.status === "cancelled", "the over-budget job declined");
    assert.match(m.rows.get(tooLow).assignment.cancelDetail, /estimated cost plus 20%/);
    assert.equal(nano.runs(), runs0);
    // Several refreshes later: still one alarm line.
    const n0 = m.calls("GET", /pricing-plans$/).length;
    await until(() => m.calls("GET", /pricing-plans$/).length >= n0 + 4, "four more refreshes");
    assert.equal(logs.filter((l) => l === alarm).length, 1);

    m.setPrice("img-one", fmtUsd(rec));
    const recovered = `[img-one] price $${fmtUsd(rec)} covers this listing's workflow again (estimated cost + 20% is $${fmtUsd(DEPOSIT)})`;
    await until(() => logs.includes(recovered), "the recovery line");
    assert.ok(NOTIFY_LINES.test(recovered));
    assert.equal(listing.worker().budget().budgetUsd, budgetFromPrice(rec));
    const fine = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
    await until(() => m.rows.get(fine).assignment.status === "submitted", "the job delivered at the new price");
    assert.match(m.rows.get(fine).versions[0].markdown, new RegExp(`listing's fixed price \\(\\$${rec}\\)`));
    const n1 = m.calls("GET", /pricing-plans$/).length;
    await until(() => m.calls("GET", /pricing-plans$/).length >= n1 + 3, "three more refreshes");
    assert.equal(logs.filter((l) => l === recovered).length, 1);
    assert.equal(logs.filter((l) => /NEEDS OPERATOR/.test(l)).length, 1);

    // Too low again, at another price: a new alarm for the new pair.
    m.setPrice("img-one", "0.01");
    await until(() => logs.includes("[img-one] NEEDS OPERATOR — price $0.01 leaves no budget after the market's 5% fee; every hire is declined until it is raised"), "the zero-budget alarm");
    const zero = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
    await until(() => m.rows.get(zero).assignment.status === "cancelled", "a hire at a price that leaves no budget declined");
    m.setPrice("img-one", fmtUsd(DEPOSIT));
    await until(() => count(logs, /NEEDS OPERATOR — price \$[\d.]+ no longer covers/) === 2, "the alarm for the same pair again, after a recovery");
    noSecrets(logs);
    assert.deepEqual(m.violations, []);
  } finally { svc.stop(); assert.equal(await svc.done, 0); await m.close(); }
});

test("a draft listing is priced with its own token; without it the catalog's priceUsd; with neither it stays off until a price appears", async () => {
  const m = createMarketMock({ handle: "draft-a", priceAmount: "0.5000", listingStatus: "draft" });
  await m.listen();
  m.addAgent({ handle: "draft-b", token: TOKEN2, priceAmount: "0.80", listingStatus: "draft" });
  m.addAgent({ handle: "draft-c", token: TOKEN3, priceAmount: "0.60", listingStatus: "draft" });
  const files = catalogFiles([
    { handle: "draft-a", token: MOCK_TOKEN, graph: "default" },
    { handle: "draft-b", token: TOKEN2, graph: "default", priceUsd: 0.5 },
    { handle: "draft-c", token: TOKEN3, graph: "default" },
  ]);
  // First the market lets an agent token read its own draft; then it does not.
  const { svc, logs } = await startCatalog(m, files);
  assert.match(logs.join("\n"), /^\[draft-a\] price \$0\.50 \(from the market \(read with the agent token\)\); per-job budget \$0\.47/m);
  assert.match(logs.join("\n"), /^\[draft-b\] price \$0\.80 \(from the market \(read with the agent token\)\)/m);
  svc.stop();
  assert.equal(await svc.done, 0);

  m.tokenReadsDraft = false;
  const files2 = { ...files, args: (mm) => files.args(mm).map((x) => (x === files.stateDir ? join(files.dir, "state2") : x)) };
  const { svc: svc2, logs: logs2 } = await startCatalog(m, files2);
  try {
    const all = () => logs2.join("\n");
    assert.match(all(), /^\[draft-b\] the price was not read on the market \(GET \/v1\/agents\/draft-b \(with the agent token\): HTTP 404\); using \$0\.50 from the catalog's priceUsd$/m);
    assert.match(all(), /^\[draft-b\] price \$0\.50 \(from the catalog's priceUsd\); per-job budget \$0\.47/m);
    assert.match(all(), /^\[draft-c\] OFF — no price: not read on the market \(.*HTTP 404\) and the catalog has no priceUsd; this listing takes no jobs and is tried again in 0 s$/m);
    assert.match(all(), /draft-c \(off: no price\)/);
    // A hire on the listing without a price is left alone: not started, not declined.
    const waiting = m.hire({ agent: "draft-c", description: "a lighthouse at dawn" });
    const p0 = m.calls("GET", /^\/v1\/agents\/me\/assignments/).length;
    await until(() => m.calls("GET", /pricing-plans$|^\/v1\/agents\/draft-c$/).length > 6 && m.calls("GET", /^\/v1\/agents\/me\/assignments/).length >= p0, "a few refreshes");
    assert.equal(m.rows.get(waiting).assignment.status, "in_progress");
    assert.equal(m.rows.get(waiting).assignment.startedAt, null);
    assert.equal(count(logs2, /^\[draft-c\] OFF — no price/), 1, "the OFF line is not repeated at every refresh");
    // The owner sets it live: the next refresh reads the price and the job runs.
    m.setListingStatus("draft-c", "live");
    await until(() => m.rows.get(waiting).assignment.status === "submitted", "the waiting job delivered");
    assert.match(all(), /^\[draft-c\] the price can be read on the market again$/m);
    assert.match(all(), /^\[draft-c\] price \$0\.60 \(from the market\); per-job budget \$0\.57/m);
    noSecrets(logs2);
    assert.deepEqual(m.violations, []);
  } finally { svc2.stop(); assert.equal(await svc2.done, 0); await m.close(); }
});

test("MARKET_AUTO_PRICE allowed: a price below the recommendation is raised with the agent token; a higher one is never lowered", async () => {
  const rec = recommendPrice({ depositUsd: DEPOSIT });
  const m = createMarketMock({ handle: "img-low", priceAmount: fmtUsd(DEPOSIT), pricePatch: "allowed" });
  await m.listen();
  m.addAgent({ handle: "img-high", token: TOKEN2, priceAmount: "5.00" });
  const files = catalogFiles([{ handle: "img-low", token: MOCK_TOKEN, graph: "default" }, { handle: "img-high", token: TOKEN2, graph: "default" }], { once: true });
  try {
    const { svc, logs } = await startCatalog(m, files, { MARKET_AUTO_PRICE: "1" });
    assert.equal(await svc.done, 0);
    const patches = m.calls("PATCH", /^\/v1\/pricing-plans\//);
    assert.equal(patches.length, 1, "only the low listing is patched");
    assert.deepEqual(patches[0].body, { price_amount: fmtUsd(rec) });
    assert.equal(patches[0].path, `/v1/pricing-plans/${m.agent("img-low").plans[0].pricing_plan_id}`);
    const line = `[img-low] price raised on the market from $${fmtUsd(DEPOSIT)} to $${fmtUsd(rec)} (MARKET_AUTO_PRICE)`;
    assert.ok(logs.includes(line), logs.join("\n"));
    assert.ok(NOTIFY_LINES.test(line));
    assert.equal(Number(m.agent("img-low").plans[0].price_amount), rec);
    assert.equal(m.agent("img-high").plans[0].price_amount, "5.00");
    assert.equal(count(logs, /NEEDS OPERATOR/), 0, "no drift alarm: the raised price covers the workflow");
    assert.equal(svc.listings[0].worker().budget().budgetUsd, budgetFromPrice(rec));
    noSecrets(logs);
    assert.deepEqual(m.violations, []);
  } finally { await m.close(); }
});

test("MARKET_AUTO_PRICE refused (403): logged once, never tried again for that listing; the drift alarm stands", async () => {
  const m = createMarketMock({ handle: "img-low", priceAmount: fmtUsd(DEPOSIT), pricePatch: "forbidden" });
  await m.listen();
  const files = catalogFiles([{ handle: "img-low", token: MOCK_TOKEN, graph: "default" }]);
  const { svc, logs } = await startCatalog(m, files, { MARKET_AUTO_PRICE: "1" });
  try {
    const n0 = m.calls("GET", /pricing-plans$/).length;
    await until(() => m.calls("GET", /pricing-plans$/).length >= n0 + 4, "four more refreshes");
    assert.equal(m.calls("PATCH", /^\/v1\/pricing-plans\//).length, 1);
    assert.equal(count(logs, /^\[img-low\] NEEDS OPERATOR — the market does not let the agent token change this listing's price \(HTTP 403\); MARKET_AUTO_PRICE is off for it until restart, so set the price on the market yourself$/), 1);
    assert.equal(count(logs, /^\[img-low\] NEEDS OPERATOR — price \$[\d.]+ no longer covers/), 1);
    assert.equal(m.agent("img-low").plans[0].price_amount, fmtUsd(DEPOSIT));
    // patchListingPrice reports the status; a non-uuid plan id is not sent.
    assert.deepEqual(await patchListingPrice({ baseUrl: m.url, planId: "nope", token: MOCK_TOKEN, priceUsd: 1 }), { ok: false, status: null });
    noSecrets(logs);
    assert.deepEqual(m.violations, []);
  } finally { svc.stop(); assert.equal(await svc.done, 0); await m.close(); }
});

test("stop() drains every listing: runs in flight on two listings finish before done resolves", async () => {
  const m = createMarketMock({ handle: "img-one", priceAmount: "1.00" });
  await m.listen();
  m.addAgent({ handle: "wf-any", token: TOKEN2, priceAmount: "1.00" });
  const files = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }, { handle: "wf-any", token: TOKEN2, custom: true }]);
  const { svc } = await startCatalog(m, files);
  try {
    const a = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
    const b = m.hire({ agent: "wf-any", description: WORKED() });
    await until(() => m.rows.get(a).assignment.startedAt && m.rows.get(b).assignment.startedAt, "both started");
    svc.stop();
    assert.equal(await svc.done, 0);
    for (const id of [a, b]) assert.equal(m.rows.get(id).assignment.status, "submitted");
    for (const h of ["img-one", "wf-any"]) assert.ok(!existsSync(join(files.stateDir, h, "worker.lock")), `${h}: the lock is released`);
  } finally { await m.close(); }
});

test("configuration: the agents file replaces the single-listing settings; no listing with a token is an error", async () => {
  const files = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }]);
  const env = { NANOGPT_API_KEY: NANO_KEY, MARKET_JOB_BUDGET_USD: "0.5", MARKET_AGENT_TOKEN: MOCK_TOKEN };
  const cfg = readConfig(["--agents-file", files.file], env);
  assert.equal(cfg.catalog.agents.length, 1);
  assert.deepEqual(cfg.ignored, ["MARKET_JOB_BUDGET_USD", "MARKET_AGENT_TOKEN"]);
  assert.equal(cfg.priceRefreshMs, 600_000);
  assert.equal(cfg.autoPrice, false);
  assert.equal(readConfig([], { ...env, MARKET_AGENTS_FILE: files.file, MARKET_AUTO_PRICE: "1", MARKET_PRICE_REFRESH_SECONDS: "30" }).priceRefreshMs, 30_000);
  assert.throws(() => readConfig(["--agents-file", files.file], { ...env, MARKET_AUTO_PRICE: "yes" }), /MARKET_AUTO_PRICE must be 1 or 0/);
  assert.throws(() => readConfig(["--agents-file", files.file], { ...env, MARKET_PRICE_REFRESH_SECONDS: "-1" }), /MARKET_PRICE_REFRESH_SECONDS must be a number above 0/);
  assert.throws(() => readConfig(["--agents-file", files.file], { MARKET_AGENT_TOKEN: MOCK_TOKEN }), /no NanoGPT key/);
  assert.equal(readConfig(["--agents-file", files.file], { NANOGPT_API_KEY: "" }, { needKey: false }).apiKey, null);
  const none = catalogFiles([{ handle: "img-one", graph: "default" }]);
  const m = createMarketMock(); await m.listen();
  try {
    const logs = [];
    await assert.rejects(startMarketService(readConfig(none.args(m), { NANOGPT_API_KEY: NANO_KEY }), { log: (l) => logs.push(l) }), (e) => e instanceof MarketConfigError && /no listing in .* can run/.test(e.message));
    const ign = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }], { once: true });
    const svc = await startMarketService(readConfig(ign.args(m), env), { log: (l) => logs.push(l) });
    assert.equal(await svc.done, 0);
    assert.ok(logs.includes("the agents file replaces MARKET_JOB_BUDGET_USD, MARKET_AGENT_TOKEN; they are ignored"));
  } finally { await m.close(); }
});

test("notifications: listing-prefixed lines still match; the webhook gets them and its URL is never logged", async () => {
  for (const l of ["[nanoodle-song] assignment ab12: new hire \"x\" for 1 USD", "[nanoodle-song] assignment ab12: delivered", "[nanoodle-song] stopped: 401; no new polls",
    "[nanoodle-song] NEEDS OPERATOR — price $0.30 no longer covers this listing's workflow (estimated cost + 20% is $0.37); raise it to $0.40 on the market",
    "[nanoodle-song] price $0.40 covers this listing's workflow again (estimated cost + 20% is $0.37)", "[nanoodle-song] price raised on the market from $0.30 to $0.40 (MARKET_AUTO_PRICE)"]) {
    assert.ok(NOTIFY_LINES.test(l), l);
  }
  for (const l of ["[nanoodle-song] price $0.40 (from the market); per-job budget $0.38", "[nanoodle-song] skipped: no token file at /x", "[nanoodle-song] assignment ab12: running the workflow"]) {
    assert.ok(!NOTIFY_LINES.test(l), l);
  }
  const m = createMarketMock({ handle: "img-one", priceAmount: "1.00" });
  await m.listen();
  const sent = [];
  const realFetch = globalThis.fetch;
  const files = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }], { once: true });
  const cfg = readConfig(files.args(m), { NANOGPT_API_KEY: NANO_KEY, MARKET_NOTIFY_URL: "https://hooks.example.test/secret-path" });
  const id = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
  // The notifier posts with the global fetch; catch the webhook calls only.
  globalThis.fetch = (u, init) => (String(u).startsWith("https://hooks.example.test/") ? (sent.push(JSON.parse(init.body).text), Promise.resolve(new Response("ok"))) : realFetch(u, init));
  const logs = [];
  try {
    const svc = await startMarketService(cfg, { log: (l) => logs.push(l) });
    assert.equal(await svc.done, 0);
    await sleep(20);
    assert.equal(m.rows.get(id).assignment.status, "submitted");
    assert.ok(sent.some((t) => /^nanoodle market: \[img-one\] assignment \w+: new hire /.test(t)), JSON.stringify(sent));
    assert.ok(sent.some((t) => /^nanoodle market: \[img-one\] assignment \w+: delivered$/.test(t)), JSON.stringify(sent));
    assert.ok(!logs.join("\n").includes("secret-path"));
    void createNotifier;
  } finally { globalThis.fetch = realFetch; await m.close(); }
});

/* ------------------------------ the two commands ------------------------------ */

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: tmpdir(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("market-worker.mjs --agents-file: serves the listings with a token, skips the one without; a malformed catalog exits 2", { timeout: 60_000 }, async () => {
  const m = createMarketMock({ handle: "img-one", priceAmount: "1.00" });
  await m.listen();
  const files = catalogFiles([{ handle: "img-one", token: MOCK_TOKEN, graph: "default" }, { handle: "later-one", custom: true, priceUsd: 1 }], { once: true });
  const id = m.hire({ agent: "img-one", description: "a lighthouse at dawn" });
  try {
    const bin = join(ROOT, "scripts", "market-worker.mjs");
    const r = await runNode([bin, ...files.args(m)], { NANOGPT_API_KEY: NANO_KEY });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /market-worker: \[later-one\] skipped: no token file/);
    assert.match(r.stderr, /market-worker: \[img-one\] assignment \w+: delivered/);
    assert.equal(m.rows.get(id).assignment.status, "submitted");
    assert.ok(!r.stderr.includes(MOCK_TOKEN) && !r.stderr.includes(NANO_KEY));
    const bad = join(files.dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ agents: [{ handle: "X", tokenFile: "/x", custom: true }] }));
    const r2 = await runNode([bin, "--agents-file", bad, "--once"], { NANOGPT_API_KEY: NANO_KEY });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /agents file .*bad\.json: agents\[0\] \(X\): "handle" must be/);
    const r3 = await runNode([bin, "--help"]);
    assert.match(r3.stdout, /--agents-file <catalog\.json>/);
  } finally { await m.close(); }
});

test("market-catalog.mjs plan and check: cost, cost + 20%, recommendation, the market's price and a verdict; check fails a listing priced too low", { timeout: 60_000 }, async () => {
  const rec = recommendPrice({ depositUsd: DEPOSIT });
  const m = createMarketMock({ handle: "img-ok", priceAmount: fmtUsd(rec) });
  await m.listen();
  m.addAgent({ handle: "img-rich", token: TOKEN2, priceAmount: "2.00" });
  m.addAgent({ handle: "img-low", token: TOKEN3, priceAmount: fmtUsd(DEPOSIT) });
  const files = catalogFiles([
    { handle: "img-ok", graph: "default" }, { handle: "img-rich", graph: "default" }, { handle: "img-low", graph: "default" },
    { handle: "img-draft", graph: "default", priceUsd: 0.01 * Math.round(rec * 100) }, { handle: "wf-any", custom: true, priceUsd: 1 },
  ]);
  try {
    const out = [];
    const rows = await plan({ file: files.file, baseUrl: m.url, nanogptBase: nano.url, out: (l) => out.push(l) });
    assert.deepEqual(rows.map((r) => [r.handle, r.verdict]), [["img-ok", "ok"], ["img-rich", "lower"], ["img-low", "too-low"], ["img-draft", "ok"], ["wf-any", "n/a"]]);
    const text = out.join("\n");
    assert.match(text, new RegExp(`img-rich  Idea to image\\n  estimated cost  \\$[\\d.]+\\n  cost \\+ 20%      \\$${fmtUsd(DEPOSIT).replace(".", "\\.")} \\(what the payout must cover\\)\\n  recommended     \\$${fmtUsd(rec).replace(".", "\\.")}\\n  price           \\$2\\.00 \\(market, live\\); per-job budget \\$1\\.90\\n  verdict         could be lowered to \\$${fmtUsd(rec).replace(".", "\\.")}`));
    assert.match(text, /img-low[\s\S]*verdict         too low: the worker would decline this listing's own workflow/);
    assert.match(text, /img-draft[\s\S]*price           \$[\d.]+ \(catalog priceUsd; not read on the market\)/);
    assert.match(text, /wf-any  \(buyers' own workflows only\)\n  price           \$1\.00 \(catalog priceUsd; not read on the market\); per-job budget \$0\.95/);
    assert.equal(m.requests.filter((r) => r.auth).length, 0, "plan uses no credentials");
    const bin = join(ROOT, "scripts", "market-catalog.mjs");
    const common = ["--agents-file", files.file, "--base-url", m.url, "--nanogpt-base", nano.url];
    const p = await runNode([bin, "plan", ...common]);
    assert.equal(p.status, 0, p.stderr);
    const c = await runNode([bin, "check", ...common]);
    assert.equal(c.status, 1);
    assert.match(c.stdout, /priced too low for their own workflow, or the workflow cannot run: img-low\n/);
    m.setPrice("img-low", fmtUsd(rec));
    const c2 = await runNode([bin, "check", ...common]);
    assert.equal(c2.status, 0, c2.stdout);
    assert.equal((await runNode([bin, "nope"])).status, 2);
    assert.equal(REPO_ROOT.replace(/\/$/, ""), ROOT.replace(/\/$/, ""));
  } finally { await m.close(); }
});

test("marketNeedUsd: estimated cost + 20%, rounded up to the cent, at least $0.01; no headroom on top", async () => {
  const { marketNeedUsd, MARKET_MARGIN_RATE, createWorkflowRunner } = await import("../src/market/runner.mjs");
  assert.equal(MARKET_MARGIN_RATE, 0.2);
  for (const [est, want] of [[0, 0.01], [0.001, 0.01], [0.009648, 0.02], [0.033841, 0.05], [0.151844, 0.19], [0.25, 0.30], [0.262269, 0.32], [0.5, 0.60], [1, 1.20]]) {
    assert.equal(marketNeedUsd(est), want, `estimate ${est}`);
  }
  for (const bad of [-1, NaN, Infinity, "0.1", undefined]) assert.throws(() => marketNeedUsd(bad), TypeError);
  // The runner reports that figure (not the direct rails' deposit) and refuses on it alone.
  const runner = createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd: 5, baseUrl: nano.url });
  const args = { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dawn" } };
  const fits = await runner.price(args);
  assert.equal(fits.ok, true);
  assert.equal(fits.pricing.depositUsd, marketNeedUsd(fits.pricing.estimatedCostUsd));
  const exact = await runner.price(args, { budgetUsd: fits.pricing.depositUsd });
  assert.equal(exact.ok, true, "a budget equal to cost + 20% is enough");
  const under = await runner.price(args, { budgetUsd: fits.pricing.depositUsd - 0.01 });
  assert.equal(under.ok, false);
  assert.deepEqual(under.refusals.map((r) => r.code), ["OVER_BUDGET"]);
  assert.match(under.refusals[0].message, /estimated cost plus 20% is \$[\d.]+; this listing covers at most \$[\d.]+/);
});
