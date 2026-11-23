import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, cpSync, existsSync, readdirSync, lstatSync, symlinkSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { deriveAddress, derivePublicKey, deriveSecretKey } from 'nanocurrency';
import { createMaintenanceBarrier, maintenanceConfig } from '../src/maintenance.mjs';
import { maintenanceProcessIdentity } from '../src/maintenance-report.mjs';
import { qualifyStartupPermit } from '../src/startup-permit.mjs';
import { openNearLedger } from '../src/near/ledger.mjs';
import { createFakeChain, throwawayNearKey, nanoGptMock } from './fixtures/near-fake-chain.mjs';
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from './fixtures/nano-protocol.mjs';

const revision = 'b'.repeat(40), tree = 'c'.repeat(64), request = { v: 1, token: 'a'.repeat(32), operation: 'deploy', revision };
const json = (file, value, mode = 0o600) => writeFileSync(file, JSON.stringify(value), { mode });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, nodeVersion = '22.23.5') {
  const root = mkdtempSync(join(tmpdir(), 'startup-permit-')), release = join(root, 'release'), file = join(root, 'control.json'), startupFile = join(root, 'startup.json');
  mkdirSync(release);
  const manifest = { v: 1, revision, repository: 'https://github.com/nanoodlecom/nanoodle-mcp.git', node: nodeVersion,
    ci: { v: 1, repository: 'nanoodlecom/nanoodle-mcp', revision, workflow: '.github/workflows/test.yml', runId: 12, attempt: 1 },
    sourceTree: 'd'.repeat(64), tree, files: 1, installScripts: false, devDependencies: false };
  json(join(release, '.nanoodle-release.json'), manifest, 0o444); chmodSync(release, 0o555);
  json(file, request);
  const grant = () => ({ v: 1, request, process: maintenanceProcessIdentity(), release: { path: release, revision, tree } });
  const barrier = () => createMaintenanceBarrier({ file, startupFile, releaseRoot: release, ownerUid: process.getuid() });
  const cleanup = [];
  t.after(async () => { for (const action of cleanup.reverse()) await action(); unseal(release); rmSync(root, { recursive: true, force: true }); });
  return { cleanup, root, release, file, startupFile, manifest, grant, barrier, put: value => json(startupFile, value ?? grant()) };
}

test('only a grant for this kernel process, operator request and sealed release permits paused initialization', async t => {
  const w = fixture(t); w.put();
  const barrier = w.barrier(); let initialized = false;
  await barrier.start(async () => {
    initialized = true;
    assert.equal(barrier.accepting(), false);
    barrier.assertAdmitted();
    assert.equal(await barrier.run(async () => 'recorded refund', 'wallet'), 'recorded refund');
    await assert.rejects(barrier.run(() => assert.fail('New workflow'), 'request'), { code: 'SERVICE_DRAINING' });
    await assert.rejects(barrier.run(() => assert.fail('New payment scan'), 'background'), { code: 'SERVICE_DRAINING' });
    await barrier.recover(() => barrier.run(async () => 'recover recorded obligations', 'background'));
  });
  assert.equal(initialized, true); assert.equal(barrier.snapshot().activeOperations, 0);
  await assert.rejects(barrier.run(() => assert.fail('Still paused')), { code: 'SERVICE_DRAINING' });
  await assert.rejects(barrier.recover(() => assert.fail('No startup capability')), { code: 'MAINTENANCE_RECOVERY_UNAVAILABLE' });
  assert.equal(readFileSync(w.file, 'utf8'), JSON.stringify(request));
});

test('old PID reuse identity, wrong request/release, malformed grants and writable artifacts cannot initialize', async t => {
  const w = fixture(t);
  const edits = [g => { g.process.pid++; }, g => { g.process.startTicks = String(BigInt(g.process.startTicks) + 1n); },
    g => { g.process.bootId = '00000000-0000-0000-0000-000000000000'; }, g => { g.process.uid++; },
    g => { g.request = { ...g.request, token: 'e'.repeat(32) }; }, g => { g.release.path += '-other'; },
    g => { g.release.revision = 'e'.repeat(40); }, g => { g.release.tree = 'e'.repeat(64); },
    g => { g.v = 2; }, g => { g.private = 'DO_NOT_LEAK'; }];
  for (const edit of edits) {
    const grant = w.grant(); edit(grant); w.put(grant);
    await assert.rejects(w.barrier().start(() => assert.fail('Invalid grant initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  }
  w.put(); chmodSync(w.startupFile, 0o666);
  await assert.rejects(w.barrier().start(() => assert.fail('Writable grant initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  chmodSync(w.startupFile, 0o600); chmodSync(w.release, 0o755);
  await assert.rejects(w.barrier().start(() => assert.fail('Unsealed release initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  chmodSync(w.release, 0o555); chmodSync(join(w.release, '.nanoodle-release.json'), 0o644);
  await assert.rejects(w.barrier().start(() => assert.fail('Writable manifest initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
});

test('startup accepts the previous sealed runtime and refuses an unqualified runtime', async t => {
  const legacy = fixture(t, '22.23.4'); legacy.put();
  await legacy.barrier().start(() => assert.equal(legacy.barrier().accepting(), false));
  const unknown = fixture(t, '22.23.3'); unknown.put();
  await assert.rejects(unknown.barrier().start(() => assert.fail('Unqualified runtime initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
});

test('special/link permit files fail promptly and disclose no private payload', async t => {
  const w = fixture(t); w.put(); linkSync(w.startupFile, w.startupFile + '.hard');
  assert.equal(qualifyStartupPermit({ file: w.startupFile, ownerUid: process.getuid(), request, releaseRoot: w.release }).status, 'unavailable');
  rmSync(w.startupFile); symlinkSync(w.startupFile + '.hard', w.startupFile);
  const failure = await w.barrier().start(() => assert.fail('Symlink grant initialized')).catch(e => e);
  assert.equal(failure.code, 'MAINTENANCE_STARTUP_UNAVAILABLE');
  assert.doesNotMatch(failure.message, /DO_NOT_LEAK|hard|startup.json/);
});

test('waiting does no initialization; a changed/removed flag or deadline never opens the gate', async t => {
  const w = fixture(t), waiting = deferred(); let initialized = 0;
  const startup = w.barrier().start(() => { initialized++; }, { pollMs: 2, timeoutMs: 1000, onWait: waiting.resolve });
  await waiting.promise; assert.equal(initialized, 0); rmSync(w.file);
  await assert.rejects(startup, { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  json(w.file, request);
  const replaced = deferred();
  const waitingOnOldFlag = w.barrier().start(() => { initialized++; }, { pollMs: 2, timeoutMs: 1000, onWait: replaced.resolve });
  await replaced.promise; json(w.file + '.replacement', request); renameSync(w.file + '.replacement', w.file);
  await assert.rejects(waitingOnOldFlag, { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  await assert.rejects(w.barrier().start(() => { initialized++; }, { pollMs: 2, timeoutMs: 8 }), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  assert.equal(initialized, 0);
});

test('callbacks registered during authorized startup cannot borrow recovery permission', async t => {
  const w = fixture(t); w.put(); const barrier = w.barrier(), ready = deferred(), finish = deferred(), later = deferred(); let detached;
  const startup = barrier.start(async () => {
    detached = later.promise.then(() => barrier.run(() => assert.fail('Background callback borrowed startup'), 'background'));
    ready.resolve(); await finish.promise;
  });
  await ready.promise; later.resolve();
  await assert.rejects(detached, { code: 'SERVICE_DRAINING' });
  assert.equal(barrier.snapshot().counts.background, 1);
  finish.resolve(); await startup;
  rmSync(w.startupFile); rmSync(w.file);
  assert.equal(await barrier.run(async () => 'explicitly reopened'), 'explicitly reopened');
});

test('an orphan permit, missing startup configuration or duplicate startup is never an implicit resume', async t => {
  const w = fixture(t); w.put(); rmSync(w.file);
  await assert.rejects(w.barrier().start(() => assert.fail('Orphan grant initialized')), { code: 'MAINTENANCE_STARTUP_UNAVAILABLE' });
  json(w.file, request);
  const legacy = createMaintenanceBarrier({ file: w.file, ownerUid: process.getuid() });
  await assert.rejects(legacy.start(() => assert.fail('Default startup accepted a retained flag')), { code: 'SERVICE_DRAINING' });
  const barrier = w.barrier(); await barrier.start(async () => {});
  await assert.rejects(barrier.start(async () => {}), TypeError);
  for (const config of [{ NANOODLE_MAINTENANCE_STARTUP_FILE: w.startupFile },
    { NANOODLE_MAINTENANCE_FILE: w.file, NANOODLE_MAINTENANCE_STARTUP_FILE: w.file },
    { NANOODLE_MAINTENANCE_FILE: w.file, NANOODLE_MAINTENANCE_STARTUP_FILE: '/different/permit' }]) assert.throws(() => maintenanceConfig(config), TypeError);
});

function processIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return { pid, uid: process.getuid(), bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTicks: stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)[19] };
}
function unseal(path) {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) unseal(join(path, entry.name));
  }
}

function copyRelease(w) {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  chmodSync(w.release, 0o700);
  for (const folder of ['src', 'bin']) cpSync(join(packageRoot, folder), join(w.release, folder), { recursive: true });
  cpSync(join(packageRoot, 'package.json'), join(w.release, 'package.json'));
  mkdirSync(join(w.release, 'assets'));
  for (const name of ['near-site.js', 'near-wallet.js', 'creator-site.js', 'nano-landing.js']) cpSync(join(packageRoot, 'assets', name), join(w.release, 'assets', name));
  mkdirSync(join(w.release, 'node_modules'));
  const lock = JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'));
  for (const [path, value] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || value.dev) continue;
    const installed = join(packageRoot, path);
    if (value.optional && !existsSync(installed)) continue;
    cpSync(installed, join(w.release, path), { recursive: true });
  }
  chmodSync(w.release, 0o555);
  return packageRoot;
}

test('real CLI waits before any provider request, initializes while paused and admits MCP only after explicit reopening', { timeout: 45000 }, async t => {
  const w = fixture(t), packageRoot = copyRelease(w);
  let requests = 0;
  const api = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [] })); });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  w.cleanup.push(() => { api.closeAllConnections(); return new Promise(resolve => api.close(resolve)); });
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const graphs = join(w.root, 'graphs'); mkdirSync(graphs); mkdirSync(join(w.root, 'out'), { mode: 0o700 });
  cpSync(join(packageRoot, 'tests/fixtures/hello-noodle.json'), join(graphs, 'hello.json'));
  const child = spawn(process.execPath, [join(w.release, 'bin/nanoodle-mcp.mjs'), '--graphs', graphs, '--out', join(w.root, 'out'), '--serve', `127.0.0.1:${port}`, '--key', 'synthetic-no-account-key'],
    { env: { PATH: process.env.PATH, NANOGPT_BASE_URL: `http://127.0.0.1:${api.address().port}`, NANOODLE_MAINTENANCE_FILE: w.file,
      NANOODLE_MAINTENANCE_STARTUP_FILE: w.startupFile, NANOODLE_MAINTENANCE_OWNER_UID: String(process.getuid()) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr.on('data', chunk => { log += chunk; });
  w.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
  const wait = async predicate => {
    const until = Date.now() + 7000;
    while (!predicate()) { assert.equal(child.exitCode, null, log); assert.ok(Date.now() < until, log); await delay(10); }
  };
  await wait(() => log.includes('waiting for a process-bound operator permit'));
  assert.equal(requests, 0, 'No provider request before the process-bound grant');
  const grant = w.grant(); grant.process = processIdentity(child.pid); w.put(grant);
  await wait(() => log.includes('MCP over HTTP'));
  const call = () => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }).catch(error => { error.message += '\n' + log; throw error; });
  assert.equal((await call()).status, 503, 'Startup permit must not open external MCP admission');
  rmSync(w.startupFile); rmSync(w.file);
  assert.equal((await call()).status, 200);
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0, log);
});


test('the hosted CLI recovers a recorded refund once and refuses stale Nano peers after a crash', { timeout: 60000 }, async t => {
  const w = fixture(t), packageRoot = copyRelease(w), key = await throwawayNearKey();
  const chain = createFakeChain(), nano = nanoGptMock();
  const merchant = 'startup-shop.testnet', payer = 'startup-payer.testnet', deposit = 10n ** 22n;
  const seed = '0'.repeat(64), account = deriveAddress(derivePublicKey(deriveSecretKey(seed, 0)), { useNanoPrefix: true });
  const oldHead = { hash: 'B'.repeat(64), blockCount: '10' };
  const floor = { v: 1, networkGenesis: NANO_GENESIS_HASH, account, head: oldHead, confirmed: oldHead };
  let nanoHeight = 10;
  const nanoCalls = [];
  const nanoRpc = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    nanoCalls.push({ peer: req.url, action: body.action });
    const result = body.action === 'block_info' && body.hash === NANO_GENESIS_HASH ? NANO_GENESIS_REPLY
      : body.action === 'account_info' ? nanoAccountInfo({ height: nanoHeight, frontier: (nanoHeight === 10 ? 'B' : 'A').repeat(64),
        representative: account, balance: String(10n ** 31n) })
      : { error: 'Unexpected mock RPC action' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  nanoRpc.listen(0, '127.0.0.1'); await once(nanoRpc, 'listening');
  w.cleanup.push(() => { nanoRpc.closeAllConnections(); return new Promise(resolve => nanoRpc.close(resolve)); });
  const rpcBase = `http://127.0.0.1:${nanoRpc.address().port}`;
  chain.addAccount(merchant, 10n ** 25n, key.publicKey); chain.addAccount(payer, 10n ** 25n);
  await chain.listen(); await nano.listen();
  w.cleanup.push(() => chain.close(), () => nano.close());
  const out = join(w.root, 'out'), graphs = join(w.root, 'graphs'); mkdirSync(out, { mode: 0o700 }); mkdirSync(graphs);
  const marketState = join(w.root, 'market-state'); mkdirSync(marketState, { mode: 0o700 });
  const durablePath = join(out, 'nano-wallet-checkpoint.json'), healthPath = join(out, 'funding-health.json');
  cpSync(join(packageRoot, 'tests/fixtures/hello-noodle.json'), join(graphs, 'hello.json'));
  const file = join(out, 'near-state.json');
  const ledger = openNearLedger({ file, network: 'testnet', merchant });
  const paidAt = Date.now();
  ledger.putQuote({ id: 'nq_startup', status: 'pending', asset: 'near', tool: 'hello', amountYocto: String(deposit),
    createdAt: paidAt, expiresAt: paidAt + 3600000 });
  ledger.recordPayment('nq_startup', 'synthetic-prior-paid-transfer',
    { status: 'paid', paidYocto: String(deposit), payer, paidAtBlockMs: paidAt });
  ledger.updateQuote('nq_startup', { status: 'running' });
  const policy = join(w.root, 'state-policy.json');
  json(policy, { v: 1, outDir: out, nanoAddress: account, chargeNano: false, near: { network: 'testnet', merchant }, marketRoot: null, marketHandles: [] });
  const initialBalance = chain.balance(payer);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt === 3) nanoHeight = 9;
    const priorNanoCalls = nanoCalls.length;
    rmSync(w.startupFile, { force: true });
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [join(w.release, 'bin/nanoodle-mcp.mjs'), '--graphs', graphs, '--out', out,
      '--serve', `127.0.0.1:${port}`, '--public-url', base, '--key', 'synthetic-no-account-key', '--near-merchant', merchant,
      '--near-network', 'testnet', '--near-rpc', chain.url, '--near-usd', '3.64'],
      { env: { PATH: process.env.PATH, NANOGPT_BASE_URL: nano.url, NEAR_PRIVATE_KEY: key.secretKey, NANOODLE_STATE_POLICY: policy,
        NANO_SEED: seed, NANO_RPC_URL: `${rpcBase}/a,${rpcBase}/b`, MARKET_STATE_DIR: marketState,
        NANOODLE_WRITER_LOCK_DIR: join(w.root, 'locks'), NANOODLE_MAINTENANCE_FILE: w.file,
        NANOODLE_MAINTENANCE_STARTUP_FILE: w.startupFile, NANOODLE_MAINTENANCE_OWNER_UID: String(process.getuid()) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; child.stderr.on('data', chunk => { log += chunk; });
    w.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; } });
    const wait = async predicate => { const deadline = Date.now() + 8000; while (!predicate()) {
      assert.equal(child.exitCode, null, log); assert.ok(Date.now() < deadline, log); await delay(10);
    } };
    const exit = once(child, 'exit');
    if (attempt === 3) {
      const funding = () => JSON.parse(readFileSync(healthPath));
      await wait(() => funding().process?.pid === child.pid);
      assert.equal(funding().ok, false);
      assert.equal(funding().code, 'nano-checkpoint-unproven');
      assert.deepEqual(JSON.parse(readFileSync(durablePath)), floor);
      await wait(() => log.includes('MCP over HTTP'));
      assert.equal((await fetch(base + '/out/nano-wallet-checkpoint.json')).status, 404);
      assert.ok(nanoCalls.slice(priorNanoCalls).every(call => ['account_info', 'block_info'].includes(call.action)));
      nanoHeight = 10;
      try { await wait(() => funding().ok === true); }
      catch (error) {
        const { code, checkedAt } = funding();
        throw new Error(`Funding report ${code} at ${checkedAt}`, { cause: error });
      }
      assert.equal(funding().process.pid, child.pid);
      assert.equal(chain.sendTxCount, 1);
      assert.equal(nano.runs(), 0);
      assert.ok(nanoCalls.every(call => call.action !== 'process'));
      child.kill('SIGTERM'); const [code] = await exit; assert.equal(code, 0, log);
      continue;
    }
    await wait(() => log.includes('waiting for a process-bound operator permit'));
    assert.equal(chain.sendTxCount, attempt === 2 ? 1 : 0);
    const head = attempt === 0 ? { hash: 'C'.repeat(64), blockCount: '11' } : oldHead;
    const identity = processIdentity(child.pid);
    w.put({ ...w.grant(), v: 2, process: identity,
      nanoCheckpoint: { v: 1, networkGenesis: NANO_GENESIS_HASH, account, head, confirmed: oldHead } });
    if (attempt === 0) {
      const [code] = await exit; assert.equal(code, 1, log);
      assert.match(log, /Nano startup checkpoint lacks two confirmed peer views/);
      assert.equal(chain.sendTxCount, 0);
      assert.equal(JSON.parse(readFileSync(file)).quotes.nq_startup.status, 'running');
      assert.throws(() => readFileSync(join(out, 'nano-handoff.json')), { code: 'ENOENT' });
      assert.throws(() => readFileSync(durablePath), { code: 'ENOENT' });
      assert.deepEqual(new Set(nanoCalls.filter(call => call.action === 'account_info').map(call => call.peer)), new Set(['/a', '/b']));
      assert.ok(nanoCalls.every(call => ['account_info', 'block_info'].includes(call.action)));
      continue;
    }
    await wait(() => log.includes('NEAR mode on testnet'));
    await wait(() => log.includes('MCP over HTTP'));
    const q = JSON.parse(readFileSync(file)).quotes.nq_startup;
    assert.equal(q.status, 'failed', log); assert.equal(q.outcome, 'interrupted');
    assert.equal(chain.sendTxCount, 1, 'Recorded refund must not be signed/broadcast again on a later startup');
    assert.equal(chain.balance(payer) - initialBalance, deposit);
    assert.equal(nano.runs(), 0, 'Recovery must never rerun an interrupted workflow');
    const health = await fetch(base + '/near/health').then(r => r.json());
    assert.equal(health.active, true); assert.equal(health.watcher.listening, false);
    assert.equal(health.watcher.error, 'SERVICE_DRAINING');
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_noodle', arguments: {} } }) });
    assert.equal(response.status, 503);
    assert.equal((await fetch(base + '/out/nano-handoff.json')).status, 404);
    assert.equal(lstatSync(durablePath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(durablePath)), floor);
    if (attempt === 2) {
      rmSync(w.startupFile); rmSync(w.file);
      child.kill('SIGKILL'); const [, signal] = await exit; assert.equal(signal, 'SIGKILL', log);
      continue;
    }
    child.kill('SIGTERM'); const [code] = await exit; assert.equal(code, 0, log);
    const handoff = join(out, 'nano-handoff.json');
    assert.equal(lstatSync(handoff).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(handoff)), { v: 1, request, process: identity, checkpoint: floor });
  }
});
