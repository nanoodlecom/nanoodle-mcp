import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargeGate } from '../../src/gate.mjs';
import { createDispatcher } from '../../src/server.mjs';
import { createNanoWorkflowBoundary } from '../../src/ecosystems/acp/nano-workflow.mjs';
import { offering } from './fixtures.mjs';

const GATE = 'nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet';
const PAYER = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
test('existing Nano x402 gate and dispatcher retain their quote/payment/result contract', async () => {
  let runs = 0;
  const receivable = {};
  const registry = {
    tools: [{ name: 'hello-noodle', description: 'offline fixture', x402: { usd: 0.4 } }],
    listTools: () => [{ name: 'hello-noodle', description: 'fixture', inputSchema: { type: 'object', properties: { Idea: { type: 'string' } } } }],
    prepareCall: async p => { assert.equal(p.name, 'hello-noodle'); assert.equal(typeof p.arguments.Idea, 'string'); },
    callTool: async () => { runs++; return { content: [{ type: 'text', text: 'Hello fixture' }], costUsd: 1 }; },
  };
  const gate = createChargeGate({ address: GATE, publicBase: 'http://pay.invalid', usd: 0.4,
    xnoUsd: 1, validate: p => registry.prepareCall(p), pollMs: 5, waitMs: 20,
    ops: { rpc: async p => p.action === 'receivable' ? { blocks: receivable } : { history: [] },
      transfer: async () => { throw Error('No wallet transfer expected'); }, pocket: async () => {} } });
  const paid = gate.wrapRegistry(registry);
  const dispatch = createDispatcher({ name: 'test', version: '0', commit: null, ...paid, log() {} });
  let stored, published;
  const workflow = createNanoWorkflowBoundary({ registry, dispatch, gate,
    resolveWorkflowDigest: async () => offering.workflowDigest,
    retainCall: async ({ call }) => { stored = call; }, recoverCall: async () => stored,
    valueNanoQuote: async ({ amountRaw }) => ({
      // Fake static $1/XNO oracle; round exact Nano raw up to a USD micro-unit.
      usdCeilingAtomic: ((BigInt(amountRaw) + 10n ** 24n - 1n) / 10n ** 24n).toString(), rateDigest: 'b'.repeat(64) }),
    reserveNanoQuote: async ({ quote }) => ({ status: 'reserved', paymentId: quote.paymentId, reservationId: 'fake-operator-reserve' }),
    confirmNanoPayment: async ({ quote }) => {
      assert.equal(runs, 0);
      // Simulated chain observation only. No signing, send or payment occurs.
      receivable['A'.repeat(64)] = { amount: quote.amountRaw, source: PAYER };
      assert.equal(await gate.waitForPayment(quote.paymentId, 1000), 'paid');
      return { paymentId: quote.paymentId, status: 'paid' };
    },
    publishResult: async ({ provenance, result }) => { published = result;
      return { resultDigest: provenance.resultDigest, deliverableRef: 'https://results.invalid/fixture' }; },
  });
  const call = { name: 'hello-noodle', arguments: { Idea: 'fixture' } };
  const quote = await workflow.quote({ call, idempotencyKey: '8453:7' });
  assert.equal(gate.quote(quote.paymentId).status, 'pending');
  assert.ok(BigInt(quote.downstreamUsdAtomic) >= 400000n); assert.equal(runs, 0);
  const reservation = await workflow.reserve({ quote, idempotencyKey: '8453:7' });
  assert.equal(gate.quote(quote.paymentId).status, 'pending');
  const result = await workflow.dispatch({ call, quote, reservation, idempotencyKey: '8453:7' });
  assert.equal(result.resultDigest.length, 64); assert.equal(runs, 1);
  assert.match(published.content[0].text, /Hello fixture/);
  assert.equal(gate.quote(quote.paymentId).status, 'consumed');
});
