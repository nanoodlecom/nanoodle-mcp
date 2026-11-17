/** Canonical Nano recovery metadata. No keys, prompts, outputs or provider error text. */
import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { validateMigrationReceipt } from "./migration-receipt.mjs";
import { nanoFundingLiabilities } from "../funding-liabilities.mjs";

export class RecoveryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.reconciliationRequired = true;
  }
}
const check = (ok, code) => {
  if (!ok) throw new RecoveryError(code);
};
const copy = (x) => JSON.parse(JSON.stringify(x));
const uint = (x) => typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x);
const hash = (x) => typeof x === "string" && /^[A-F0-9]{64}$/i.test(x);

export function openRecoveryStore(path, { fault = () => {}, requireExisting = false, migration = null } = {}) {
  check(typeof requireExisting === "boolean" && (!migration || requireExisting), "RECOVERY_MIGRATION_INVALID");
  if (!requireExisting) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (requireExisting) {
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(parent);
      check(st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077), "RECOVERY_FILE_UNSAFE");
    } finally { closeSync(parent); }
  }
  const fd = openSync(path, constants.O_RDWR | (requireExisting ? 0 : constants.O_CREAT) | constants.O_NOFOLLOW, 0o600);
  let identity;
  try {
    const st = fstatSync(fd);
    check(st.isFile() && st.nlink === 1 && st.uid === process.getuid() && !(st.mode & 0o077), "RECOVERY_FILE_UNSAFE");
    check(!requireExisting || st.size > 0, "RECOVERY_SCHEMA_UNSUPPORTED");
    identity = { dev: st.dev, ino: st.ino };
  } finally { closeSync(fd); }
  function assertFile() {
    try {
      const st = lstatSync(path);
      check(st.isFile() && st.dev === identity.dev && st.ino === identity.ino && st.nlink === 1
        && st.uid === process.getuid() && !(st.mode & 0o077), "RECOVERY_FILE_UNSAFE");
      if (requireExisting) {
        const parent = lstatSync(dirname(path));
        check(parent.isDirectory() && parent.uid === process.getuid() && !(parent.mode & 0o077), "RECOVERY_FILE_UNSAFE");
      }
    } catch { throw new RecoveryError("RECOVERY_FILE_UNSAFE"); }
  }
  const db = new DatabaseSync(path);
  try { assertFile(); } catch (error) { db.close(); throw error; }
  let closed = false,
    poisoned = false;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all();
  const expected = [
    "recovery_schema",
    "metadata",
    "sends",
    "active_send",
    "consumed_payment",
    "quote_amount",
    "wallet_identity",
  ];
  if (requireExisting && !tables.length) {
    db.close(); throw new RecoveryError("RECOVERY_SCHEMA_UNSUPPORTED");
  }
  if (
    tables.length &&
    (tables.filter((t) => !t.name.startsWith("sqlite_")).length !==
      expected.length ||
      !expected.every((name) => tables.some((t) => t.name === name)))
  ) {
    db.close();
    throw new RecoveryError("RECOVERY_SCHEMA_UNSUPPORTED");
  }
  if (tables.length) {
    const versions = db.prepare("SELECT version FROM recovery_schema").all();
    if (versions.length !== 1 || versions[0].version !== 3) {
      db.close();
      throw new RecoveryError("RECOVERY_SCHEMA_UNSUPPORTED");
    }
    if (JSON.stringify(db.prepare("PRAGMA table_info(wallet_identity)").all().map(r => r.name)) !== JSON.stringify(["singleton", "account", "height_proofs"])) {
      db.close(); throw new RecoveryError("RECOVERY_SCHEMA_UNSUPPORTED");
    }
  }
  function assertMigration() {
    if (!migration) return;
    try {
      const owner = db.prepare("SELECT account,height_proofs FROM wallet_identity WHERE singleton=1").get();
      if (owner?.account !== migration.account || owner.height_proofs !== 1) throw Error();
      const row = db.prepare("SELECT data FROM metadata WHERE scope=?").get(`migration:${migration.account}`);
      validateMigrationReceipt(row ? JSON.parse(row.data) : null, migration);
      const gate = db.prepare("SELECT data FROM metadata WHERE scope=?").get(`gate:${migration.account}`);
      const value = gate ? JSON.parse(gate.data) : null;
      if (value?.v !== 3 || !Array.isArray(value.quotes) || !Array.isArray(value.owed)
        || !value.historyCursor || typeof value.historyCursor !== "object" || Array.isArray(value.historyCursor)) throw Error();
    } catch { throw new RecoveryError("RECOVERY_MIGRATION_INVALID"); }
  }
  try { assertMigration(); } catch (error) { db.close(); throw error; }
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS recovery_schema (version INTEGER NOT NULL);
      INSERT INTO recovery_schema SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM recovery_schema);
      CREATE TABLE IF NOT EXISTS wallet_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account TEXT NOT NULL,
        height_proofs INTEGER NOT NULL CHECK(height_proofs IN (0,1)));
      CREATE TABLE IF NOT EXISTS metadata (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, account TEXT NOT NULL, binding TEXT NOT NULL,
        state TEXT NOT NULL, hash TEXT, block TEXT, previous_balance TEXT);
      CREATE TABLE IF NOT EXISTS active_send (account TEXT PRIMARY KEY, id TEXT, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS consumed_payment (hash TEXT PRIMARY KEY, quote_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quote_amount (bucket TEXT PRIMARY KEY, quote_id TEXT UNIQUE NOT NULL);
      COMMIT;`);
  } catch (e) {
    db.close();
    throw e;
  }
  const orphaned = db
    .prepare(
      `SELECT s.id FROM sends s LEFT JOIN active_send a
    ON a.account=s.account AND a.id=s.id
    WHERE s.state IN ('submitted','uncertain') AND a.id IS NULL LIMIT 1`,
    )
    .get();
  const invalidSlot = db
    .prepare(
      `SELECT a.account FROM active_send a LEFT JOIN sends s
    ON a.id=s.id AND a.account=s.account
    WHERE a.epoch<1 OR a.epoch>9007199254740991 OR typeof(a.epoch)!='integer'
      OR (a.id IS NOT NULL AND (s.id IS NULL OR s.state NOT IN ('intent','submitted','uncertain')))
    LIMIT 1`,
    )
    .get();
  if (orphaned || invalidSlot) {
    db.close();
    throw new RecoveryError("RECOVERY_ACCOUNT_STATE_INVALID");
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  function available() {
    check(!closed && !poisoned, "RECOVERY_STORE_UNAVAILABLE");
    assertFile();
  }
  function tx(fn, operation = "operation") {
    available();
    let committed = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      available();
      assertMigration();
      const value = fn();
      fault("before_commit", operation);
      db.exec("COMMIT");
      committed = true;
      fault("after_commit", operation);
      return value;
    } catch (e) {
      if (!committed) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
      if (!(e instanceof RecoveryError) || committed) poisoned = true;
      throw e instanceof RecoveryError && !committed
        ? e
        : new RecoveryError("RECOVERY_COMMIT_UNCERTAIN");
    }
  }
  const readSend = (id) => {
    const r = db.prepare("SELECT * FROM sends WHERE id=?").get(id);
    if (!r) return null;
    let binding, block;
    try { binding = JSON.parse(r.binding); block = r.block === null ? null : JSON.parse(r.block); }
    catch { throw new RecoveryError("RECOVERY_OPERATION_INVALID"); }
    check(binding && typeof binding === "object" && !Array.isArray(binding)
      && JSON.stringify(Object.keys(binding).sort()) === JSON.stringify(["account", "amountRaw", "to"])
      && binding.account === r.account && typeof binding.to === "string" && binding.to.length > 0
      && uint(binding.amountRaw) && BigInt(binding.amountRaw) > 0n
      && ["intent", "submitted", "uncertain", "completed"].includes(r.state), "RECOVERY_OPERATION_INVALID");
    check(r.state === "intent"
      ? r.hash === null && r.block === null && r.previous_balance === null
      : hash(r.hash) && r.hash === r.hash.toUpperCase() && uint(r.previous_balance)
        && block && typeof block === "object" && !Array.isArray(block), "RECOVERY_OPERATION_INVALID");
    return { id: r.id, ...binding, state: r.state, hash: r.hash, block, previousBalance: r.previous_balance };
  };
  function intent(id, binding) {
    check(
      typeof id === "string" && id.length > 0 && id.length <= 512,
      "SEND_ID_INVALID",
    );
    check(
      binding &&
        typeof binding.account === "string" &&
        typeof binding.to === "string" &&
        uint(binding.amountRaw) &&
        BigInt(binding.amountRaw) > 0n,
      "SEND_BINDING_INVALID",
    );
    const clean = {
      account: binding.account,
      to: binding.to,
      amountRaw: binding.amountRaw,
    };
    bindAccount(clean.account);
    const encoded = JSON.stringify(clean);
    const old = db.prepare("SELECT binding FROM sends WHERE id=?").get(id);
    check(!old || old.binding === encoded, "SEND_BINDING_CONFLICT");
    if (!old)
      db.prepare(
        "INSERT INTO sends(id,account,binding,state) VALUES(?,?,?,'intent')",
      ).run(id, clean.account, encoded);
    return readSend(id);
  }
  function bindAccount(account, { requireHeight = null } = {}) {
    check(typeof account === "string" && /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(account), "RECOVERY_ACCOUNT_INVALID");
    check(requireHeight === null || typeof requireHeight === "boolean", "RECOVERY_ACCOUNT_INVALID");
    const owner = db.prepare("SELECT account,height_proofs FROM wallet_identity WHERE singleton=1").get();
    if (owner) {
      check(owner.account === account, "RECOVERY_ACCOUNT_MISMATCH");
      check(!(owner.height_proofs === 1 && requireHeight === false), "RECOVERY_FRESHNESS_REQUIRED");
      if (owner.height_proofs === 0 && requireHeight === true) {
        check(!db.prepare("SELECT id FROM sends LIMIT 1").get(), "RECOVERY_FRESHNESS_UNQUALIFIED");
        db.prepare("UPDATE wallet_identity SET height_proofs=1 WHERE singleton=1").run();
      }
    }
    else {
      check(!db.prepare("SELECT id FROM sends LIMIT 1").get() && !db.prepare("SELECT hash FROM consumed_payment LIMIT 1").get(), "RECOVERY_ACCOUNT_STATE_INVALID");
      db.prepare("INSERT INTO wallet_identity VALUES(1,?,?)").run(account, requireHeight === true ? 1 : 0);
    }
  }
  function writeState(scope, revision, data) {
    const old = db
      .prepare("SELECT revision FROM metadata WHERE scope=?")
      .get(scope);
    check((old?.revision ?? 0) === revision, "RECOVERY_STATE_CONFLICT");
    const next = revision + 1;
    db.prepare(
      "INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data",
    ).run(scope, next, JSON.stringify(data));
    return next;
  }
  function activeSend(account) {
    available();
    const r = db.prepare("SELECT id,epoch FROM active_send WHERE account=?").get(account);
    if (!r?.id) return null;
    const operation = readSend(r.id);
    check(operation && operation.account === account && Number.isSafeInteger(r.epoch) && r.epoch > 0
      && ["intent", "submitted", "uncertain"].includes(operation.state), "RECOVERY_ACCOUNT_STATE_INVALID");
    return { ...operation, epoch: r.epoch };
  }
  return Object.freeze({
    assertAvailable() { available(); assertMigration(); },
    bindAccount(account, options) { return tx(() => bindAccount(account, options)); },
    load(scope) {
      available();
      const row = db
        .prepare("SELECT revision,data FROM metadata WHERE scope=?")
        .get(scope);
      return row
        ? { revision: row.revision, data: JSON.parse(row.data) }
        : { revision: 0, data: null };
    },
    save(
      scope,
      revision,
      data,
      { intents = [], payment = null, payments = [] } = {},
    ) {
      check(typeof scope === "string" && !scope.startsWith("migration:"), "RECOVERY_MIGRATION_IMMUTABLE");
      return tx(() => {
        for (const claim of [...payments, ...(payment ? [payment] : [])]) {
          check(
            hash(claim.hash) && typeof claim.quoteId === "string",
            "PAYMENT_PROOF_INVALID",
          );
          const h = claim.hash.toUpperCase();
          const old = db
            .prepare("SELECT quote_id FROM consumed_payment WHERE hash=?")
            .get(h);
          check(
            !old || old.quote_id === claim.quoteId,
            "PAYMENT_ALREADY_CONSUMED",
          );
          if (!old)
            db.prepare("INSERT INTO consumed_payment VALUES(?,?)").run(
              h,
              claim.quoteId,
            );
        }
        for (const i of intents) intent(i.id, i);
        return writeState(scope, revision, copy(data));
      }, "save");
    },
    paymentOwner(blockHash) {
      available();
      check(hash(blockHash), "PAYMENT_PROOF_INVALID");
      return (
        db
          .prepare("SELECT quote_id FROM consumed_payment WHERE hash=?")
          .get(blockHash.toUpperCase())?.quote_id ?? null
      );
    },
    reserveAmount(bucket, quoteId) {
      return tx(() => {
        check(
          uint(bucket) && typeof quoteId === "string",
          "QUOTE_AMOUNT_INVALID",
        );
        const old = db
          .prepare("SELECT quote_id FROM quote_amount WHERE bucket=?")
          .get(bucket);
        if (old) return old.quote_id === quoteId;
        db.prepare("INSERT INTO quote_amount VALUES(?,?)").run(bucket, quoteId);
        return true;
      });
    },
    getSend(id) {
      available();
      return readSend(id);
    },
    activeSend,
    status(account) {
      available();
      assertMigration();
      const owner = db.prepare("SELECT account,height_proofs FROM wallet_identity WHERE singleton=1").get();
      check(owner?.account === account, "RECOVERY_ACCOUNT_MISMATCH");
      check(!db.prepare(`SELECT s.id FROM sends s LEFT JOIN active_send a ON a.account=s.account AND a.id=s.id
        WHERE s.account!=? OR s.state NOT IN ('intent','submitted','uncertain','completed')
          OR (s.state IN ('submitted','uncertain') AND a.id IS NULL) LIMIT 1`).get(account), "RECOVERY_ACCOUNT_STATE_INVALID");
      const operation = activeSend(account);
      const row = db.prepare("SELECT data FROM metadata WHERE scope=?").get(`gate:${account}`);
      let data = null;
      try { if (row) data = JSON.parse(row.data); }
      catch { throw new RecoveryError("RECOVERY_GATE_INVALID"); }
      check(!row || data?.v === 3 && Array.isArray(data.quotes) && Array.isArray(data.owed), "RECOVERY_GATE_INVALID");
      const heldRuns = data?.quotes.filter(q => q.recoveryRequired && q.settled !== true).length ?? 0;
      const heldPayouts = data?.owed.filter(o => o.legacy || o.held || ["review_required", "legacy_uncertain"].includes(o.state)).length ?? 0;
      const activeOperations = operation ? 1 : 0;
      // Pure aggregate observation: no IDs, signed bytes, financial writes or
      // RPC calls. Fresh signing remains the wallet/ledger owners' authority.
      return { enforced: true, schema: 3, heightProtected: owner.height_proofs === 1,
        activeOperations, heldRuns, heldPayouts, queuedPayouts: data?.owed.length ?? 0,
        ready: activeOperations + heldRuns + heldPayouts === 0 };
    },
    beginSend(id, binding) {
      return tx(() => {
        const r = intent(id, binding);
        if (r.state === "completed") return r;
        const active = db
          .prepare("SELECT id,epoch FROM active_send WHERE account=?")
          .get(r.account);
        check(
          !active?.id || active.id === id,
          "WALLET_RECONCILIATION_REQUIRED",
        );
        if (active?.id === id) return { ...r, epoch: active.epoch };
        const epoch = (active?.epoch || 0) + 1;
        check(Number.isSafeInteger(epoch), "ACCOUNT_WRITER_EPOCH_INVALID");
        db.prepare(
          "INSERT INTO active_send VALUES(?,?,?) ON CONFLICT(account) DO UPDATE SET id=excluded.id,epoch=excluded.epoch",
        ).run(r.account, id, epoch);
        return { ...r, epoch };
      });
    },
    initializeMigration(receipt) {
      receipt = copy(receipt);
      validateMigrationReceipt(receipt, { account: receipt?.account });
      return tx(() => {
        const account = receipt.account, owner = db.prepare("SELECT account,height_proofs FROM wallet_identity WHERE singleton=1").get();
        check(owner?.account === account && owner.height_proofs === 1, "RECOVERY_MIGRATION_INVALID");
        check(!db.prepare("SELECT scope FROM metadata WHERE scope=?").get(`migration:${account}`)
          && !db.prepare("SELECT id FROM sends LIMIT 1").get(), "RECOVERY_MIGRATION_ALREADY_STARTED");
        const row = db.prepare("SELECT data FROM metadata WHERE scope=?").get(`gate:${account}`);
        const gate = row ? JSON.parse(row.data) : null;
        check(gate?.v === 3 && Array.isArray(gate.quotes) && Array.isArray(gate.owed) && gate.historyCursor
          && typeof gate.historyCursor === "object" && !Array.isArray(gate.historyCursor), "RECOVERY_MIGRATION_INVALID");
        let liabilities;
        try { liabilities = nanoFundingLiabilities(gate); } catch { throw new RecoveryError("RECOVERY_MIGRATION_INVALID"); }
        check(liabilities === 0n && gate.owed.length === 0, "RECOVERY_MIGRATION_NOT_QUIESCENT");
        return writeState(`migration:${account}`, 0, receipt);
      }, "initialize-migration");
    },
    submitted(id, { hash: h, block, previousBalance, epoch }) {
      return tx(() => {
        const r = readSend(id);
        check(r, "SEND_NOT_FOUND");
        if (r.state !== "intent") return { ...r, granted: false }; // another worker won
        const owner = db
          .prepare("SELECT id,epoch FROM active_send WHERE account=?")
          .get(r.account);
        check(
          owner?.id === id &&
            owner.epoch === epoch &&
            Number.isSafeInteger(epoch),
          "ACCOUNT_WRITER_FENCED",
        );
        check(hash(h) && block && uint(previousBalance), "SIGNED_SEND_INVALID");
        db.prepare(
          "UPDATE sends SET state='submitted',hash=?,block=?,previous_balance=? WHERE id=?",
        ).run(
          h.toUpperCase(),
          JSON.stringify(copy(block)),
          previousBalance,
          id,
        );
        return { ...readSend(id), granted: true };
      });
    },
    uncertain(id) {
      return tx(() => {
        check(readSend(id), "SEND_NOT_FOUND");
        db.prepare(
          "UPDATE sends SET state='uncertain' WHERE id=? AND state='submitted'",
        ).run(id);
        return readSend(id);
      });
    },
    complete(id, h, { height = null } = {}) {
      return tx(() => {
        const r = readSend(id);
        check(
          r && r.hash === h && r.state !== "intent",
          "SEND_RECEIPT_CONFLICT",
        );
        if (r.state === "completed") return r;
        const heightRequired = db.prepare("SELECT height_proofs FROM wallet_identity WHERE singleton=1").get()?.height_proofs === 1;
        check(height === null ? !heightRequired : typeof height === "string" && /^[1-9]\d{0,38}$/.test(height), "RECOVERY_CONFIRMATION_HEIGHT_REQUIRED");
        if (height !== null) {
          const scope = `account-head:${r.account}`;
          const row = db.prepare("SELECT revision,data FROM metadata WHERE scope=?").get(scope);
          const old = row ? JSON.parse(row.data) : null;
          const migrationRow = db.prepare("SELECT data FROM metadata WHERE scope=?").get(`migration:${r.account}`);
          const anchor = migrationRow ? validateMigrationReceipt(JSON.parse(migrationRow.data), { account: r.account }).initialHead : null;
          const floor = old && (!anchor || BigInt(old.blockCount) >= BigInt(anchor.blockCount)) ? old : anchor;
          check(!floor || (BigInt(height) >= BigInt(floor.blockCount)
            && (height !== floor.blockCount || floor.hash === h)), "RECOVERY_HEAD_REGRESSION");
          writeState(scope, row?.revision ?? 0, { operationId: id, hash: h, blockCount: height,
            balance: r.block.balance, representative: r.block.representative });
        }
        db.prepare("UPDATE sends SET state='completed' WHERE id=?").run(id);
        db.prepare(
          "UPDATE active_send SET id=NULL WHERE account=? AND id=?",
        ).run(r.account, id);
        return readSend(id);
      });
    },
    releaseUnsigned(id, epoch) {
      return tx(() => {
        const r = readSend(id);
        if (r?.state === "intent")
          db.prepare(
            "UPDATE active_send SET id=NULL WHERE account=? AND id=? AND epoch=?",
          ).run(r.account, id, epoch);
      });
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  });
}
