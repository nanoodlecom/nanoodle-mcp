import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { createRunFunding } from "../src/run-funding.mjs";
import { marketCreatorLiabilities } from "../src/funding-liabilities.mjs";
import { parseUsdNano } from "../src/usd.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";

let nano, previousEnvironmentKey;
before(async () => {
  previousEnvironmentKey = process.env.NANOGPT_API_KEY;
  process.env.NANOGPT_API_KEY = "test-environment-key-must-not-be-used";
  nano = nanoGptMock({ walletPayments: true }); await nano.listen();
});
after(async () => {
  await nano.close();
  if (previousEnvironmentKey === undefined) delete process.env.NANOGPT_API_KEY;
  else process.env.NANOGPT_API_KEY = previousEnvironmentKey;
});
const pair = { usdNano: 500_000_000n, raw: 10n ** 30n };
async function setup(balance = 10n ** 30n, liabilitiesRaw = () => 0n) {
  let funds = balance, tail = Promise.resolve();
  const serial = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
  const pool = createRunFunding({ serial, balance: async () => funds, liabilitiesRaw });
  const policies = [], payments = [];
  const runner = createWorkflowRunner({ payment: invoice => {
      const scope = pool.capture();
      return serial(() => {
        pool.authorize(scope, invoice, funds);
        funds -= BigInt(invoice.amountRaw); payments.push(invoice.paymentId);
        nano.settleWalletInvoice(invoice.paymentId);
      });
    },
    budgetUsd: 1, baseUrl: nano.url, fundingPair: async () => pair,
    fundRun: (terms, execute) => { policies.push(terms); return pool.run(terms, execute); } });
  const priced = await runner.price({ graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } });
  assert.equal(priced.ok, true);
  return { pool, policies, payments, runner, args: { pricing: priced.pricing, inputs: priced.inputs,
    outDir: await mkdtemp(join(tmpdir(), "market-funding-")), fundingId: "market:test-assignment" } };
}

test("Market execution inherits one capped reservation derived from its accepted pricing", async () => {
  const w = await setup();
  const before = nano.runs();
  const result = await w.runner.run(w.args);
  assert.ok(result.outputs.length > 0); assert.ok(nano.runs() > before);
  assert.equal(w.payments.length, 2, "both models use scoped x402 payments even when an environment key exists");
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

test("a completed Market run checkpoints its fee before returning unused model capital", async () => {
  const record = { id: "test-assignment", phase: "running", creator: { status: "awaiting_acceptance", xnoUsd: "0.5" } };
  const w = await setup(4n * 10n ** 28n, context => marketCreatorLiabilities([record], context));
  await w.runner.run({ ...w.args, creator: true, onRunComplete(run) {
    assert.equal(w.pool.snapshot().activeRuns, 1);
    const feeUsd = parseUsdNano(run.costUsd) / 5n;
    record.creator.reserveRaw = (feeUsd * pair.raw / pair.usdNano).toString();
  } });
  assert.ok(marketCreatorLiabilities([record]) > 0n);
  const remaining = 4n * 10n ** 28n - 820000000000000000000000000n - 18000000000000000000000000000n;
  await assert.rejects(w.pool.run({ id: "new-job", maxUsd: 1, maxRaw: remaining }, () => assert.fail("must not spend creator money")),
    { code: "FUNDING_INSUFFICIENT" });
});

test("insufficient pool funds or missing assignment identity never starts Market inference", async () => {
  for (const balance of [0n, 10n ** 30n]) {
    const w = await setup(balance), before = nano.runs();
    await assert.rejects(w.runner.run({ ...w.args, ...(balance ? { fundingId: undefined } : {}) }),
      { code: balance ? "FUNDING_INVALID" : "FUNDING_INSUFFICIENT" });
    assert.equal(nano.runs(), before);
  }
});
