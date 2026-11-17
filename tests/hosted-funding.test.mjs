import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedFundingSources } from "../src/hosted-funding.mjs";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hosted-funding-"));
  const options = { nanoFile: join(dir, "nano.json"), nearFile: join(dir, "near.json"), marketRoot: join(dir, "market") };
  const write = (path, value) => writeFile(path, JSON.stringify(value));
  return { dir, options, write, sources: createHostedFundingSources(options) };
}

test("live owners replace stale disk snapshots while disabled profiles still reserve their debts", async () => {
  const w = await setup();
  await w.write(w.options.nanoFile, { v: 2, quotes: [{ id: "n", status: "paid", amountRaw: "100" }], owed: [] });
  const payouts = [{ paymentId: "market_a", status: "queued", amountRaw: "200" }];
  await w.write(w.options.nearFile, { v: 1, quotes: {}, payouts: { market_a: payouts[0] } });
  const activeFile = join(w.options.marketRoot, "active", "market-state.json");
  const disabledFile = join(w.options.marketRoot, "disabled", "market-state.json");
  await mkdir(join(w.options.marketRoot, "active"), { recursive: true });
  await mkdir(join(w.options.marketRoot, "disabled"), { recursive: true });
  await w.write(activeFile, { v: 1, assignments: { a: { id: "a", phase: "submitted", creator: { status: "queued", amountRaw: "200" } } } });
  await w.write(disabledFile, { v: 1, assignments: { b: { id: "b", phase: "submitted", creator: { status: "owed", amountRaw: "300" } } } });
  assert.equal(w.sources.liabilitiesRaw(), 600n);
  w.sources.registerNano(() => 150n);
  w.sources.registerNear(() => 250n, () => payouts);
  assert.equal(w.sources.liabilitiesRaw(), 700n);
  let amount = "350";
  w.sources.registerMarket(disabledFile, () => [{ id: "b", phase: "submitted", creator: { status: "owed", amountRaw: amount } }]);
  assert.equal(w.sources.liabilitiesRaw(), 750n);
  amount = "400";
  assert.equal(w.sources.liabilitiesRaw(), 800n, "the reader observes the owner's live memory rather than a delayed JSON write");
});

test("fresh state may be empty; existing malformed financial files cannot become zero debts", async () => {
  const w = await setup();
  assert.equal(w.sources.liabilitiesRaw(), 0n);
  await writeFile(w.options.nanoFile, "broken JSON");
  assert.throws(() => w.sources.liabilitiesRaw(), /funding-state-unreadable/);
  await w.write(w.options.nanoFile, { v: 2, quotes: [], owed: [] });
  await w.write(w.options.nearFile, { v: 99, quotes: {} });
  assert.throws(() => w.sources.liabilitiesRaw(), /invalid-funding-state/);
});

test("a closed or unpublished Market profile does not make its earned creator fee spendable", async () => {
  const w = await setup();
  await mkdir(w.options.marketRoot, { recursive: true });
  await w.write(join(w.options.marketRoot, "market-state.json"), { v: 1, assignments: {
    old: { id: "old", phase: "submitted", budgetUsd: 1.2, run: { costUsd: 1 },
      creator: { status: "awaiting_acceptance", xnoUsd: "1" } },
  } });
  assert.equal(w.sources.liabilitiesRaw(), 2n * 10n ** 29n);
});
