import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client as ModernClient, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { createChargeGate } from '../../src/gate.mjs';
import { createDispatcher } from '../../src/server.mjs';
import { createCompatibilityServer, PROVENANCE_KEY } from './server.mjs';

const revision = 'a'.repeat(40);
const GATE = 'nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet';
const PAYER = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const definition = { name: 'poster', description: 'Offline canned poster',
  inputSchema: { type: 'object', properties: { Text: { type: 'string' } }, required: ['Text'] } };
function fixture({ onCall, failTransfer = false } = {}) {
  let runs = 0, rpcCalls = 0;
  const blocks = {}, transfers = [], events = [];
  const registry = {
    tools: [definition], listTools: () => [definition],
    prepareCall: async p => {
      if (p.name !== 'poster' || typeof p.arguments?.Text !== 'string' ||
          Object.keys(p.arguments).some(k => k !== 'Text')) {
        throw Object.assign(new Error('PRIVATE upstream URL and prompt'), { mcpCode: -32602 });
      }
    },
    callTool: async p => { runs++; return onCall ? onCall(p) : {
      content: [{ type: 'text', text: 'offline output' }], costUsd: 0.01, costExact: true,
    }; },
  };
  const gate = createChargeGate({ address: GATE, usd: 0.05, xnoUsd: 1,
    publicBase: 'https://offline.invalid', pollMs: 5, waitMs: 20,
    validate: p => registry.prepareCall(p), usage: (event, fields) => events.push({ event, ...fields }),
    // A network attempt is a failure; only scripted in-memory Nano responses exist.
    fetch: () => { throw new Error('External network prohibited'); },
    ops: { rpc: async p => { rpcCalls++; return p.action === 'receivable' ? { blocks: { ...blocks } } : { history: [] }; },
      transfer: async (to, amountRaw) => {
        transfers.push({ to, amountRaw });
        if (failTransfer) throw new Error('Scripted settlement response lost');
        return 'F'.repeat(64);
      },
      pocket: async () => {},
    },
  });
  return { gate, paidRegistry: gate.wrapRegistry(registry), events, transfers,
    runs: () => runs, rpcCalls: () => rpcCalls,
    pay: x => { blocks['B'.repeat(64)] = { amount: x.amountRaw, source: PAYER }; },
  };
}
async function connect(t, paidRegistry, kind = 'modern', timeoutMs = 1000) {
  let server, invoke;
  const factory = () => {
    const instance = createCompatibilityServer({ paidRegistry, revision, version: '0.6.0', timeoutMs });
    ({ server, invoke } = instance); return server;
  };
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const sent = [];
  const original = ct.send.bind(ct);
  ct.send = async (...args) => { sent.push(structuredClone(args[0])); return original(...args); };
  const client = kind === 'legacy' ? new LegacyClient({ name: 'legacy-offline', version: '1' }) :
    new ModernClient({ name: 'modern-offline', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const handle = serveStdio(factory, { transport: st });
  t.after(async () => { await client.close(); await handle.close(); });
  await client.connect(ct);
  return { client, server, invoke, sent };
}
const call = args => ({ name: 'poster', arguments: { Text: 'lighthouse', ...args } });

for (const kind of ['modern', 'legacy']) {
  test(`${kind} actual SDK: discovery, paid quote, receipt and shared-gate replay`, async t => {
    const f = fixture();
    const a = await connect(t, f.paidRegistry, kind);
    const catalog = await a.client.listTools();
    assert.equal(catalog.tools.length, 1);
    assert.ok(catalog.tools[0].inputSchema.properties._payment_id);
    assert.equal(catalog.tools[0].annotations.idempotentHint, false);
    assert.deepEqual(a.server.getCapabilities(), { tools: {} });
    if (kind === 'modern') {
      assert.equal(catalog.ttlMs, 0);
      assert.equal(catalog.cacheScope, 'private');
      assert.ok(a.sent.some(m => m.method === 'server/discover'));
      assert.ok(!a.sent.some(m => m.method === 'initialize'));
      assert.equal(a.sent.find(m => m.method === 'tools/list').params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    } else {
      assert.ok(a.sent.some(m => m.method === 'initialize'));
      assert.equal(a.server.getNegotiatedProtocolVersion(), '2025-11-25');
    }
    if (kind === 'modern') assert.deepEqual((await a.client.listResources()).resources, []);
    else await assert.rejects(a.client.listResources(), e => e.code === -32601);
    await assert.rejects(a.client.callTool({ name: 'missing', arguments: {} }), e => e.code === -32602);
    await assert.rejects(a.client.callTool(call({ Text: 3 })), e => e.code === -32602 && !e.message.includes('PRIVATE'));
    assert.equal(f.events.length, 0, 'invalid args cannot allocate a quote');
    const quote = await a.client.callTool(call());
    const x = quote.structuredContent.x402;
    assert.equal(x.address, GATE);
    assert.deepEqual(x.phases, ['pay', 'watch', 'results']);
    assert.equal(f.runs(), 0);
    assert.equal(f.transfers.length, 0, 'quote never pays on behalf of client');
    f.pay(x);
    assert.equal(await f.gate.waitForPayment(x.paymentId, 1000), 'paid');
    const b = await connect(t, f.paidRegistry, kind);
    const results = await Promise.all([a.client.callTool(call({ _payment_id: x.paymentId })), b.client.callTool(call({ _payment_id: x.paymentId }))]);
    assert.equal(f.runs(), 1, 'separate SDK servers share canonical reservation');
    for (const result of results) {
      assert.match(result.content.map(c => c.text).join('\n'), /offline output[\s\S]*block BBBB[\s\S]*actual cost \$0.01/);
      assert.equal(result._meta[PROVENANCE_KEY].sourceRevision, revision);
      assert.equal(result._meta[PROVENANCE_KEY].paymentId, x.paymentId);
      assert.ok(!('costUsd' in result));
    }
    const changed = await a.client.callTool(call({ Text: 'changed', _payment_id: x.paymentId }));
    assert.equal(changed.isError, true);
    assert.equal(changed.structuredContent.automaticRetry, false);
    assert.equal(f.runs(), 1);
    assert.equal(f.events.filter(e => e.event === 'quote').length, 1);
  });
}

test('timeout preserves paid execution; same payment ID recovers without second dispatch', async t => {
  let finish, started;
  const running = new Promise(r => { started = r; });
  const f = fixture({ onCall: () => { started(); return new Promise(r => { finish = r; }); } });
  const a = await connect(t, f.paidRegistry, 'modern', 30);
  const x = (await a.client.callTool(call())).structuredContent.x402;
  f.pay(x);
  assert.equal(await f.gate.waitForPayment(x.paymentId, 1000), 'paid');
  const pending = a.client.callTool(call({ _payment_id: x.paymentId }));
  await running;
  const result = await pending;
  assert.equal(result.structuredContent.status, 'outcome_unknown');
  assert.equal(result.structuredContent.paymentId, x.paymentId);
  assert.equal(f.events.filter(e => e.event === 'quote').length, 1);
  finish({ content: [{ type: 'text', text: 'late success' }], costUsd: 0.01 });
  const recovered = await a.client.callTool(call({ _payment_id: x.paymentId }));
  assert.match(recovered.content[0].text, /late success/);
  assert.equal(f.runs(), 1);
});

for (const kind of ['modern', 'legacy']) test(`${kind} SDK cancellation abandons wait, gate stays consumed and replay recovers`, async t => {
  let finish, started;
  const running = new Promise(r => { started = r; });
  const f = fixture({ onCall: () => { started(); return new Promise(r => { finish = r; }); } });
  const a = await connect(t, f.paidRegistry, kind);
  const x = (await a.client.callTool(call())).structuredContent.x402;
  f.pay(x);
  assert.equal(await f.gate.waitForPayment(x.paymentId, 1000), 'paid');
  const c = new AbortController();
  const pending = kind === 'legacy'
    ? a.client.callTool(call({ _payment_id: x.paymentId }), undefined, { signal: c.signal })
    : a.client.callTool(call({ _payment_id: x.paymentId }), { signal: c.signal });
  await running; c.abort();
  await assert.rejects(pending);
  assert.equal(f.gate.quote(x.paymentId).status, 'consumed');
  finish({ content: [{ type: 'text', text: 'after cancel' }], costUsd: 0.01 });
  const result = await a.client.callTool(call({ _payment_id: x.paymentId }));
  assert.match(result.content[0].text, /after cancel/);
  assert.equal(f.runs(), 1);
});

test('safe failures never disclose upstream secrets or claim a confirmed refund', async t => {
  const f = fixture({ onCall: () => { throw new Error('PRIVATE prompt https://key:secret@example.invalid'); } });
  const a = await connect(t, f.paidRegistry);
  const x = (await a.client.callTool(call())).structuredContent.x402;
  f.pay(x); await f.gate.waitForPayment(x.paymentId, 1000);
  const result = await a.client.callTool(call({ _payment_id: x.paymentId }));
  assert.equal(result.structuredContent.status, 'outcome_unknown');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('key:secret'));
  assert.equal(result.structuredContent.automaticRetry, false);
});

test('pre-aborted request never reaches the injected boundary; free registry fails closed', async () => {
  let calls = 0;
  const p = { listTools: () => [{ ...definition, inputSchema: { ...definition.inputSchema,
    properties: { ...definition.inputSchema.properties, _payment_id: { type: 'string' } } } }],
    callTool: async () => { calls++; throw new Error('should not run'); } };
  const a = createCompatibilityServer({ paidRegistry: p, version: '0.6.0', revision });
  const c = new AbortController(); c.abort();
  const result = await a.invoke(call(), { signal: c.signal });
  assert.equal(result.structuredContent.automaticRetry, false);
  assert.equal(calls, 0);
  assert.throws(() => createCompatibilityServer({ paidRegistry: { ...p, listTools: () => [definition] }, version: '0.6.0', revision }), /charge-gated/);
});

test('abort between invoke and scheduled dispatch neither allocates nor consumes a canonical quote', async () => {
  const f = fixture();
  const a = createCompatibilityServer({ paidRegistry: f.paidRegistry, version: '0.6.0', revision });
  const quoteAbort = new AbortController();
  const quotePending = a.invoke(call(), { signal: quoteAbort.signal });
  quoteAbort.abort(); // invoke returned, but its dispatch microtask has not run
  const quoteResult = await quotePending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quoteResult.structuredContent.status, 'outcome_unknown');
  assert.equal(quoteResult.structuredContent.automaticRetry, false);
  assert.equal(f.events.length, 0, 'aborted quote request must not allocate a quote');
  assert.equal(f.runs(), 0);

  const x = (await a.invoke(call())).structuredContent.x402;
  f.pay(x);
  assert.equal(await f.gate.waitForPayment(x.paymentId, 1000), 'paid');
  const params = call({ _payment_id: x.paymentId });
  const paidAbort = new AbortController();
  const paidPending = a.invoke(params, { signal: paidAbort.signal });
  paidAbort.abort(); // same race, now with a real paid canonical reservation
  const paidResult = await paidPending;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(paidResult.structuredContent.status, 'outcome_unknown');
  assert.equal(paidResult.structuredContent.automaticRetry, false);
  assert.equal(paidResult.structuredContent.paymentId, x.paymentId);
  assert.equal(f.runs(), 0, 'pre-dispatch abort cannot execute the paid workflow');
  assert.equal(f.gate.quote(x.paymentId).status, 'paid', 'reservation must remain unconsumed');
  assert.equal(f.transfers.length, 0);
  assert.equal(f.events.filter(e => e.event === 'quote').length, 1);

  // Explicit reconciliation with the original payment ID can still retrieve it.
  const recovered = await a.invoke(params);
  assert.match(recovered.content[0].text, /offline output/);
  assert.equal(f.runs(), 1);
});

test('abort after actual canonical dispatch returns uncertainty and preserves same-ID recovery', async () => {
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const f = fixture({ onCall: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const a = createCompatibilityServer({ paidRegistry: f.paidRegistry, version: '0.6.0', revision });
  const x = (await a.invoke(call())).structuredContent.x402;
  f.pay(x);
  assert.equal(await f.gate.waitForPayment(x.paymentId, 1000), 'paid');
  const params = call({ _payment_id: x.paymentId });
  const c = new AbortController();
  const pending = a.invoke(params, { signal: c.signal });
  await running; // the provider boundary has actually been entered
  c.abort();
  const result = await pending;
  assert.equal(result.structuredContent.status, 'outcome_unknown');
  assert.equal(result.structuredContent.automaticRetry, false);
  assert.equal(result.structuredContent.paymentId, x.paymentId);
  assert.equal(f.runs(), 1);
  assert.equal(f.gate.quote(x.paymentId).status, 'consumed');
  assert.equal(f.events.filter(e => e.event === 'quote').length, 1);
  finish({ content: [{ type: 'text', text: 'completed after abort' }], costUsd: 0.01 });
  const recovered = await a.invoke(params);
  assert.match(recovered.content[0].text, /completed after abort/);
  assert.equal(f.runs(), 1);
});

test('modern auto client conservatively falls back to unchanged canonical dispatcher', async t => {
  const dispatch = createDispatcher({ name: 'canonical-offline', version: '0.6.0', commit: null,
    listTools: () => [], callTool: async () => { throw new Error('No live calls'); } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const methods = [];
  st.onmessage = async msg => { methods.push(msg.method); const reply = await dispatch(msg); if (reply) await st.send(reply); };
  const client = new ModernClient({ name: 'auto-offline', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  t.after(async () => { await client.close(); await st.close(); });
  await st.start(); await client.connect(ct);
  assert.deepEqual((await client.listTools()).tools, []);
  assert.ok(methods.includes('server/discover'));
  assert.ok(methods.includes('initialize'));
  assert.equal(client.getServerVersion().name, 'canonical-offline');
});


test('uncertain refund never becomes adapter-confirmed settlement or a new quote', async t => {
  const f = fixture({ failTransfer: true, onCall: () => { throw new Error('scripted provider failure'); } });
  const a = await connect(t, f.paidRegistry);
  const x = (await a.client.callTool(call())).structuredContent.x402;
  f.pay(x); await f.gate.waitForPayment(x.paymentId, 1000);
  const result = await a.client.callTool(call({ _payment_id: x.paymentId }));
  assert.equal(result.structuredContent.status, 'outcome_unknown');
  assert.equal(result.structuredContent.automaticRetry, false);
  assert.equal(result._meta[PROVENANCE_KEY].outcome, 'outcome_unknown');
  assert.ok(!JSON.stringify(result).includes('was refunded'));
  assert.ok(f.events.some(e => e.event === 'refund' && e.ok === false));
  assert.ok(!f.events.some(e => e.event === 'refund' && e.ok === true));
  assert.equal(f.events.filter(e => e.event === 'quote').length, 1);
  assert.equal(f.runs(), 1);
});
