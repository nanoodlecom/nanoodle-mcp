import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createRunFunding } from "../src/run-funding.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });
const pair = { usdNano: 500_000_000n, raw: 10n ** 30n };
async function setup(balance = 10n ** 30n) {
  const pool = createRunFunding({ serial: fn => fn(), balance: async () => balance });
  const policies = [];
  const runner = createWorkflowRunner({ payment: async () => assert.fail("fixture must not request real payments"),
    budgetUsd: 1, baseUrl: nano.url, fundingPair: async () => pair,
    fundRun: (terms, execute) => { policies.push(terms); return pool.run(terms, execute); } });
  const priced = await runner.price({ graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } });
  assert.equal(priced.ok, true);
  return { pool, policies, runner, args: { pricing: priced.pricing, inputs: priced.inputs,
    outDir: await mkdtemp(join(tmpdir(), "market-funding-")), fundingId: "market:test-assignment" } };
}

test("Market execution inherits one capped reservation derived from its accepted pricing", async () => {
  const w = await setup();
  const before = nano.runs();
  const result = await w.runner.run(w.args);
  assert.ok(result.outputs.length > 0); assert.ok(nano.runs() > before);
  assert.equal(w.policies[0].id, w.args.fundingId);
  assert.ok(w.policies[0].maxRaw > 0n);
  assert.deepEqual(w.pool.snapshot(), { activeRuns: 0, reservedRaw: "0" });
});

test("Market creator markup is held inside the accepted net budget", async () => {
  const w = await setup();
  await w.runner.run({ ...w.args, creator: true });
  const policy = w.policies[0];
  assert.ok(policy.overheadRaw > 0n);
  assert.ok(Number(policy.maxUsd) < w.args.pricing.depositUsd);
  const capRaw = BigInt(Math.round(w.args.pricing.depositUsd * 1e9)) * pair.raw / pair.usdNano;
  assert.ok(policy.maxRaw + policy.overheadRaw <= capRaw + 1n);
});

test("insufficient pool funds or missing assignment identity never starts Market inference", async () => {
  for (const balance of [0n, 10n ** 30n]) {
    const w = await setup(balance), before = nano.runs();
    await assert.rejects(w.runner.run({ ...w.args, ...(balance ? { fundingId: undefined } : {}) }),
      { code: balance ? "FUNDING_INVALID" : "FUNDING_INSUFFICIENT" });
    assert.equal(nano.runs(), before);
  }
});
