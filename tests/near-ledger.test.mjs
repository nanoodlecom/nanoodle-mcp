/**
 * Durable NEAR state: synchronous atomic writes, refusal to start from an
 * unreadable or foreign file, and pruning that never drops consumed hashes or
 * refunds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNearLedger } from "../src/near/ledger.mjs";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "near-ledger-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OPTS = { network: "testnet", merchant: "merchant.testnet" };

test("a missing file starts empty and nothing is written until a mutation", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "sub", "near-state.json");
    const l = openNearLedger({ file, ...OPTS });
    assert.equal(l.file, file);
    assert.deepEqual(l.quotes(), []);
    assert.deepEqual(l.refunds(), []);
    assert.equal(l.getQuote("nq_x"), null);
    assert.equal(l.consumedBy("h"), null);
    assert.equal(l.getMeta("lastNonce"), undefined);
    l.setMeta("lastNonce", "7"); // creates the directory
    assert.equal(JSON.parse(readFileSync(file, "utf8")).meta.lastNonce, "7");
  });
});

test("persist, reopen and read back", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "near-state.json");
    const l = openNearLedger({ file, ...OPTS });
    l.putQuote({ id: "nq_a", status: "pending", amountYocto: "8379000000000000000000", createdAt: 1, expiresAt: 2 });
    // written synchronously: the file has it before putQuote returned
    assert.equal(JSON.parse(readFileSync(file, "utf8")).quotes.nq_a.amountYocto, "8379000000000000000000");
    const q = l.updateQuote("nq_a", { status: "running", payTx: "TX1" });
    assert.equal(q.status, "running");
    assert.equal(q.amountYocto, "8379000000000000000000");
    assert.equal(l.consumeTx("TX1", "nq_a"), true);
    l.putRefund({ id: "rf_1", paymentId: "nq_a", to: "payer.testnet", amountYocto: "5", status: "signed", txHash: "R1" });
    l.updateRefund("rf_1", { status: "sent" });
    l.setMeta("lastNonce", "275735371000006");

    const disk = JSON.parse(await readFile(file, "utf8"));
    assert.equal(disk.v, 1);
    assert.equal(disk.network, "testnet");
    assert.equal(disk.merchant, "merchant.testnet");
    assert.deepEqual(disk.consumedTx, { TX1: "nq_a" });

    const again = openNearLedger({ file, ...OPTS });
    assert.deepEqual(again.getQuote("nq_a"), { id: "nq_a", status: "running", amountYocto: "8379000000000000000000", createdAt: 1, expiresAt: 2, payTx: "TX1" });
    assert.equal(again.consumedBy("TX1"), "nq_a");
    assert.equal(again.getRefund("rf_1").status, "sent");
    assert.equal(again.refundForPayment("nq_a").id, "rf_1");
    assert.equal(again.refundForPayment("nq_b"), null);
    assert.equal(again.getMeta("lastNonce"), "275735371000006");
    assert.equal(again.quotes().length, 1);
    assert.equal(again.refunds().length, 1);
    // no temp files are left behind
    assert.deepEqual(await readdir(dir), ["near-state.json"]);
  });
});

test("returned objects are copies", async () => {
  await withDir(async (dir) => {
    const l = openNearLedger({ file: join(dir, "s.json"), ...OPTS });
    const input = { id: "nq_a", status: "pending", pricing: { usd: "0.03" } };
    l.putQuote(input);
    input.status = "hacked";
    const q = l.getQuote("nq_a");
    q.status = "hacked";
    q.pricing.usd = "999";
    assert.equal(l.getQuote("nq_a").status, "pending");
    assert.equal(l.getQuote("nq_a").pricing.usd, "0.03");
  });
});

test("consumeTx twice is false, also after reopen", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json");
    const l = openNearLedger({ file, ...OPTS });
    assert.equal(l.consumeTx("HASH", "nq_a"), true);
    assert.equal(l.consumeTx("HASH", "nq_a"), false);
    assert.equal(l.consumeTx("HASH", "nq_b"), false);
    assert.equal(l.consumedBy("HASH"), "nq_a");
    const again = openNearLedger({ file, ...OPTS });
    assert.equal(again.consumeTx("HASH", "nq_c"), false);
    assert.equal(again.consumedBy("HASH"), "nq_a");
  });
});

test("a restored payment must retain its replay claim before the ledger can reopen", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json"), l = openNearLedger({ file, ...OPTS });
    l.putQuote({ id: "retained", status: "pending" });
    l.recordPayment("retained", "paid-hash", { status: "paid" });
    l.putQuote({ id: "legacy", status: "pending" });
    l.consumeTx("legacy-hash", "legacy");
    l.consumeTx("pruned-hash", "pruned");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    for (const owner of [undefined, "pruned"]) {
      const consumedTx = { ...snapshot.consumedTx, "paid-hash": owner };
      const incomplete = JSON.stringify({ ...snapshot, consumedTx });
      await writeFile(file, incomplete);
      assert.throws(() => openNearLedger({ file, ...OPTS, requireExisting: true }), { code: "STATE_PAYMENT_REPLAY_UNVERIFIED" });
      assert.equal(await readFile(file, "utf8"), incomplete);
    }
    for (const status of ["paid", "running", "settled", "failed", "rejected"]) {
      const quotes = { ...snapshot.quotes, retained: { id: "retained", status, payTx: null } };
      const incomplete = JSON.stringify({ ...snapshot, quotes });
      await writeFile(file, incomplete);
      assert.throws(() => openNearLedger({ file, ...OPTS, requireExisting: true }), { code: "STATE_PAYMENT_REPLAY_UNVERIFIED" }, status);
      assert.equal(await readFile(file, "utf8"), incomplete);
    }
    await writeFile(file, JSON.stringify(snapshot));
    const restored = openNearLedger({ file, ...OPTS, requireExisting: true });
    assert.equal(restored.consumedBy("paid-hash"), "retained");
    assert.equal(restored.consumedBy("pruned-hash"), "pruned");
    assert.equal(restored.hasUnattachedPayment("legacy"), true);
  });
});

test("duplicate ids and unknown ids", async () => {
  await withDir(async (dir) => {
    const l = openNearLedger({ file: join(dir, "s.json"), ...OPTS });
    l.putQuote({ id: "nq_a", status: "pending" });
    assert.throws(() => l.putQuote({ id: "nq_a", status: "pending" }), { code: "DUPLICATE_ID" });
    assert.throws(() => l.updateQuote("nq_missing", {}), { code: "NOT_FOUND" });
    l.putRefund({ id: "rf_1", paymentId: "nq_a" });
    assert.throws(() => l.putRefund({ id: "rf_1", paymentId: "nq_a" }), { code: "DUPLICATE_ID" });
    assert.throws(() => l.updateRefund("rf_x", {}), { code: "NOT_FOUND" });
    assert.throws(() => l.putQuote({ status: "pending" }), TypeError);
    // update cannot change the id
    assert.equal(l.updateQuote("nq_a", { id: "other" }).id, "nq_a");
  });
});

test("a corrupt or malformed file -> STATE_UNREADABLE", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json");
    for (const body of ["{not json", "", "[]", "null", JSON.stringify({ v: 2, network: "testnet", merchant: "merchant.testnet", quotes: {}, consumedTx: {}, refunds: {} }),
      JSON.stringify({ v: 1, network: "testnet", merchant: "merchant.testnet", quotes: {}, refunds: {} }),
      JSON.stringify({ v: 1, network: "testnet", merchant: "merchant.testnet", quotes: [], consumedTx: {}, refunds: {} })]) {
      await writeFile(file, body);
      assert.throws(() => openNearLedger({ file, ...OPTS }), { name: "NearError", code: "STATE_UNREADABLE" }, body);
    }
    // a directory where the file should be
    assert.throws(() => openNearLedger({ file: dir, ...OPTS }), { code: "STATE_UNREADABLE" });
  });
});

test("network or merchant mismatch -> STATE_MISMATCH", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json");
    openNearLedger({ file, ...OPTS }).consumeTx("H", "nq_a");
    assert.throws(() => openNearLedger({ file, network: "testnet", merchant: "other.testnet" }), { code: "STATE_MISMATCH" });
    assert.throws(() => openNearLedger({ file, network: "mainnet", merchant: "merchant.testnet" }), { code: "STATE_MISMATCH" });
    assert.throws(() => openNearLedger({ file, network: "devnet", merchant: "merchant.testnet" }), TypeError);
  });
});

test("prune drops old finished quotes and long-expired unpaid quotes; consumedTx and refunds stay", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json");
    let t = 1_000_000_000;
    const l = openNearLedger({ file, ...OPTS, now: () => t });
    const day = 86_400_000;
    l.putQuote({ id: "settled_old", status: "settled", finishedAt: t - day - 1 });
    l.putQuote({ id: "failed_old", status: "failed", finishedAt: t - day - 1 });
    l.putQuote({ id: "rejected_old", status: "rejected", finishedAt: t - day - 1 });
    l.putQuote({ id: "expired_old", status: "expired", expiresAt: t - day - 1, finishedAt: null });
    l.putQuote({ id: "settled_new", status: "settled", finishedAt: t - 1000 });
    l.putQuote({ id: "pending_old", status: "pending", createdAt: 0, expiresAt: 1 });
    l.putQuote({ id: "pending_live", status: "pending", createdAt: t, expiresAt: t + 900_000 });
    l.putQuote({ id: "running_old", status: "running", createdAt: 0 });
    l.putQuote({ id: "settled_no_time", status: "settled" });
    l.consumeTx("TX_OLD", "settled_old");
    for (const id of ["running_old", "settled_new", "settled_no_time"]) {
      const txHash = "payment-" + id;
      l.updateQuote(id, { payTx: txHash });
      l.consumeTx(txHash, id);
    }
    l.putRefund({ id: "rf_old", paymentId: "settled_old", status: "sent" });
    assert.equal(l.prune(), 5);
    const left = l.quotes().map((q) => q.id).sort();
    assert.deepEqual(left, ["pending_live", "running_old", "settled_new", "settled_no_time"]);
    assert.equal(l.consumedBy("TX_OLD"), "settled_old");
    assert.equal(l.getRefund("rf_old").status, "sent");
    // persisted
    const again = openNearLedger({ file, ...OPTS });
    assert.equal(again.quotes().length, 4);
    assert.equal(again.consumedBy("TX_OLD"), "settled_old");
    // custom retention
    t += 2000;
    assert.equal(l.prune({ retainMs: 500 }), 1);
    assert.equal(l.prune(), 0);
  });
});

test("NEAR retention keeps quotes with a short creator payout or a wrong-asset refund", async () => {
  await withDir(async dir => {
    const l = openNearLedger({ file: join(dir, "state.json"), ...OPTS, now: () => 90_000_000 });
    l.putQuote({ id: "job", status: "settled", finishedAt: 1, payer: "payer.testnet", asset: "usdc",
      tokenContract: "token.testnet", refundId: "refund",
      settlement: { refundYocto: "70", authorPayout: { to: "author", amountRaw: "30" } } });
    l.putRefund({ id: "refund", paymentId: "job", status: "sent", asset: "near", to: "payer.testnet", amountYocto: "70" });
    l.putPayout({ paymentId: "job", status: "sent", to: "author", amountRaw: "25" });
    assert.equal(l.prune(), 0);
    l.updateRefund("refund", { asset: "usdc", tokenContract: "token.testnet" });
    assert.equal(l.prune(), 0);
    l.updatePayout("job", { amountRaw: "30" });
    assert.equal(l.prune(), 1);
    assert.equal(l.getQuote("job"), null);
    assert.equal(l.getRefund("refund").status, "sent");
    assert.equal(l.getPayout("job").status, "sent");
  });
});

test("NEAR retention preserves a quote if its refund hash also belongs to a pruned payment", async () => {
  await withDir(async dir => {
    const l = openNearLedger({ file: join(dir, "state.json"), ...OPTS, now: () => 90_000_000 });
    const row = { id: "refund", paymentId: "payment", status: "sent", to: "payer.testnet", amountYocto: "70", txHash: "shared" };
    l.putQuote({ id: row.paymentId, status: "settled", finishedAt: 1, payer: row.to, refundId: row.id,
      settlement: { refundYocto: row.amountYocto } });
    l.putRefund(row);
    l.putRefund({ ...row, id: "old-refund", paymentId: "old-payment", txHash: "replacement", supersededTxHashes: ["shared"] });
    assert.equal(l.prune(), 0);
    assert.ok(l.getQuote(row.paymentId));
    l.updateRefund("old-refund", { supersededTxHashes: ["unrelated"] });
    assert.equal(l.prune(), 1);
  });
});

test("a bigint is rejected and nothing changes", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "s.json");
    const l = openNearLedger({ file, ...OPTS });
    l.putQuote({ id: "nq_a", status: "pending" });
    assert.throws(() => l.putQuote({ id: "nq_b", amountYocto: 5n }), TypeError);
    assert.throws(() => l.updateQuote("nq_a", { amountYocto: 5n }), TypeError);
    assert.throws(() => l.updateQuote("nq_a", { nested: { deep: [1, 2n] } }), TypeError);
    assert.throws(() => l.putRefund({ id: "rf", paymentId: "nq_a", amountYocto: 1n }), TypeError);
    assert.throws(() => l.setMeta("lastNonce", 7n), TypeError);
    assert.throws(() => l.updateQuote("nq_a", { x: NaN }), TypeError);
    assert.equal(l.getQuote("nq_b"), null);
    assert.equal(l.getQuote("nq_a").amountYocto, undefined);
    assert.equal(l.getMeta("lastNonce"), undefined);
    assert.equal(l.refunds().length, 0);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).quotes), ["nq_a"]);
  });
});

test("a failed write rolls the in-memory state back", async () => {
  await withDir(async (dir) => {
    // opened while the parent directory did not exist; then a plain file takes its name
    const parent = join(dir, "sub");
    const l = openNearLedger({ file: join(parent, "s.json"), ...OPTS });
    await writeFile(parent, "x");
    assert.throws(() => l.consumeTx("H", "nq_a"));
    assert.equal(l.consumedBy("H"), null);
  });
});

test("payment attachment and duplicate protection commit together after a write failure", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "near-state.json"), stage = `${file}.tmp-${process.pid}`;
    const ledger = openNearLedger({ file, ...OPTS });
    ledger.putQuote({ id: "first", status: "pending" });
    ledger.putQuote({ id: "second", status: "pending" });
    const old = await readFile(file, "utf8"), payment = { status: "paid", paidYocto: "1" };
    await mkdir(stage);
    assert.throws(() => ledger.recordPayment("first", "hash", payment));
    assert.equal(ledger.consumedBy("hash"), null);
    assert.deepEqual(ledger.getQuote("first"), { id: "first", status: "pending" });
    assert.equal(await readFile(file, "utf8"), old);
    await rm(stage, { recursive: true });
    assert.equal(ledger.recordPayment("first", "hash", payment).payTx, "hash");
    const reopened = openNearLedger({ file, ...OPTS });
    assert.equal(reopened.consumedBy("hash"), "first");
    assert.equal(reopened.getQuote("first").status, "paid");
    assert.equal(reopened.recordPayment("second", "hash", payment), null);
    assert.equal(reopened.recordPayment("first", "different-hash", payment), null);
    assert.equal(reopened.consumedBy("different-hash"), null);
    assert.equal(reopened.getQuote("second").status, "pending");
  });
});
