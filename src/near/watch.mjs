/**
 * Watch finalized account changes over NEAR RPC. Resolve their receipt IDs to
 * transactions, then let the payment gate apply its existing FINAL verifier.
 * One watcher serves every caller; no explorer/indexer or caller tx hash needed.
 * A durable cursor makes outages and restarts replay safely (the gate consumes
 * transaction hashes durably). Existing quotes get a bounded, resumable backfill.
 */
import { NearError } from "./errors.mjs";

const META = "paymentWatch";
const timeMs = (block) => Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);

export function createNearWatcher({
  rpc, ledger, merchantId, pendingQuotes, observeTransfer,
  tokenContracts = [],
  pollMs = 2000, maxBlocksPerTick = 25, log = () => {},
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  cancel = clearTimeout,
}) {
  let state = ledger.getMeta(META) || null;
  if (state && (!Number.isSafeInteger(state.height) || state.height < 0 || typeof state.hash !== "string"
    || (state.backfill && (typeof state.backfill.nextHash !== "string" || !Number.isFinite(state.backfill.cutoffMs))))) {
    throw new NearError("STATE_UNREADABLE", "The NEAR payment watcher cursor is malformed");
  }
  let timer = null, stopped = true, inflight = null, failures = 0, lastError = null, lastScanAt = null;
  function save(next) { ledger.setMeta(META, next); state = next; }

  async function inspect(block) {
    if (!pendingQuotes().length) return;
    const accounts = [merchantId, ...tokenContracts.filter((token) => pendingQuotes().some((q) => q.asset === "usdc" && q.tokenContract === token))];
    const changes = await rpc.call("EXPERIMENTAL_changes", {
      changes_type: "account_changes", account_ids: accounts, block_id: block.header.hash,
    });
    if (changes.block_hash !== block.header.hash || !Array.isArray(changes.changes)) {
      throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received changes for a different block");
    }
    const receipts = new Set(changes.changes
      .filter((c) => accounts.includes(c.change?.account_id) && c.cause?.type === "receipt_processing")
      .map((c) => c.cause.receipt_hash).filter((id) => typeof id === "string"));
    const transactions = new Set();
    for (const receiptId of receipts) {
      const tx = await rpc.call("EXPERIMENTAL_receipt_to_tx", { receipt_id: receiptId, block_height: Number(block.header.height) });
      if (typeof tx.transaction_hash !== "string" || typeof tx.sender_account_id !== "string") {
        throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher could not resolve a receipt's transaction");
      }
      if (transactions.has(tx.transaction_hash)) continue;
      transactions.add(tx.transaction_hash);
      await observeTransfer(tx.transaction_hash, tx.sender_account_id);
    }
  }

  async function scan() {
    const latest = await rpc.block({ finality: "final" });
    const height = Number(latest?.header?.height);
    if (!Number.isSafeInteger(height) || typeof latest.header.hash !== "string") {
      throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received no finalized block height");
    }
    if (!state) {
      const pending = pendingQuotes();
      save({ height, hash: latest.header.hash, backfill: pending.length
        ? { nextHash: latest.header.hash, cutoffMs: Math.min(...pending.map((q) => q.createdAt)) }
        : null });
    }
    if (height < state.height) throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher RPC fell behind its persisted cursor");
    let remaining = maxBlocksPerTick;
    // With no quotes there is nothing to buy. Top-ups are never interpreted as jobs.
    if (!pendingQuotes().length) {
      if (state.height !== height || state.backfill) save({ height, hash: latest.header.hash, backfill: null });
    } else {
      // After a long outage, keep new payments live while recovering older
      // quotes newest-first. Rewalking a range is safe: the gate durably
      // consumes each payment hash before execution.
      if (height - state.height > maxBlocksPerTick) {
        const cutoffMs = Math.min(...pendingQuotes().map(q => q.createdAt), state.backfill?.cutoffMs ?? Infinity);
        await inspect(latest);
        remaining--;
        save({ height, hash: latest.header.hash, backfill: {
          nextHash: latest.header.prev_hash,
          cutoffMs,
        } });
      }
      let nextHeight = state.height + 1;
      while (nextHeight <= height && remaining-- > 0) {
        let block;
        try { block = nextHeight === height ? latest : await rpc.call("block", { block_id: nextHeight }); }
        catch (e) {
          if (e.code !== "UNKNOWN_BLOCK") throw e; // skipped heights exist on NEAR
          nextHeight++; // do not checkpoint until the next real block proves continuity
          continue;
        }
        if (Number(block.header.height) !== nextHeight || block.header.prev_hash !== state.hash) {
          throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received a discontinuous finalized chain");
        }
        await inspect(block);
        save({ ...state, height: Number(block.header.height), hash: block.header.hash });
        nextHeight++;
      }
      // Backfill runs newest-first without delaying live transfers at the tip.
      let budget = Math.max(0, remaining);
      while (state.backfill && budget-- > 0) {
        const block = await rpc.block({ blockId: state.backfill.nextHash });
        if (block.header.hash !== state.backfill.nextHash) throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher backfill block mismatch");
        if (timeMs(block) < state.backfill.cutoffMs) { save({ ...state, backfill: null }); break; }
        await inspect(block);
        save({ ...state, backfill: { ...state.backfill, nextHash: block.header.prev_hash } });
      }
    }
    lastScanAt = new Date().toISOString();
    if (lastError) log("NEAR payment watcher recovered; finalized transfers are being checked again");
    failures = 0; lastError = null;
  }

  function tick() {
    if (inflight) return inflight;
    inflight = scan().catch((e) => {
      failures++;
      if (!lastError) log(`NEAR payment watcher paused (${e.code || "error"}); will retry without advancing its cursor`);
      lastError = e.code || "WATCH_FAILED";
    }).finally(() => { inflight = null; });
    return inflight;
  }
  async function loop() {
    await tick();
    if (!stopped) timer = schedule(loop, Math.min(60_000, pollMs * 2 ** Math.min(failures, 5)));
  }
  return {
    tick,
    async start() {
      if (!stopped) return;
      stopped = false;
      await loop();
      if (!lastError) log(`NEAR payment watcher listening for finalized transfers to ${merchantId}`);
    },
    stop() { stopped = true; if (timer !== null) cancel(timer); },
    status: () => ({ listening: !stopped && !lastError, merchant: merchantId, height: state?.height ?? null, backfilling: !!state?.backfill, lastScanAt, error: lastError }),
  };
}
