import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex, decodeFunctionData } from 'viem';
import { fixture, sdk, message, system, encodedLog, client, provider, evaluator, economics, contract, blockHash } from './fixtures.mjs';
import { createAcpSeller, validateEconomics } from '../../src/ecosystems/acp/seller.mjs';
import { openAcpJournal } from '../../src/ecosystems/acp/journal.mjs';

const funded = async f => { assert.equal((await f.request()).state, 'awaiting_funding'); f.fund(); };
const event = async f => f.seller.handle(f.session, system('job.funded'));
const completeLogs = f => {
  const r = f.journal.get('8453:7');
  f.state.raw.status = 3;
  f.state.logs.push(encodedLog('JobSubmitted', { jobId: 7n, provider, deliverable: r.deliverableHash }),
    encodedLog('JobCompleted', { jobId: 7n, evaluator, reason: '0x' + '00'.repeat(32) }),
    encodedLog('PaymentReleased', { jobId: 7n, provider, amount: 950000n }));
};

test('inactive by default; live mode, unknown platform fees and negative economics fail closed', async () => {
  assert.deepEqual(await createAcpSeller({}).handle(), { status: 'disabled' });
  assert.throws(() => createAcpSeller({ enabled: true, mode: 'live' }), /LIVE_NOT_IMPLEMENTED/);
  assert.throws(() => validateEconomics({ ...economics, platformFeeBps: null }), /FEES_REQUIRED/);
  assert.throws(() => validateEconomics({ ...economics, platformFeeBps: 10000 }), /FEES_REQUIRED/);
  assert.throws(() => validateEconomics({ ...economics, priceAtomic: '100' }), /MARGIN_BELOW_FLOOR/);
});

test('real SDK session + real dispatcher: quote, exact funding, one result receipt, evaluator revenue', async t => {
  const f = await fixture(); t.after(() => f.close());
  const quoted = await f.request(); assert.equal(quoted.state, 'awaiting_funding');
  assert.equal(f.state.count.dispatch, 0);
  f.fund();
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => event(f)));
  assert.ok(outcomes.every(r => r.state === 'submitted'));
  assert.deepEqual(f.state.count, { quote: 1, reserve: 1, dispatch: 1, budget: 1, submit: 1, publish: 1 });
  const receipt = JSON.parse(f.state.submitted);
  assert.equal(receipt.funding.earned, false);
  assert.equal(receipt.downstreamPaymentId, 'pay_fixture');
  assert.equal(receipt.resultDigest.length, 64);
  assert.equal(receipt.deliverableRef, 'https://results.invalid/greeting');
  assert.equal(f.journal.get('8453:7').evaluatorReceipt, undefined);
  completeLogs(f);
  const done = await f.seller.handle(f.session, system('job.completed'));
  assert.equal(done.state, 'completed'); assert.equal(done.evaluatorReceipt.releasedAtomic, '950000');
  assert.equal(done.evaluatorReceipt.profit, null);
  await f.restart();
  assert.equal((await event(f)).state, 'completed');
  assert.equal(f.state.count.submit, 1);
  const disk = readFileSync(`${f.dir}/jobs.json`, 'utf8');
  assert.ok(!disk.includes('Ada') && !disk.includes('Hello') && !disk.includes('SECRET'));
});

test('actual SDK AcpAgent entry callback over fake transport, no fetch or wallet signer', async t => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('network forbidden'); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const f = await fixture({ start: true }); t.after(() => f.close());
  f.transport.emit(message());
  for (let i = 0; i < 50 && f.journal.get('8453:7')?.state !== 'awaiting_funding'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.journal.get('8453:7').state, 'awaiting_funding');
  f.fund(); f.transport.emit(system('job.funded'));
  for (let i = 0; i < 50 && f.journal.get('8453:7')?.state !== 'submitted'; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.journal.get('8453:7').state, 'submitted');
  assert.equal(f.state.count.submit, 1);
});

test('funded event before requirement does not authorize guessed inputs; replay cannot regress chain truth', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.equal((await event(f)).state, 'awaiting_requirement');
  await funded(f);
  f.session.appendEntry(system('job.funded')); f.session.appendEntry(system('job.created'));
  assert.equal(f.session.status, 'open'); // SDK-derived status can regress under reordering.
  assert.equal((await event(f)).state, 'submitted');
  assert.equal((await f.seller.handle(f.session, system('job.created'))).state, 'submitted');
  assert.equal(f.state.count.dispatch, 1);
});

test('notification alone is not funding; exact amount and canonical contract logs are required', async t => {
  for (const variant of ['notification', 'wrong_amount', 'wrong_log_amount', 'wrong_contract', 'wrong_client', 'wrong_job', 'removed', 'fork', 'no_log']) {
    await t.test(variant, async t => {
      const f = await fixture(); t.after(() => f.close()); await f.request();
      if (variant === 'notification') { assert.equal((await event(f)).state, 'awaiting_funding'); }
      else {
        f.fund(variant === 'wrong_amount' ? 999999n : 1000000n);
        const log = f.state.logs[0];
        if (variant === 'wrong_contract') log.address = client;
        if (variant === 'wrong_log_amount') f.state.logs = [encodedLog('JobFunded', { jobId: 7n, client, amount: 42n })];
        if (variant === 'wrong_client') f.state.logs = [encodedLog('JobFunded', { jobId: 7n, client: provider, amount: 1000000n })];
        if (variant === 'wrong_job') f.state.logs = [encodedLog('JobFunded', { jobId: 8n, client, amount: 1000000n })];
        if (variant === 'removed') log.removed = true;
        if (variant === 'fork') log.blockHash = '0x' + '99'.repeat(32);
        if (variant === 'no_log') f.state.logs = [];
        assert.equal((await event(f)).state, 'review_required');
      }
      assert.equal(f.state.count.dispatch, 0); assert.equal(f.state.count.submit, 0);
    });
  }
});

test('spoofed buyer, unknown fields, malformed requirement and self evaluator are rejected before quote', async t => {
  for (const m of [message('{"Idea":"Ada"}', provider), message('{"_payment_id":"bad"}'), message('{"Idea":2}'), message('not json')]) {
    const f = await fixture(); t.after(() => f.close());
    assert.equal((await f.seller.handle(f.session, m)).state, 'rejected_input');
    assert.equal(f.state.count.quote, 0);
  }
  const f = await fixture(); t.after(() => f.close()); f.state.raw.evaluator = provider;
  assert.equal((await f.request()).state, 'rejected_input');
  assert.equal(f.state.count.quote, 0);
});

test('changed input on requirement replay and immutable workflow binding cannot dispatch', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f);
  assert.equal((await f.seller.handle(f.session, message('{"Idea":"Mallory"}'))).state, 'review_required');
  assert.equal(f.state.count.dispatch, 0);
  const g = await fixture(); t.after(() => g.close()); await funded(g); g.state.raw.description = 'different';
  assert.equal((await event(g)).state, 'review_required'); assert.equal(g.state.count.dispatch, 0);
});

test('quote and ACP expiry gate dispatch; expiry during reserve cannot start paid work', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f);
  f.state.now += 600001;
  assert.equal((await event(f)).state, 'review_required'); assert.equal(f.state.count.dispatch, 0);
  let g;
  g = await fixture({ overrides: { reserve: async ({ quote }) => { g.state.now += 600001;
    return { status: 'reserved', paymentId: quote.paymentId, reservationId: 'fixture' }; } } });
  t.after(() => g.close()); await funded(g);
  assert.equal((await event(g)).state, 'review_required'); assert.equal(g.state.count.dispatch, 0);
});

test('successful restart resumes awaiting funds; intent crashes do not replay unknown effects', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.request(); await f.restart(); f.fund();
  assert.equal((await event(f)).state, 'submitted');
  for (const state of ['quote_intent', 'budget_intent', 'reserve_intent', 'dispatch_intent', 'submit_intent']) {
    const g = await fixture(); t.after(() => g.close()); await funded(g);
    const before = { ...g.state.count }; const record = g.journal.get('8453:7');
    g.journal.put('8453:7', { ...record, state }); await g.restart();
    assert.equal((await event(g)).state, 'review_required');
    assert.deepEqual(g.state.count, before);
  }
});

test('persisted ready result submits once after restart without downstream rerun', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f);
  const record = f.journal.get('8453:7');
  // Seed the durable checkpoint left by a previous process after publication,
  // before its first submit intent. No SDK submission has happened in this process.
  const deliverable = JSON.stringify({ schema: 'nanoodle.acp.service.v1', jobId: '7',
    deliverableRef: 'https://results.invalid/restored', resultDigest: 'd'.repeat(64) });
  f.journal.put('8453:7', { ...record, state: 'ready', deliverable,
    deliverableHash: sdk.hashDeliverable(deliverable), resultDigest: 'd'.repeat(64) });
  await f.restart(); assert.equal((await event(f)).state, 'submitted');
  assert.equal(f.state.count.dispatch, 0); assert.equal(f.state.count.submit, 1);
  assert.equal((await event(f)).state, 'submitted'); assert.equal(f.state.count.submit, 1);
});

test('downstream exception is safe and uncertain; failure never resubmits/refunds/claims profit', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f); f.state.error = true;
  const r = await event(f); assert.equal(r.state, 'review_required');
  assert.ok(!JSON.stringify(r).includes('SECRET')); assert.equal(f.state.count.submit, 0);
  await f.restart(); await event(f);
  assert.equal(f.state.count.dispatch, 1); assert.equal(f.journal.get('8453:7').evaluatorReceipt, undefined);
});

test('timeout and cancellation retain uncertainty and block later ignored-abort completion', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture({ timeoutMs: cancel ? 1000 : 20 }); t.after(() => f.close()); await funded(f);
    let release; f.state.pendingDispatch = new Promise(r => { release = r; });
    const operation = event(f);
    if (cancel) {
      while (!f.state.count.dispatch) await new Promise(r => setTimeout(r, 1));
      f.seller.cancel(8453, '7');
    }
    assert.equal((await operation).state, 'review_required');
    release(); await new Promise(r => setTimeout(r, 5));
    assert.equal(f.state.count.submit, 0); assert.equal((await event(f)).state, 'review_required');
    assert.equal(f.state.count.dispatch, 1);
  }
});

test('uncertain SDK submission resolves only from finalized evaluator and matching deliverable evidence', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f); f.state.submitError = true;
  assert.equal((await event(f)).state, 'review_required'); assert.equal(f.state.count.submit, 1);
  await f.restart(); assert.equal((await event(f)).state, 'review_required');
  completeLogs(f);
  assert.equal((await f.seller.handle(f.session, system('job.completed'))).state, 'completed');
  assert.equal(f.state.count.submit, 1); assert.equal(f.state.count.dispatch, 1);
});

test('spoof completion cannot earn revenue; evaluator rejection records loss exposure', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f); await event(f);
  assert.equal((await f.seller.handle(f.session, system('job.completed'))).state, 'submitted');
  assert.equal(f.journal.get('8453:7').evaluatorReceipt, undefined);
  f.state.raw.status = 4;
  f.state.logs.push(encodedLog('JobRejected', { jobId: 7n, rejector: evaluator, reason: '0x' + '00'.repeat(32) }));
  const r = await f.seller.handle(f.session, system('job.rejected'));
  assert.equal(r.state, 'rejected'); assert.equal(r.lossReviewRequired, true);
  assert.equal(r.evaluatorReceipt.releasedAtomic, '0'); assert.equal(r.evaluatorReceipt.profit, null);
  await f.restart(); assert.equal((await event(f)).state, 'rejected'); assert.equal(f.state.count.dispatch, 1);
});

test('journal exclusive lock, tampered proof binding, hook jobs and wrong chain fail closed', async t => {
  const f = await fixture(); t.after(() => f.close());
  assert.throws(() => openAcpJournal(`${f.dir}/jobs.json`), /EEXIST/);
  f.state.raw.hook = client;
  assert.equal((await f.request()).state, 'rejected_input');
  f.state.raw.hook = '0x' + '00'.repeat(20); f.state.chainId = 1;
  assert.equal((await f.request()).state, 'rejected_input'); assert.equal(f.state.count.quote, 0);
});

test('SDK ABI submission hash matches adapter receipt hash and event decoder', async () => {
  // Exercise the actual EvmAcpClient call encoder with a fake read-only provider.
  const evm = await sdk.EvmAcpClient.create({ contractAddresses: { 8453: contract },
    provider: { getSupportedChainIds: async () => [8453], getNetworkContext: async () => ({ network: 'mainnet' }) } });
  const content = '{"schema":"nanoodle.acp.service.v1"}';
  const prepared = await evm.submit(8453, { jobId: 7n, deliverable: content });
  const data = prepared.tx[0].data;
  const decoded = decodeFunctionData({ abi: sdk.ACP_ABI, data });
  assert.equal(decoded.functionName, 'submit');
  assert.equal(decoded.args[1], sdk.hashDeliverable(content));
  assert.equal(decoded.args[1], keccak256(toHex(content)));
});

test('real SDK offering requirement schema rejects other input names before any job creation', async t => {
  const f = await fixture(); t.after(() => f.close());
  const draft = JSON.parse(readFileSync(new URL('./offering.draft.json', import.meta.url), 'utf8'));
  assert.equal(draft.requiredFunds, false); assert.equal(draft.priceType, 'fixed');
  assert.equal(draft.priceValue * 1e6, Number(economics.priceAtomic));
  await assert.rejects(f.agent.createJobFromOffering(8453, draft, provider,
    { Unknown: 'wrong input' }, { evaluatorAddress: evaluator }), /[Vv]alid|Idea|requirement/);
  assert.equal(f.state.count.budget, 0); assert.equal(f.state.count.dispatch, 0);
});

test('expiry while downstream work runs retains the receipt but cannot submit', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f);
  let release; f.state.pendingDispatch = new Promise(r => { release = r; });
  const operation = event(f);
  while (!f.state.count.dispatch) await new Promise(r => setTimeout(r, 1));
  f.state.now += 600001; release();
  const record = await operation;
  assert.equal(record.state, 'review_required'); assert.equal(f.state.count.dispatch, 1);
  assert.equal(f.state.count.submit, 0); assert.ok(record.deliverableHash);
});

test('completion with another deliverable hash never records released revenue', async t => {
  const f = await fixture(); t.after(() => f.close()); await funded(f); await event(f);
  completeLogs(f);
  f.state.logs = f.state.logs.filter(log => log.topics[0] !== encodedLog('JobSubmitted', {
    jobId: 7n, provider, deliverable: '0x' + '00'.repeat(32) }).topics[0]);
  f.state.logs.push(encodedLog('JobSubmitted', { jobId: 7n, provider, deliverable: '0x' + '00'.repeat(32) }));
  const record = await f.seller.handle(f.session, system('job.completed'));
  assert.equal(record.state, 'review_required'); assert.equal(record.evaluatorReceipt, undefined);
  assert.equal(f.state.count.submit, 1);
});
