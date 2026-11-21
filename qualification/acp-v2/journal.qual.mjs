import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAcpJournal } from '../../src/ecosystems/acp/journal.mjs';

function tempJournal(t) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'jobs.json');
}

test('journal roundtrip, copy isolation and key discipline', t => {
  const path = tempJournal(t);
  const j = openAcpJournal(path);
  assert.equal(j.get('8453:7'), null);
  const record = { state: 'ready', nested: { n: 1 } };
  const returned = j.put('8453:7', record);
  returned.nested.n = 99; record.nested.n = 55;
  assert.equal(j.get('8453:7').nested.n, 1);
  const got = j.get('8453:7'); got.nested.n = 42;
  assert.equal(j.get('8453:7').nested.n, 1);
  for (const bad of ['7', '8453:', ':7', '8453:7:9', 'abc:7', '8453:-1', ''])
    assert.throws(() => j.put(bad, {}), /JOURNAL_KEY_INVALID/);
  j.close();
});

test('journal close is idempotent, releases the lock, and data survives reopen', t => {
  const path = tempJournal(t);
  const j = openAcpJournal(path);
  j.put('8453:7', { state: 'submitted' });
  j.close(); j.close();
  assert.equal(existsSync(`${path}.lock`), false);
  assert.throws(() => j.get('8453:7'), /JOURNAL_UNAVAILABLE/);
  assert.throws(() => j.put('8453:7', {}), /JOURNAL_UNAVAILABLE/);
  const reopened = openAcpJournal(path);
  assert.equal(reopened.get('8453:7').state, 'submitted');
  reopened.close();
});

test('corrupt or wrong-version journal fails closed and does not strand the lock', t => {
  const path = tempJournal(t);
  writeFileSync(path, 'not json{');
  assert.throws(() => openAcpJournal(path), /JOURNAL_INVALID/);
  assert.equal(existsSync(`${path}.lock`), false);
  writeFileSync(path, JSON.stringify({ version: 2, jobs: {} }));
  assert.throws(() => openAcpJournal(path), /JOURNAL_INVALID/);
  assert.equal(existsSync(`${path}.lock`), false);
  writeFileSync(path, JSON.stringify({ version: 1, jobs: [] }));
  assert.throws(() => openAcpJournal(path), /JOURNAL_INVALID/);
  assert.equal(existsSync(`${path}.lock`), false);
});
