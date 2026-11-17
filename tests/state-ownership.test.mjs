import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireWriterLocks, canonicalStatePath, defaultWriterLockDir } from '../src/process-lock.mjs';
import { verifyStartupState } from '../src/startup-state.mjs';
import { openNearLedger } from '../src/near/ledger.mjs';
import { openMarketState } from '../src/market/state.mjs';
import { createChargeGate } from '../src/gate.mjs';
import { createHostedFundingSources } from '../src/hosted-funding.mjs';
import { createNanoWallet, resolveWalletKey } from '../src/wallet.mjs';

const linux = { skip: process.platform !== 'linux' };
const lockModule = new URL('../src/process-lock.mjs', import.meta.url).href;
const bin = fileURLToPath(new URL('../bin/nanoodle-mcp.mjs', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'nanoodle-ownership-'));
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

function fixture() {
  const root = temp(), out = join(root, 'out'), market = join(root, 'market');
  mkdirSync(out); mkdirSync(join(market, 'demo'), { recursive: true });
  const policyFile = join(root, 'policy.json');
  const policy = { v: 1, outDir: out, nanoAddress: null, chargeNano: true,
    near: { merchant: 'shop.testnet', network: 'testnet' }, marketRoot: market, marketHandles: ['demo'] };
  const files = [join(out, 'gate-state.json'), join(out, 'near-state.json'), join(market, 'demo', 'market-state.json')];
  json(files[0], { v: 2, quotes: [], owed: [] });
  json(files[1], { v: 1, ...policy.near, quotes: {}, consumedTx: {}, refunds: {}, payouts: {}, meta: {} });
  json(files[2], { v: 1, assignments: {} }); json(policyFile, policy);
  const config = { policyFile, outDir: out, nanoAddress: null, chargeNano: true,
    nearMerchant: 'shop.testnet', nearNetwork: 'testnet', marketRoot: market, marketHandles: ['demo'] };
  return { root, out, market, policyFile, policy, files, config, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function tryLock(dir, resources) {
  const code = `import { acquireWriterLocks } from ${JSON.stringify(lockModule)};
    try { const l=acquireWriterLocks(${JSON.stringify({ dir, resources })}); l.close(); }
    catch(e) { process.stderr.write(e.code || e.message); process.exit(e.code==='WRITER_BUSY'?75:1); }`;
  try { execFileSync(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' }); return 0; }
  catch (e) { return e.status; }
}

test('Linux locks survive helper exit, conflict across processes and release without unlinking', linux, () => {
  const dir = temp(); let held;
  try {
    held = acquireWriterLocks({ dir, resources: ['nano:one', 'state:one'] });
    assert.equal(tryLock(dir, ['nano:one']), 75);
    assert.equal(tryLock(dir, ['nano:two']), 0);
    assert.throws(() => acquireWriterLocks({ dir, resources: ['nano:one'] }), { code: 'WRITER_BUSY' });
    const files = held.count; assert.equal(files, 2);
    held.close(); assert.equal(tryLock(dir, ['nano:one']), 0);
    assert.ok(existsSync(join(dir, createHash('sha256').update('nano:one').digest('hex') + '.lock')));
  } finally { held?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('partial lock acquisition releases only the failed contender; a stopped live holder stays fenced and SIGKILL releases', linux, async () => {
  const dir = temp();
  const code = `import {acquireWriterLocks} from ${JSON.stringify(lockModule)};
    acquireWriterLocks(${JSON.stringify({ dir, resources: ['b'] })}); process.send('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await once(child, 'message'); child.kill('SIGSTOP');
    assert.equal(tryLock(dir, ['a', 'b']), 75);
    assert.equal(tryLock(dir, ['a']), 0, 'failed multi-lock attempt must release a');
    assert.equal(tryLock(dir, ['b']), 75, 'paused writer retains b');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(tryLock(dir, ['b']), 0, 'kernel releases the killed owner without deleting files');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('unsafe lock permissions and symlinks refuse ownership; canonical paths resolve existing ancestor aliases', linux, () => {
  const root = temp();
  try {
    const dir = join(root, 'locks'); mkdirSync(dir, { mode: 0o777 }); chmodSync(dir, 0o777);
    assert.throws(() => acquireWriterLocks({ dir, resources: ['a'] }), /0700/);
    chmodSync(dir, 0o700);
    const target = join(root, 'other'); writeFileSync(target, 'preserve', { mode: 0o600 });
    symlinkSync(target, join(dir, createHash('sha256').update('a').digest('hex') + '.lock'));
    assert.throws(() => acquireWriterLocks({ dir, resources: ['a'] }));
    assert.equal(readFileSync(target, 'utf8'), 'preserve');
    symlinkSync(dir, join(root, 'alias'));
    assert.equal(canonicalStatePath(join(root, 'alias', 'not-created')), join(dir, 'not-created'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('required state validates the complete existing set without modifying it', linux, () => {
  const f = fixture();
  try {
    const before = f.files.map(p => readFileSync(p, 'utf8'));
    assert.deepEqual(verifyStartupState(f.config).files, f.files);
    assert.deepEqual(f.files.map(p => readFileSync(p, 'utf8')), before);
    assert.equal(verifyStartupState({}), null);
  } finally { f.clean(); }
});

for (const index of [0, 1, 2]) test(`missing required ledger ${index} refuses an empty restart`, linux, () => {
  const f = fixture();
  try { unlinkSync(f.files[index]); assert.throws(() => verifyStartupState(f.config), { code: 'REQUIRED_STATE_UNAVAILABLE' }); assert.equal(existsSync(f.files[index]), false); }
  finally { f.clean(); }
});

for (const [label, change] of [
  ['unknown policy version', p => { p.v = 2; }],
  ['policy typo', p => { p.ignoreMissing = true; }],
  ['different Nano identity', p => { p.nanoAddress = 'nano_changed'; }],
  ['different NEAR identity', p => { p.near.merchant = 'different.testnet'; }],
  ['different output root', p => { p.outDir += '-wrong'; }],
  ['missing configured profile', p => { p.marketHandles = []; }],
  ['extra profile', p => { p.marketHandles.push('new'); }],
  ['traversal profile', p => { p.marketHandles = ['../demo']; }],
]) test(`required state rejects ${label}`, linux, () => {
  const f = fixture();
  try { change(f.policy); json(f.policyFile, f.policy); assert.throws(() => verifyStartupState(f.config), { code: 'REQUIRED_STATE_UNAVAILABLE' }); }
  finally { f.clean(); }
});

test('unknown ledger schemas, malformed JSON and writable policy fail closed', linux, () => {
  const f = fixture();
  try {
    for (const file of f.files) {
      const before = readFileSync(file); json(file, { v: 999 });
      assert.throws(() => verifyStartupState(f.config), { code: 'REQUIRED_STATE_UNAVAILABLE' }); writeFileSync(file, before);
    }
    writeFileSync(f.files[2], '{'); assert.throws(() => verifyStartupState(f.config), { code: 'REQUIRED_STATE_UNAVAILABLE' });
    chmodSync(f.policyFile, 0o666); assert.throws(() => verifyStartupState(f.config), { code: 'REQUIRED_STATE_UNAVAILABLE' });
  } finally { f.clean(); }
});

test('actual ledger owners refuse ENOENT after preflight instead of creating new state', linux, () => {
  const root = temp();
  try {
    assert.throws(() => openNearLedger({ file: join(root, 'near-state.json'), network: 'testnet', merchant: 'shop.testnet', requireExisting: true }), /refusing to start empty/);
    assert.throws(() => openMarketState({ dir: root, requireExisting: true }), /refusing to start empty/);
    assert.equal(existsSync(join(root, 'worker.lock')), false, 'failed open must not strand the Market lock');
    assert.throws(() => createChargeGate({ address: 'test', ops: {}, usd: 1, stateFile: join(root, 'gate-state.json'), requireExistingState: true }), /refusing to accept payments/);
    assert.equal(existsSync(join(root, 'gate-state.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('funding fallback retains missing required profiles, including a deleted whole directory', linux, () => {
  const f = fixture();
  try {
    const sources = createHostedFundingSources({ nanoFile: f.files[0], nearFile: f.files[1], marketRoot: f.market });
    sources.requireFiles(f.files); assert.equal(sources.liabilitiesRaw(), 0n);
    rmSync(join(f.market, 'demo'), { recursive: true });
    assert.throws(() => sources.liabilitiesRaw(), /funding-state-missing/);
  } finally { f.clean(); }
});

test('CLI refuses a competing Nano wallet even with another output directory before RPC/PoW or tool loading', linux, async () => {
  const root = temp(); let held;
  try {
    const wallet = createNanoWallet({ secretKey: resolveWalletKey({ seed: '0'.repeat(64) }) });
    const lockDir = join(root, 'nanoodle-mcp', 'writer-locks');
    held = acquireWriterLocks({ dir: lockDir, resources: [`nano:${wallet.address}`] });
    for (const args of [[], ['--serve', '0', '--charge-usd', '0.05'], ['--recovery-db', join(root, 'journal.sqlite')]]) {
      const child = spawn(process.execPath, [bin, '--graphs', join(root, 'missing-graphs'), '--out', join(root, 'other-out'), ...args], {
        env: { PATH: process.env.PATH, HOME: root, NANOODLE_WRITER_LOCK_DIR: lockDir, NANO_SEED: '0'.repeat(64), NANO_RPC_URL: 'http://127.0.0.1:1', NANO_WORK_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = ''; child.stderr.on('data', c => { stderr += c; });
      const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.match(stderr, /Another payment writer/);
      assert.doesNotMatch(stderr, /fetch|graphs.*not found|work prewarm/);
      assert.equal(existsSync(join(root, 'other-out')), false);
      assert.equal(existsSync(join(root, 'journal.sqlite')), false, 'contender cannot open/create a journal before locking');
    }
  } finally { held?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('CLI missing production state exits before graph loading or NEAR network startup', linux, async () => {
  const f = fixture();
  try {
    f.policy.nanoAddress = null; f.policy.chargeNano = false; f.policy.marketRoot = null; f.policy.marketHandles = [];
    json(f.policyFile, f.policy); unlinkSync(f.files[1]);
    const child = spawn(process.execPath, [bin, '--graphs', join(f.root, 'missing-graphs'), '--out', f.out, '--serve', '0', '--near-merchant', 'shop.testnet', '--near-network', 'testnet'], {
      env: { PATH: process.env.PATH, HOME: f.root, NANOODLE_WRITER_LOCK_DIR: join(f.root, "writer-locks"), NANOGPT_API_KEY: 'fixture-only', NANOODLE_STATE_POLICY: f.policyFile, NEAR_RPC_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', c => { stderr += c; });
    const [code] = await once(child, 'exit'); assert.equal(code, 1); assert.match(stderr, /Required payment state/);
    assert.doesNotMatch(stderr, /NEAR refund key|cannot reach|graphs.*not found/);
    assert.equal(existsSync(f.files[1]), false);
  } finally { f.clean(); }
});

test('removed/replaced kernel lock stops subsequent wallet operations before any RPC or signature', linux, async () => {
  const dir = temp(); let held, requests = 0;
  try {
    held = acquireWriterLocks({ dir, resources: ['one'] }); held.assertHeld();
    const wallet = createNanoWallet({ secretKey: resolveWalletKey({ seed: '0'.repeat(64) }), assertWriter: held.assertHeld,
      fetch: async () => { requests++; throw Error('should not fetch'); } });
    const file = join(dir, createHash('sha256').update('one').digest('hex') + '.lock');
    unlinkSync(file); writeFileSync(file, '', { mode: 0o600 });
    assert.throws(held.assertHeld, { code: 'WRITER_LOCK_LOST' });
    await assert.rejects(wallet.ops.transferOnce(wallet.address, 1n), { code: 'WRITER_LOCK_LOST' });
    assert.equal(requests, 0); held.close(); assert.throws(held.assertHeld, { code: 'WRITER_LOCK_LOST' });
  } finally { held?.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('default namespace uses the OS account rather than HOME/XDG and explicit overrides must be absolute', linux, () => {
  assert.equal(defaultWriterLockDir({ HOME: '/different', XDG_STATE_HOME: '/different' }), defaultWriterLockDir({}));
  assert.throws(() => defaultWriterLockDir({ NANOODLE_WRITER_LOCK_DIR: 'relative' }), /absolute/);
});
