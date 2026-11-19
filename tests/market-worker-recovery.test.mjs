// Market worker hardening: a job already started elsewhere is never re-run, the
// one-process lock cannot be silently shared, the buyer never sees local error
// text, log lines cannot be forged by a job title, a fatal poll error waits for
// paid runs in flight, and the default state directory does not depend on the
// working directory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, isAbsolute } from "node:path";
import { createMarketMock, MOCK_TOKEN } from "./fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { createMarketClient } from "../src/market/client.mjs";
import { openMarketState } from "../src/market/state.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createMarketWorker, logSafe } from "../src/market/worker.mjs";
import { runLoop, defaultStateDir, readConfig } from "../scripts/market-worker.mjs";

const NANO_KEY = "nanogpt-test-key-do-not-log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (req) => `Please run my workflow.\n\n\`\`\`nanoodle\n${JSON.stringify(req, null, 2)}\n\`\`\`\n`;
const WORKED = (idea = "a lighthouse at dawn") => brief({ graph: WORKED_GRAPH, inputs: { Idea: idea } });

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });

async function rig({ market, dir = null, runner = null, backoffMs = 0 }) {
  const stateDir = dir || mkdtempSync(join(tmpdir(), "market-recovery-"));
  const logs = [];
  const store = openMarketState({ dir: stateDir });
  const client = createMarketClient({ baseUrl: market.url, token: MOCK_TOKEN });
  const r = runner || createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd: 0.5, baseUrl: nano.url });
  const worker = createMarketWorker({ client, store, runner: r, budgetUsd: 0.5, backoffMs, log: (l) => logs.push(l) });
  const once = async () => { await worker.tick(); await worker.drain(); };
  return { store, worker, once, logs, stateDir };
}

test("a job already started by a worker whose state is gone is NOT run again (fresh or different --state-dir)", async () => {
  const market = createMarketMock();
  await market.listen();
  market.fault({ method: "POST", path: /\/submit$/, mode: "status", status: 503 });
  const A = await rig({ market, backoffMs: 3_600_000 });
  const runs0 = nano.runs();
  const id = market.hire({ description: WORKED() });
  await A.once();
  const row = market.rows.get(id).assignment;
  assert.equal(row.status, "in_progress");
  assert.ok(row.startedAt, "worker A started it");
  assert.equal(row.submittedAt, null, "its submit got a 503");
  assert.equal(nano.runs() - runs0, 1);
  A.store.close();

  // Worker B starts on an empty state directory (a crash, then a restart from another cwd).
  const B = await rig({ market });
  const starts = market.calls("POST", /\/start$/).length;
  await B.once();
  await B.once();
  assert.equal(nano.runs() - runs0, 1, "the paid workflow ran once in total");
  assert.equal(market.calls("POST", /\/start$/).length, starts, "B did not start it");
  assert.equal(market.calls("POST", /\/submit$/).length, 1, "B submitted nothing");
  assert.equal(market.calls("POST", /\/decline$/).length, 0, "B did not decline it either");
  assert.equal(B.store.get(id).phase, "stuck");
  assert.ok(B.logs.some((l) => /NEEDS OPERATOR — already started before this worker knew it/.test(l)), B.logs.join("\n"));
  B.store.close();

  // A restarted on its own directory still finishes the delivery without a second run.
  const A2 = await rig({ market, dir: A.stateDir });
  await A2.once();
  assert.equal(market.rows.get(id).assignment.status, "submitted");
  assert.equal(nano.runs() - runs0, 1);
  A2.store.close();
  await market.close();
});

test("a fresh hire (startedAt null, no worker message) on an empty state directory is still run", async () => {
  const market = createMarketMock();
  await market.listen();
  const A = await rig({ market });
  const id = market.hire({ description: WORKED() });
  await A.once();
  assert.equal(market.rows.get(id).assignment.status, "submitted");
  A.store.close();
  await market.close();
});

test("lock: losing a takeover race is detected; a write after the lock moved stops; close() leaves another owner's lock", () => {
  // 1. The interleaving: B judges the lock stale, then (before B removes it) another live
  //    worker takes it over. B must re-read, see the live owner and refuse.
  const dir = mkdtempSync(join(tmpdir(), "market-lock-"));
  const lock = join(dir, "worker.lock");
  writeFileSync(lock, "2147483646"); // a stale lock (no such pid)
  assert.throws(() => openMarketState({
    dir,
    _lockHooks: {
      beforeTakeover() {
        // Another worker (a live pid: our parent) wins the race and writes its own lock.
        writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), boot: null, nonce: "other" }));
      },
    },
  }), /another worker \(pid \d+\) owns/);
  assert.match(readFileSync(lock, "utf8"), /"nonce":"other"/, "the winner's lock is untouched");

  // 2. Two stores in one directory (same pid, so the second takes the first's lock over):
  //    the first one's next write fails instead of silently writing alongside.
  const dir2 = mkdtempSync(join(tmpdir(), "market-lock-"));
  const A = openMarketState({ dir: dir2 });
  A.create("a1", { phase: "new" });
  const B = openMarketState({ dir: dir2 });
  assert.throws(() => A.update("a1", { phase: "starting" }), /no longer this process's lock/);
  A.close();
  assert.ok(existsSync(join(dir2, "worker.lock")), "A.close() did not remove B's lock");
  B.update("a1", { phase: "starting" });
  B.close();
  assert.ok(!existsSync(join(dir2, "worker.lock")), "B removed its own lock");

  // 3. A lock written on another host (two containers on one volume) is never taken over.
  const dir3 = mkdtempSync(join(tmpdir(), "market-lock-"));
  writeFileSync(join(dir3, "worker.lock"), JSON.stringify({ pid: 1, host: "some-other-host", boot: null, nonce: "x" }));
  assert.throws(() => openMarketState({ dir: dir3 }), /some-other-host[\s\S]*remove the lock file by hand/);

  // 4. An older bare-pid lock of a dead process is still taken over.
  const dir4 = mkdtempSync(join(tmpdir(), "market-lock-"));
  writeFileSync(join(dir4, "worker.lock"), "2147483646");
  const s = openMarketState({ dir: dir4 });
  assert.equal(JSON.parse(readFileSync(join(dir4, "worker.lock"), "utf8")).pid, process.pid);
  s.close();
});

test("a local error during the run never reaches the buyer; the provider's own message does", async () => {
  const market = createMarketMock();
  await market.listen();
  const real = createWorkflowRunner({ apiKey: NANO_KEY, budgetUsd: 0.5, baseUrl: nano.url });
  const secretPath = "/home/operator/private/market-state/out/abc";
  const runner = {
    price: real.price,
    run: async () => { throw Object.assign(new Error(`EACCES: permission denied, mkdir '${secretPath}'`), { code: "EACCES" }); },
  };
  const A = await rig({ market, runner });
  const id = market.hire({ description: WORKED() });
  await A.once();
  const a = market.rows.get(id).assignment;
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "failed");
  assert.ok(!a.cancelDetail.includes(secretPath) && !/EACCES/.test(a.cancelDetail), a.cancelDetail);
  assert.match(a.cancelDetail, /^The workflow run failed\. You are refunded in full/);
  assert.ok(A.logs.some((l) => l.includes(secretPath)), "the operator's log keeps the full error");
  A.store.close();

  // A provider failure (the NanoGPT stand-in refuses prompts containing FAIL) is shown to the buyer.
  const B = await rig({ market });
  const id2 = market.hire({ description: WORKED("FAIL please") });
  await B.once();
  assert.match(market.rows.get(id2).assignment.cancelDetail, /The workflow run failed: run failed at .*stub: the model refused this prompt/);
  B.store.close();
  await market.close();
});

test("a job title cannot forge a log line or send terminal escapes", async () => {
  const market = createMarketMock();
  await market.listen();
  const A = await rig({ market });
  market.hire({ title: "x\n2026-01-01T00:00:00.000Z market-worker: assignment 00000000: delivered\u001b[2J\u2028", description: WORKED() });
  await A.once();
  for (const l of A.logs) assert.ok(!/[\x00-\x1f\x7f\u2028]/.test(l), JSON.stringify(l));
  assert.ok(A.logs.some((l) => /new hire "x\\n2026/.test(l)), A.logs.join("\n"));
  assert.equal(logSafe("a\nb\u001bc\u202ed"), "a\\x0ab\\x1bc\\u202ed");
  A.store.close();
  await market.close();
});

test("a fatal poll error stops polling but waits for the paid run in flight before closing the state", async () => {
  const events = [];
  let ticks = 0;
  let inflight = null;
  const worker = {
    async tick() {
      ticks++;
      if (ticks === 1) { inflight = sleep(80).then(() => events.push("run finished")); return; }
      throw new Error("the market rejected the agent token (HTTP 401); check MARKET_AGENT_TOKEN");
    },
    async drain() { if (inflight) await inflight; events.push("drained"); },
  };
  const store = { close: () => events.push("state closed") };
  const logs = [];
  const loop = runLoop(worker, store, { pollMs: 1, log: (l) => logs.push(l) });
  const code = await loop.done;
  assert.equal(code, 1);
  assert.equal(ticks, 2, "no poll after the fatal error");
  assert.deepEqual(events.slice(0, 2), ["run finished", "drained"]);
  assert.equal(events.at(-1), "state closed");
  assert.match(logs.join("\n"), /HTTP 401[\s\S]*waiting for the runs in flight/);
});

test("the default state directory is absolute and per user, not ./market-state", () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/var/lib/someone/state" }), "/var/lib/someone/state/nanoodle-market");
  const d = defaultStateDir({});
  assert.ok(isAbsolute(d) && d.endsWith(join(".local", "state", "nanoodle-market")), d);
  const cfg = readConfig(["--budget-usd", "0.5"], { MARKET_AGENT_TOKEN: MOCK_TOKEN, NANOGPT_API_KEY: NANO_KEY, XDG_STATE_HOME: "/x/state" });
  assert.equal(cfg.stateDir, "/x/state/nanoodle-market");
  const cfg2 = readConfig(["--budget-usd", "0.5", "--state-dir", "/y/s"], { MARKET_AGENT_TOKEN: MOCK_TOKEN, NANOGPT_API_KEY: NANO_KEY });
  assert.equal(cfg2.stateDir, "/y/s");
});
