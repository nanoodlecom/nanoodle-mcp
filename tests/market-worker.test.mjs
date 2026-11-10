// The NEAR Agent Market worker (src/market/*) against the market stand-in
// (tests/fixtures/market-mock.mjs, shapes from the market's OpenAPI) and the
// NanoGPT stand-in the NEAR tests use. Covers: a normal job, a declined unsafe
// graph, a declined over-budget graph, malformed briefs, a restart mid-run, a
// lost submit response, an uncertain start, and a change request.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createMarketMock, MOCK_TOKEN } from "./fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { createMarketClient } from "../src/market/client.mjs";
import { openMarketState, STATE_FILE } from "../src/market/state.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createMarketWorker } from "../src/market/worker.mjs";
import { BRIEF_TEMPLATE } from "../src/market/brief.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NANO_KEY = "nanogpt-test-key-do-not-log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (req, prose = "Please run my workflow.") => `${prose}\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;
const WORKED = (idea = "a lighthouse at dawn") => brief({ graph: WORKED_GRAPH, inputs: { Idea: idea } });

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });

/** A market, a state dir and a worker wired together. */
async function rig({ budgetUsd = 0.5, dir = null, market = null, backoffMs = 0, defaultWorkflow = null } = {}) {
  const m = market || createMarketMock();
  if (!market) await m.listen();
  const stateDir = dir || mkdtempSync(join(tmpdir(), "market-worker-"));
  const logs = [];
  const store = openMarketState({ dir: stateDir });
  const client = createMarketClient({ baseUrl: m.url, token: MOCK_TOKEN });
  const runner = createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd, baseUrl: nano.url });
  const worker = createMarketWorker({ client, store, runner, budgetUsd, listingPriceUsd: 1, backoffMs, defaultWorkflow, log: (l) => logs.push(l) });
  const once = async () => { await worker.tick(); await worker.drain(); };
  return { m, store, worker, once, logs, stateDir };
}

const noSecrets = (logs) => {
  const all = logs.join("\n");
  assert.ok(!all.includes(MOCK_TOKEN), "the agent token appears in the log");
  assert.ok(!all.includes(NANO_KEY), "the NanoGPT key appears in the log");
};

test("a normal job: started, run once, outputs uploaded, Markdown with itemized and actual cost submitted", async () => {
  const { m, store, once, logs } = await rig();
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "submitted");
  assert.ok(r.assignment.startedAt, "start was declared");
  assert.equal(nano.runs() - runs0, 1, "the workflow ran exactly once");
  assert.equal(r.versions.length, 1);
  const md = r.versions[0].markdown;
  assert.match(md, /## What this job consumed/);
  assert.match(md, /LLM \(z-ai\/glm-5\.3-flash\): \$0\.000622 — up to 223 input \+ 2000 output tokens/);
  assert.match(md, /Image \(blackforestlabs\/flux-3\/klein\/text-to-image\): \$0\.009 — 1 image at 1024x1024 \(fixed price\)/);
  assert.match(md, /Total estimated cost: \$0\.00962/);
  assert.match(md, /Deposit: \$0\.03, the most this run could cost/);
  assert.match(md, /per-job budget of \$0\.5/);
  assert.match(md, /Actual cost: \$0\.00941, as reported by NanoGPT\./);
  assert.match(md, /"nanoodleMarketReceipt"/);
  // The image went through reserve → PUT → complete and is listed on the version.
  assert.equal(r.versions[0].files.length, 1);
  const f = m.files.get(r.versions[0].files[0]);
  assert.ok(f.completed && f.link && f.bytes.length > 0);
  assert.ok(md.includes(`/files/${f.token}/`), "the Markdown links the file");
  assert.equal(m.calls("PUT", /^\/_storage\//)[0].auth, false, "no Authorization header on the presigned PUT");
  // Thread and progress: one started message, progress at most once per 30 s.
  assert.equal(r.messages.filter((x) => x.senderSide === "worker").length, 1);
  assert.match(r.messages[0].body, /^Started\./);
  assert.equal(m.calls("POST", /\/progress$/).length, 1);
  assert.deepEqual(m.violations, []);
  assert.equal(store.get(id).phase, "submitted");
  noSecrets(logs);
  // Another poll changes nothing.
  await once();
  assert.equal(nano.runs() - runs0, 1);
  assert.equal(m.calls("POST", /\/submit$/).length, 1);
  store.close(); await m.close();
});

test("text outputs go into the Markdown (the published brief template)", async () => {
  const { m, store, once } = await rig();
  const id = m.hire({ description: `Run this please\n\n${BRIEF_TEMPLATE}` });
  await once();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "submitted");
  assert.ok(r.versions[0].markdown.includes(nano.REPLY));
  assert.equal(r.versions[0].files.length, 0);
  assert.deepEqual(m.violations, []);
  store.close(); await m.close();
});

test("an unsafe graph is declined (rejected) before start, naming the node; nothing runs", async () => {
  const { m, store, once } = await rig();
  const runs0 = nano.runs();
  const unsafe = {
    v: 1,
    nodes: [
      { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
      { id: "e1", type: "endpoint", name: "Exfil", fields: { url: "http://169.254.169.254/latest/meta-data" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "e1", port: "prompt" } }],
  };
  const id = m.hire({ description: brief({ graph: unsafe, inputs: { Idea: "hi" } }) });
  await once();
  const a = m.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "rejected");
  assert.equal(a.startedAt, null, "declined before start");
  assert.match(a.cancelDetail, /refunded in full/);
  assert.match(a.cancelDetail, /Exfil/);
  assert.match(a.cancelDetail, /endpoint/);
  assert.ok(a.cancelDetail.length <= 1000);
  assert.equal(nano.runs(), runs0);
  assert.equal(m.calls("POST", /\/start$/).length, 0);
  assert.equal(store.get(id).phase, "declined");
  assert.deepEqual(m.violations, []);
  store.close(); await m.close();
});

test("a graph whose deposit exceeds the per-job budget is declined with the figures; nothing runs", async () => {
  const { m, store, once } = await rig({ budgetUsd: 0.02 });
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  const a = m.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "rejected");
  assert.match(a.cancelDetail, /needs a \$0\.03 deposit; this server accepts at most \$0\.02/);
  assert.equal(a.startedAt, null);
  assert.equal(nano.runs(), runs0);
  assert.match(store.get(id).decline.code, /DEPOSIT_TOO_HIGH/);
  store.close(); await m.close();
});

test("malformed briefs are declined with the format and an example", async () => {
  const { m, store, once } = await rig();
  const plain = m.hire({ description: "Make me a nice picture of a cat, thanks!" });
  const badJson = m.hire({ description: "```nanoodle\n{ graph: oops }\n```" });
  const badInputs = m.hire({ description: brief({ graph: WORKED_GRAPH, inputs: { Nope: "x" } }) });
  const shortLink = m.hire({ description: brief({ url: "https://da.gd/abc" }) });
  await once();
  for (const id of [plain, badJson, badInputs, shortLink]) {
    const a = m.rows.get(id).assignment;
    assert.equal(a.status, "cancelled", id);
    assert.equal(a.cancelReason, "rejected");
    assert.equal(a.startedAt, null);
  }
  assert.match(m.rows.get(plain).assignment.cancelDetail, /no workflow request[\s\S]*```nanoodle/);
  assert.match(m.rows.get(badJson).assignment.cancelDetail, /not valid JSON/);
  assert.match(m.rows.get(badInputs).assignment.cancelDetail, /unknown input "Nope"/);
  assert.match(m.rows.get(shortLink).assignment.cancelDetail, /short links/);
  assert.deepEqual(m.violations, []);
  store.close(); await m.close();
});

test("a restart mid-run never runs the workflow again: the job is handed back (failed) with a full refund", async () => {
  const market = createMarketMock();
  await market.listen();
  const A = await rig({ market });
  const runs0 = nano.runs();
  const id = market.hire({ description: WORKED("HOLD this one") }); // the NanoGPT stand-in never answers "HOLD"
  A.worker.tick();
  for (let i = 0; i < 200 && !(A.store.get(id) && A.store.get(id).phase === "running"); i++) await sleep(10);
  assert.equal(A.store.get(id).phase, "running");
  while (nano.runs() === runs0) await sleep(10);
  // The process dies here: its state can no longer be written.
  A.store.close();
  const onDisk = JSON.parse(readFileSync(join(A.stateDir, STATE_FILE), "utf8"));
  assert.equal(onDisk.assignments[id].phase, "running", "running was on disk before the paid call");

  const B = await rig({ market, dir: A.stateDir });
  await B.once();
  const a = market.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "failed");
  assert.match(a.cancelDetail, /restarted while your workflow was running[\s\S]*never run twice/);
  assert.equal(B.store.get(id).outcome, "interrupted");
  assert.equal(nano.runs() - runs0, 1, "one NanoGPT call in total: the second worker did not run it");
  assert.equal(market.calls("POST", /\/submit$/).length, 0);
  await B.once();
  assert.equal(nano.runs() - runs0, 1);
  B.store.close(); await market.close();
});

test("a lost submit response is resolved by reading the assignment back after a restart; nothing is run or sent twice", async () => {
  const market = createMarketMock();
  await market.listen();
  market.fault({ method: "POST", path: /\/submit$/, mode: "drop" });
  const A = await rig({ market, backoffMs: 3_600_000 });
  const runs0 = nano.runs();
  const id = market.hire({ description: WORKED() });
  await A.once();
  assert.equal(A.store.get(id).phase, "submitting");
  assert.equal(A.store.get(id).submitUncertain, true);
  assert.equal(market.rows.get(id).assignment.status, "submitted", "the dropped submit did land");
  A.store.close();

  const B = await rig({ market, dir: A.stateDir });
  await B.once();
  assert.equal(B.store.get(id).phase, "submitted");
  assert.equal(market.calls("POST", /\/submit$/).length, 1, "not submitted a second time");
  assert.equal(market.rows.get(id).versions.length, 1);
  assert.equal(nano.runs() - runs0, 1);
  assert.ok(B.logs.some((l) => /earlier submit landed/.test(l)));
  assert.deepEqual(market.violations, []);
  B.store.close(); await market.close();
});

test("a submit that failed with a 503 is sent again with the same Markdown and files", async () => {
  const { m, store, once } = await rig();
  m.fault({ method: "POST", path: /\/submit$/, mode: "status", status: 503 });
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  assert.equal(m.rows.get(id).assignment.status, "submitted");
  assert.equal(m.calls("POST", /\/submit$/).length, 2);
  assert.equal(m.rows.get(id).versions.length, 1);
  assert.equal(nano.runs() - runs0, 1);
  store.close(); await m.close();
});

test("an uncertain start is retried (start is idempotent) and the run waits for a 200", async () => {
  const { m, store, once } = await rig();
  m.fault({ method: "POST", path: /\/start$/, mode: "drop" });
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  assert.equal(m.calls("POST", /\/start$/).length, 2);
  assert.equal(m.rows.get(id).assignment.status, "submitted");
  assert.equal(nano.runs() - runs0, 1);
  store.close(); await m.close();
});

test("a run that fails is handed back as failed (full refund) and never retried", async () => {
  const { m, store, once } = await rig();
  const id = m.hire({ description: WORKED("FAIL please") });
  await once();
  const a = m.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "failed");
  assert.match(a.cancelDetail, /run failed/);
  assert.equal(store.get(id).outcome, "run_failed");
  store.close(); await m.close();
});

test("a change request is answered on the thread and the same result resubmitted, without a second run", async () => {
  const { m, store, once } = await rig();
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  m.requestChanges(id, "Can you make it brighter?");
  await once();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "submitted");
  assert.equal(r.versions.length, 2);
  assert.deepEqual(r.versions[1].files, r.versions[0].files, "the new version re-lists the same files");
  assert.match(r.versions[1].markdown, /Submitted again unchanged after a change request/);
  assert.match(r.messages.at(-1).body, /exactly once per hire/);
  assert.equal(nano.runs() - runs0, 1);
  await once();
  assert.equal(r.versions.length, 2, "handled once per change request");
  store.close(); await m.close();
});

test("concurrency is bounded", async () => {
  const market = createMarketMock();
  await market.listen();
  const stateDir = mkdtempSync(join(tmpdir(), "market-worker-"));
  const store = openMarketState({ dir: stateDir });
  let live = 0, peak = 0;
  const runner = {
    price: async () => ({ ok: true, refusals: [], inputs: {}, pricing: { estimatedCostUsd: 0.001, fixedPrice: true, headroom: 1.25, depositUsd: 0.01, items: [], boundGraph: {} } }),
    run: async () => { live++; peak = Math.max(peak, live); await sleep(30); live--; return { costUsd: 0.001, costExact: true, notices: [], outputs: [{ key: "t", kind: "text", text: "ok" }] }; },
  };
  const worker = createMarketWorker({ client: createMarketClient({ baseUrl: market.url, token: MOCK_TOKEN }), store, runner, budgetUsd: 0.5, concurrency: 2 });
  for (let i = 0; i < 5; i++) market.hire({ description: WORKED() });
  await worker.tick(); await worker.drain();
  assert.equal(peak, 2);
  assert.equal([...market.rows.values()].filter((r) => r.assignment.status === "submitted").length, 5);
  store.close(); await market.close();
});

test("state: an unreadable state file stops the worker; a live owner's lock is respected", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-state-"));
  writeFileSync(join(dir, STATE_FILE), "{ not json");
  assert.throws(() => openMarketState({ dir }), /refusing to start empty/);
  const dir2 = mkdtempSync(join(tmpdir(), "market-state-"));
  writeFileSync(join(dir2, "worker.lock"), String(process.ppid));
  assert.throws(() => openMarketState({ dir: dir2 }), /another worker/);
  const dir3 = mkdtempSync(join(tmpdir(), "market-state-"));
  writeFileSync(join(dir3, "worker.lock"), "2147483646"); // no such process: a stale lock is taken over
  const s = openMarketState({ dir: dir3 });
  s.close();
  assert.ok(!existsSync(join(dir3, "worker.lock")));
});

test("CLI: budget above the listing price after the 5% fee is refused; a group-readable token file is refused; secrets never printed", () => {
  const bin = join(ROOT, "scripts", "market-worker.mjs");
  const env = { PATH: process.env.PATH, MARKET_AGENT_TOKEN: MOCK_TOKEN, NANOGPT_API_KEY: NANO_KEY };
  let r = spawnSync(process.execPath, [bin, "--budget-usd", "0.96", "--listing-price-usd", "1", "--once"], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /after the market's 5% fee/);
  assert.ok(!r.stderr.includes(MOCK_TOKEN) && !r.stderr.includes(NANO_KEY));
  const dir = mkdtempSync(join(tmpdir(), "market-cli-"));
  const tf = join(dir, "token");
  writeFileSync(tf, MOCK_TOKEN);
  chmodSync(tf, 0o644);
  r = spawnSync(process.execPath, [bin, "--budget-usd", "0.5", "--token-file", tf, "--once"], { env: { PATH: process.env.PATH, NANOGPT_API_KEY: NANO_KEY }, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /chmod 600/);
  r = spawnSync(process.execPath, [bin, "--once"], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--budget-usd is required/);
});

/* ------------------------- plain-language briefs ------------------------- */

const DEFAULT_WF = { graph: WORKED_GRAPH, inputName: "Idea", label: "Idea to image" };

test("a plain-language brief runs the default workflow with the brief as its input, and says so", async () => {
  const { m, store, once, logs } = await rig({ defaultWorkflow: DEFAULT_WF });
  const runs0 = nano.runs();
  const id = m.hire({ title: "Poster", description: "A poster for a small coffee shop opening on Saturday, warm morning light." });
  await once();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "submitted");
  assert.equal(nano.runs() - runs0, 1, "ran exactly once");
  assert.match(r.messages[0].body, /^Started\. Your brief has no workflow block, so this agent's default workflow \(Idea to image\) runs once now with your brief as its input:/);
  const md = r.versions[0].markdown;
  assert.match(md, /Your brief had no workflow block, so this agent ran its default workflow \(Idea to image\) once/);
  assert.match(md, /generated by AI models/);
  assert.equal(r.versions[0].files.length, 1);
  assert.equal(store.get(id).defaultWorkflow, "Idea to image");
  assert.ok(logs.some((l) => /plain brief \(\d+ characters\) → default workflow "Idea to image"/.test(l)));
  assert.deepEqual(m.violations, []);
  noSecrets(logs);
  store.close(); await m.close();
});

test("with a default workflow: a workflow block still wins, a broken block is still declined, an empty brief is declined", async () => {
  const { m, store, once } = await rig({ defaultWorkflow: DEFAULT_WF });
  const runs0 = nano.runs();
  const own = m.hire({ description: `Run mine\n\n${BRIEF_TEMPLATE}` });
  const broken = m.hire({ description: "Draw a cat\n\n```nanoodle\n{ not json\n```\n" });
  const empty = m.hire({ title: "", description: "   " });
  await once();
  assert.equal(m.rows.get(own).assignment.status, "submitted");
  assert.equal(store.get(own).defaultWorkflow, null);
  assert.equal(m.rows.get(own).versions[0].files.length, 0, "the buyer's own text workflow ran, not the image default");
  assert.equal(m.rows.get(broken).assignment.cancelReason, "rejected");
  assert.match(m.rows.get(broken).assignment.cancelDetail, /not valid JSON/);
  assert.equal(m.rows.get(empty).assignment.cancelReason, "rejected");
  assert.equal(nano.runs() - runs0, 1, "only the buyer's own workflow ran");
  assert.deepEqual(m.violations, []);
  store.close(); await m.close();
});

test("a plain brief that prices over the budget is declined before start with the figure", async () => {
  const { m, store, once } = await rig({ defaultWorkflow: DEFAULT_WF, budgetUsd: 0.01 });
  const runs0 = nano.runs();
  const id = m.hire({ description: "a lighthouse at dawn" });
  await once();
  assert.equal(m.rows.get(id).assignment.cancelReason, "rejected");
  assert.match(m.rows.get(id).assignment.cancelDetail, /refunded in full/);
  assert.equal(m.rows.get(id).assignment.startedAt, null);
  assert.equal(nano.runs(), runs0);
  store.close(); await m.close();
});

test("CLI: --default-graph is read and checked; a bad file or input name is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-default-"));
  const tf = join(dir, "token"); writeFileSync(tf, MOCK_TOKEN, { mode: 0o600 });
  const bin = join(ROOT, "scripts", "market-worker.mjs");
  const env = { PATH: process.env.PATH, HOME: dir, NANOGPT_API_KEY: NANO_KEY, MARKET_AGENT_TOKEN_FILE: tf, MARKET_STATE_DIR: join(dir, "state") };
  const bad = join(dir, "bad.json"); writeFileSync(bad, "{ nope");
  let r = spawnSync(process.execPath, [bin, "--budget-usd", "0.5", "--default-graph", bad, "--once"], { env, encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /cannot read it as JSON/);
  const good = join(ROOT, "scripts", "market-idea-to-image.json");
  r = spawnSync(process.execPath, [bin, "--budget-usd", "0.5", "--default-graph", good, "--default-input", "Nope", "--once"], { env, encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /no text node with that name \(it has: Idea\)/);
  r = spawnSync(process.execPath, [bin, "--budget-usd", "0.5", "--default-input", "Idea", "--once"], { env, encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /--default-input needs --default-graph/);
  assert.ok(!r.stderr.includes(NANO_KEY) && !r.stderr.includes(MOCK_TOKEN));
});
