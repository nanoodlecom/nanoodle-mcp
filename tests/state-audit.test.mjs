/** State-transition regressions. All providers, payments and files are local fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { serveHttp } from '../src/http.mjs';
import { createDispatcher, serveMcp } from '../src/server.mjs';
import { createChargeGate, hashArgs } from '../src/gate.mjs';

const ADDRESS = 'nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet';
const PAYER = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const params = { name: 'poster', arguments: { Text: 'a' } };
const registry = (run = async () => ({ content: [{ type: 'text', text: 'done' }], costUsd: 0.02 })) => ({
  tools: [{ name: 'poster', description: 'Make a poster' }],
  listTools: () => [{ name: 'poster', description: 'Make a poster', inputSchema: { type: 'object' } }],
  callTool: run,
});
function gateOptions(extra = {}) {
  return {
    address: ADDRESS, usd: 0.05, xnoUsd: 1, publicBase: 'http://pay.test', pollMs: 10,
    ops: { rpc: async () => ({}), transfer: async () => { throw new Error('unexpected transfer'); } },
    ...extra,
  };
}
function savedQuote(extra = {}) {
  return {
    id: 'pay_existing', tool: 'poster', argsHash: hashArgs(params.name, params.arguments),
    usd: 0.05, amountRaw: String(5n * 10n ** 28n), pair: { usdNano: '1000000000', raw: String(10n ** 30n) },
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000, source: PAYER,
    status: 'paid', ...extra,
  };
}
async function savedGate(t, quote, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-state-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'gate-state.json');
  await writeFile(stateFile, JSON.stringify({ v: 2, quotes: [quote], owed: [] }));
  return { stateFile, gate: createChargeGate(gateOptions({ stateFile, ...extra })) };
}

test('artifact delivery withholds bookkeeping, staging files, directories and symlinks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-artifact-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const privateFiles = ['gate-state.json', 'usage.jsonl', 'costs.json', 'gate-state.json.tmp', 'future-private.txt'];
  for (const file of privateFiles) await writeFile(join(dir, file), 'PRIVATE-BOOKKEEPING');
  await writeFile(join(dir, 'result.png'), 'GENERATED-IMAGE');
  await writeFile(join(dir, 'result.bin'), 'GENERATED-BINARY');
  await symlink(join(dir, 'gate-state.json'), join(dir, 'linked.png'));
  await mkdir(join(dir, 'directory.png'));
  const server = await serveHttp({ host: '127.0.0.1', port: 0, name: 'audit', version: '0',
    listTools: () => [], callTool: async () => ({}), outDir: dir, publicBase: 'http://pay.test', log: () => {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const file of [...privateFiles, 'linked.png', 'directory.png']) {
    for (const method of ['GET', 'HEAD']) {
      const r = await fetch(`${base}/out/${file}`, { method });
      assert.equal(r.status, 404, `${method} ${file} must be private`);
      assert.doesNotMatch(await r.text(), /PRIVATE-BOOKKEEPING/);
    }
  }
  for (const [file, body] of [['result.png', 'GENERATED-IMAGE'], ['result.bin', 'GENERATED-BINARY']]) {
    const r = await fetch(`${base}/out/${file}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), body);
    const head = await fetch(`${base}/out/${file}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
});

test('idless messages cannot execute tools or produce request replies', async () => {
  let calls = 0;
  const dispatch = createDispatcher({ name: 'audit', version: '0', commit: null,
    listTools: () => [], callTool: async () => { calls++; return { content: [] }; } });
  for (const method of ['tools/call', 'tools/list', 'initialize', 'ping', 'notifications/initialized']) {
    assert.equal(await dispatch({ jsonrpc: '2.0', method, params }), null, method);
  }
  assert.equal(calls, 0, 'a notification must never spend the server wallet');
  for (const id of [null, true, {}, []]) {
    const r = await dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params });
    assert.equal(r.error.code, -32600);
    assert.equal(r.id, null);
  }
  assert.equal(calls, 0, 'invalid request ids must never dispatch');
  for (const id of [0, '']) {
    assert.deepEqual((await dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params })).result, { content: [] });
  }
  assert.equal(calls, 2);
});

test('a failed regeneration after restart cannot refund an already settled deposit', async (t) => {
  const transfers = [];
  const quote = savedQuote({ settled: true, settleReceipt: { known: true, costUsd: 0.02,
    take: '4000000000000000000000000000', change: '26000000000000000000000000000', author: true } });
  const { gate, stateFile } = await savedGate(t, quote, {
    ops: { rpc: async () => ({}), transfer: async (...args) => { transfers.push(args); return 'F'.repeat(64); } },
  });
  let calls = 0;
  const wrapped = gate.wrapRegistry(registry(async () => { calls++; throw new Error('SECRET-PROVIDER-FAILURE'); }));
  const retry = { ...params, arguments: { ...params.arguments, _payment_id: quote.id } };
  const result = await wrapped.callTool(retry);
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.deepEqual(transfers, [], 'the first settlement already returned change and paid the author');
  assert.match(result.content[0].text, /already settled/i);
  assert.doesNotMatch(result.content[0].text, /was refunded|being refunded/);
  assert.deepEqual(await wrapped.callTool(retry), result);
  assert.equal(calls, 1, 'a failed recovery replays, rather than redispatching');
  for (let i = 0; i < 100; i++) {
    const data = JSON.parse(await readFile(stateFile, 'utf8'));
    if (data.quotes[0].error) {
      assert.doesNotMatch(data.quotes[0].error, /SECRET-PROVIDER/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('redacted recovery error was not persisted');
});

test('retention cannot forget a paid quote before the customer claims its run', async (t) => {
  const quote = savedQuote({ createdAt: Date.now() - 25 * 60 * 60_000, expiresAt: Date.now() - 24 * 60 * 60_000 });
  const { gate } = await savedGate(t, quote);
  assert.equal(gate.quote(quote.id)?.status, 'paid');
  assert.equal(gate.quote(quote.id)?.status, 'paid', 'repeated status reads must preserve the unpaid obligation');
  let calls = 0;
  const wrapped = gate.wrapRegistry(registry(async () => { calls++; return { content: [], costUsd: 0.05 }; }));
  const result = await wrapped.callTool({ ...params, arguments: { ...params.arguments, _payment_id: quote.id } });
  assert.ok(!result.isError);
  assert.equal(calls, 1);
  assert.equal(gate.quote(quote.id).status, 'consumed', 'completion begins the replay retention window');
  await wrapped.callTool({ ...params, arguments: { ...params.arguments, _payment_id: quote.id } });
  assert.equal(calls, 1, 'a late claim still has a replay window after completion');
});

test('abandoning a payment wait releases it immediately without changing the quote', async (t) => {
  const { gate } = await savedGate(t, savedQuote({ status: 'pending', source: null }));
  const abort = new AbortController();
  const waiting = gate.waitForPayment('pay_existing', 25_000, { signal: abort.signal });
  abort.abort();
  const status = await Promise.race([waiting, new Promise((resolve) => {
    const timeout = setTimeout(() => resolve('WAIT-LEAKED'), 100);
    timeout.unref();
  })]);
  assert.equal(status, 'pending');
  assert.equal(gate.quote('pay_existing').status, 'pending');
});

test('unreadable or malformed payment state fails closed without replacing the recovery file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-corrupt-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = join(dir, 'gate-state.json');
  for (const bytes of ['{truncated', 'null', '{}', JSON.stringify({ quotes: [savedQuote({ amountRaw: '-1' })], owed: [] }),
    JSON.stringify({ quotes: [savedQuote({ pair: { usdNano: '0', raw: '1' } })], owed: [] }),
    JSON.stringify({ quotes: [], owed: [{ to: PAYER, amountRaw: '-1', event: 'refund' }] })]) {
    await writeFile(stateFile, bytes);
    assert.throws(() => createChargeGate(gateOptions({ stateFile })), /cannot restore gate state.*refusing to accept payments/);
    assert.equal(await readFile(stateFile, 'utf8'), bytes);
  }
  await rm(stateFile);
  assert.doesNotThrow(() => createChargeGate(gateOptions({ stateFile })), 'a first boot may start with no state file');
});

async function eventually(fn) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('connection resources were not released');
}

test('disconnect releases watch capacity and cancels its payment wait immediately', async (t) => {
  const { gate } = await savedGate(t, savedQuote({ status: 'pending', source: null }));
  let waiting = 0;
  const wait = gate.waitForPayment.bind(gate);
  gate.waitForPayment = (...args) => {
    waiting++;
    return wait(...args).finally(() => waiting--);
  };
  const server = await serveHttp({ host: '127.0.0.1', port: 0, name: 'audit', version: '0',
    listTools: () => [], callTool: async () => ({}), gate, maxStreams: 1, publicBase: 'http://pay.test', log: () => {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/x402/watch/pay_existing`);
  const reader = response.body.getReader();
  await reader.read();
  assert.equal(waiting, 1);
  assert.equal((await fetch(`${base}/x402/watch/unknown`)).status, 503);
  await reader.cancel();
  await eventually(async () => {
    const r = await fetch(`${base}/x402/watch/unknown`);
    await r.text();
    return r.status === 200 && waiting === 0;
  });
});

test('disconnect releases a result socket without cancelling or repeating its workflow', async (t) => {
  let finish;
  const running = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const { gate } = await savedGate(t, savedQuote({ status: 'pending', source: null }));
  const server = await serveHttp({ host: '127.0.0.1', port: 0, name: 'audit', version: '0',
    listTools: () => [], callTool: async () => { calls++; await running; return { content: [] }; },
    gate, maxStreams: 1, progressMs: 5, publicBase: 'http://pay.test', log: () => {} });
  t.after(() => { finish(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await eventually(async () => {
    const r = await fetch(`${base}/x402/watch/unknown`);
    await r.text();
    return r.status === 200;
  });
  // Hold a second connection while the first workflow finishes. Its finally
  // must not release a second slot and let a third stream exceed the cap.
  const second = await fetch(`${base}/x402/watch/pay_existing`);
  const secondReader = second.body.getReader();
  await secondReader.read();
  finish();
  assert.equal((await fetch(`${base}/x402/watch/unknown`)).status, 503);
  assert.equal(calls, 1);
  await secondReader.cancel();
});

test('browser origins cannot turn a local server into a cross-origin spending proxy', async (t) => {
  let calls = 0;
  const server = await serveHttp({ host: '127.0.0.1', port: 0, name: 'audit', version: '0',
    listTools: () => [], callTool: async () => { calls++; return { content: [] }; },
    publicBase: 'https://mcp.example', log: () => {} });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
  for (const origin of ['https://attacker.example', 'null', 'https://mcp.example.attacker.example']) {
    for (const method of ['OPTIONS', 'POST']) {
      const r = await fetch(`${base}/mcp`, { method,
        headers: { 'Content-Type': 'application/json', Origin: origin }, ...(method === 'POST' ? { body } : {}) });
      assert.equal(r.status, 403, `${method} ${origin} must be rejected before dispatch`);
      await r.text();
    }
  }
  assert.equal(calls, 0);
  for (const origin of [null, 'https://mcp.example']) {
    const r = await fetch(`${base}/mcp`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body });
    assert.equal(r.status, 200);
    await r.text();
  }
  assert.equal(calls, 2, 'native clients and the canonical browser origin still work');
  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://mcp.example' } });
  assert.equal(preflight.status, 204);
});

test('a refunded pay page stops monitoring and removes the payment instructions', async (t) => {
  const server = await serveHttp({ host: '127.0.0.1', port: 0, name: 'audit', version: '0',
    listTools: () => [], callTool: async () => ({}), publicBase: 'http://pay.test', log: () => {},
    gate: { quote: () => ({ id: 'pay_refunded', tool: 'poster', status: 'refunded', usd: 0.05,
      amountXno: '0.05', amountRaw: '50000000000000000000000000000', address: ADDRESS,
      uri: `nano:${ADDRESS}?amount=50000000000000000000000000000`, expiresAt: new Date().toISOString() }) } });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/pay/pay_refunded`)).text();
  const elements = { paybox: { innerHTML: 'SCAN-TO-PAY' }, status: {}, expiry: {} };
  let eventSource, closed = 0, fetches = 0;
  const context = {
    document: { getElementById: (id) => elements[id] }, setTimeout: () => {},
    fetch: async () => { fetches++; return { json: async () => ({ status: 'refunded' }) }; },
    EventSource: class {
      constructor() { eventSource = this; }
      addEventListener(name, listener) { this[name] = listener; }
      close() { closed++; }
    },
  };
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script, context);
  eventSource.status({ data: JSON.stringify({ status: 'refunded' }) });
  assert.match(elements.paybox.innerHTML, /Payment refunded/);
  assert.doesNotMatch(elements.paybox.innerHTML, /SCAN-TO-PAY/);
  assert.equal(closed, 1);
  eventSource.onerror();
  assert.equal(fetches, 0, 'a terminal refund must not enter an immediate long-poll loop');
});

test('stdio EOF drains an accepted workflow and writes its result before closing', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let finish, closed = false, started = false, text = '';
  const running = new Promise((resolve) => { finish = resolve; });
  output.on('data', (data) => { text += data; });
  const done = new Promise((resolve) => {
    serveMcp({ input, output, name: 'audit', version: '0', listTools: () => [],
      callTool: async () => { started = true; await running; return { content: [{ type: 'text', text: 'delivered' }] }; },
      onClose: () => { closed = true; resolve(); } });
  });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) + '\n');
  await eventually(() => started);
  assert.equal(closed, false, 'EOF must not exit while an accepted tool is still running');
  finish();
  await done;
  assert.equal(JSON.parse(text).result.content[0].text, 'delivered');
  assert.equal(closed, true);
});
