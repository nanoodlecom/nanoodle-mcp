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
import { createWorkflowRunner, checkNanoGptKey, isOperatorSideFailure } from "../src/market/runner.mjs";
import { createMarketWorker } from "../src/market/worker.mjs";
import { BRIEF_TEMPLATE } from "../src/market/brief.mjs";
import { createMarketCreatorPayments } from "../src/market/creators.mjs";
import { deriveAddress, derivePublicKey, deriveSecretKey } from "nanocurrency";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NANO_KEY = "nanogpt-test-key-do-not-log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (req, prose = "Please run my workflow.") => `${prose}\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;
const WORKED = (idea = "a lighthouse at dawn") => brief({ graph: WORKED_GRAPH, inputs: { Idea: idea } });

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });

/** A market, a state dir and a worker wired together. */
async function rig({ budgetUsd = 0.5, dir = null, market = null, backoffMs = 0, defaultWorkflow = null, creatorPayments = null, customWorkflows = true } = {}) {
  const m = market || createMarketMock();
  if (!market) await m.listen();
  const stateDir = dir || mkdtempSync(join(tmpdir(), "market-worker-"));
  const logs = [];
  const store = openMarketState({ dir: stateDir });
  const client = createMarketClient({ baseUrl: m.url, token: MOCK_TOKEN });
  const runner = createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd, baseUrl: nano.url });
  const worker = createMarketWorker({ client, store, runner, budgetUsd, listingPriceUsd: 1, backoffMs, defaultWorkflow, creatorPayments, customWorkflows, log: (l) => logs.push(l) });
  const once = async () => { await worker.tick(); await worker.drain(); };
  return { m, store, worker, once, logs, stateDir };
}

const noSecrets = (logs) => {
  const all = logs.join("\n");
  assert.ok(!all.includes(MOCK_TOKEN), "the agent token appears in the log");
  assert.ok(!all.includes(NANO_KEY), "the NanoGPT key appears in the log");
};

test("accepted market hires pay the embedded Nano author once, at the locked rate, including after restart", async () => {
  const author = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 1)), { useNanoPrefix: true });
  const owed = new Map(); let xnoUsd = "0.5";
  const creatorPayments = createMarketCreatorPayments({ rates: { currentUsdc: async () => ({ xnoUsd }) },
    payouts: { enqueue: intent => { assert.ok(!owed.has(intent.paymentId), "must not enqueue a settled assignment twice"); owed.set(intent.paymentId, intent); }, tick: async () => {} } });
  const r = await rig({ creatorPayments });
  const id = r.m.hire({ description: brief({ graph: { ...WORKED_GRAPH, x402: { author } }, inputs: { Idea: "a lighthouse" } }) });
  const before = nano.runs(); await r.once();
  assert.equal(r.store.get(id).creator.status, "awaiting_acceptance"); assert.equal(owed.size, 0);
  xnoUsd = "1"; r.m.accept(id); await r.once();
  assert.equal(owed.size, 1); const intent = owed.get(`market_${id}`);
  assert.equal(intent.to, author); assert.equal(BigInt(intent.amountRaw), 3764n * 10n ** 24n);
  assert.equal(r.store.get(id).creator.status, "queued");
  r.store.close();
  const restarted = await rig({ creatorPayments, dir: r.stateDir, market: r.m }); await restarted.once();
  assert.equal(owed.size, 1); assert.equal(nano.runs() - before, 1);
  restarted.store.close(); await r.m.close();
});

test("creator workflows are refused before running when Nano payouts are unavailable", async () => {
  const r = await rig(), before = nano.runs();
  const id = r.m.hire({ description: brief({ graph: { ...WORKED_GRAPH, x402: { author: "nano_missing" } }, inputs: { Idea: "a lighthouse" } }) });
  await r.once(); assert.equal(r.store.get(id).phase, "declined"); assert.equal(nano.runs(), before);
  assert.equal(r.store.get(id).decline.code, "CREATOR_PAYOUT_UNAVAILABLE"); r.store.close(); await r.m.close();
});

test("market creator amounts are capped after model costs and never pay on an unknown cost", () => {
  const payments = createMarketCreatorPayments({});
  assert.equal(payments.amount({ xnoUsd: "0.5" }, { costUsd: 1, proceedsUsd: 1.1 }), String(2n * 10n ** 29n));
  assert.equal(payments.amount({ xnoUsd: "0.5" }, { costUsd: 1, proceedsUsd: 0.9 }), "0");
  assert.equal(payments.amount({ xnoUsd: "0.5" }, { costUsd: null, proceedsUsd: 1 }), "0");
});

test("hosted marketplace briefs cannot replace the workflow or its embedded creator; cancelled hires never owe a payout", async () => {
  const author = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 1)), { useNanoPrefix: true });
  const payouts = [], creatorPayments = createMarketCreatorPayments({ rates: { currentUsdc: async () => ({ xnoUsd: "0.5" }) }, payouts: { enqueue: intent => payouts.push(intent), tick: async () => {} } });
  const r = await rig({ customWorkflows: false, creatorPayments, defaultWorkflow: { graph: { ...WORKED_GRAPH, x402: { author } }, inputName: "Idea", label: "Hosted poster" } });
  try {
    const malicious = r.m.hire({ description: WORKED() }), before = nano.runs(); await r.once();
    assert.equal(r.store.get(malicious).phase, "declined"); assert.equal(nano.runs(), before);
    const id = r.m.hire({ description: "A lighthouse at dawn" }); await r.once(); assert.equal(r.store.get(id).creator.author, author);
    r.m.cancel(id); await r.once(); assert.equal(r.store.get(id).creator.status, "cancelled"); assert.equal(payouts.length, 0);
  } finally { r.store.close(); await r.m.close(); }
});

test("an accepted creator debt survives an outbox failure and restart without repeating model execution", async () => {
  let fail = true; const paid = [], creatorPayments = {
    prepare: async () => ({ author: "test-author", xnoUsd: "0.5", status: "awaiting_acceptance" }), amount: () => "100",
    enqueue: (id, terms) => { if (fail) throw new Error("disk unavailable"); paid.push({ id, ...terms }); },
  };
  const r = await rig({ creatorPayments });
  const id = r.m.hire({ description: brief({ graph: { ...WORKED_GRAPH, x402: { author: "test-author" } }, inputs: { Idea: "a lighthouse" } }) });
  const before = nano.runs(); await r.once(); r.m.accept(id); await r.once(); assert.equal(r.store.get(id).creator.status, "owed"); r.store.close();
  fail = false; const resumed = await rig({ creatorPayments, dir: r.stateDir, market: r.m });
  try { await resumed.once(); await resumed.once(); assert.equal(paid.length, 1); assert.equal(resumed.store.get(id).creator.status, "queued"); assert.equal(nano.runs() - before, 1); }
  finally { resumed.store.close(); await r.m.close(); }
});

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
  assert.match(md, /Estimated cost \+ 20%: \$0\.02 \(rounded up to the cent\), checked against this agent's per-job budget/);
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

test("a graph whose estimated cost plus 20% exceeds the per-job budget is declined with the figures; nothing runs", async () => {
  const { m, store, once } = await rig({ budgetUsd: 0.01 });
  const runs0 = nano.runs();
  const id = m.hire({ description: WORKED() });
  await once();
  const a = m.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "rejected");
  assert.match(a.cancelDetail, /estimated cost plus 20% is \$0\.02; this listing covers at most \$0\.01/);
  assert.equal(a.startedAt, null);
  assert.equal(nano.runs(), runs0);
  assert.match(store.get(id).decline.code, /OVER_BUDGET/);
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

test("operator-side failures are told apart, and a rejected NanoGPT key is caught before any hire", async () => {
  assert.ok(isOperatorSideFailure('run failed at "Writer": API key rejected (HTTP 401) — check your NanoGPT key / NANOGPT_API_KEY'));
  assert.ok(isOperatorSideFailure("Insufficient balance for this request"));
  assert.ok(!isOperatorSideFailure('run failed at "Image": the prompt was blocked by the content filter'));
  const answer = (status) => async () => new Response("{}", { status });
  assert.deepEqual(await checkNanoGptKey({ apiKey: "k", fetch: answer(401) }), { ok: false, status: 401, detail: "NanoGPT rejected the API key" });
  assert.equal((await checkNanoGptKey({ apiKey: "k", fetch: answer(200) })).ok, true);
  assert.equal((await checkNanoGptKey({ apiKey: "k", fetch: answer(404) })).ok, true, "an unknown status does not block start-up");
  assert.equal((await checkNanoGptKey({ apiKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } })).ok, true);
});

test("a run whose every output is empty text is handed back with a refund; one real output is still delivered", async () => {
  const market = createMarketMock();
  await market.listen();
  const store = openMarketState({ dir: mkdtempSync(join(tmpdir(), "market-empty-")) });
  const pricing = { estimatedCostUsd: 0.001, fixedPrice: true, headroom: 1.25, depositUsd: 0.01, items: [], boundGraph: {} };
  let outputs = [{ key: "LLM", kind: "text", text: "" }, { key: "Other", kind: "text", text: "  \n" }];
  const runner = {
    price: async () => ({ ok: true, refusals: [], inputs: {}, pricing }),
    run: async () => ({ costUsd: 0.0001, costExact: true, notices: [], outputs }),
  };
  const logs = [];
  const worker = createMarketWorker({ client: createMarketClient({ baseUrl: market.url, token: MOCK_TOKEN }), store, runner, budgetUsd: 0.5, log: (l) => logs.push(l) });
  const empty = market.hire({ description: WORKED() });
  await worker.tick(); await worker.drain();
  const a = market.rows.get(empty).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "failed");
  assert.match(a.cancelDetail, /every output was empty text.*reasoningEffort.*You are refunded in full/s);
  assert.equal(store.get(empty).decline.code, "EMPTY_RESULT");
  assert.ok(logs.some((l) => /run failed \(every output is empty text\); handing it back/.test(l)));
  // One non-empty output beside an empty one is a result: delivered.
  outputs = [{ key: "LLM", kind: "text", text: "" }, { key: "Haiku", kind: "text", text: "pale light on the rocks" }];
  const partial = market.hire({ description: WORKED() });
  await worker.tick(); await worker.drain();
  assert.equal(market.rows.get(partial).assignment.status, "submitted");
  assert.deepEqual(market.violations, []);
  store.close(); await market.close();
});

test("a plain brief with a \"Style:\" line sets the workflow's Style input; the messages say so; without it the default stays", async () => {
  const market = createMarketMock();
  await market.listen();
  const store = openMarketState({ dir: mkdtempSync(join(tmpdir(), "market-fields-")) });
  const seen = [];
  const pricing = { estimatedCostUsd: 0.001, fixedPrice: true, headroom: 1.25, depositUsd: 0.01, items: [], boundGraph: {} };
  const runner = {
    price: async (args) => { seen.push(args.inputs); return { ok: true, refusals: [], inputs: args.inputs, pricing }; },
    run: async () => ({ costUsd: 0.001, costExact: true, notices: [], outputs: [{ key: "Lyrics", kind: "text", text: "la la" }] }),
  };
  const graph = { v: 1, name: "Idea to song", nodes: [{ id: "n1", type: "text", name: "Song idea", fields: { text: "" } }, { id: "n5", type: "text", name: "Style", fields: { text: "No style given." } }], links: [] };
  const logs = [];
  const worker = createMarketWorker({
    client: createMarketClient({ baseUrl: market.url, token: MOCK_TOKEN }), store, runner, budgetUsd: 0.5, customWorkflows: false,
    defaultWorkflow: { graph, inputName: "Song idea", label: "Idea to song", fieldNames: ["Style"] }, log: (l) => logs.push(l),
  });
  const styled = market.hire({ description: "A wistful song about the singularity.\nStyle: 80s trip-hop bands that have a female singer and an awesome electric style" });
  await worker.tick(); await worker.drain();
  assert.deepEqual(seen.at(-1), { "Song idea": "A wistful song about the singularity.", Style: "80s trip-hop bands that have a female singer and an awesome electric style" });
  const row = market.rows.get(styled);
  assert.equal(row.assignment.status, "submitted");
  assert.match(row.messages.map((m) => m.body).join("\n"), /runs once now with your brief as its input and Style as you set it:/);
  assert.match(row.versions[0].markdown, /with your brief as the input and Style as you set it \(1 output\)/);
  assert.ok(logs.some((l) => /plain brief \(37 characters; also set: Style\) → default workflow "Idea to song"/.test(l)), logs.join("\n"));
  // No Style line: only the main input is sent, so the graph's own default Style text is used.
  const plain = market.hire({ description: "An upbeat birthday song for my mum." });
  await worker.tick(); await worker.drain();
  assert.deepEqual(seen.at(-1), { "Song idea": "An upbeat birthday song for my mum." });
  assert.doesNotMatch(market.rows.get(plain).versions[0].markdown, /as you set/);
  // Only a Style line: the job title is the song idea.
  const onlyStyle = market.hire({ title: "Rainy day song", description: "Style: slow country ballad" });
  await worker.tick(); await worker.drain();
  assert.deepEqual(seen.at(-1), { "Song idea": "Rainy day song", Style: "slow country ballad" });
  assert.deepEqual(market.violations, []);
  store.close(); await market.close();
});

test("a typed Duration field: the buyer's length is used, none given picks one for the job, and the buyer is told either way", async () => {
  const market = createMarketMock();
  await market.listen();
  const store = openMarketState({ dir: mkdtempSync(join(tmpdir(), "market-duration-")) });
  const seen = [];
  const pricing = { estimatedCostUsd: 0.001, fixedPrice: true, headroom: 1.25, depositUsd: 0.01, items: [], boundGraph: {} };
  const runner = {
    price: async (args) => { seen.push(args.inputs); return { ok: true, refusals: [], inputs: args.inputs, pricing }; },
    run: async () => ({ costUsd: 0.001, costExact: true, notices: [], outputs: [{ key: "Lyrics", kind: "text", text: "la la" }] }),
  };
  const graph = { v: 1, name: "Idea to song", nodes: [{ id: "n1", type: "text", name: "Song idea", fields: { text: "" } }, { id: "n5", type: "text", name: "Style", fields: { text: "x" } }, { id: "n6", type: "text", name: "Duration", fields: { text: "180 seconds" } }], links: [] };
  const worker = createMarketWorker({
    client: createMarketClient({ baseUrl: market.url, token: MOCK_TOKEN }), store, runner, budgetUsd: 0.5, customWorkflows: false,
    defaultWorkflow: { graph, inputName: "Song idea", label: "Idea to song", fieldNames: ["Style", "Duration"], fieldSpecs: { Duration: { seconds: { min: 30, max: 240, defaultMin: 120, defaultMax: 240 } } } },
  });
  const short = market.hire({ description: "A jingle for my bakery.\nDuration: 45 seconds\nStyle: cheerful ukulele" });
  await worker.tick(); await worker.drain();
  // Every pricing of this job (there may be more than one) saw the same inputs.
  const mine = seen.filter((i) => i["Song idea"] === "A jingle for my bakery.");
  assert.ok(mine.length >= 1);
  for (const i of mine) assert.deepEqual(i, { "Song idea": "A jingle for my bakery.", Style: "cheerful ukulele", Duration: "45 seconds" });
  const row = market.rows.get(short);
  assert.equal(row.assignment.status, "submitted");
  assert.match(row.messages.map((m) => m.body).join("\n"), /with your brief as its input and Style, Duration as you set them:.*Duration: aiming for about 45 seconds, as you asked\. The result/s);
  assert.match(row.versions[0].markdown, /and Style, Duration as you set them \(1 output\)\. Duration: aiming for about 45 seconds, as you asked\. Files are attached/);
  // None given: one length for the job (the same in both pricings), between 120 and 240, and said to the buyer.
  const plain = market.hire({ description: "An upbeat birthday song for my mum." });
  await worker.tick(); await worker.drain();
  const picks = seen.filter((i) => i["Song idea"] === "An upbeat birthday song for my mum.").map((i) => i.Duration);
  assert.ok(picks.length >= 1 && new Set(picks).size === 1, JSON.stringify(picks));
  const n = parseInt(picks[0], 10);
  assert.ok(n >= 120 && n <= 240 && picks[0] === `${n} seconds`, picks[0]);
  const md = market.rows.get(plain).versions[0].markdown;
  assert.match(md, new RegExp(`with your brief as the input \\(1 output\\)\\. Duration: none given, so it aims for about ${n} seconds \\(picked between 120 and 240\\)\\. Files`));
  assert.deepEqual(market.violations, []);
  store.close(); await market.close();
});
