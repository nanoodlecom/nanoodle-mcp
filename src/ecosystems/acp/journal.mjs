import { createHash, randomUUID } from 'node:crypto';
import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const copy = value => JSON.parse(JSON.stringify(value));
export function check(ok, code) { if (!ok) throw new Error(code); }
export const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
export const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
export const same = (a, b) => address(a) && address(b) && a.toLowerCase() === b.toLowerCase();
export const ZERO = '0x0000000000000000000000000000000000000000';

/** Job orchestration journal, not a payment balance or replacement settlement ledger.
 * Exclusive lifetime lock: a crash leaves it in place and requires operator review.
 * Each transition is fsynced BEFORE its external effect. A failed write poisons the
 * handle so no later effect can run against an uncommitted in-memory transition.
 */
export function openAcpJournal(path) {
  const lock = `${path}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  let closed = false, poisoned = false;
  let data;
  try {
    try { data = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') data = { version: 1, jobs: {} }; else throw e; }
    check(data.version === 1 && data.jobs && Object.getPrototypeOf(data.jobs) === Object.prototype, 'JOURNAL_INVALID');
  } catch (e) { closeSync(fd); unlinkSync(lock); throw new Error('JOURNAL_INVALID'); }
  function persist(next) {
    check(!closed && !poisoned, 'JOURNAL_UNAVAILABLE');
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify(next)); fsyncSync(out); } finally { closeSync(out); }
      renameSync(temp, path);
      const dir = openSync(dirname(path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
      data = next;
    } catch { poisoned = true; throw new Error('JOURNAL_UNAVAILABLE'); }
  }
  return Object.freeze({
    get(key) { check(!closed && !poisoned, 'JOURNAL_UNAVAILABLE'); return data.jobs[key] ? copy(data.jobs[key]) : null; },
    put(key, record) {
      check(/^[0-9]+:[0-9]+$/.test(key), 'JOURNAL_KEY_INVALID');
      const next = copy(data); next.jobs[key] = copy(record); persist(next);
      return copy(record);
    },
    close() { if (!closed) { closed = true; closeSync(fd); unlinkSync(lock); } },
  });
}
