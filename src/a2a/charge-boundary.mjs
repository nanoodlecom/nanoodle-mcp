import { check, offline, copy } from './bindings.mjs';

/** Actual existing Nano charge-gate seam, deliberately NOT installed by the CLI.
 * Caller must supply an offline scripted createChargeGate and its registry.
 * gate.wrapRegistry owns quoting, payment detection, execution and settlement.
 * This module never verifies a client payment assertion or invokes the raw
 * registry executor, and never touches the downstream NanoGPT x402 hook.
 */
export function createOfflineChargeBoundary({ mode, gate, registry }) {
  offline(mode);
  check(typeof gate?.quote === 'function' && typeof gate?.wrapRegistry === 'function'
    && typeof registry?.prepareCall === 'function');
  const paid = gate.wrapRegistry(registry);
  return Object.freeze({
    listTools: () => paid.listTools(),
    async validate(call) { offline(mode); await registry.prepareCall(copy(call)); },
    async issueQuote(call) {
      offline(mode);
      const result = await paid.callTool(copy(call));
      const quoteId = result?.structuredContent?.x402?.paymentId;
      check(typeof quoteId === 'string' && gate.quote(quoteId)?.tool === call.name);
      return { quoteId };
    },
    async describeQuote(quoteId, name) {
      offline(mode);
      const q = gate.quote(quoteId);
      check(q && q.id === quoteId && q.tool === name);
      // Authoritative canonical projection, not a second payment ledger.
      return copy(q);
    },
    async dispatch({ call, quoteId }) {
      offline(mode);
      const q = gate.quote(quoteId);
      check(q?.id === quoteId && q.tool === call.name && q.status === 'paid');
      return paid.callTool({ name: call.name, arguments: { ...copy(call.arguments), _payment_id: quoteId } });
    },
  });
}
