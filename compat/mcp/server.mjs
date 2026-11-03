/** Opt-in SDK façade. Payment state and execution belong to the injected charge gate. */
import { Server, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export const ADAPTER_VERSION = '0.1.0';
export const PROVENANCE_KEY = 'com.nanoodle/mcp-compat';
const PAYMENT_ID = /^pay_[A-Za-z0-9_-]{12}$/;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * paidRegistry MUST be the bound {listTools, callTool} returned by
 * createChargeGate(...).wrapRegistry(registry), sharing the canonical gate's
 * stateFile. Never pass an ungated registry or fabricate payment verification.
 * Create one Server per transport/client; share only the canonical charge gate.
 */
export function createCompatibilityServer({ paidRegistry, version, revision, timeoutMs = 30_000 }) {
  if (!paidRegistry || typeof paidRegistry.listTools !== 'function' || typeof paidRegistry.callTool !== 'function') {
    throw new TypeError('A canonical paid registry is required');
  }
  if (typeof version !== 'string' || !version || !/^[0-9a-f]{40}$/.test(revision || '')) {
    throw new TypeError('Supply the package version and full source revision');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('timeoutMs must be 1..300000');
  }
  const tools = () => {
    const catalog = paidRegistry.listTools();
    // Fail closed on accidentally injected free registries. This shape check is
    // an integration guard, not a substitute for the charge gate's enforcement.
    if (!Array.isArray(catalog) || catalog.some(t => !t?.inputSchema?.properties?._payment_id || t.name === 'run_noodle')) {
      throw new Error('Only the canonical charge-gated catalog may be exposed');
    }
    return catalog.map(t => ({ ...t, annotations: {
      ...t.annotations, readOnlyHint: false, destructiveHint: true,
      idempotentHint: false, openWorldHint: true,
    } })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  tools(); // refuse wiring errors before connecting
  const server = new Server({ name: 'nanoodle-mcp-compat', version }, {
    capabilities: { tools: {} },
    supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
    instructions: 'Paid Nano workflows. Call to obtain a quote, show only its payUrl to the user, ' +
      'watch payment using its agent-only watchUrl, then call identical arguments with _payment_id. ' +
      'Never automatically pay, create a replacement quote, or retry an uncertain call with a new payment ID. ' +
      'Timeout/disconnect/cancellation do not prove cancellation, failure, refund, or settlement.',
  });
  const provenance = (paymentId, outcome) => ({ adapterVersion: ADAPTER_VERSION,
    sourceRevision: revision, packageVersion: version, outcome,
    ...(paymentId ? { paymentId } : {}),
  });
  const uncertain = (paymentId, reason) => ({
    isError: true,
    content: [{ type: 'text', text: reason + ' Payment and execution outcome must be reconciled with the operator/canonical gate. ' +
      (paymentId ? 'Keep this _payment_id and identical arguments; never pay again or request a replacement quote automatically.' :
        'No payment ID was returned. Do not automatically repeat the call or make a payment.') }],
    structuredContent: { status: 'outcome_unknown', automaticRetry: false,
      ...(paymentId ? { paymentId } : {}) },
    _meta: { [PROVENANCE_KEY]: provenance(paymentId, 'outcome_unknown') },
  });

  async function invoke(params, { signal } = {}) {
    if (!object(params) || typeof params.name !== 'string' ||
        (params.arguments !== undefined && !object(params.arguments)) ||
        !tools().some(t => t.name === params.name)) {
      throw new ProtocolError(-32602, 'Invalid workflow tool or arguments');
    }
    const paymentId = params.arguments?._payment_id;
    if (paymentId !== undefined && (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId))) {
      throw new ProtocolError(-32602, 'Invalid payment ID');
    }
    if (signal?.aborted) return uncertain(paymentId, 'Request cancelled before dispatch.');
    const controller = new AbortController();
    let timer, abort;
    const stopped = new Promise(resolve => {
      abort = () => { controller.abort(); resolve(uncertain(paymentId, 'Request cancelled.')); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort(); resolve(uncertain(paymentId, 'Request timed out.'));
      }, timeoutMs);
    });
    // Canonical gate currently ignores cancellation during a paid run. Keep its
    // promise alive: abandoning the wait must not release/reissue a reservation.
    const execution = Promise.resolve().then(async () => {
      // invoke() returns before this microtask runs. Cancellation can arrive in
      // that gap, so check again at the actual dispatch boundary, with no await
      // between the check and the canonical gate call.
      if (controller.signal.aborted) return uncertain(paymentId, 'Request cancelled before dispatch.');
      const result = await paidRegistry.callTool({
        name: params.name, arguments: params.arguments ?? {},
      }, { signal: controller.signal, streaming: false });
      if (!object(result) || !Array.isArray(result.content) || result.isError) {
        return uncertain(paymentId, 'The workflow did not return a successful result.');
      }
      // Preserve canonical x402 quote objects, output blocks and payment receipt;
      // strip gate-only cost sidecars. Adapter provenance is not a chain receipt.
      return { content: result.content,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        _meta: { ...result._meta, [PROVENANCE_KEY]: provenance(paymentId, 'returned') },
      };
    }).catch(error => {
      if (error?.mcpCode === -32602) throw new ProtocolError(-32602, 'Invalid workflow tool arguments');
      return uncertain(paymentId, 'The workflow could not return an outcome.');
    });
    try { return await Promise.race([execution, stopped]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  server.setRequestHandler('tools/list', async () => ({ tools: tools(), ttlMs: 0, cacheScope: 'private' }));
  server.setRequestHandler('tools/call', async (request, ctx) => server.projectCallToolResult(
    await invoke(request.params, { signal: ctx.mcpReq.signal }), undefined));
  return { server, invoke };
}

/** Official era-selecting entry: do not hand-connect the low-level Server. */
export function serveCompatibility(options, transportOptions = {}) {
  return serveStdio(() => createCompatibilityServer(options).server, transportOptions);
}
