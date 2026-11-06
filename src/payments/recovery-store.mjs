/** Canonical Nano recovery metadata. No keys, prompts, outputs or provider error text. */
import { DatabaseSync } from "node:sqlite";
import { openSync, closeSync, mkdirSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";

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

export function openRecoveryStore(path, { fault = () => {} } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const db = new DatabaseSync(path);
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
  ];
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
    if (versions.length !== 1 || versions[0].version !== 1) {
      db.close();
      throw new RecoveryError("RECOVERY_SCHEMA_UNSUPPORTED");
    }
  }
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS recovery_schema (version INTEGER NOT NULL);
      INSERT INTO recovery_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM recovery_schema);
      CREATE TABLE IF NOT EXISTS metadata (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, account TEXT NOT NULL, binding TEXT NOT NULL,
        state TEXT NOT NULL, hash TEXT, block TEXT, previous_balance TEXT);
      CREATE TABLE IF NOT EXISTS active_send (account TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumed_payment (hash TEXT PRIMARY KEY, quote_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quote_amount (bucket TEXT PRIMARY KEY, quote_id TEXT UNIQUE NOT NULL);
      COMMIT;`);
  } catch (e) {
    db.close();
    throw e;
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  function available() {
    check(!closed && !poisoned, "RECOVERY_STORE_UNAVAILABLE");
  }
  function tx(fn, operation = "operation") {
    available();
    let committed = false;
    try {
      db.exec("BEGIN IMMEDIATE");
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
    return r
      ? {
          id: r.id,
          ...JSON.parse(r.binding),
          state: r.state,
          hash: r.hash,
          block: r.block ? JSON.parse(r.block) : null,
          previousBalance: r.previous_balance,
        }
      : null;
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
    const encoded = JSON.stringify(clean);
    const old = db.prepare("SELECT binding FROM sends WHERE id=?").get(id);
    check(!old || old.binding === encoded, "SEND_BINDING_CONFLICT");
    if (!old)
      db.prepare(
        "INSERT INTO sends(id,account,binding,state) VALUES(?,?,?,'intent')",
      ).run(id, clean.account, encoded);
    return readSend(id);
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
  return Object.freeze({
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
    activeSend(account) {
      available();
      const r = db
        .prepare("SELECT id FROM active_send WHERE account=?")
        .get(account);
      return r ? readSend(r.id) : null;
    },
    beginSend(id, binding) {
      return tx(() => {
        const r = intent(id, binding);
        if (r.state === "completed") return r;
        const active = db
          .prepare("SELECT id FROM active_send WHERE account=?")
          .get(r.account);
        check(!active || active.id === id, "WALLET_RECONCILIATION_REQUIRED");
        db.prepare("INSERT OR IGNORE INTO active_send VALUES(?,?)").run(
          r.account,
          id,
        );
        return r;
      });
    },
    submitted(id, { hash: h, block, previousBalance }) {
      return tx(() => {
        const r = readSend(id);
        check(r, "SEND_NOT_FOUND");
        if (r.state !== "intent") return { ...r, granted: false }; // another worker won
        check(
          db
            .prepare("SELECT id FROM active_send WHERE account=?")
            .get(r.account)?.id === id,
          "WALLET_RECONCILIATION_REQUIRED",
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
    complete(id, h) {
      return tx(() => {
        const r = readSend(id);
        check(
          r && r.hash === h && r.state !== "intent",
          "SEND_RECEIPT_CONFLICT",
        );
        db.prepare("UPDATE sends SET state='completed' WHERE id=?").run(id);
        db.prepare("DELETE FROM active_send WHERE account=? AND id=?").run(
          r.account,
          id,
        );
        return readSend(id);
      });
    },
    releaseUnsigned(id) {
      return tx(() => {
        const r = readSend(id);
        if (r?.state === "intent")
          db.prepare("DELETE FROM active_send WHERE account=? AND id=?").run(
            r.account,
            id,
          );
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
