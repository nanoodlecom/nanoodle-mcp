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

test("a Nano transfer is claimed across both live and inactive payment ledgers", async () => {
  const w = await setup(), sent = "A".repeat(64), pending = "B".repeat(64), live = "C".repeat(64);
  await w.write(w.options.nanoFile, { v: 2, quotes: [{ id: "n" }], owed: [
    { fields: { paymentId: "n" }, event: "change", prepared: { hash: pending } },
  ] });
  await w.write(w.options.nearFile, { v: 1, quotes: {}, payouts: {
    market_accepted: { paymentId: "market_accepted", status: "sent", txHash: sent },
  } });
  assert.equal(w.sources.nanoTransferClaimed(sent, "nano:n:change"), true);
  assert.equal(w.sources.nanoTransferClaimed(pending.toLowerCase(), "creator:n"), true);
  assert.equal(w.sources.nanoTransferClaimed(pending, "nano:n:change"), false);
  w.sources.registerNano(() => 100n, () => [{ id: "nano:n:change", hash: live }]);
  assert.equal(w.sources.nanoTransferClaimed(pending, "creator:n"), false);
  assert.equal(w.sources.nanoTransferClaimed(live, "creator:n"), true);
  assert.equal(w.sources.nanoTransferClaimed(sent, "creator:market_accepted"), false);
});

test("Market creator payout verification reads the owning ledger even before the worker starts", async () => {
  const w = await setup(), dir = join(w.options.marketRoot, "inactive"), file = join(dir, "market-state.json");
  await mkdir(dir, { recursive: true });
  const record = { id: "a", phase: "submitted", creator: { status: "queued", author: "author", amountRaw: "20" } };
  await w.write(file, { v: 1, assignments: { a: record } });
  const expected = { paymentId: "market_a", to: "author", amountRaw: "20" };
  assert.equal(w.sources.marketPayoutMatches(expected), true);
  assert.equal(w.sources.marketPayoutMatches({ ...expected, amountRaw: "10" }), false);
  w.sources.registerMarket(file, () => [record]);
  record.creator.status = "awaiting_acceptance";
  assert.equal(w.sources.marketPayoutMatches(expected), false);
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

test("quote readiness expires without discarding debts or preventing their settlement", async () => {
  const w = await setup(); let clock = 1000;
  const sources = createHostedFundingSources({ ...w.options, now: () => clock });
  sources.registerNano(() => 123n);
  assert.equal(sources.ready(), false);
  sources.setReady(true);
  clock += 59_999;
  assert.equal(sources.ready(), true);
  clock += 1;
  assert.equal(sources.ready(), false, "a stalled report cannot keep admitting deposits");
  assert.equal(sources.liabilitiesRaw(), 123n, "expiry leaves existing debt accounting available");
  sources.setReady(true);
  assert.equal(sources.ready(), true, "a new healthy observation can resume admission");
  sources.setReady(false);
  assert.equal(sources.ready(), false);
});

test("invalid clock movement and storage failure require a new healthy observation", async () => {
  const w = await setup(); let clock = 1000;
  const sources = createHostedFundingSources({ ...w.options, now: () => clock });
  sources.setReady(true);
  clock -= 1;
  assert.equal(sources.ready(), false);
  clock += 1;
  assert.equal(sources.ready(), false, "clock recovery alone cannot revive an invalid observation");
  sources.setReady(true);
  sources.setStorageReady(false);
  sources.setStorageReady(true);
  assert.equal(sources.ready(), false, "storage recovery alone cannot revive an observation");
  sources.setReady(true);
  assert.equal(sources.ready(), true);
  clock = NaN;
  assert.equal(sources.ready(), false);
});
