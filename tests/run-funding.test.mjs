import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunFunding, runFundingBudget, FundingError } from "../src/run-funding.mjs";
import { parseUsdNano } from "../src/usd.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function world({ initial = 1000n, requireScope = true } = {}) {
  let balance = initial, liabilities = 0n, tail = Promise.resolve(), nextInvoice = 0;
  const serial = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
  const pool = createRunFunding({ serial, balance: async () => balance, liabilitiesRaw: () => liabilities, requireScope });
  const sent = [];
  const pay = (amountRaw = 40n, ...args) => {
    const amountUsd = args.length ? args[0] : 0.4;
    const paymentId = args.length > 1 ? args[1] : `invoice-${++nextInvoice}`;
    const fail = args[2] === true;
    const scope = pool.capture();
    return serial(() => {
      pool.authorize(scope, { amountRaw: String(amountRaw), amountUsd, paymentId }, balance);
      sent.push(paymentId); balance -= amountRaw;
      if (fail) throw Error("ambiguous publish");
    });
  };
  return { pool, pay, sent, serial, setLiabilities: v => { liabilities = v; }, balance: () => balance };
}
const budget = (id, maxRaw = 100n, maxUsd = 1) => ({ id, maxRaw, maxUsd });

test("locked quote terms reserve creator markup without authorizing models to spend it", () => {
  const options = { id: "quote", budgetUsd: "1.20", pair: { usdNano: 500_000_000n, raw: 10n ** 30n } };
  assert.deepEqual(runFundingBudget(options), { id: "quote", maxUsd: "1.200000000", maxRaw: 24n * 10n ** 29n, overheadRaw: 0n });
  assert.deepEqual(runFundingBudget({ ...options, creator: true }), { id: "quote", maxUsd: "1.000000000", maxRaw: 2n * 10n ** 30n, overheadRaw: 4n * 10n ** 29n });
  assert.throws(() => runFundingBudget({ ...options, pair: { usdNano: 0n, raw: 1n } }), { code: "FUNDING_INVALID" });
});

test("parallel paid nodes share one cumulative USD and raw budget", async () => {
  const w = world();
  await w.pool.run(budget("parallel"), async () => {
    const results = await Promise.allSettled([w.pay(), w.pay(), w.pay()]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "FUNDING_OVER_BUDGET");
  });
  assert.equal(w.sent.length, 2);
  assert.deepEqual(w.pool.snapshot(), { activeRuns: 0, reservedRaw: "0" });
});

test("another run cannot spend reserved working capital; draws and actual balance both decrease", async () => {
  const w = world({ initial: 100n }), entered = deferred(), finish = deferred();
  const first = w.pool.run(budget("first", 80n), async () => { await w.pay(60n, 0.6); entered.resolve(); await finish.promise; });
  await entered.promise;
  let executions = 0;
  await assert.rejects(w.pool.run(budget("second", 30n), () => { executions++; }), { code: "FUNDING_INSUFFICIENT" });
  assert.equal(executions, 0, "insufficient capital refuses before inference");
  assert.equal(w.balance(), 40n);
  assert.equal(w.pool.snapshot().reservedRaw, "20");
  finish.resolve(); await first;
  await w.pool.run(budget("second", 30n), () => { executions++; });
  assert.equal(executions, 1, "only unused capacity is released");
});

test("customer and creator debts remain reserved even when the nominal balance covers a run", async () => {
  const w = world({ initial: 100n }); w.setLiabilities(60n);
  let ran = false;
  await assert.rejects(w.pool.run(budget("debt", 50n), () => { ran = true; }), { code: "FUNDING_INSUFFICIENT" });
  assert.equal(ran, false);
  assert.equal(w.sent.length, 0);
});

test("admission rechecks liabilities after awaiting the chain balance", async () => {
  let liabilities = 0n;
  const pool = createRunFunding({ serial: fn => fn(), liabilitiesRaw: () => liabilities,
    balance: async () => { liabilities = 80n; return 100n; } });
  await assert.rejects(pool.run(budget("changed-debt", 30n), () => assert.fail("must not run")), { code: "FUNDING_INSUFFICIENT" });
});

test("missing or malformed invoice prices and reused identities never grant spend authority", async () => {
  const w = world();
  await w.pool.run(budget("invalid"), async () => {
    for (const price of [undefined, null, 0, -1, Infinity, NaN, false, "", "garbage"]) {
      await assert.rejects(w.pay(1n, price), FundingError);
    }
    await w.pay(1n, 0.1, "one-invoice");
    await assert.rejects(w.pay(1n, 0.1, "one-invoice"), { code: "FUNDING_INVOICE_USED" });
    await assert.rejects(w.pay(1n, 0.1, ""), { code: "FUNDING_INVALID" });
  });
  assert.deepEqual(w.sent, ["one-invoice"]);
});

test("a false USD quote cannot bypass the independent raw cap", async () => {
  const w = world();
  await w.pool.run(budget("raw", 10n, 100), async () => {
    await assert.rejects(w.pay(11n, 0.00001), { code: "FUNDING_OVER_BUDGET" });
  });
  assert.equal(w.sent.length, 0);
});

test("sub-nanodollar invoices round up against budgets; tiny exponents do not become huge prices", async () => {
  assert.equal(parseUsdNano("1234567890e-20"), 0n);
  assert.equal(parseUsdNano("1234567890e-20", { roundUp: true }), 1n);
  assert.equal(parseUsdNano("1.0000000001"), 1_000_000_000n);
  assert.equal(parseUsdNano("1.0000000001", { roundUp: true }), 1_000_000_001n);
  const w = world();
  await w.pool.run(budget("rounding", 10n, "0.000000001"), async () => {
    await w.pay(1n, "0.0000000006");
    await assert.rejects(w.pay(1n, "0.0000000001"), { code: "FUNDING_OVER_BUDGET" });
  });
});

test("failed or ambiguous payments consume authority and cannot be retried as a fresh invoice", async () => {
  const w = world();
  await w.pool.run(budget("ambiguous"), async () => {
    await assert.rejects(w.pay(80n, 0.8, "lost-response", true), /ambiguous publish/);
    await assert.rejects(w.pay(80n, 0.8, "new-identity"), { code: "FUNDING_OVER_BUDGET" });
  });
  assert.deepEqual(w.sent, ["lost-response"]);
});

test("detached work inherits a closed scope and cannot spend after the result", async () => {
  const w = world(), go = deferred(); let late;
  await w.pool.run(budget("late"), async () => { late = go.promise.then(() => w.pay()); });
  go.resolve();
  await assert.rejects(late, { code: "FUNDING_CLOSED" });
  assert.equal(w.sent.length, 0);
});

test("a nested run, duplicate active identity or forged scope cannot reset a budget", async () => {
  const w = world(), started = deferred(), finish = deferred();
  const first = w.pool.run(budget("same"), async () => {
    await assert.rejects(w.pool.run(budget("nested"), () => {}), { code: "FUNDING_NESTED" });
    assert.throws(() => w.pool.authorize({}, { amountRaw: "1" }, 1000n), { code: "FUNDING_CLOSED" });
    started.resolve(); await finish.promise;
  });
  await started.promise;
  await assert.rejects(w.pool.run(budget("same"), () => {}), { code: "FUNDING_DUPLICATE" });
  finish.resolve(); await first;
  await assert.rejects(w.pay(), { code: "FUNDING_REQUIRED" });
});

test("legacy payments cannot take another run's reservation or creator overhead", async () => {
  const w = world({ initial: 120n, requireScope: false }), started = deferred(), finish = deferred();
  const first = w.pool.run({ ...budget("creator", 100n), overheadRaw: 20n }, async () => {
    await w.pay(100n, 1); started.resolve(); await finish.promise;
  });
  await started.promise;
  assert.equal(w.pool.snapshot().reservedRaw, "20");
  await assert.rejects(w.pay(1n, 0.01), { code: "FUNDING_INSUFFICIENT" });
  finish.resolve(); await first;
  await w.pay(1n, 0.01);
});

test("invalid policy and failed runs leave no phantom reservation", async () => {
  const w = world();
  for (const opts of [budget("bad", -1n), budget("bad", 0n), budget("bad", 100n, NaN), budget("bad", 100n, "1e99999")]) {
    await assert.rejects(w.pool.run(opts, () => {}), { code: "FUNDING_INVALID" });
  }
  await assert.rejects(w.pool.run(budget("failed"), () => { throw Error("engine failed"); }), /engine failed/);
  assert.deepEqual(w.pool.snapshot(), { activeRuns: 0, reservedRaw: "0" });
  await w.pool.run(budget("healthy"), () => {});
});
