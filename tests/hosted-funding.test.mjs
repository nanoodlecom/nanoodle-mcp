import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedFundingSources, registerCanonicalNanoFunding } from "../src/hosted-funding.mjs";

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

test("canonical Nano obligations precede disabled-rail workers and cannot fall back after journal loss", async () => {
  const w = await setup();
  await w.write(w.options.nanoFile, { v: 2, quotes: [], owed: [] });
  let data = { v: 3, quotes: [{ id: "canonical-debt", status: "paid", amountRaw: "100" }], owed: [] };
  const store = { load: scope => { assert.equal(scope, "gate:account"); return { revision: 1, data }; } };
  assert.equal(registerCanonicalNanoFunding(w.sources, store, "account"), true);
  assert.equal(w.sources.liabilitiesRaw(), 100n, "no live Nano gate needs to be running");
  data.quotes[0].amountRaw = "200";
  assert.equal(w.sources.liabilitiesRaw(), 200n);
  data = null;
  assert.throws(() => w.sources.liabilitiesRaw(), /canonical-funding-state-unavailable/);
  data = { v: 2, quotes: [], owed: [] };
  assert.throws(() => w.sources.liabilitiesRaw(), /canonical-funding-state-unavailable/);
});

test("a new journal may use its legacy import source, but required canonical state cannot be initialized empty", async () => {
  const w = await setup(), store = { load: () => ({ data: null }) };
  await w.write(w.options.nanoFile, { v: 2, quotes: [{ id: "legacy-debt", status: "paid", amountRaw: "50" }], owed: [] });
  assert.equal(registerCanonicalNanoFunding(w.sources, store, "account"), false);
  assert.equal(w.sources.liabilitiesRaw(), 50n);
  assert.throws(() => registerCanonicalNanoFunding(w.sources, store, "account", { required: true }), /canonical-funding-state-unavailable/);
});

test("raw canonical execution intents remain held until a live Nano owner establishes their state", async () => {
  const { nanoRecoveryObligations } = await import("../src/payments/recovery-obligations.mjs");
  const w = await setup();
  await w.write(w.options.nanoFile, { v: 2, quotes: [], owed: [] });
  const data = { v: 3, quotes: [{ id: "interrupted", status: "consumed", settled: false, amountRaw: "100", execution: "intent" }], owed: [] };
  const store = { load: () => ({ data }) };
  registerCanonicalNanoFunding(w.sources, store, "account");
  assert.equal(w.sources.recoveryObligations().heldRuns, 1, "startup cannot treat a persisted dispatch as unstarted work");
  w.sources.registerNano(() => 100n);
  assert.equal(w.sources.recoveryObligations().heldRuns, 1, "omitting a new recovery reader cannot revive stale JSON authority");
  w.sources.registerNano(() => 100n, () => nanoRecoveryObligations(data, { live: true }));
  assert.equal(w.sources.recoveryObligations().heldRuns, 0, "a live owner may distinguish its own running dispatch");
  data.quotes[0].recoveryRequired = true;
  assert.equal(w.sources.recoveryObligations().heldRuns, 1, "a recovered ambiguous dispatch remains held");
});

test("disabled rails and live payout owners both retain legacy prepared-payout barriers", async () => {
  const w = await setup();
  const signed = { paymentId: "market_legacy", status: "signed", amountRaw: "100", prepared: { hash: "PRIVATE_HASH" } };
  await w.write(w.options.nearFile, { v: 1, quotes: {}, payouts: { market_legacy: signed } });
  assert.equal(w.sources.recoveryObligations().unverifiedCreatorPayouts, 1);
  let live = [signed]; w.sources.registerNear(() => 100n, () => live);
  assert.equal(w.sources.recoveryObligations().unverifiedCreatorPayouts, 1);
  assert.equal(w.sources.recoveryObligations({ isJournaled: () => true }).unverifiedCreatorPayouts, 0);
  live = [{ ...signed, status: "sent" }];
  assert.equal(w.sources.recoveryObligations().unverifiedCreatorPayouts, 1, "an old publish receipt alone does not prove confirmation");
  assert.equal(w.sources.recoveryObligations({ isJournaled: () => true }).unverifiedCreatorPayouts, 0);
  live = [{ ...signed, status: "unknown" }];
  assert.throws(() => w.sources.recoveryObligations(), /recovery-obligations-invalid/);
});

test("a queued creator claim cannot lose its payout intent or change its binding during restore", async () => {
  const w = await setup(), file = join(w.options.marketRoot, "disabled", "market-state.json");
  await mkdir(join(w.options.marketRoot, "disabled"), { recursive: true });
  await w.write(file, { v: 1, assignments: { job: { id: "job", phase: "submitted", creator: { status: "queued", author: "creator", amountRaw: "100" } } } });
  assert.equal(w.sources.recoveryObligations().unverifiedCreatorPayouts, 1, "a disabled profile must retain its missing-outbox barrier");
  const payout = { paymentId: "market_job", status: "queued", to: "creator", amountRaw: "100", prepared: null };
  await w.write(w.options.nearFile, { v: 1, quotes: {}, payouts: { market_job: payout } });
  assert.equal(w.sources.recoveryObligations().unverifiedCreatorPayouts, 0);
  await w.write(w.options.nearFile, { v: 1, quotes: {}, payouts: { market_job: { ...payout, amountRaw: "99" } } });
  assert.throws(() => w.sources.recoveryObligations(), /recovery-obligations-invalid/);
});
