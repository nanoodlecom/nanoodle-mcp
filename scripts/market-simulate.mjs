#!/usr/bin/env node
/**
 * Offline simulation of the NEAR Agent Market worker.
 *
 *   node scripts/market-simulate.mjs        (npm run simulate:market)
 *
 * Runs the real worker (scripts/market-worker.mjs) as a child process against
 * two local stand-ins: the market (tests/fixtures/market-mock.mjs, whose
 * request and response shapes are copied from https://market.near.ai/openapi.json
 * and which checks every request against them) and NanoGPT (the stand-in the
 * NEAR simulation uses). It plays the buyer: hires the agent with briefs and
 * prints what the buyer sees for a normal job, an unsafe graph, an
 * over-budget graph, a malformed brief, a worker killed mid-run, and a submit
 * whose answer is lost.
 *
 * Needs no network, no keys and no funds. Exits non-zero if any check fails.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMarketMock, MOCK_TOKEN } from "../tests/fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "../tests/fixtures/near-fake-chain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "scripts", "market-worker.mjs");
const BUDGET = "0.50";
const PRICE = "1.00";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0, checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${what}`);
};
const step = (n, title) => console.log(`\n── ${n}. ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
const indent = (s, p = "    │ ") => s.split("\n").map((l) => p + l).join("\n");
const brief = (req, prose) => `${prose}\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;

const market = createMarketMock();
const nano = nanoGptMock();
await market.listen();
await nano.listen();
const stateDir = await mkdtemp(join(tmpdir(), "market-sim-"));
const env = {
  PATH: process.env.PATH,
  MARKET_AGENT_TOKEN: MOCK_TOKEN,
  NANOGPT_API_KEY: "sim-operator-key",
};
const args = ["--base-url", market.url, "--nanogpt-base", nano.url, "--budget-usd", BUDGET, "--listing-price-usd", PRICE, "--state-dir", stateDir, "--poll-seconds", "1"];

/** Start the worker; returns { done, kill, log() }. */
function startWorker(extra = ["--once"]) {
  const child = spawn(process.execPath, [WORKER, ...args, ...extra], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (d) => { log += d; });
  const done = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig })));
  return { child, done, kill: () => child.kill("SIGKILL"), log: () => log };
}
const showLog = (w) => console.log(indent(w.log().trim().split("\n").map((l) => l.replace(/^\S+ market-worker: /, "")).join("\n"), "    worker: "));
const stateOf = async () => { try { return JSON.parse(await readFile(join(stateDir, "market-state.json"), "utf8")).assignments; } catch { return {}; } };

console.log("NEAR Agent Market worker — offline simulation");
console.log(`market stand-in ${market.url} (shapes from market.near.ai/openapi.json), NanoGPT stand-in ${nano.url}`);
console.log(`listing price $${PRICE} per hire; per-job budget $${BUDGET} (the market keeps 5%, so a hire pays the operator $0.95)`);

/* 1 ─────────────────────────────────────────────────────────────── */
step(1, "A buyer hires the agent with a text → llm → image workflow");
const runs0 = nano.runs();
const normal = market.hire({
  title: "Lighthouse picture",
  description: brief({ graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dawn" } }, "Please run this workflow and send me the image."),
});
let w = startWorker();
let ex = await w.done;
showLog(w);
let row = market.rows.get(normal);
check(ex.code === 0, "worker exited cleanly after one pass");
check(row.assignment.status === "submitted", `assignment is ${row.assignment.status} (expected submitted)`);
check(!!row.assignment.startedAt, "start was declared before the run");
check(nano.runs() - runs0 === 1, "the workflow ran exactly once on NanoGPT");
check(row.versions.length === 1 && row.versions[0].files.length === 1, "one version, with the generated image attached");
check(market.calls("PUT", /^\/_storage\//).every((c) => !c.auth), "the presigned upload carried no Authorization header");
check(row.messages.some((m) => /^Started\./.test(m.body)), "the buyer got a 'Started' message on the thread");
const md = row.versions[0]?.markdown || "";
const costPart = md.slice(md.indexOf("## What this job consumed"), md.indexOf("<details>"));
console.log("    The buyer's deliverable (cost section):");
console.log(indent(costPart.trim()));
check(/Total estimated cost: \$0\.00962/.test(md) && /Actual cost: \$0\.00941, as reported by NanoGPT/.test(md), "itemized estimated cost $0.00962 and actual cost $0.00941");

/* 2 ─────────────────────────────────────────────────────────────── */
step(2, "A graph with a node a paid server will not run (endpoint → any URL)");
const unsafe = market.hire({
  title: "Fetch something",
  description: brief({
    graph: {
      v: 1,
      nodes: [
        { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
        { id: "e1", type: "endpoint", name: "Exfil", fields: { url: "http://169.254.169.254/latest/meta-data" } },
      ],
      links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "e1", port: "prompt" } }],
    },
    inputs: { Idea: "hi" },
  }, "Run it."),
});

/* 3 ─────────────────────────────────────────────────────────────── */
const big = structuredClone(WORKED_GRAPH);
big.nodes[1].fields.maxTokens = 1000000;
const over = market.hire({ title: "Long essay", description: brief({ graph: big, inputs: { Idea: "everything" } }, "A long one please.") });

/* 4 ─────────────────────────────────────────────────────────────── */
const malformed = market.hire({ title: "Cat", description: "Make me a nice picture of a cat, thanks!" });

const runsBefore = nano.runs();
w = startWorker();
ex = await w.done;
showLog(w);
for (const [n, id, title, rx] of [
  [2, unsafe, "unsafe graph", /Exfil[\s\S]*endpoint/],
  [3, over, "over-budget graph", /needs a \$0\.75 deposit; this server accepts at most \$0\.5/],
  [4, malformed, "malformed brief", /no workflow request[\s\S]*```nanoodle/],
]) {
  const a = market.rows.get(id).assignment;
  if (n === 3) step(3, "A graph whose deposit ($0.75) is above the per-job budget ($0.50)");
  if (n === 4) step(4, "A brief with no workflow request in it");
  console.log("    What the buyer reads (decline detail):");
  console.log(indent(a.cancelDetail || "(none)"));
  check(a.status === "cancelled" && a.cancelReason === "rejected", `${title}: declined with reason "rejected" (buyer refunded in full)`);
  check(a.startedAt === null, `${title}: declined before start`);
  check(rx.test(a.cancelDetail || ""), `${title}: the detail says why`);
}
check(nano.runs() === runsBefore, "no NanoGPT call for any declined job");

/* 5 ─────────────────────────────────────────────────────────────── */
step(5, "The worker is killed while a workflow is running, then restarted");
const held = market.hire({ title: "Slow one", description: brief({ graph: WORKED_GRAPH, inputs: { Idea: "HOLD — the stand-in never answers this" } }, "Run it.") });
const runsHeld = nano.runs();
w = startWorker([]);
for (let i = 0; i < 300; i++) {
  const s = await stateOf();
  if (s[held] && s[held].phase === "running" && nano.runs() > runsHeld) break;
  await sleep(20);
}
const before = (await stateOf())[held];
console.log(`    on disk before the kill: phase "${before && before.phase}", NanoGPT calls for this job so far: ${nano.runs() - runsHeld}`);
w.kill();
ex = await w.done;
check(ex.sig === "SIGKILL", "worker killed with SIGKILL mid-run");
w = startWorker();
ex = await w.done;
showLog(w);
let a5 = market.rows.get(held).assignment;
console.log("    What the buyer reads:");
console.log(indent(a5.cancelDetail || "(none)"));
check(a5.status === "cancelled" && a5.cancelReason === "failed", "the restarted worker handed the job back (reason failed, full refund)");
check(nano.runs() - runsHeld === 1, "the paid workflow was not run a second time");
check(market.calls("POST", new RegExp(`${held}/submit$`)).length === 0, "nothing was submitted for it");

/* 6 ─────────────────────────────────────────────────────────────── */
step(6, "The submit lands but its answer is lost; the worker restarts");
market.fault({ method: "POST", path: /\/submit$/, mode: "drop" });
const lost = market.hire({ title: "Another lighthouse", description: brief({ graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dusk" } }, "Please run.") });
const runsLost = nano.runs();
w = startWorker();
ex = await w.done;
showLog(w);
let s6 = (await stateOf())[lost];
check(s6 && s6.phase === "submitting" && s6.submitUncertain === true, `after the lost answer the record says "submitting, uncertain" (${s6 && s6.phase})`);
check(market.rows.get(lost).assignment.status === "submitted", "on the market the submit did land");
w = startWorker();
ex = await w.done;
showLog(w);
s6 = (await stateOf())[lost];
check(s6 && s6.phase === "submitted", "the restarted worker read the assignment back and recorded the delivery");
check(market.calls("POST", new RegExp(`${lost}/submit$`)).length === 1, "the deliverable was submitted once");
check(market.rows.get(lost).versions.length === 1, "the buyer sees one version");
check(nano.runs() - runsLost === 1, "the workflow ran once");

/* summary ─────────────────────────────────────────────────────────── */
step(7, "Protocol conformance");
check(market.violations.length === 0, `every request matched the OpenAPI request schemas and every answer the response schemas${market.violations.length ? `: ${market.violations.join(" | ")}` : ""}`);
const allLogs = w.log();
check(!allLogs.includes(MOCK_TOKEN) && !allLogs.includes("sim-operator-key"), "no credential in the worker's log");

await market.close();
await nano.close();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}.`);
process.exit(failures ? 1 : 0);
