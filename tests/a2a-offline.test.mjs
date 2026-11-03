import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCard, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { createChargeGate } from '../src/gate.mjs';
import { openA2ABindings, hash } from '../src/a2a/bindings.mjs';
import { createOfflineChargeBoundary } from '../src/a2a/charge-boundary.mjs';
import { createOfflineA2AFacade } from '../src/a2a/offline-facade.mjs';

const mode = 'offline-fixture';
const ADDR = 'nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet';
const PAYER = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const workflows = [{ name: 'poster', digest: 'a'.repeat(64), description: 'Allowlisted existing poster graph.' }];
const auth = (user = 'alice', tenant = 'tenant-one', version = '1.0') => new ServerCallContext({
  tenant, requestedVersion: version, user: { isAuthenticated: !!user, userName: user },
});
const msg = (id, { action = 'quote', args = { Text: 'PRIVATE INPUT' }, task, quoteId, contextId, immediate = false } = {}) =>
  SendMessageRequest.fromJSON({ message: { messageId: id, role: 'ROLE_USER', taskId: task?.id,
    contextId: contextId ?? task?.contextId, parts: [{ data: { action, name: 'poster', arguments: args,
      ...(quoteId ? { quoteId } : {}) } }] }, configuration: { returnImmediately: immediate } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await delay(5); }
  throw new Error('fixture condition timed out');
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { onCall, override, timeoutMs = 1000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-a2a-'));
  const path = join(dir, 'ids.sqlite');
  let store = openA2ABindings({ mode, path });
  const state = { received: {}, calls: 0, transfers: [], events: [], quotes: 0 };
  const tools = [{ name: 'poster', description: 'A poster workflow.', inputSchema: {
    type: 'object', properties: { Text: { type: 'string' } }, required: ['Text'] } }];
  const registry = {
    tools, listTools: () => [...tools, { name: 'run_noodle', description: 'Arbitrary workflow' }],
    prepareCall: async p => { assert.equal(p.name, 'poster'); assert.deepEqual(Object.keys(p.arguments), ['Text']);
      assert.equal(typeof p.arguments.Text, 'string'); },
    callTool: async p => { state.calls++; if (onCall) return onCall(p);
      return { content: [{ type: 'text', text: 'PRIVATE OUTPUT' }], costUsd: 0.01, textOutput: true }; },
  };
  const gate = createChargeGate({ address: ADDR, usd: 0.05, xnoUsd: 1, publicBase: 'https://offline.invalid',
    pollMs: 5, waitMs: 5, validate: p => registry.prepareCall(p),
    fetch: async () => { throw new Error('LIVE_NETWORK_FORBIDDEN'); },
    usage: (event, fields) => { state.events.push({ event, fields }); if (event === 'quote') state.quotes++; },
    ops: {
      rpc: async p => {
        if (p.action === 'receivable') return { blocks: state.received };
        if (p.action === 'account_history') return { history: [] };
        throw new Error('UNEXPECTED_FIXTURE_RPC');
      },
      pocket: async () => {},
      transfer: async (to, amount) => { state.transfers.push({ to, amount }); return 'F'.repeat(64); },
    },
  });
  const canonical = createOfflineChargeBoundary({ mode, gate, registry });
  const boundary = { ...canonical, ...override };
  let facade = createOfflineA2AFacade({ mode, bindings: store, boundary, workflows, timeoutMs });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { get facade() { return facade; }, get store() { return store; }, state, gate, canonical, path,
    async rpc(method, params, context = auth()) {
      const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      return JSON.parse(JSON.stringify(await new JsonRpcTransportHandler(facade).handle(request, context)));
    },
    restart() { store.close(); store = openA2ABindings({ mode, path });
      facade = createOfflineA2AFacade({ mode, bindings: store, boundary, workflows, timeoutMs }); },
    async pay(task) {
      const id = task.metadata.quoteId, q = gate.quote(id);
      state.received['B'.repeat(64)] = { amount: q.amountRaw, source: PAYER };
      await until(() => gate.quote(id)?.status === 'paid');
    },
    async client(context = auth()) {
      const handler = new JsonRpcTransportHandler(facade), wire = [];
      // Actual SDK serialization, transport routing, errors and client parsing.
      // Fetch is an in-process byte boundary: no TCP listener or external calls.
      const fetchImpl = async (_url, init) => {
        const body = JSON.parse(init.body); wire.push(body);
        const result = await handler.handle(body, context);
        assert.equal(typeof result[Symbol.asyncIterator], 'undefined');
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      };
      const card = await facade.getAgentCard();
      const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })] }).createFromAgentCard(card);
      return { client, wire, card };
    },
  };
}

// Real official SDK client -> JSON bytes -> official server transport -> actual
// charge gate -> scripted Nano observer/executor -> SDK client, entirely offline.
test('A2A 1.0 SDK quote/payment/run/status roundtrip binds canonical receipts', async t => {
  const f = await fixture(t), { client, wire, card } = await f.client();
  assert.deepEqual(card.skills.map(x => x.id), ['poster']);
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.equal(AgentCard.toJSON(card).securitySchemes.hostBearer.httpAuthSecurityScheme.scheme, 'bearer');
  const first = await client.sendMessage(msg('quote-one'));
  assert.equal(first.status.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const q = first;
  assert.equal(q.metadata.payment.status, 'pending');
  assert.equal(f.state.calls, 0);
  await assert.rejects(client.sendMessage(msg('run-before-paid', { action: 'run', task: q, quoteId: q.metadata.quoteId })));
  await f.pay(q);
  const runMessage = msg('run-one', { action: 'run', task: q, quoteId: q.metadata.quoteId });
  const done = (await client.sendMessage(runMessage));
  assert.equal(done.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.quotes, 1);
  assert.equal(done.metadata.receipt.quoteId, q.metadata.quoteId);
  assert.equal(done.metadata.receipt.taskId, q.id);
  assert.equal(done.metadata.receipt.requestBinding, done.metadata.requestBinding);
  assert.equal(done.artifacts[0].parts[0].content.value.content[0].text, 'PRIVATE OUTPUT');
  assert.equal(hash(done.artifacts[0].parts[0].content.value), done.metadata.receipt.resultSha256);
  assert.equal((await client.sendMessage(runMessage)).id, q.id);
  assert.equal((await client.getTask({ id: q.id })).status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.state.calls, 1);
  assert.deepEqual(wire.slice(0, 2).map(x => x.method), ['SendMessage', 'SendMessage']);
});

test('duplicate and out-of-order messages never issue a second quote or dispatch', async t => {
  const f = await fixture(t), { client } = await f.client();
  const initial = msg('same-message');
  const [a, b] = await Promise.all([client.sendMessage(initial), client.sendMessage(initial)]);
  assert.equal(a.id, b.id); assert.equal(f.state.quotes, 1);
  const q = a;
  await f.pay(q);
  const run = msg('run-duplicate', { action: 'run', task: q, quoteId: q.metadata.quoteId });
  await client.sendMessage(run);
  await client.sendMessage(initial); // old quote event after completion
  await assert.rejects(client.sendMessage(msg('same-message', { args: { Text: 'other input' } })));
  await assert.rejects(client.sendMessage(msg('second-run', { action: 'run', task: q, quoteId: q.metadata.quoteId })));
  await assert.rejects(client.cancelTask({ id: q.id }));
  assert.equal((await client.getTask({ id: q.id })).status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.state.calls, 1); assert.equal(f.state.quotes, 1);
});

test('tenant AND authenticated principal isolate status, cancellation, results and replay', async t => {
  const f = await fixture(t), { client } = await f.client();
  const q = (await client.sendMessage(msg('private')));
  for (const context of [auth('bob'), auth('alice', 'tenant-two'), auth(''), auth('alice', 'tenant-one', '0.3')]) {
    const other = (await f.client(context)).client;
    await assert.rejects(other.getTask({ id: q.id }));
    await assert.rejects(other.cancelTask({ id: q.id }));
    await assert.rejects(other.sendMessage(msg('steal', { action: 'run', task: q, quoteId: q.metadata.quoteId })));
  }
  const injected = msg('metadata-auth'); injected.metadata = { user: 'alice', tenant: 'tenant-one' };
  await assert.rejects(f.facade.sendMessage(injected, auth('')));
  const bob = (await f.client(auth('bob'))).client;
  const independent = (await bob.sendMessage(msg('private')));
  assert.notEqual(independent.id, q.id);
});

test('workflow, context, quote and argument substitution rejected before execution', async t => {
  const f = await fixture(t), { client } = await f.client();
  const q = (await client.sendMessage(msg('bound')));
  await f.pay(q);
  for (const changes of [{ args: { Text: 'CHANGED' } }, { contextId: 'wrong-context' }, { quoteId: 'wrong-quote' },
    { args: { Text: 'PRIVATE INPUT', _payment_id: q.metadata.quoteId } }]) {
    await assert.rejects(client.sendMessage(msg(`bad-${Object.keys(changes)[0]}`, {
      action: 'run', task: q, quoteId: q.metadata.quoteId, ...changes,
    })));
  }
  const dynamic = msg('arbitrary'); dynamic.message.parts[0].content.value.name = 'run_noodle';
  await assert.rejects(client.sendMessage(dynamic));
  assert.equal(f.state.calls, 0);
});

test('cancel before dispatch is idempotent and cannot be undone by payment or old messages', async t => {
  const f = await fixture(t), { client } = await f.client();
  const initial = msg('cancel-quote'), q = (await client.sendMessage(initial));
  assert.equal((await client.cancelTask({ id: q.id })).status.state, TaskState.TASK_STATE_CANCELED);
  assert.equal((await client.cancelTask({ id: q.id })).status.state, TaskState.TASK_STATE_CANCELED);
  await f.pay(q); // Fixture only: canceled local task does not promise a refund.
  await assert.rejects(client.sendMessage(msg('too-late', { action: 'run', task: q, quoteId: q.metadata.quoteId })));
  assert.equal((await client.sendMessage(initial)).status.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(f.state.calls, 0); assert.equal(f.state.transfers.length, 0);
});

test('cancel after dispatch refuses false cancellation; duplicate dispatch remains single', async t => {
  const completion = deferred();
  const f = await fixture(t, { onCall: () => completion.promise }), { client } = await f.client();
  const q = (await client.sendMessage(msg('slow-quote'))); await f.pay(q);
  const run = msg('slow-run', { action: 'run', task: q, quoteId: q.metadata.quoteId, immediate: true });
  const working = (await client.sendMessage(run));
  assert.equal(working.status.state, TaskState.TASK_STATE_WORKING);
  await until(() => f.state.calls === 1);
  await assert.rejects(client.cancelTask({ id: q.id }));
  await client.sendMessage(run); assert.equal(f.state.calls, 1);
  completion.resolve({ content: [{ type: 'text', text: 'done' }], costUsd: 0.01 });
  await until(async () => (await client.getTask({ id: q.id })).status.state === TaskState.TASK_STATE_COMPLETED);
});

test('timeout aborts cooperative boundary and keeps settlement uncertain despite late completion', async t => {
  const late = deferred(); let signal;
  const f = await fixture(t, { timeoutMs: 30, override: { dispatch: x => { signal = x.signal; return late.promise; } } });
  const { client } = await f.client();
  const q = (await client.sendMessage(msg('timeout-quote'))); await f.pay(q);
  const run = msg('timeout-run', { action: 'run', task: q, quoteId: q.metadata.quoteId });
  const task = (await client.sendMessage(run));
  assert.equal(task.metadata.phase, 'uncertain'); assert.equal(task.metadata.reconciliationRequired, true);
  assert.equal(signal.aborted, true);
  late.resolve({ content: [{ type: 'text', text: 'late' }] }); await delay(10);
  assert.equal((await client.getTask({ id: q.id })).metadata.phase, 'uncertain');
  assert.equal((await client.sendMessage(run)).metadata.phase, 'uncertain');
  await assert.rejects(client.sendMessage(msg('retry-uncertain', { action: 'run', task: q, quoteId: q.metadata.quoteId })));
  await assert.rejects(client.cancelTask({ id: q.id }));
});

test('restart preserves quote/message binding and receipt but never reruns paid outputs', async t => {
  const f = await fixture(t), { client } = await f.client();
  const first = msg('restart-quote'), q = (await client.sendMessage(first));
  f.restart(); const restarted = (await f.client()).client;
  assert.equal((await restarted.sendMessage(first)).metadata.quoteId, q.metadata.quoteId);
  assert.equal(f.state.quotes, 1); await f.pay(q);
  const run = msg('restart-run', { action: 'run', task: q, quoteId: q.metadata.quoteId });
  const complete = (await restarted.sendMessage(run));
  f.restart(); const again = (await f.client()).client;
  const recovered = (await again.sendMessage(run));
  assert.deepEqual(recovered.metadata.receipt, complete.metadata.receipt);
  assert.equal(recovered.metadata.outputUnavailable, true); assert.deepEqual(recovered.artifacts, []);
  assert.equal(f.state.calls, 1);
  const disk = (await readFile(f.path)).toString('utf8');
  assert.equal(disk.includes('PRIVATE INPUT'), false); assert.equal(disk.includes('PRIVATE OUTPUT'), false);
  assert.equal(disk.includes('amountRaw'), false);
});

test('durable dispatch intent across restart cannot authorize a second attempt', async t => {
  const f = await fixture(t), q = await f.facade.sendMessage(msg('intent-quote'), auth());
  f.store.transition(q.id, ['awaiting'], { phase: 'dispatching' });
  f.restart();
  const task = await f.facade.getTask({ id: q.id }, auth());
  assert.equal(task.metadata.phase, 'uncertain');
  await assert.rejects(f.facade.sendMessage(msg('intent-run', { action: 'run', task: q, quoteId: q.metadata.quoteId }), auth()));
  assert.equal(f.state.calls, 0);
});

test('safe failures omit upstream errors, while receipts bind the original canonical failure', async t => {
  const f = await fixture(t, { onCall: async () => { throw new Error('SECRET UPSTREAM TOKEN'); } });
  const q = await f.facade.sendMessage(msg('error-quote'), auth()); await f.pay(q);
  const failure = await f.facade.sendMessage(msg('error-run', { action: 'run', task: q, quoteId: q.metadata.quoteId }), auth());
  assert.equal(failure.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(JSON.stringify(failure).includes('SECRET UPSTREAM'), false);
  assert.equal(failure.metadata.receipt.settlement, 'canonical-result-returned; not independently verified');
});

test('offline guard, bounded store, unavailable quote and unsupported operations fail closed', async t => {
  const f = await fixture(t, { override: { issueQuote: async () => { throw new Error('SECRET FAILURE'); } } });
  const failed = await f.facade.sendMessage(msg('unavailable-quote'), auth());
  assert.equal(failed.metadata.phase, 'uncertain');
  assert.equal(JSON.stringify(failed).includes('SECRET FAILURE'), false);
  await assert.rejects(f.facade.listTasks({}, auth()));
  assert.throws(() => createOfflineA2AFacade({ mode: 'live', workflows }));
  const small = openA2ABindings({ mode, path: join(tmpdir(), `small-${hash(f.path)}.sqlite`), maxTasks: 1 });
  t.after(async () => { small.close(); await rm(join(tmpdir(), `small-${hash(f.path)}.sqlite`), { force: true }); });
  const g = createOfflineA2AFacade({ mode, bindings: small, boundary: f.canonical, workflows });
  await g.sendMessage(msg('capacity-one'), auth());
  await assert.rejects(g.sendMessage(msg('capacity-two'), auth()));
});

test('concurrent duplicate run messages resolve to the original paid execution', async t => {
  const f = await fixture(t), { client } = await f.client();
  const q = await client.sendMessage(msg('concurrent-quote')); await f.pay(q);
  const run = msg('concurrent-run', { action: 'run', task: q, quoteId: q.metadata.quoteId });
  const [a, b] = await Promise.all([client.sendMessage(run), client.sendMessage(run)]);
  assert.equal(a.id, b.id); assert.equal(a.status.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(b.status.state, TaskState.TASK_STATE_COMPLETED); assert.equal(f.state.calls, 1);
});

test('cancel while quote is being created cannot be reversed by the late quote', async t => {
  const slowQuote = deferred(); let canonical;
  const f = await fixture(t, { override: { issueQuote: async call => {
    await slowQuote.promise; return canonical.issueQuote(call);
  } } }); canonical = f.canonical;
  const q = await f.facade.sendMessage(msg('cancel-inflight-quote', { immediate: true }), auth());
  await f.facade.cancelTask({ id: q.id }, auth());
  slowQuote.resolve();
  const canceled = await until(async () => { const task = await f.facade.getTask({ id: q.id }, auth());
    return task.metadata.quoteId && task; });
  assert.equal(canceled.status.state, TaskState.TASK_STATE_CANCELED);
  await f.pay(canceled);
  await assert.rejects(f.facade.sendMessage(msg('canceled-inflight-run', {
    action: 'run', task: canceled, quoteId: canceled.metadata.quoteId,
  }), auth()));
  assert.equal(f.state.calls, 0);
});

test('cancel racing pre-dispatch validation wins before canonical executor starts', async t => {
  const barrier = deferred(); let pause = false;
  const f = await fixture(t, { override: { validate: async () => { if (pause) await barrier.promise; } } });
  const q = await f.facade.sendMessage(msg('race-quote'), auth()); await f.pay(q);
  pause = true;
  const pending = f.facade.sendMessage(msg('race-run', { action: 'run', task: q, quoteId: q.metadata.quoteId }), auth());
  await f.facade.cancelTask({ id: q.id }, auth()); barrier.resolve();
  await assert.rejects(pending);
  assert.equal((await f.facade.getTask({ id: q.id }, auth())).status.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(f.state.calls, 0);
});

test('restart after quote issuance intent fails closed instead of issuing an orphan duplicate', async t => {
  const f = await fixture(t), q = await f.facade.sendMessage(msg('quote-intent'), auth());
  // Simulate the durable intent before the quote ID could be committed.
  f.store.transition(q.id, ['awaiting'], { phase: 'quoting', quoteId: null });
  f.restart();
  const replay = await f.facade.sendMessage(msg('quote-intent'), auth());
  assert.equal(replay.metadata.phase, 'uncertain'); assert.equal(f.state.quotes, 1);
});

function wireError(response, code, reason) {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(Object.hasOwn(response, 'result'), false);
  assert.equal(response.error.code, code);
  assert.deepEqual(response.error.data, [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org',
  }]);
}

test('SDK JSON-RPC wire: all disabled push features return PushNotificationNotSupported', async t => {
  const f = await fixture(t);
  assert.equal((await f.facade.getAgentCard()).capabilities.pushNotifications, false);
  // Use actual JSON bytes and SDK server transport: the SDK client can reject
  // disabled features locally, which would otherwise hide a wrong server error.
  for (const [method, params] of [
    ['CreateTaskPushNotificationConfig', { id: 'config', taskId: 'task', url: 'https://offline.invalid/notify' }],
    ['GetTaskPushNotificationConfig', { id: 'config', taskId: 'task' }],
    ['ListTaskPushNotificationConfigs', { taskId: 'task' }],
    ['DeleteTaskPushNotificationConfig', { id: 'config', taskId: 'task' }],
  ]) wireError(await f.rpc(method, params), -32003, 'PUSH_NOTIFICATION_NOT_SUPPORTED');
  const configuredSend = SendMessageRequest.toJSON(msg('disabled-inline-push'));
  configuredSend.configuration.taskPushNotificationConfig = { id: 'config', url: 'https://offline.invalid/notify' };
  wireError(await f.rpc('SendMessage', configuredSend), -32003, 'PUSH_NOTIFICATION_NOT_SUPPORTED');
  assert.equal(f.state.quotes, 0); assert.equal(f.state.calls, 0);
});

test('SDK JSON-RPC wire: disabled extended card returns UnsupportedOperation', async t => {
  const f = await fixture(t);
  assert.equal((await f.facade.getAgentCard()).capabilities.extendedAgentCard, false);
  wireError(await f.rpc('GetExtendedAgentCard', {}), -32004, 'UNSUPPORTED_OPERATION');
  assert.equal(f.state.quotes, 0); assert.equal(f.state.calls, 0);
});

test('SDK JSON-RPC wire: new messages to terminal tasks are unsupported; cancel errors remain distinct', async t => {
  for (const phase of ['canceled', 'completed', 'failed']) {
    const f = await fixture(t, phase === 'failed' ? { onCall: async () => { throw new Error('private failure'); } } : {});
    const q = await f.facade.sendMessage(msg(`terminal-${phase}-quote`), auth());
    let run;
    if (phase === 'canceled') await f.facade.cancelTask({ id: q.id }, auth());
    else {
      await f.pay(q);
      run = msg(`terminal-${phase}-run`, { action: 'run', task: q, quoteId: q.metadata.quoteId });
      await f.facade.sendMessage(run, auth());
    }
    const newMessage = msg(`new-${phase}-run`, { action: 'run', task: q, quoteId: q.metadata.quoteId });
    wireError(await f.rpc('SendMessage', SendMessageRequest.toJSON(newMessage)), -32004, 'UNSUPPORTED_OPERATION');
    if (run) {
      // An exact retry remains a replay of the recorded operation, not a new message.
      const replay = await f.rpc('SendMessage', SendMessageRequest.toJSON(run));
      assert.equal(replay.result.task.metadata.phase, phase);
      wireError(await f.rpc('CancelTask', { id: q.id }), -32002, 'TASK_NOT_CANCELABLE');
    }
    assert.equal((await f.facade.getTask({ id: q.id }, auth())).metadata.phase, phase);
    assert.equal(f.state.quotes, 1); assert.equal(f.state.calls, phase === 'canceled' ? 0 : 1);
  }
});
