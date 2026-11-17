import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createBlock, deriveAddress, derivePublicKey } from "nanocurrency";
import { preparePaymentMigration } from "../scripts/prepare-payment-migration.mjs";
import { acquireWriterLocks } from "../src/process-lock.mjs";
import { openRecoveryStore } from "../src/payments/recovery-store.mjs";
import { verifyStartupState } from "../src/startup-state.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";

const NOW = Date.parse("2026-11-17T13:00:00Z"), secret = "1".repeat(64);
const account = deriveAddress(derivePublicKey(secret), { useNanoPrefix: true });
const json = (path, data) => writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
const read = path => JSON.parse(readFileSync(path));
function block(previous, balance = "1000") {
  const b = createBlock(secret, { previous, balance, representative: account, link: "B".repeat(64), work: "0".repeat(16) });
  b.block.account = account; return b;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "prepare-migration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, "out"), market = join(root, "market"), profile = join(market, "demo");
  mkdirSync(out, { mode: 0o700 }); mkdirSync(market, { mode: 0o700 }); mkdirSync(profile, { mode: 0o700 });
  const anchor = block("A".repeat(64));
  const quote = { id: "pay_settled", tool: "example", argsHash: "args", usd: 0.1,
    pair: { usdNano: "1000000000", raw: "1000000000000000000000000000000" }, amountRaw: "10000000000000000000000",
    createdAt: NOW - 300_000, expiresAt: NOW - 200_000, completedAt: NOW - 100_000,
    status: "paid", settled: true, source: account, payHash: "C".repeat(64),
    privateStuff: { prompt: "NEVER_COPY_PROMPTS_OR_KEYS", secretKey: "NEVER_COPY_PROMPTS_OR_KEYS" } };
  const nano = { v: 2, quotes: [quote, { ...quote, id: "pay_expired", amountRaw: "20000000000000000000000",
    settled: false, status: "expired", source: null, payHash: null }], owed: [] };
  const near = { v: 1, network: "mainnet", merchant: "shop.near", quotes: {}, consumedTx: {}, refunds: {}, payouts: {}, meta: {} };
  const assignments = { v: 1, assignments: { done: { id: "done", phase: "submitted" } } };
  const files = [join(out, "gate-state.json"), join(out, "near-state.json"), join(profile, "market-state.json")];
  files.forEach((file, i) => json(file, [nano, near, assignments][i]));
  const checkpoint = { v: 1, networkGenesis: NANO_GENESIS_HASH, account,
    head: { hash: anchor.hash, blockCount: "10" }, confirmed: { hash: anchor.hash, blockCount: "10" } };
  const healthFile = join(out, "funding-health.json");
  json(healthFile, { v: 1, checkedAt: new Date(NOW).toISOString(), ok: true, activeRuns: 0, oldestStartedAt: null,
    balanceRaw: "1000", liabilitiesRaw: "0", reservedRaw: "0", enforced: true, protectTransfers: true,
    writerProtection: { enforced: true, requiredState: true }, nanoRpc: { enforced: true, configuredPeers: 2, minimumPeers: 2,
      readablePeers: 2, networkPeers: 2, lastReadAt: NOW, checkpoint } });
  const policyFile = join(root, "policy.json"), policy = { v: 1, outDir: out, nanoAddress: account, chargeNano: true,
    near: { network: "mainnet", merchant: "shop.near" }, marketRoot: market, marketHandles: ["demo"] };
  json(policyFile, policy);
  const calls = [], blocks = new Map([[anchor.hash, { confirmed: "true", height: "10", contents: anchor.block }]]);
  const w = { root, out, market, files, healthFile, policyFile, policy, anchor, calls, blocks, height: 10, current: anchor, onRequest: null };
  w.options = { policyFile, destination: join(root, "prepared"), rpcUrls: ["http://first.invalid", "http://second.invalid"],
    lockDir: join(root, "locks"), now: () => NOW, fetch: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body); await w.onRequest?.(body);
      assert.ok(["account_info", "block_info"].includes(body.action), "no effectful RPC may leave this tool");
      if (body.action === "account_info") return Response.json(nanoAccountInfo({ height: w.height, frontier: w.current.hash,
        balance: w.current.block.balance, representative: account }));
      if (body.hash === NANO_GENESIS_HASH) return Response.json(NANO_GENESIS_REPLY);
      return Response.json(blocks.get(body.hash) ?? { error: "Block not found" });
    } };
  return w;
}

test("offline preparation preserves all original bytes and money metadata, emits a required V2 policy and never activates it", async t => {
  const w = fixture(t), before = [...w.files, w.policyFile, w.healthFile].map(file => readFileSync(file));
  const result = await preparePaymentMigration(w.options);
  assert.equal(result.ok, true); assert.equal(result.sourceCount, 3); assert.equal(result.activationInstalled, false);
  assert.equal(result.signatures + result.transfers + result.workflows, 0);
  [...w.files, w.policyFile, w.healthFile].forEach((file, i) => assert.deepEqual(readFileSync(file), before[i]));
  const nextFile = join(w.options.destination, "state-policy.v2.json"), next = read(nextFile);
  const checked = verifyStartupState({ policyFile: nextFile, outDir: w.out, nanoAddress: account, chargeNano: true,
    nearMerchant: "shop.near", nearNetwork: "mainnet", marketRoot: w.market, marketHandles: ["demo"],
    recoveryDb: next.recovery.path, requireRecoveryMonitoring: true });
  const store = openRecoveryStore(next.recovery.path, { requireExisting: true, migration: checked.recovery });
  const imported = store.load(`gate:${account}`).data, receipt = store.load(`migration:${account}`).data;
  assert.equal(imported.quotes.length, 2); assert.equal(imported.owed.length, 0);
  assert.equal(imported.quotes[0].settled, true); assert.equal(imported.quotes[0].payHash, "C".repeat(64));
  assert.equal(imported.quotes[1].legacyRecovery, true);
  assert.equal(store.paymentOwner("C".repeat(64)), null, "a legacy hash reference is not an incoming-payment proof");
  assert.deepEqual(receipt.sources.map(s => s.scope), ["nano", "near", "market:demo"]);
  assert.equal(receipt.initialHead.hash, w.anchor.hash); assert.equal(store.status(account).ready, true);
  assert.doesNotMatch(JSON.stringify(imported), /NEVER_COPY|privateStuff|secretKey/); store.close();
  for (const path of [nextFile, next.recovery.path, join(w.options.destination, "migration-receipt.json"), join(w.options.destination, "preparation.json")]) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  assert.equal(statSync(w.options.destination).mode & 0o777, 0o700);
  assert.equal(read(w.policyFile).v, 1);
  assert.ok(w.calls.length > 0); assert.ok(w.calls.every(c => ["block_info", "account_info"].includes(c.action)));
});

test("a newer confirmed head must prove ancestry back to the captured live floor", async t => {
  const w = fixture(t), next = block(w.anchor.hash, "900");
  w.current = next; w.height = 11; w.blocks.set(next.hash, { confirmed: "true", height: "11", contents: next.block });
  assert.equal((await preparePaymentMigration(w.options)).ok, true);
  assert.ok(w.calls.some(c => c.hash === w.anchor.hash));
  assert.equal(read(join(w.options.destination, "migration-receipt.json")).initialHead.hash, next.hash);
});

test("a higher signed head on a different branch cannot replace the captured history", async t => {
  const w = fixture(t), fork = block("D".repeat(64)), next = block(fork.hash, "900");
  w.current = next; w.height = 11;
  w.blocks.set(fork.hash, { confirmed: "true", height: "10", contents: fork.block });
  w.blocks.set(next.hash, { confirmed: "true", height: "11", contents: next.block });
  await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_ANCESTRY_INVALID" });
  assert.equal(existsSync(w.options.destination), false);
});

test("two frozen peers cannot create an initial account floor below the live process", async t => {
  const w = fixture(t); w.height = 9;
  await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_HEAD_BEHIND_FLOOR" });
  assert.equal(existsSync(w.options.destination), false);
});

test("both the local unconfirmed head and its prior confirmed checkpoint must belong to the same chain", async t => {
  const w = fixture(t), health = read(w.healthFile);
  health.nanoRpc.checkpoint.confirmed = { hash: "F".repeat(64), blockCount: "9" }; json(w.healthFile, health);
  // The predecessor is unavailable; a correct high head alone is insufficient.
  await assert.rejects(preparePaymentMigration(w.options));
  assert.equal(existsSync(w.options.destination), false);
});

test("every app lock scope fences preparation before any RPC or destination creation", async t => {
  for (const resource of [w => `nano:${account}`, w => "near:mainnet:shop.near", w => `state:${w.out}`,
    w => `market:${w.market}`, w => `recovery:${join(w.options.destination, "recovery.sqlite")}`]) {
    const w = fixture(t), held = acquireWriterLocks({ dir: w.options.lockDir, resources: [resource(w)] });
    try { await assert.rejects(preparePaymentMigration(w.options), { code: "WRITER_BUSY" }); }
    finally { held.close(); }
    assert.equal(w.calls.length, 0); assert.equal(existsSync(w.options.destination), false);
  }
});

test("pending checkouts, unpaid obligations, active assignments and historical creator uncertainty refuse preparation", async t => {
  const changes = [
    w => { const n = read(w.files[0]); n.quotes[0].status = "pending"; json(w.files[0], n); },
    w => { const n = read(w.files[0]); n.quotes[0].settled = false; json(w.files[0], n); },
    w => { const n = read(w.files[1]); n.refunds.r = { paymentId: "q", status: "queued", amountYocto: "1", createdAt: NOW }; json(w.files[1], n); },
    w => { const n = read(w.files[1]); n.payouts.p = { paymentId: "q", status: "sent", to: account, amountRaw: "1", txHash: "E".repeat(64) }; json(w.files[1], n); },
    w => { const n = read(w.files[2]); n.assignments.done = { id: "done", phase: "running", budgetUsd: 1 }; json(w.files[2], n); },
  ];
  for (const change of changes) {
    const w = fixture(t); change(w);
    await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_NOT_QUIESCENT" });
    assert.equal(w.calls.length, 0); assert.equal(existsSync(w.options.destination), false);
  }
});

test("stale, busy, missing and wrong-wallet handoff reports cannot authorize a preparation", async t => {
  for (const change of [h => { h.checkedAt = new Date(NOW - 60_001).toISOString(); }, h => { h.activeRuns = 1; },
    h => { h.nanoRpc.checkpoint = null; }, h => { h.nanoRpc.checkpoint.account = NANO_GENESIS_REPLY.contents.account; },
    h => { h.nanoRpc.lastReadAt -= 60_001; }]) {
    const w = fixture(t), h = read(w.healthFile); change(h); json(w.healthFile, h);
    await assert.rejects(preparePaymentMigration(w.options));
    assert.equal(w.calls.length, 0); assert.equal(existsSync(w.options.destination), false);
  }
});

test("dormant profiles outside the pinned source set cannot be silently omitted", async t => {
  const w = fixture(t), extra = join(w.market, "disabled"); mkdirSync(extra, { mode: 0o700 });
  json(join(extra, "market-state.json"), { v: 1, assignments: {} });
  await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_SOURCE_SCOPE_MISMATCH" });
  assert.equal(w.calls.length, 0); assert.equal(existsSync(w.options.destination), false);
});

test("source changes and same-byte file replacement during reads prevent any journal creation", async t => {
  for (const replace of [false, true]) {
    const w = fixture(t); let changed = false;
    w.onRequest = body => { if (body.action !== "account_info" || changed) return; changed = true;
      if (replace) { const before = readFileSync(w.files[0]); renameSync(w.files[0], w.files[0] + ".old"); writeFileSync(w.files[0], before, { mode: 0o600 }); }
      else { const n = read(w.files[0]); n.updated = true; json(w.files[0], n); }
    };
    await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_SOURCE_CHANGED" });
    assert.equal(existsSync(w.options.destination), false);
  }
});

test("an existing artifact, unsafe source or expired observation is never overwritten or installed", async t => {
  const w = fixture(t); mkdirSync(w.options.destination, { mode: 0o700 });
  const sentinel = join(w.options.destination, "keep"); writeFileSync(sentinel, "KEEP");
  await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_DESTINATION_EXISTS" });
  assert.equal(readFileSync(sentinel, "utf8"), "KEEP"); assert.equal(w.calls.length, 0);
  rmSync(w.options.destination, { recursive: true }); chmodSync(w.files[0], 0o644);
  await assert.rejects(preparePaymentMigration(w.options), { code: "MIGRATION_SOURCE_UNSAFE" }); chmodSync(w.files[0], 0o600);
  w.onRequest = async () => { await new Promise(resolve => setTimeout(resolve, 15)); };
  await assert.rejects(preparePaymentMigration({ ...w.options, timeoutMs: 5 }));
  assert.equal(existsSync(w.options.destination), false); assert.equal(read(w.policyFile).v, 1);
});

test("the command-line error path reports only a fixed code, never private arguments", () => {
  const result = spawnSync(process.execPath, [new URL("../scripts/prepare-payment-migration.mjs", import.meta.url).pathname,
    "--policy", "/PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED", "--unknown", "PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED/);
  assert.match(result.stderr, /MIGRATION_ARGUMENT_INVALID/);
});
