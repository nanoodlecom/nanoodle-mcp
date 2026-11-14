import * as realSdk from '@virtuals-protocol/acp-node-v2';
import { decodeEventLog, encodeEventTopics, encodeAbiParameters, keccak256, toHex } from 'viem';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadTools } from '../../src/tools.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAcpJournal, hash, ZERO } from '../../src/ecosystems/acp/journal.mjs';
import { createAcpJobReader } from '../../src/ecosystems/acp/verified-job.mjs';
import { createAcpSeller } from '../../src/ecosystems/acp/seller.mjs';
import { createNanoWorkflowBoundary } from '../../src/ecosystems/acp/nano-workflow.mjs';
import { createDispatcher } from '../../src/server.mjs';
export const sdk = { ...realSdk, hashDeliverable: value => keccak256(toHex(value)) };
export const provider = '0x1111111111111111111111111111111111111111';
export const client = '0x2222222222222222222222222222222222222222';
export const evaluator = '0x3333333333333333333333333333333333333333';
export const blockHash = '0x' + '44'.repeat(32), txHash = '0x' + '55'.repeat(32);
export const contract = sdk.ACP_CONTRACT_ADDRESSES[8453];
export const epoch = 1804204800000;
export const economics = { priceAtomic: '1000000', platformFeeBps: 500, maxDownstreamUsdAtomic: '401000',
  maxConversionUsdAtomic: '50000', maxNetworkUsdAtomic: '100000', minMarginUsdAtomic: '200000' };
export const graphDigest = createHash('sha256').update(readFileSync(new URL('../../tests/fixtures/hello-noodle.json', import.meta.url))).digest('hex');
export const offering = { name: 'Noodle fixed response', tool: 'hello-noodle', workflowDigest: graphDigest,
  provider, inputNames: ['Idea'], resultHosts: ['results.invalid'] };
export function encodedLog(name, args, extra = {}) {
  const event = sdk.ACP_ABI.find(e => e.type === 'event' && e.name === name);
  const dataInputs = event.inputs.filter(i => !i.indexed);
  return { address: contract, blockNumber: 100n, blockHash, transactionHash: txHash, removed: false,
    topics: encodeEventTopics({ abi: [event], eventIdea: name, args }),
    data: encodeAbiParameters(dataInputs, dataInputs.map(i => args[i.name])), ...extra };
}
export const message = (content = '{"Idea":"Ada"}', from = client) => ({ kind: 'message', chainId: 8453,
  onChainJobId: '7', from, contentType: 'requirement', content, timestamp: epoch });
export const system = type => ({ kind: 'system', chainId: 8453, onChainJobId: '7', timestamp: epoch,
  event: { type, jobId: '7', client, provider, evaluator, amount: 1, expiredAt: String(epoch / 1000 + 600), hook: ZERO } });
export async function fixture({ overrides = {}, timeoutMs = 1000, start = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-seller-'));
  let journal = openAcpJournal(join(dir, 'jobs.json'));
  const state = { now: epoch, raw: { id: 7n, client, provider, evaluator, description: offering.name,
    budget: 0n, expiredAt: BigInt(epoch / 1000 + 600), status: 0, hook: ZERO }, logs: [],
    count: { quote: 0, reserve: 0, dispatch: 0, budget: 0, submit: 0, publish: 0 }, calls: new Map(),
    quote: null, error: null, pendingDispatch: null, posted: [], chainId: 8453, readCount: 0 };
  const rpc = {
    getChainId: async () => state.chainId,
    getBlock: async () => ({ number: 100n, hash: blockHash }),
    readContract: async params => { state.readCount++; if (params.blockNumber !== 100n) throw Error('unpinned'); return { ...state.raw }; },
    getLogs: async params => state.logs.filter(log => log.topics[0] === encodeEventTopics({ abi: [params.event] })[0]),
  };
  const readJob = createAcpJobReader({ rpc, sdk, decodeEventLog, contract, fromBlock: 1n });
  const transport = { connect: async fn => fn?.(), disconnect: async () => {}, onEntry(fn) { this.handler = fn; },
    getHistory: async () => [], sendMessage() {}, postMessage: async () => {}, emit(entry) { return this.handler(entry); } };
  const api = { getActiveJobs: async () => [], getJob: async () => ({ chainId: 8453, onChainJobId: '7',
    jobStatus: ['OPEN','FUNDED','SUBMITTED','COMPLETED','REJECTED','EXPIRED'][state.raw.status], clientAddress: client,
    providerAddress: provider, evaluatorAddress: evaluator, description: offering.name, budget: state.raw.budget.toString(),
    expiredAt: new Date(Number(state.raw.expiredAt) * 1000).toISOString(), hookAddress: ZERO,
    deliverable: null, hookConfigs: null, clientSubscription: null }),
    postDeliverable: async (_c, _j, content) => { state.posted.push(content); } };
  const fakeClient = { getAddress: async () => provider, getSupportedChainIds: () => [8453],
    getContractAddresses: () => ({ 8453: contract }), getProvider: () => ({ getSupportedChainIds: async () => [8453] }),
    setBudget: async (_chain, p) => { state.count.budget++; if (p.amount !== 1000000n) throw Error('bad budget'); return { type: 'budget' }; },
    submit: async (_chain, p) => { state.count.submit++; state.submitted = p.deliverable; return { type: 'submit' }; },
    submitPrepared: async (_chain, p) => { if (state.submitError && p[0].type === 'submit') throw Error('SECRET'); return txHash; },
    isStalePrepareError: () => false };
  const agent = new sdk.AcpAgent(new Map([['evm', fakeClient]]), transport, api);
  await agent.getAddress();
  const session = new sdk.JobSession(agent, [provider], '7', 8453, ['provider']);
  await session.fetchJob();
  const registry = await loadTools({ dirs: [fileURLToPath(new URL('../../tests/fixtures', import.meta.url))], outDir: dir, log() {} });
  const paid = { callTool: async call => {
    if (!call.arguments._payment_id) {
      state.count.quote++;
      state.quote = { paymentId: 'pay_fixture', amountRaw: '1230000000000000000000000000', amountUsd: 0.4,
        expiresAt: new Date(epoch + 900000).toISOString(), status: 'pending', tool: call.name };
      return { content: [], structuredContent: { x402: state.quote } };
    }
    state.count.dispatch++;
    if (state.pendingDispatch) await state.pendingDispatch;
    if (state.error) throw Error('SECRET downstream key prompt');
    return { content: [{ type: 'text', text: 'Hello Ada' }] };
  } };
  const dispatch = createDispatcher({ name: 'fixture', version: '0', commit: null,
    listTools: () => [], callTool: paid.callTool, log() {} });
  const workflow = createNanoWorkflowBoundary({ registry, dispatch, gate: { quote: () => state.quote },
    resolveWorkflowDigest: async () => offering.workflowDigest,
    valueNanoQuote: async () => ({ usdCeilingAtomic: '401000', rateDigest: 'b'.repeat(64) }),
    retainCall: async ({ call, callDigest }) => { state.calls.set(callDigest, call); },
    recoverCall: async ({ callDigest }) => state.calls.get(callDigest),
    reserveNanoQuote: async ({ quote }) => { state.count.reserve++; return { status: 'reserved', paymentId: quote.paymentId, reservationId: 'operator_fixture' }; },
    confirmNanoPayment: async ({ quote }) => { state.quote.status = 'paid'; return { paymentId: quote.paymentId, status: 'paid' }; },
    publishResult: async ({ provenance }) => { state.count.publish++; return { deliverableRef: 'https://results.invalid/greeting', resultDigest: provenance.resultDigest }; },
  });
  const makeSeller = () => createAcpSeller({ enabled: true, mode: 'offline-qualification', sdk, journal, readJob,
    workflow: { ...workflow, ...overrides }, offering, economics, now: () => state.now, timeoutMs });
  let seller = makeSeller();
  if (start) { seller.attach(agent); await agent.start(); }
  return { dir, state, rpc, readJob, session, agent, transport,
    get journal() { return journal; }, get seller() { return seller; },
    async request() { return seller.handle(session, message()); },
    fund(amount = 1000000n) { state.raw.status = 1; state.raw.budget = amount;
      state.logs.push(encodedLog('JobFunded', { jobId: 7n, client, amount })); },
    async restart() { journal.close(); journal = openAcpJournal(join(dir, 'jobs.json')); seller = makeSeller(); },
    async close() { await agent.stop(); journal.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
