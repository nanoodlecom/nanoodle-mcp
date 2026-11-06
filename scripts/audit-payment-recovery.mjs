/** Offline evidence for remaining recovery gaps. Never imports or creates a wallet. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChargeGate, hashArgs } from '../src/gate.mjs';
const address = 'nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet';
const source = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const params = { name: 'poster', arguments: {} };
const registry = (callTool) => ({ tools: [{ name: 'poster' }],
  listTools: () => [{ name: 'poster', description: 'fixture', inputSchema: {} }], callTool });
const result = () => ({ content: [{ type: 'text', text: 'fixture' }], textOutput: true, costUsd: 0.02 });
const options = { address, usd: 0.05, xnoUsd: 1, publicBase: 'http://fixture.invalid', pollMs: 5 };
const quote = (extra = {}) => ({ id: 'pay_fixture', tool: 'poster', argsHash: hashArgs('poster', {}),
  amountRaw: String(5n * 10n ** 28n), usd: 0.05, pair: { usdNano: '1000000000', raw: String(10n ** 30n) },
  source, status: 'paid', createdAt: Date.now(), expiresAt: Date.now() + 900_000, ...extra });
const retry = { ...params, arguments: { _payment_id: 'pay_fixture' } };
async function until(fn) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch { /* write in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('offline probe timed out');
}
const dir = await mkdtemp(join(tmpdir(), 'mcp-recovery-probes-'));
try {
  const stateFile = join(dir, 'settlement.json');
  await writeFile(stateFile, JSON.stringify({ v: 2, quotes: [quote()], owed: [] }));
  let firstSends = 0, restoredSends = 0;
  const gate = createChargeGate({ ...options, stateFile, ops: {
    rpc: async () => ({}), transfer: () => { firstSends++; return new Promise(() => {}); },
  } });
  await gate.wrapRegistry(registry(result)).callTool(retry);
  const saved = await until(async () => {
    const data = JSON.parse(await readFile(stateFile, 'utf8'));
    return data.quotes[0].settled && data;
  });
  assert.equal(firstSends, 1);
  assert.deepEqual(saved.owed, []);
  const restored = createChargeGate({ ...options, stateFile, ops: {
    rpc: async () => ({}), transfer: async () => { restoredSends++; return 'F'.repeat(64); },
  } });
  await restored.wrapRegistry(registry(result)).callTool(retry);
  assert.equal(restoredSends, 0);
  console.log(JSON.stringify({ gap: 'inflight_change_not_durable', firstSends, persistedOwed: saved.owed.length, restoredSends }));

  let time = Date.now(), acceptedSends = 0;
  const secondFile = join(dir, 'ambiguous.json');
  await writeFile(secondFile, JSON.stringify({ v: 2, quotes: [quote()], owed: [] }));
  const ambiguous = createChargeGate({ ...options, stateFile: secondFile, now: () => time, ops: {
    rpc: async () => ({}), transfer: async () => {
      acceptedSends++;
      if (acceptedSends === 1) throw new Error('fixture: accepted send, response and reconciliation unavailable');
      return 'F'.repeat(64);
    },
  } });
  await ambiguous.wrapRegistry(registry(async () => { throw new Error('fixture provider failed'); })).callTool(retry);
  time += 31_000;
  await until(() => acceptedSends === 2);
  console.log(JSON.stringify({ gap: 'ambiguous_send_retried_as_new_transfer', acceptedSends }));

  const thirdFile = join(dir, 'history.json');
  await writeFile(thirdFile, JSON.stringify({ v: 2, quotes: [quote({ status: 'pending', source: null })], owed: [] }));
  const history = Array.from({ length: 150 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'), type: 'receive',
    amount: i === 149 ? quote().amountRaw : '1', account: source }));
  let pages = 0;
  const deep = createChargeGate({ ...options, stateFile: thirdFile, ops: {
    rpc: async (body) => {
      if (body.action !== 'account_history') return {};
      pages++;
      const at = body.head ? history.findIndex((e) => e.hash === body.head) : 0;
      return { history: history.slice(at, at + 100), ...(at + 100 < history.length ? { previous: history[at + 100].hash } : {}) };
    }, transfer: async () => { throw new Error('no transfers in history probe'); },
  } });
  await until(() => pages >= 3);
  assert.equal(deep.quote('pay_fixture').status, 'pending');
  console.log(JSON.stringify({ gap: 'restart_seeds_only_first_history_page', historyEntries: history.length, pages, status: deep.quote('pay_fixture').status }));
} finally {
  // The last probe has an unref'ed watcher. It owns no real resources or data.
  // Leave it idle until process exit, and wait for queued fixture writes first.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await rm(dir, { recursive: true, force: true });
}
