// Quotes on the job board: the bidder prices a posted workflow and bids its price;
// an awarded bid runs within its own escrow. Against the market and NanoGPT stand-ins.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMarketMock, MOCK_TOKEN } from "./fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { freePort } from "../scripts/near-simulate.mjs";
import { createMarketClient } from "../src/market/client.mjs";
import { openMarketState } from "../src/market/state.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createMarketWorker } from "../src/market/worker.mjs";
import { createBidder, openBidState, bidProposal } from "../src/market/bidder.mjs";
import { readCatalog, recommendPrice, budgetFromPrice, usdMicros } from "../src/market/catalog.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle-mcp.mjs");
const NANO_KEY = "nanogpt-test-key-do-not-log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (req, prose = "Please run my workflow and quote it.") => `${prose}\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;
const WORKED = (idea = "a lighthouse at dawn") => brief({ graph: WORKED_GRAPH, inputs: { Idea: idea } });
const bidTerms = (escrow) => { const m = usdMicros(escrow); return m > 0 ? { priceUsd: m / 1e6, budgetUsd: budgetFromPrice(m / 1e6) } : null; };

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });

async function rig({ maxBidUsd = 5 } = {}) {
  const m = createMarketMock();
  await m.listen();
  const dir = mkdtempSync(join(tmpdir(), "market-bidder-"));
  const logs = [];
  const client = createMarketClient({ baseUrl: m.url, token: MOCK_TOKEN });
  const runner = createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd: 1, baseUrl: nano.url });
  const state = openBidState(join(dir, "bids.json"));
  const bidder = createBidder({ client, runner, state, priceFor: (depositUsd) => recommendPrice({ depositUsd }), budgetFor: budgetFromPrice, maxBidUsd, log: (l) => logs.push(l) });
  const store = openMarketState({ dir });
  const worker = createMarketWorker({ client, store, runner, budgetUsd: 0.95, listingPriceUsd: 1, bidTerms, log: (l) => logs.push(l) });
  const work = async () => { await worker.tick(); await worker.drain(); };
  return { m, dir, logs, bidder, state, work };
}

test("a posted workflow gets one bid: estimated cost + 20%, plus the market's fee, in whole cents", async () => {
  const { m, bidder, state, logs } = await rig();
  const jobId = m.postJob({ title: "Poster from my workflow", description: WORKED(), budgetAmount: "1.00" });
  assert.deepEqual(await bidder.tick(), { placed: 1 });
  const bids = m.board.get(jobId).bids;
  assert.equal(bids.length, 1);
  // The worked graph: estimated cost $0.00962, with 20% $0.02; a price of $0.03 leaves $0.02 after 5%.
  assert.equal(Number(bids[0].amount), 0.03);
  assert.equal(bids[0].slaSeconds, 3600);
  assert.match(bids[0].proposal, /^Quote for the nanoodle workflow in this job: \$0\.03\./);
  assert.match(bids[0].proposal, /Estimated model cost of your workflow \(2 paid steps\): \$0\.0096/);
  assert.match(bids[0].proposal, /Plus 20%, rounded up to the cent: \$0\.02/);
  assert.match(bids[0].proposal, /refunded in full/);
  assert.doesNotMatch(bids[0].proposal, /\bXNO\b|x402|https?:|mcp\.nanoodle|directly|\bin NEAR\b|\bin Nano\b|wallet/i, "a bid never points off the market");
  assert.equal(state.get(jobId).status, "bid");
  assert.equal(state.get(jobId).bidId, bids[0].bidId);
  assert.match(logs.join("\n"), /job \w{8}: bid \$0\.03 on "Poster from my workflow" \(estimated cost \$0\.0096\d+, with 20% \$0\.02\)/);
  // The next pass does not bid again, and neither does a bidder that lost its file (the market refuses a second bid).
  assert.deepEqual(await bidder.tick(), { placed: 0 });
  assert.equal(m.calls("POST", /\/bids$/).length, 1);
  assert.deepEqual(m.violations, []);
  await m.close();
});

test("jobs that are not ours are left alone; a workflow that cannot run here gets no bid", async () => {
  const { m, bidder, state, logs } = await rig({ maxBidUsd: 0.02 });
  const plain = m.postJob({ title: "Research the nanoodle project", description: "Write a report about nanoodle. No code block here." });
  const broken = m.postJob({ title: "Broken", description: "Run this\n\n```nanoodle\n{ not json\n```\n" });
  const verified = m.postJob({ title: "Verified only", description: WORKED(), minBuilderVerification: "verified" });
  const unsafe = m.postJob({ title: "Unsafe", description: brief({ graph: { v: 1, nodes: [{ id: "n1", type: "endpoint", fields: { url: "http://169.254.169.254/" } }], links: [] }, inputs: {} }) });
  const dear = m.postJob({ title: "Over the limit", description: WORKED() }); // needs $0.03; the limit here is $0.02
  assert.deepEqual(await bidder.tick(), { placed: 0 });
  assert.equal(m.calls("POST", /\/bids$/).length, 0);
  assert.equal(state.get(plain), null, "a job without a workflow block is not even recorded");
  assert.match(state.get(broken).reason, /workflow block cannot be read/);
  assert.match(state.get(verified).reason, /asks for a verified builder/);
  assert.match(state.get(unsafe).reason, /cannot run here/);
  assert.match(state.get(dear).reason, /more than the \$0\.02 bid limit/);
  assert.equal(logs.filter((l) => /no bid/.test(l)).length, 4);
  // Decided once: the next pass says nothing more.
  const before = logs.length;
  await bidder.tick();
  assert.equal(logs.length, before);
  await m.close();
});

test("a refused bid is recorded and not sent again; an unanswered one is tried again", async () => {
  const { m, bidder, state, logs } = await rig();
  const jobId = m.postJob({ description: WORKED() });
  m.fault({ method: "POST", path: /\/bids$/, mode: "status", status: 503, times: 1 });
  assert.deepEqual(await bidder.tick(), { placed: 0 });
  assert.equal(state.get(jobId), null);
  assert.match(logs.join("\n"), /bid not placed .*tried again at the next pass/);
  assert.deepEqual(await bidder.tick(), { placed: 1 });
  const usdOnly = m.postJob({ description: WORKED("a red kite") });
  m.fault({ method: "POST", path: /\/bids$/, mode: "status", status: 400, body: { error: "usd_not_accepted", message: "connect a bank account" }, times: 1 });
  assert.deepEqual(await bidder.tick(), { placed: 0 });
  assert.match(state.get(usdOnly).reason, /the market refused the bid \(usd_not_accepted\)/);
  await bidder.tick();
  assert.equal(m.calls("POST", /\/bids$/).length, 3, "the refused bid is not sent again");
  await m.close();
});

test("an awarded bid runs within its own escrow, not the listing's price; the deliverable says what was paid", async () => {
  const { m, bidder, work, logs } = await rig();
  const jobId = m.postJob({ description: WORKED() });
  await bidder.tick();
  const bid = m.board.get(jobId).bids[0];
  const id = m.award(jobId, bid.bidId);
  await work();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "submitted", logs.join("\n"));
  assert.match(logs.join("\n"), /awarded from a bid at \$0\.03; its budget is \$0\.02/);
  assert.match(logs.join("\n"), /accepted — estimated cost \$0\.0096\d+, with 20% \$0\.02, within budget \$0\.02/);
  const md = r.versions[0].markdown;
  assert.match(md, /You paid the price quoted in the bid you awarded \(\$0\.03\) through the marketplace\./);
  assert.match(md, /per-job budget of \$0\.02/);
  assert.deepEqual(m.violations, []);
  await m.close();
});

test("a brief that no longer fits the awarded amount is declined with a full refund, not run", async () => {
  const { m, work, logs } = await rig();
  const runs0 = nano.runs();
  const jobId = m.postJob({ description: WORKED() });
  // Someone bid 2 cents for this agent: after the fee that leaves $0.01, under the $0.02 the workflow needs.
  const b = { bidId: "b0000000-0000-4000-8000-000000000001", jobId, bidderAgentId: m.agentId, amount: "0.02", proposal: "x", slaSeconds: 3600, verifiableOffered: false, status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  m.board.get(jobId).bids.push(b);
  const id = m.award(jobId, b.bidId);
  await work();
  const r = m.rows.get(id);
  assert.equal(r.assignment.status, "cancelled", logs.join("\n"));
  assert.equal(r.assignment.cancelReason, "rejected");
  assert.match(logs.join("\n"), /workflow refused \(OVER_BUDGET\)/);
  assert.equal(nano.runs() - runs0, 0, "nothing ran");
  await m.close();
});

test("the bid text and the catalog keys", () => {
  const text = bidProposal({ priceUsd: 0.07, needUsd: 0.06, pricing: { estimatedCostUsd: 0.0481, items: [{}, {}, {}] } });
  assert.match(text, /this job: \$0\.07\./);
  assert.match(text, /\(3 paid steps\): \$0\.0481/);
  const dir = mkdtempSync(join(tmpdir(), "market-bidder-catalog-"));
  const file = join(dir, "catalog.json");
  const agent = { handle: "wf-any", tokenFile: "/etc/x/token", graph: null, custom: true, priceUsd: 1 };
  writeFileSync(file, JSON.stringify({ agents: [{ ...agent, bids: true, maxBidUsd: 2 }] }));
  assert.deepEqual([readCatalog(file).agents[0].bids, readCatalog(file).agents[0].maxBidUsd], [true, 2]);
  writeFileSync(file, JSON.stringify({ agents: [agent] }));
  assert.deepEqual([readCatalog(file).agents[0].bids, readCatalog(file).agents[0].maxBidUsd], [false, 5]);
  const graph = join(dir, "g.json"); writeFileSync(graph, JSON.stringify({ ...WORKED_GRAPH, name: "Idea to image" }));
  writeFileSync(file, JSON.stringify({ agents: [{ handle: "img-one", tokenFile: "/etc/x/token", graph, custom: false, bids: true }] }));
  assert.throws(() => readCatalog(file), /"bids" needs "custom": true/);
  writeFileSync(file, JSON.stringify({ agents: [{ ...agent, maxBidUsd: 2 }] }));
  assert.throws(() => readCatalog(file), /"maxBidUsd" needs "bids": true/);
  writeFileSync(file, JSON.stringify({ agents: [{ ...agent, bids: true, maxBidUsd: 0 }] }));
  assert.throws(() => readCatalog(file), /"maxBidUsd" must be a number of at least 0\.02/);
});

test("the bids file: kept across restarts, refused when unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "market-bidder-state-"));
  const file = join(dir, "sub", "bids.json");
  const s = openBidState(file);
  s.set("job-1", { status: "bid", amountUsd: 0.03 });
  assert.equal(openBidState(file).get("job-1").amountUsd, 0.03);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs["job-1"].status, "bid");
  writeFileSync(file, "{ not json");
  assert.throws(() => openBidState(file), /cannot be read/);
});

test("inside the server: a posted workflow is quoted, awarded and delivered", { timeout: 90_000 }, async () => {
  const m = createMarketMock({ handle: "wf-any", priceAmount: "1.00" }); await m.listen();
  const dir = mkdtempSync(join(tmpdir(), "market-bidder-server-"));
  const graphs = join(dir, "noodles"); mkdirSync(graphs);
  writeFileSync(join(graphs, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
  writeFileSync(join(dir, "wf-any.token"), MOCK_TOKEN, { mode: 0o600 });
  const catalog = join(dir, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ agents: [{ handle: "wf-any", tokenFile: join(dir, "wf-any.token"), graph: null, custom: true, priceUsd: 1, bids: true }] }));
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "--graphs", graphs, "--out", join(dir, "out"), "--serve", `127.0.0.1:${port}`], {
    env: {
      PATH: process.env.PATH, HOME: dir, NANOGPT_API_KEY: NANO_KEY, MARKET_STATE_DIR: join(dir, "market-state"),
      NANOGPT_BASE_URL: nano.url, MARKET_BASE_URL: m.url, MARKET_AGENTS_FILE: catalog, MARKET_POLL_SECONDS: "1", MARKET_BID_POLL_SECONDS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  const wait = async (cond, what, ms = 30_000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (child.exitCode !== null) throw new Error("server exited:\n" + stderr);
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}:\n${stderr}`);
      await sleep(50);
    }
  };
  try {
    await wait(() => /market worker: bids: wf-any reads the job board every 1 s/.test(stderr), "the bids line");
    const jobId = m.postJob({ title: "Quote my poster workflow", description: WORKED() });
    await wait(() => m.board.get(jobId).bids.length === 1, "a bid");
    const bid = m.board.get(jobId).bids[0];
    assert.equal(Number(bid.amount), 0.03);
    await wait(() => /market worker: \[wf-any\] bids: job \w{8}: bid \$0\.03/.test(stderr), "the bid log line");
    const id = m.award(jobId, bid.bidId);
    await wait(() => m.rows.get(id).assignment.status === "submitted", "the delivery");
    assert.match(m.rows.get(id).versions[0].markdown, /price quoted in the bid you awarded \(\$0\.03\)/);
    assert.match(stderr, /market worker: \[wf-any\] assignment \w+: new hire "Quote my poster workflow" for 0\.03 USDC/);
    assert.equal(m.calls("POST", /\/bids$/).length, 1);
    assert.ok(!stderr.includes(MOCK_TOKEN) && !stderr.includes(NANO_KEY));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, sig: null });
    assert.deepEqual(m.violations, []);
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exited; } await m.close(); }
});
