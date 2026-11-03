import { check, hash, copy, uint, address, same, ZERO } from './journal.mjs';

export function validateEconomics(e) {
  check(e && Number.isSafeInteger(e.platformFeeBps) && e.platformFeeBps >= 0 && e.platformFeeBps < 10000,
    'PLATFORM_FEES_REQUIRED');
  for (const k of ['priceAtomic', 'maxDownstreamUsdAtomic', 'maxConversionUsdAtomic', 'maxNetworkUsdAtomic', 'minMarginUsdAtomic'])
    check(uint(e[k]) && BigInt(e[k]) <= BigInt(Number.MAX_SAFE_INTEGER), 'ECONOMICS_CONFIG_REQUIRED');
  check(BigInt(e.priceAtomic) > 0n, 'ECONOMICS_CONFIG_REQUIRED');
  const price = BigInt(e.priceAtomic);
  const fee = (price * BigInt(e.platformFeeBps) + 9999n) / 10000n;
  check(price - fee - BigInt(e.maxDownstreamUsdAtomic) - BigInt(e.maxConversionUsdAtomic)
    - BigInt(e.maxNetworkUsdAtomic) >= BigInt(e.minMarginUsdAtomic), 'MARGIN_BELOW_FLOOR');
  return { platformFeeEstimateAtomic: fee.toString() };
}

/** Inactive by default, OFFLINE QUALIFICATION ONLY. Does not create/start agents,
 * register offerings, construct providers/signers, transfer funds or approve jobs.
 * SDK and all effects are injected; SDK package is isolated under qualification/.
 */
export function createAcpSeller({ enabled = false, mode = 'disabled', sdk, journal, readJob,
  workflow, offering, economics, now = Date.now, timeoutMs = 5000 }) {
  if (!enabled) return Object.freeze({ handle: async () => ({ status: 'disabled' }) });
  check(mode === 'offline-qualification' && process.env.NODE_ENV !== 'production', 'ACP_LIVE_NOT_IMPLEMENTED');
  validateEconomics(economics);
  check(offering && typeof offering.name === 'string' && offering.name.length > 0 && offering.name.length <= 120
    && typeof offering.tool === 'string' && offering.tool !== 'run_noodle'
    && /^[a-f0-9]{64}$/.test(offering.workflowDigest) && address(offering.provider)
    && Array.isArray(offering.inputNames) && offering.inputNames.length > 0
    && offering.inputNames.every(k => /^[A-Za-z][A-Za-z0-9_-]*$/.test(k))
    && Array.isArray(offering.resultHosts) && offering.resultHosts.length > 0
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'OFFERING_CONFIG_REQUIRED');
  check(typeof readJob === 'function' && journal && workflow && sdk, 'ACP_BOUNDARY_REQUIRED');
  // Detach all operator configuration from caller-owned mutable objects.
  offering = copy(offering); economics = Object.fromEntries(['priceAtomic', 'platformFeeBps',
    'maxDownstreamUsdAtomic', 'maxConversionUsdAtomic', 'maxNetworkUsdAtomic', 'minMarginUsdAtomic']
    .map(k => [k, economics[k]]));
  const queues = new Map(), active = new Map(), cancelled = new Set();
  const keyOf = session => `${session.chainId}:${session.jobId}`;
  const save = (key, record, state, extra = {}) => journal.put(key, { ...record, ...extra, state });
  async function bounded(key, fn) {
    check(!cancelled.has(key), 'ACP_OPERATION_INTERRUPTED');
    const controller = new AbortController(); active.set(key, controller);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(controller.signal)),
        new Promise((_, reject) => {
          const fail = () => reject(new Error('ACP_OPERATION_INTERRUPTED'));
          controller.signal.addEventListener('abort', fail, { once: true });
          timer = setTimeout(() => controller.abort(), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); active.delete(key); }
  }
  function bindJob(job, session) {
    check(job.chainId === 8453 && session.chainId === 8453 && String(job.id) === session.jobId
      && same(job.provider, offering.provider) && address(job.client) && address(job.evaluator)
      && !same(job.evaluator, offering.provider) && !same(job.client, offering.provider)
      && same(job.hook, ZERO) && job.description === offering.name
      && typeof job.expiredAt === 'bigint' && typeof job.budget === 'bigint'
      && job.provenance?.source === 'finalized_rpc', 'ACP_JOB_BINDING_INVALID');
    return { chainId: 8453, jobId: session.jobId, client: job.client.toLowerCase(),
      evaluator: job.evaluator.toLowerCase(), provider: job.provider.toLowerCase(),
      expiry: job.expiredAt.toString(), offering: offering.name, workflowDigest: offering.workflowDigest };
  }
  function funded(job) {
    check(job.status === 1 && job.budget === BigInt(economics.priceAtomic)
      && Number(job.expiredAt) * 1000 > now(), 'ACP_NOT_FUNDED_OR_EXPIRED');
    const event = job.events.find(e => e.name === 'JobFunded'
      && same(e.args.client, job.client) && e.args.amount === job.budget);
    check(event, 'ACP_FUNDING_UNVERIFIED');
    return { transactionHash: event.transactionHash, blockHash: event.blockHash,
      blockNumber: event.blockNumber, amountAtomic: job.budget.toString(), asset: 'USDC', earned: false };
  }
  function terminal(key, r, job) {
    const states = { 3: 'completed', 4: 'rejected', 5: 'expired' };
    const state = states[job.status];
    if (!state) return null;
    if (r.state === 'completed' || r.state === 'rejected' || r.state === 'expired') return r;
    if (state === 'completed') {
      const completed = job.events.find(e => e.name === 'JobCompleted' && same(e.args.evaluator, job.evaluator));
      const released = job.events.find(e => e.name === 'PaymentReleased' && same(e.args.provider, offering.provider));
      // Submission is an external effect with an uncertain return. The confirmed
      // submitted hash resolves it without submitting or dispatching again.
      const submitted = job.events.find(e => e.name === 'JobSubmitted'
        && same(e.args.provider, offering.provider) && e.args.deliverable === r.deliverableHash);
      check(r.deliverableHash && completed && released && submitted
        && typeof released.args.amount === 'bigint' && released.args.amount >= 0n
        && released.args.amount <= BigInt(economics.priceAtomic), 'ACP_COMPLETION_UNVERIFIED');
      return save(key, r, state, { evaluatorReceipt: { transactionHash: completed.transactionHash,
        releasedAtomic: released.args.amount.toString(), asset: 'USDC',
        // Net provider revenue is not profit: downstream, FX, gas and loss
        // reconciliation remain necessary even after evaluator approval.
        profit: null }, reviewCode: null });
    }
    const event = job.events.find(e => e.name === (state === 'rejected' ? 'JobRejected' : 'JobExpired')
      && (state !== 'rejected' || same(e.args.rejector, job.evaluator)));
    check(event, 'ACP_TERMINAL_UNVERIFIED');
    return save(key, r, state, { evaluatorReceipt: { transactionHash: event.transactionHash,
      releasedAtomic: '0', asset: 'USDC', profit: null },
      lossReviewRequired: !!r.funding, reviewCode: null });
  }
  async function processEntry(session, entry) {
    const key = keyOf(session);
    check(session instanceof sdk.JobSession && session.roles.includes('provider')
      && !session.roles.includes('evaluator') && !session.roles.includes('client'), 'ACP_PROVIDER_SESSION_REQUIRED');
    check(entry.chainId === session.chainId && entry.onChainJobId === session.jobId
      && (entry.kind !== 'system' || entry.event?.jobId === session.jobId), 'ACP_ENTRY_MISMATCH');
    let r = journal.get(key);
    try {
      const job = await bounded(key, () => readJob(session.jobId));
      const binding = bindJob(job, session), bindingHash = hash(binding);
      if (r) check(r.bindingHash === bindingHash, 'ACP_JOB_CHANGED');
      if (r) {
        const done = terminal(key, r, job); if (done) return done;
        // Never roll back or retry an uncertain effect after a process restart.
        if (r.state.endsWith('_intent')) return save(key, r, 'review_required', { reviewCode: 'ACP_EFFECT_OUTCOME_UNKNOWN' });
        if (r.state === 'review_required' || r.state === 'submitted') return r;
      }
      check(Number(job.expiredAt) * 1000 > now(), 'ACP_JOB_EXPIRED');
      if (!r) {
        // First requirement must be buyer-authored. Funding arriving first does
        // not authorize guessing inputs, even if the job is really funded.
        if (entry.kind !== 'message' || entry.contentType !== 'requirement') return { state: 'awaiting_requirement' };
        check(same(entry.from, job.client) && typeof entry.content === 'string'
          && Buffer.byteLength(entry.content) <= 16384 && job.status === 0, 'ACP_REQUIREMENT_INVALID');
        const args = JSON.parse(entry.content);
        check(args && Object.getPrototypeOf(args) === Object.prototype && Object.keys(args).length <= 32
          && Object.keys(args).sort().join(',') === [...offering.inputNames].sort().join(',')
          && Object.entries(args).every(([k, v]) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(k)
            && typeof v === 'string' && v.length > 0 && v.length <= 4000), 'ACP_REQUIREMENT_INVALID');
        const call = { name: offering.tool, arguments: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))) };
        r = save(key, { bindingHash, binding, callDigest: hash(call), economics,
          accounting: 'escrow_is_not_revenue', mode }, 'quote_intent');
        const quote = await bounded(key, signal => workflow.quote({ call, idempotencyKey: key, signal }));
        check(quote.workflowDigest === offering.workflowDigest && uint(quote.downstreamUsdAtomic)
          && typeof quote.paymentId === 'string' && /^pay_[A-Za-z0-9_-]{1,96}$/.test(quote.paymentId)
          && uint(quote.amountRaw) && BigInt(quote.amountRaw) > 0n
          && Number.isSafeInteger(quote.expiresAt) && /^[a-f0-9]{64}$/.test(quote.rateDigest)
          && BigInt(quote.downstreamUsdAtomic) <= BigInt(economics.maxDownstreamUsdAtomic)
          && quote.expiresAt > now() && quote.expiresAt >= Number(job.expiredAt) * 1000, 'DOWNSTREAM_QUOTE_UNSAFE');
        r = save(key, r, 'budget_intent', { quote: { paymentId: quote.paymentId, amountRaw: quote.amountRaw,
          expiresAt: quote.expiresAt, downstreamUsdAtomic: quote.downstreamUsdAtomic,
          rateDigest: quote.rateDigest, workflowDigest: quote.workflowDigest } });
        const budget = sdk.AssetToken.usdcFromRaw(BigInt(economics.priceAtomic), 8453);
        check(budget.rawAmount === BigInt(economics.priceAtomic), 'ACP_BUDGET_PRECISION_LOSS');
        await bounded(key, () => session.setBudget(budget));
        return save(key, r, 'awaiting_funding');
      }
      if (entry.kind === 'message') {
        check(same(entry.from, job.client) && entry.contentType === 'requirement'
          && typeof entry.content === 'string' && Buffer.byteLength(entry.content) <= 16384, 'ACP_REQUIREMENT_INVALID');
        const args = JSON.parse(entry.content);
        const replay = { name: offering.tool, arguments: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))) };
        check(hash(replay) === r.callDigest, 'ACP_REQUIREMENT_CHANGED');
      }
      // Inputs are supplied by a trusted, local, content-addressed recovery store;
      // no prompts are persisted by the orchestration journal.
      const call = await bounded(key, signal => workflow.recoverCall({ callDigest: r.callDigest, idempotencyKey: key, signal }));
      check(hash(call) === r.callDigest && call.name === offering.tool, 'ACP_INPUT_RECOVERY_FAILED');
      if (r.state === 'awaiting_funding') {
        if (job.status === 0) return r;
        const funding = funded(job);
        check(r.quote.expiresAt > now(), 'DOWNSTREAM_QUOTE_EXPIRED');
        r = save(key, r, 'reserve_intent', { funding, fundingProvenance: job.provenance });
        const reservation = await bounded(key, signal => workflow.reserve({ quote: r.quote, idempotencyKey: key, signal }));
        check(reservation?.status === 'reserved' && reservation.paymentId === r.quote.paymentId
          && typeof reservation.reservationId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(reservation.reservationId), 'DOWNSTREAM_RESERVATION_UNCERTAIN');
        r = save(key, r, 'dispatch_intent', { reservation: { status: 'reserved',
          paymentId: reservation.paymentId, reservationId: reservation.reservationId } });
        const beforeDispatch = await bounded(key, () => readJob(session.jobId));
        check(hash(bindJob(beforeDispatch, session)) === r.bindingHash, 'ACP_JOB_CHANGED');
        funded(beforeDispatch);
        check(r.quote.expiresAt > now(), 'DOWNSTREAM_QUOTE_EXPIRED');
        const result = await bounded(key, signal => workflow.dispatch({ call, quote: r.quote, reservation,
          idempotencyKey: key, signal }));
        const url = new URL(result?.deliverableRef);
        check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
          && url.href.length <= 2048 && offering.resultHosts.includes(url.host) && /^[a-f0-9]{64}$/.test(result.resultDigest), 'ACP_RESULT_INVALID');
        const receipt = { schema: 'nanoodle.acp.service.v1', chainId: 8453, jobId: session.jobId,
          offering: offering.name, workflowDigest: offering.workflowDigest, callDigest: r.callDigest,
          downstreamPaymentId: r.quote.paymentId, resultDigest: result.resultDigest,
          deliverableRef: url.href, funding: r.funding };
        const deliverable = JSON.stringify(receipt);
        r = save(key, r, 'ready', { deliverable, deliverableHash: sdkHash(deliverable), resultDigest: result.resultDigest });
      }
      if (r.state === 'ready') {
        const current = await bounded(key, () => readJob(session.jobId));
        check(hash(bindJob(current, session)) === r.bindingHash, 'ACP_JOB_CHANGED');
        funded(current);
        check(r.quote.expiresAt > now(), 'DOWNSTREAM_QUOTE_EXPIRED');
        // Hash must use the SDK's on-chain deliverable encoding (keccak UTF-8).
        r = save(key, r, 'submit_intent');
        await bounded(key, () => session.submit(r.deliverable));
        return save(key, r, 'submitted');
      }
      return r;
    } catch {
      // Callback/provider exception text never reaches callers, disk, or logs.
      // No refund, retry, evaluator approval or earned-profit inference here.
      if (r) return save(key, r, 'review_required', { reviewCode: 'ACP_REVIEW_REQUIRED' });
      return { state: 'rejected_input', code: 'ACP_INPUT_OR_PROOF_INVALID' };
    }
  }
  const sdkHash = value => {
    check(typeof sdk.hashDeliverable === 'function', 'ACP_DELIVERABLE_HASH_REQUIRED');
    const digest = sdk.hashDeliverable(value);
    check(/^0x[a-f0-9]{64}$/.test(digest), 'ACP_DELIVERABLE_HASH_INVALID');
    return digest;
  };
  return Object.freeze({
    handle(session, entry) {
      const key = keyOf(session);
      const previous = queues.get(key) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => processEntry(session, entry));
      queues.set(key, next);
      next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
      return next;
    },
    cancel(chainId, jobId) {
      const key = `${chainId}:${jobId}`; cancelled.add(key); active.get(key)?.abort();
      const r = journal.get(key);
      if (r && !['completed', 'rejected', 'expired'].includes(r.state))
        save(key, r, 'review_required', { reviewCode: 'ACP_OPERATION_INTERRUPTED' });
    },
    attach(agent) {
      check(agent instanceof sdk.AcpAgent, 'ACP_AGENT_REQUIRED');
      agent.on('entry', async (session, entry) => { try { await this.handle(session, entry); } catch { /* fixed failure, no SDK console leak */ } });
    },
  });
}
