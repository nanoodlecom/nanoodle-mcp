import { randomUUID } from 'node:crypto';
import { AgentCard, Task, TaskState, Role } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, TaskNotCancelableError,
  UnsupportedOperationError, PushNotificationNotSupportedError, VersionNotSupportedError } from '@a2a-js/sdk/errors';
import { offline, check, hash, copy, identifier } from './bindings.mjs';

const dataPart = value => ({ data: value, mediaType: 'application/json', filename: '' });
const bad = () => new RequestMalformedError({ message: 'Invalid Noodle A2A request or binding.' });
const unsupported = async () => { throw new UnsupportedOperationError(); };
const pushUnsupported = async () => { throw new PushNotificationNotSupportedError(); };
const phases = { quoting: TaskState.TASK_STATE_WORKING, awaiting: TaskState.TASK_STATE_INPUT_REQUIRED,
  dispatching: TaskState.TASK_STATE_WORKING, uncertain: TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED, failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED };

/** Offline qualification facade for the real Nano quote -> paid -> call contract.
 * No listener, live credential verifier, balance ledger or native A2A payments.
 * SDK ServerCallContext identity MUST be established by the trusted host; fields
 * in messages/metadata never establish an identity. Only A2A 1.0 JSON-RPC is
 * qualified here; 0.3 compatibility is deliberately not advertised.
 */
export function createOfflineA2AFacade({ mode, bindings, boundary, workflows, url = 'https://offline.invalid/a2a',
  timeoutMs = 2000 }) {
  offline(mode);
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  check(bindings && ['validate', 'issueQuote', 'describeQuote', 'dispatch', 'listTools'].every(k => typeof boundary?.[k] === 'function'));
  check(Array.isArray(workflows) && workflows.length > 0 && workflows.length <= 100);
  const available = new Set(boundary.listTools().map(t => t.name));
  const offered = new Map(workflows.map(w => {
    check(identifier(w.name) && w.name !== 'run_noodle' && available.has(w.name)
      && /^[a-f0-9]{64}$/.test(w.digest) && typeof w.description === 'string');
    return [w.name, copy(w)];
  }));
  check(offered.size === workflows.length && new URL(url).hostname.endsWith('.invalid'));
  const card = AgentCard.fromJSON({ name: 'Noodle paid workflows — OFFLINE qualification', version: '0.1.0',
    description: 'Offline fixtures only. Application payment via the existing Nano charge gate. No live endpoint.',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    securitySchemes: { hostBearer: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'host-validated' } } },
    securityRequirements: [{ schemes: { hostBearer: { list: [] } } }],
    skills: [...offered.values()].map(w => ({ id: w.name, name: w.name, description: w.description,
      tags: ['offline-fixture', 'paid-workflow'], inputModes: ['application/json'], outputModes: ['application/json'] })),
  });
  const running = new Map(), outputs = new Map();
  function scope(context) {
    offline(mode);
    if (context?.requestedVersion !== '1.0') throw new VersionNotSupportedError();
    if (!context.user?.isAuthenticated || !identifier(context.user.userName) || !identifier(context.tenant)) throw bad();
    return hash(['noodle-a2a-owner/v1', context.tenant, context.user.userName]);
  }
  function owned(id, context) {
    const owner = scope(context), r = bindings.get(id);
    if (!r || r.scope !== owner) throw new TaskNotFoundError();
    return r;
  }
  function render(r) {
    // An intent without an active local operation means restart interrupted it.
    const interrupted = ['quoting', 'dispatching'].includes(r.phase) && !running.has(r.id);
    const phase = interrupted ? 'uncertain' : r.phase;
    const metadata = { contract: 'nanoodle-a2a-offline/v1', offline: true, phase,
      requestBinding: r.callBinding, workflowDigest: r.workflowDigest, quoteId: r.quoteId ?? null,
      jobId: r.quoteId ?? null, reconciliationRequired: phase === 'uncertain',
      cancellationScope: 'local-dispatch-only; payment/refunds remain canonical',
      outputUnavailable: r.phase === 'completed' && !outputs.has(r.id),
      ...(r.receipt ? { receipt: r.receipt } : {}) };
    return Task.fromJSON({ id: r.id, contextId: r.contextId, status: { state: phases[phase],
      message: { role: Role.ROLE_AGENT, messageId: `status-${r.id}`, taskId: r.id, contextId: r.contextId,
        parts: [dataPart(metadata)] } }, artifacts: outputs.has(r.id) ? [{ artifactId: `result-${r.id}`,
          name: 'Canonical workflow result', parts: [dataPart(outputs.get(r.id))],
          metadata: { requestBinding: r.callBinding, quoteId: r.quoteId, receipt: r.receipt } }] : [], metadata });
  }
  // Bounds callback time even when an injected fixture ignores AbortSignal.
  async function bounded(fn) {
    const controller = new AbortController(); let timer;
    try { return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('A2A_TIMEOUT')); }, timeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  function launch(r, fn) {
    // Mark active synchronously before async work or the first render.
    const p = Promise.resolve().then(fn).catch(() => {
      bindings.transition(r.id, ['quoting', 'dispatching'], { phase: 'uncertain', reason: 'operation_unavailable' });
    }).finally(() => running.delete(r.id));
    running.set(r.id, p); return p;
  }
  async function view(r) {
    const task = render(bindings.get(r.id));
    if (r.quoteId && task.metadata.phase === 'awaiting') {
      try {
        task.metadata.payment = await bounded(() => boundary.describeQuote(r.quoteId, r.name));
      } catch { task.metadata.quoteUnavailable = true; }
    }
    return task;
  }
  function parse(params) {
    try {
      const m = params.message;
      if (m?.role !== Role.ROLE_USER || !identifier(m.messageId) || m.parts?.length !== 1
        || m.parts[0].content?.$case !== 'data' || m.referenceTaskIds?.length || m.extensions?.length
        || params.tenant) throw bad();
      const data = copy(m.parts[0].content.value);
      if (!data || !['quote', 'run'].includes(data.action) || !offered.has(data.name)
        || !data.arguments || Array.isArray(data.arguments) || typeof data.arguments !== 'object'
        || Object.keys(data.arguments).some(k => k.startsWith('_'))
        || Object.keys(data).some(k => !['action', 'name', 'arguments', 'quoteId'].includes(k))
        || JSON.stringify(data).length > 65536) throw bad();
      if ((m.taskId && !identifier(m.taskId)) || (m.contextId && !identifier(m.contextId))) throw bad();
      return { m, data, messageBinding: hash([m.taskId, m.contextId, data]) };
    } catch { throw bad(); }
  }
  const handler = {
    async getAgentCard() { offline(mode); return copy(card); },
    getAuthenticatedExtendedAgentCard: unsupported,
    async sendMessage(params, context) {
      const owner = scope(context);
      if (params.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
      const { m, data, messageBinding } = parse(params);
      const previous = bindings.message(owner, m.messageId);
      if (previous) {
        if (previous.binding !== messageBinding) throw bad();
        const existing = owned(previous.task, context);
        // Exact duplicate waits for the original operation only when requested.
        if (!params.configuration?.returnImmediately && running.has(existing.id)) await running.get(existing.id);
        return view(bindings.get(existing.id));
      }
      const w = offered.get(data.name), call = { name: data.name, arguments: data.arguments };
      const callBinding = hash(['noodle-a2a-call/v1', owner, w.digest, call]);
      let r;
      if (m.taskId) {
        r = owned(m.taskId, context);
        if ((m.contextId && r.contextId !== m.contextId) || r.callBinding !== callBinding) throw bad();
        if (data.action !== 'run' || data.quoteId !== r.quoteId) throw bad();
        if (r.phase !== 'awaiting') throw new UnsupportedOperationError({ message: 'Task does not accept another dispatch.' });
        // Validation is side-effect-free; after awaiting it a cancellation may
        // have won. CAS below decides which operation is allowed to proceed.
        try { await bounded(() => boundary.validate(call)); } catch { throw bad(); }
        let q;
        try { q = await bounded(() => boundary.describeQuote(r.quoteId, r.name)); } catch { throw bad(); }
        if (q.id !== r.quoteId || q.tool !== r.name || q.status !== 'paid') throw bad();
        try { bindings.claim(r, m.messageId, messageBinding); } catch {
          const duplicate = bindings.message(owner, m.messageId);
          if (duplicate?.task !== r.id || duplicate.binding !== messageBinding) throw bad();
          if (!params.configuration?.returnImmediately && running.has(r.id)) await running.get(r.id);
          return view(owned(r.id, context));
        }
        if (!bindings.transition(r.id, ['awaiting'], { phase: 'dispatching' })) throw bad();
        const operation = launch(r, async () => {
          const result = await bounded(signal => boundary.dispatch({ call, quoteId: r.quoteId,
            requestBinding: r.callBinding, taskId: r.id, contextId: r.contextId, signal }));
          // The transport does not reinterpret text receipts as payment proof.
          // This hash binds the exact canonical outcome to the task and quote.
          check(result && Array.isArray(result.content) && !result.structuredContent?.x402);
          const receipt = { source: 'canonical-charge-gate', quoteId: r.quoteId, taskId: r.id,
            contextId: r.contextId, requestBinding: r.callBinding, resultSha256: hash(result),
            settlement: 'canonical-result-returned; not independently verified', offline: true };
          if (bindings.transition(r.id, ['dispatching'], { phase: result.isError ? 'failed' : 'completed', receipt })) {
            // Keep paid user output in memory only, like canonical text policy.
            // Failure text can contain prompts/secrets; return a fixed category.
            outputs.set(r.id, result.isError ? { isError: true, content: [{ type: 'text', text: 'Workflow failed; inspect canonical settlement.' }] } : copy(result));
          }
        });
        if (!params.configuration?.returnImmediately) await operation;
      } else {
        if (data.action !== 'quote' || data.quoteId !== undefined) throw bad();
        try { await bounded(() => boundary.validate(call)); } catch { throw bad(); }
        r = { id: randomUUID(), contextId: m.contextId || randomUUID(), scope: owner, name: data.name,
          workflowDigest: w.digest, callBinding, phase: 'quoting', firstMessageId: m.messageId };
        try { bindings.claim(r, m.messageId, messageBinding); } catch {
          // Another identical concurrent message may have claimed during validation.
          const duplicate = bindings.message(owner, m.messageId);
          if (duplicate?.binding === messageBinding) {
            if (!params.configuration?.returnImmediately && running.has(duplicate.task)) await running.get(duplicate.task);
            return view(owned(duplicate.task, context));
          }
          throw bad();
        }
        const operation = launch(r, async () => {
          const q = await bounded(signal => boundary.issueQuote(call, { requestBinding: r.callBinding, signal }));
          check(identifier(q.quoteId));
          // If cancellation won while quoting, retain the ID for reconciliation
          // but never make the canceled task dispatchable again.
          if (!bindings.transition(r.id, ['quoting'], { phase: 'awaiting', quoteId: q.quoteId })) {
            bindings.transition(r.id, ['canceled'], { quoteId: q.quoteId });
          }
        });
        if (!params.configuration?.returnImmediately) await operation;
      }
      return view(bindings.get(r.id));
    },
    async getTask(params, context) { return view(owned(params.id, context)); },
    async cancelTask(params, context) {
      const r = owned(params.id, context);
      if (r.phase === 'canceled') return view(r);
      if (!bindings.transition(r.id, ['quoting', 'awaiting'], { phase: 'canceled' })) throw new TaskNotCancelableError();
      // Canonical charge gate has no cancel/refund API. Never invent a refund,
      // never release money, never abort an already-dispatched paid workflow.
      return view(bindings.get(r.id));
    },
    listTasks: unsupported, createTaskPushNotificationConfig: pushUnsupported, getTaskPushNotificationConfig: pushUnsupported,
    listTaskPushNotificationConfigs: pushUnsupported, deleteTaskPushNotificationConfig: pushUnsupported,
    async *sendMessageStream() { throw new UnsupportedOperationError(); },
    async *resubscribe() { throw new UnsupportedOperationError(); },
  };
  return Object.freeze(handler);
}
