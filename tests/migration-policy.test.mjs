import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createBlock, deriveAddress, derivePublicKey, hashBlock } from "nanocurrency";
import { openRecoveryStore } from "../src/payments/recovery-store.mjs";
import { validateMigrationReceipt, receiptDigest } from "../src/payments/migration-receipt.mjs";
import { verifyStartupState } from "../src/startup-state.mjs";
import { createNanoWallet } from "../src/wallet.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";

const secret = "1".repeat(64), account = deriveAddress(derivePublicKey(secret), { useNanoPrefix: true });
const other = deriveAddress(derivePublicKey("2".repeat(64)), { useNanoPrefix: true });
const initial = createBlock(secret, { previous: "A".repeat(64), representative: account, balance: "1000", link: "B".repeat(64), work: "0".repeat(16) });
initial.block.account = account;
const sources = [{ scope: "nano", sha256: "a".repeat(64) }];
function receipt() { return { v: 1, schema: 3, account, networkGenesis: NANO_GENESIS_HASH, createdAt: 1000, legacySha256: sources[0].sha256,
  sources, sourceSetSha256: createHash("sha256").update(JSON.stringify(sources)).digest("hex"),
  initialHead: { hash: initial.hash, blockCount: "10", balance: "1000", representative: account, block: initial.block } }; }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "migration-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "journal.sqlite") };
}
const emptyGate = () => ({ v: 3, quotes: [], owed: [], historyCursor: { marker: null, head: null, newest: null } });
function initialized(file, r = receipt()) {
  const store = openRecoveryStore(file); store.bindAccount(account, { requireHeight: true });
  store.save(`gate:${account}`, 0, emptyGate()); store.initializeMigration(r); store.close();
  return { account, legacySha256: r.legacySha256, receiptSha256: receiptDigest(r) };
}

test("migration receipts bind public identity, signed initial head and frozen source fingerprints without keys", () => {
  const r = receipt(), expected = { account, legacySha256: r.legacySha256, receiptSha256: receiptDigest(r) };
  assert.equal(validateMigrationReceipt(r, expected), r);
  for (const altered of [
    { ...r, account: other }, { ...r, legacySha256: "b".repeat(64) },
    { ...r, networkGenesis: "F".repeat(64) },
    { ...r, initialHead: { ...r.initialHead, balance: "999" } },
    { ...r, initialHead: { ...r.initialHead, block: { ...initial.block, signature: "0".repeat(128) } } },
  ]) assert.throws(() => validateMigrationReceipt(altered, expected), { code: "RECOVERY_MIGRATION_INVALID" });
  assert.throws(() => validateMigrationReceipt(r, { ...expected, scopes: ["nano", "market:missing"] }), { code: "RECOVERY_MIGRATION_INVALID" });
});

test("required journals cannot initialize a missing or empty file", t => {
  const f = fixture(t);
  assert.throws(() => openRecoveryStore(f.file, { requireExisting: true }));
  assert.equal(existsSync(f.file), false, "startup must not create a replacement financial history");
  writeFileSync(f.file, "", { mode: 0o600 });
  assert.throws(() => openRecoveryStore(f.file, { requireExisting: true }));
  assert.equal(readFileSync(f.file).length, 0);
});

test("a required migration rejects wrong-wallet state before SQLite mutates the file", t => {
  const f = fixture(t), store = openRecoveryStore(f.file); store.bindAccount(other, { requireHeight: true }); store.close();
  const before = readFileSync(f.file), r = receipt();
  assert.throws(() => openRecoveryStore(f.file, { requireExisting: true,
    migration: { account, legacySha256: r.legacySha256, receiptSha256: receiptDigest(r) } }), { code: "RECOVERY_MIGRATION_INVALID" });
  assert.deepEqual(readFileSync(f.file), before);
});

test("a qualified receipt survives required startup and cannot be overwritten by generic metadata", t => {
  const f = fixture(t), migration = initialized(f.file), store = openRecoveryStore(f.file, { requireExisting: true, migration });
  assert.equal(store.load(`migration:${account}`).data.initialHead.hash, initial.hash);
  assert.throws(() => store.save(`migration:${account}`, 1, receipt()), { code: "RECOVERY_MIGRATION_IMMUTABLE" });
  store.assertAvailable(); store.close();
});

test("migration cannot bless outstanding paid work or initialize after signing has begun", t => {
  const f = fixture(t), store = openRecoveryStore(f.file); store.bindAccount(account, { requireHeight: true });
  let revision = store.save(`gate:${account}`, 0, { ...emptyGate(), quotes: [{ id: "paid", status: "paid", amountRaw: "100" }] });
  assert.throws(() => store.initializeMigration(receipt()), { code: "RECOVERY_MIGRATION_NOT_QUIESCENT" });
  store.save(`gate:${account}`, revision, emptyGate());
  store.beginSend("already-started", { account, to: other, amountRaw: "100" });
  assert.throws(() => store.initializeMigration(receipt()), { code: "RECOVERY_MIGRATION_ALREADY_STARTED" }); store.close();
});

test("the immutable receipt cannot store prompts, keys or arbitrary provider fields", t => {
  const f = fixture(t), store = openRecoveryStore(f.file); store.bindAccount(account, { requireHeight: true });
  store.save(`gate:${account}`, 0, emptyGate());
  for (const value of [
    { ...receipt(), secretKey: "NEVER_STORE_THIS" },
    { ...receipt(), initialHead: { ...receipt().initialHead, prompt: "NEVER_STORE_THIS" } },
    { ...receipt(), initialHead: { ...receipt().initialHead, block: { ...initial.block, apiKey: "NEVER_STORE_THIS" } } },
    { ...receipt(), initialHead: { ...receipt().initialHead, block: { ...initial.block, work: "NEVER_STORE_THIS" } } },
    { ...receipt(), initialHead: { ...receipt().initialHead, block: { ...initial.block, link_as_account: "NEVER_STORE_THIS" } } },
  ]) assert.throws(() => store.initializeMigration(value), { code: "RECOVERY_MIGRATION_INVALID" });
  assert.equal(store.load(`migration:${account}`).data, null);
  store.initializeMigration(receipt()); store.close();
});

test("a removed/replaced live database cannot keep granting authority through an old file descriptor", t => {
  const f = fixture(t), migration = initialized(f.file), store = openRecoveryStore(f.file, { requireExisting: true, migration });
  renameSync(f.file, f.file + ".old");
  assert.throws(() => store.assertAvailable(), { code: "RECOVERY_FILE_UNSAFE" });
  writeFileSync(f.file, readFileSync(f.file + ".old"), { mode: 0o600 });
  assert.throws(() => store.assertAvailable(), { code: "RECOVERY_FILE_UNSAFE" });
  store.close();
});

test("V2 startup pins existing canonical authority, legacy bytes and independent monitoring", t => {
  const f = fixture(t), outDir = join(f.dir, "out"), policyFile = join(f.dir, "policy.json");
  mkdirSync(outDir, { mode: 0o700 });
  const legacy = Buffer.from(JSON.stringify({ v: 2, quotes: [], owed: [] }));
  const legacySha256 = createHash("sha256").update(legacy).digest("hex");
  writeFileSync(join(outDir, "gate-state.json"), legacy, { mode: 0o600 });
  const r = structuredClone(receipt()); r.legacySha256 = legacySha256; r.sources[0].sha256 = legacySha256;
  r.sourceSetSha256 = createHash("sha256").update(JSON.stringify(r.sources)).digest("hex");
  const migration = initialized(f.file, r);
  const policy = { v: 2, outDir, nanoAddress: account, chargeNano: true, near: null, marketRoot: null, marketHandles: [],
    recovery: { path: f.file, schema: 3, legacySha256, receiptSha256: migration.receiptSha256 } };
  writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  const options = { policyFile, outDir, nanoAddress: account, chargeNano: true, recoveryDb: f.file, requireRecoveryMonitoring: true };
  const checked = verifyStartupState(options);
  assert.deepEqual(checked.files, [join(outDir, "gate-state.json")]);
  assert.equal(checked.recovery.receiptSha256, migration.receiptSha256);
  for (const override of [{ recoveryDb: null }, { recoveryDb: f.file + ".other" }, { requireRecoveryMonitoring: false }]) {
    assert.throws(() => verifyStartupState({ ...options, ...override }), { code: "REQUIRED_STATE_UNAVAILABLE" });
  }
  writeFileSync(join(outDir, "gate-state.json"), JSON.stringify({ v: 2, quotes: [], owed: [], changed: true }));
  assert.throws(() => verifyStartupState(options), { code: "REQUIRED_STATE_UNAVAILABLE" });
  writeFileSync(join(outDir, "gate-state.json"), legacy);
  policy.chargeNano = false; writeFileSync(policyFile, JSON.stringify(policy));
  assert.deepEqual(verifyStartupState({ ...options, chargeNano: false }).files, [join(outDir, "gate-state.json")],
    "disabling Nano checkout cannot discard the canonical debt/import boundary");
});

test("the migration checkpoint prevents two frozen peers authorizing an initial fork, then resumes at the real head", async t => {
  const f = fixture(t), r = receipt();
  // A persisted, valid migration artifact; independent of the new initializer.
  const seed = openRecoveryStore(f.file); seed.bindAccount(account, { requireHeight: true });
  seed.save(`gate:${account}`, 0, emptyGate()); seed.close();
  const db = new DatabaseSync(f.file);
  db.prepare("INSERT INTO metadata VALUES(?,?,?)").run(`migration:${account}`, 1, JSON.stringify(r)); db.close();
  const migration = { account, legacySha256: r.legacySha256, receiptSha256: receiptDigest(r) };
  const store = openRecoveryStore(f.file, { requireExisting: true, migration });
  let height = 9, frontier = "A".repeat(64), balance = "1100", published = null, publishes = 0, work = 0;
  const wallet = createNanoWallet({ secretKey: secret, recoveryStore: store, verifyRpcReads: true, localWork: false,
    rpcUrl: "https://first.invalid,https://second.invalid", fetch: async (_url, init) => {
      const b = JSON.parse(init.body);
      if (b.action === "block_info" && b.hash === NANO_GENESIS_HASH) return Response.json(NANO_GENESIS_REPLY);
      if (b.action === "account_info") return Response.json(nanoAccountInfo({ height, frontier, balance, representative: account }));
      if (b.action === "work_generate") { work++; return Response.json({ work: "0".repeat(16) }); }
      if (b.action === "process") { publishes++; published = b.block; height++; frontier = hashBlock(b.block); balance = b.block.balance; return Response.json({ hash: frontier }); }
      if (b.action === "block_info" && published) return Response.json({ confirmed: "true", contents: published, amount: "100", height: String(height) });
      throw Error("unexpected migration fixture request");
    } });
  let failure;
  try { await wallet.ops.transferId("after-migration", other, "100"); } catch (error) { failure = error; }
  assert.equal(publishes, 0); assert.equal(work, 0);
  assert.ok(failure, "a first read behind the persisted migration floor must fail");
  height = 10; frontier = initial.hash; balance = "1000";
  await wallet.ops.transferId("after-migration", other, "100");
  assert.equal(publishes, 1); assert.equal(published.previous, initial.hash);
  assert.equal(store.load(`account-head:${account}`).data.blockCount, "11");
  store.close();
});
