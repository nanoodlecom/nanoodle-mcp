import { check, hash, uint } from './journal.mjs';

/** Existing Nano gate protocol bridge. No wallet / Nano transfer is implemented.
 * reserveNanoQuote must reserve OPERATOR liquidity durably under idempotencyKey.
 * confirmNanoPayment must check the real downstream quote, never ACP escrow.
 * Both are deliberately required injections until the common production seam exists.
 */
export function createNanoWorkflowBoundary({ registry, dispatch, gate, resolveWorkflowDigest,
  reserveNanoQuote, confirmNanoPayment, publishResult, retainCall, recoverCall, valueNanoQuote }) {
  check([registry?.prepareCall, dispatch, gate?.quote, resolveWorkflowDigest,
    reserveNanoQuote, confirmNanoPayment, publishResult, retainCall, recoverCall, valueNanoQuote].every(x => typeof x === 'function'), 'NANO_BOUNDARY_REQUIRED');
  return Object.freeze({
    async quote({ call, idempotencyKey, signal }) {
      signal?.throwIfAborted();
      await registry.prepareCall(call);
      await retainCall({ call, callDigest: hash(call), idempotencyKey, signal });
      const workflowDigest = await resolveWorkflowDigest(call);
      check(/^[a-f0-9]{64}$/.test(workflowDigest), 'WORKFLOW_BINDING_REQUIRED');
      signal?.throwIfAborted();
      const reply = await dispatch({ jsonrpc: '2.0', id: idempotencyKey, method: 'tools/call', params: call }, { signal });
      const q = reply?.result?.structuredContent?.x402;
      check(!reply?.error && q && typeof q.paymentId === 'string' && /^pay_[A-Za-z0-9_-]{1,96}$/.test(q.paymentId) && uint(q.amountRaw)
        && BigInt(q.amountRaw) > 0n && Number.isFinite(q.amountUsd) && q.amountUsd > 0
        && Number.isSafeInteger(Math.ceil(q.amountUsd * 1e6))
        && Number.isFinite(Date.parse(q.expiresAt)), 'NANO_QUOTE_INVALID');
      const authoritative = gate.quote(q.paymentId);
      check(authoritative?.status === 'pending' && authoritative.tool === call.name
        && authoritative.amountRaw === q.amountRaw && authoritative.expiresAt === q.expiresAt, 'NANO_QUOTE_MISMATCH');
      // amountUsd excludes Nano's amount-tag dust; valuation must cover the
      // exact raw amount at the operator's locked quote rate plus any overhead.
      const valuation = await valueNanoQuote({ paymentId: q.paymentId, amountRaw: q.amountRaw,
        displayedUsd: q.amountUsd, idempotencyKey, signal });
      check(uint(valuation?.usdCeilingAtomic) && /^[a-f0-9]{64}$/.test(valuation.rateDigest), 'NANO_VALUATION_REQUIRED');
      return { paymentId: q.paymentId, amountRaw: q.amountRaw, expiresAt: Date.parse(q.expiresAt),
        downstreamUsdAtomic: valuation.usdCeilingAtomic, rateDigest: valuation.rateDigest, workflowDigest };
    },
    recoverCall,
    async reserve({ quote, idempotencyKey, signal }) {
      return reserveNanoQuote({ quote, idempotencyKey, signal });
    },
    async dispatch({ call, quote, reservation, idempotencyKey, signal }) {
      signal?.throwIfAborted();
      check(await resolveWorkflowDigest(call) === quote.workflowDigest, 'WORKFLOW_CHANGED');
      signal?.throwIfAborted();
      const evidence = await confirmNanoPayment({ quote, reservation, idempotencyKey, signal });
      check(evidence?.paymentId === quote.paymentId && evidence?.status === 'paid'
        && gate.quote(quote.paymentId)?.status === 'paid', 'NANO_PAYMENT_UNVERIFIED');
      signal?.throwIfAborted();
      const reply = await dispatch({ jsonrpc: '2.0', id: idempotencyKey, method: 'tools/call',
        params: { name: call.name, arguments: { ...call.arguments, _payment_id: quote.paymentId } } }, { signal });
      check(!reply?.error && reply?.result && !reply.result.isError && !reply.result.structuredContent?.x402, 'NANO_OUTCOME_UNCERTAIN');
      // Publisher chooses an explicitly customer-shareable artifact reference;
      // no raw model result, prompt, or local file path enters the ACP journal.
      signal?.throwIfAborted();
      return publishResult({ result: reply.result, idempotencyKey, signal,
        provenance: { paymentId: quote.paymentId, workflowDigest: quote.workflowDigest, resultDigest: hash(reply.result) } });
    },
  });
}
