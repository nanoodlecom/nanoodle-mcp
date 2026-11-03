import { check, same, ZERO, uint } from './journal.mjs';

/** Read-only EVM proof boundary. SSE / backend session fields are never proof.
 * rpc is an operator-selected viem-compatible PublicClient, sdk/decodeEventLog
 * come from the qualified SDK and viem. This module never constructs a wallet.
 * A single finalized block pins all state/log reads. Unknown hooks fail closed.
 */
export function createAcpJobReader({ rpc, sdk, decodeEventLog, chainId = 8453, contract, fromBlock }) {
  check(chainId === 8453 && same(contract, sdk.ACP_CONTRACT_ADDRESSES?.[chainId])
    && typeof fromBlock === 'bigint' && fromBlock >= 0n, 'ACP_READER_CONFIG_REQUIRED');
  return async function readJob(jobId) {
    check(uint(jobId), 'ACP_JOB_ID_INVALID');
    check(await rpc.getChainId() === chainId, 'ACP_CHAIN_MISMATCH');
    const block = await rpc.getBlock({ blockTag: 'finalized' });
    check(typeof block.number === 'bigint' && block.number >= fromBlock && /^0x[0-9a-fA-F]{64}$/.test(block.hash), 'ACP_FINALITY_UNAVAILABLE');
    const raw = await rpc.readContract({ address: contract, abi: sdk.ACP_ABI, functionName: 'getJob', args: [BigInt(jobId)], blockNumber: block.number });
    check(raw && same(raw.hook, ZERO), 'ACP_SERVICE_ONLY');
    const names = ['JobFunded', 'JobSubmitted', 'JobCompleted', 'JobRejected', 'JobExpired', 'PaymentReleased'];
    const logs = (await Promise.all(names.map(name => rpc.getLogs({ address: contract,
      event: sdk.ACP_ABI.find(e => e.type === 'event' && e.name === name),
      args: { jobId: BigInt(jobId) }, fromBlock, toBlock: block.number })))).flat();
    const events = [];
    for (const log of logs) {
      if (log.removed || !same(log.address, contract) || typeof log.blockNumber !== 'bigint'
        || log.blockNumber < fromBlock || log.blockNumber > block.number) continue;
      let decoded;
      try { decoded = decodeEventLog({ abi: sdk.ACP_ABI, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
      if (decoded.args.jobId !== BigInt(jobId)) continue;
      check(/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) && /^0x[0-9a-fA-F]{64}$/.test(log.blockHash), 'ACP_LOG_PROVENANCE_REQUIRED');
      // Validate the log's block is still canonical; never accept removed forks.
      const canonical = await rpc.getBlock({ blockNumber: log.blockNumber });
      check(canonical.hash === log.blockHash, 'ACP_LOG_FORK');
      events.push({ name: decoded.eventName, args: decoded.args, transactionHash: log.transactionHash,
        blockHash: log.blockHash, blockNumber: log.blockNumber.toString() });
    }
    return { chainId, id: jobId, ...raw, events,
      provenance: { source: 'finalized_rpc', contract, blockHash: block.hash, blockNumber: block.number.toString() } };
  };
}
