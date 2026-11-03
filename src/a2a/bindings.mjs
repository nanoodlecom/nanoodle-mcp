import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { chmodSync } from 'node:fs';

export function offline(mode) {
  if (mode !== 'offline-fixture' || process.env.NODE_ENV === 'production') throw new Error('A2A_OFFLINE_ONLY');
}
export function check(ok) { if (!ok) throw new Error('A2A_INVALID_CONTRACT'); }
export function stable(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { check(Number.isFinite(v)); return JSON.stringify(v); }
  check(v && typeof v === 'object');
  check(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);
  return Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}
export const hash = v => createHash('sha256').update(stable(v)).digest('hex');
export const copy = v => JSON.parse(JSON.stringify(v));
export const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);

/** Orchestration IDs only: no balances, amounts, payment proofs, inputs or outputs.
 * One facade process per database. Keep the DB until its canonical quotes/jobs
 * have expired; deleting it removes the message-id replay guarantee.
 */
export function openA2ABindings({ mode, path, maxTasks = 10000, maxMessages = 100000 }) {
  offline(mode); check(isAbsolute(path));
  check(Number.isSafeInteger(maxTasks) && maxTasks > 0 && Number.isSafeInteger(maxMessages) && maxMessages > 0);
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS a2a_tasks (id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS a2a_messages (scope TEXT NOT NULL, id TEXT NOT NULL, task TEXT NOT NULL,
      binding TEXT NOT NULL, PRIMARY KEY(scope,id));`);
  const get = id => {
    const r = db.prepare('SELECT data FROM a2a_tasks WHERE id=?').get(id);
    return r ? JSON.parse(r.data) : null;
  };
  return Object.freeze({
    get,
    message(scope, id) { return db.prepare('SELECT task,binding FROM a2a_messages WHERE scope=? AND id=?').get(scope, id); },
    claim(record, messageId, binding) {
      offline(mode);
      db.exec('BEGIN IMMEDIATE');
      try {
        check(!this.message(record.scope, messageId));
        check(db.prepare('SELECT count(*) AS n FROM a2a_messages').get().n < maxMessages);
        if (!get(record.id)) {
          check(db.prepare('SELECT count(*) AS n FROM a2a_tasks').get().n < maxTasks);
          db.prepare('INSERT INTO a2a_tasks VALUES (?,?,?)').run(record.id, record.scope, JSON.stringify(record));
        }
        db.prepare('INSERT INTO a2a_messages VALUES (?,?,?,?)').run(record.scope, messageId, record.id, binding);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    transition(id, from, patch) {
      offline(mode);
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = get(id);
        const changed = r && from.includes(r.phase);
        if (changed) {
          // Caller cannot change immutable IDs/bindings via this method.
          check(Object.keys(patch).every(k => ['phase', 'quoteId', 'receipt', 'reason'].includes(k)));
          db.prepare('UPDATE a2a_tasks SET data=? WHERE id=?').run(JSON.stringify({ ...r, ...patch }), id);
        }
        db.exec('COMMIT'); return !!changed;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  });
}
