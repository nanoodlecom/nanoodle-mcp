/**
 * Watch finalized account changes over NEAR RPC. Resolve their receipt IDs to
 * transactions, then let the payment gate apply its existing FINAL verifier.
 * One watcher serves every caller; no explorer/indexer or caller tx hash needed.
 * A durable cursor makes outages and restarts replay safely (the gate consumes
 * transaction hashes durably). Existing quotes get a bounded, resumable backfill.
 */
import { NearError } from "./errors.mjs";
import { assertFreshBlock, MAX_HEAD_AGE_MS, MAX_CLOCK_SKEW_MS } from "./freshness.mjs";
import { PAYMENT_WATCH_META } from "./quote-capacity.mjs";
import { requireNearAccountChanges, requireNearReceiptTransaction } from "./rpc.mjs";

function historicalTime(block) {
  const ns = block?.header?.timestamp_nanosec;
  const ms = typeof ns === "string" && /^\d+$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : NaN;
  if (!Number.isSafeInteger(ms)) throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher received an invalid historical block timestamp");
  return ms;
}

export async function readNearPaymentReceipts(rpc, blockHash, accounts) {
  const result = await rpc.call("EXPERIMENTAL_changes", {
    changes_type: "account_changes", account_ids: accounts, block_id: blockHash,
  });
  const changes = requireNearAccountChanges(result, blockHash, accounts);
  return new Set(changes.changes
    .filter((row) => accounts.includes(row.change.account_id) && row.cause.type === "receipt_processing")
    .map((row) => row.cause.receipt_hash));
}

export async function readNearReceiptTransaction(rpc, receiptId, blockHeight) {
  const tx = await rpc.call("EXPERIMENTAL_receipt_to_tx", { receipt_id: receiptId, block_height: blockHeight });
  return requireNearReceiptTransaction(tx);
}

export function createNearWatcher({
  rpc, ledger, merchantId, pendingQuotes, observeTransfer,
  tokenContracts = [], maintenance = null,
  pollMs = 2000, maxBlocksPerTick = 25, log = () => {},
  now = Date.now, maxHeadAgeMs = MAX_HEAD_AGE_MS, maxClockSkewMs = MAX_CLOCK_SKEW_MS,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  cancel = clearTimeout,
}) {
  if (maintenance !== null && (typeof maintenance.run !== "function" || typeof maintenance.accepting !== "function")) throw new TypeError("maintenance must provide operation admission and accounting");
  let state = ledger.getMeta(PAYMENT_WATCH_META) || null;
  if (state && (!Number.isSafeInteger(state.height) || state.height < 0 || typeof state.hash !== "string"
    || (state.coveredThroughMs != null && (!Number.isSafeInteger(state.coveredThroughMs) || state.coveredThroughMs < 0))
    || (state.coveredThroughMs === null && !state.backfill)
    || (state.backfill && (typeof state.backfill.nextHash !== "string" || !Number.isFinite(state.backfill.cutoffMs))))) {
    throw new NearError("STATE_UNREADABLE", "The NEAR payment watcher cursor is malformed");
  }
  let timer = null, stopped = true, inflight = null, failures = 0, lastError = null, lastScanAt = null, lastHeadAt = null;
  function save(next) { ledger.setMeta(PAYMENT_WATCH_META, next); state = next; }

  async function inspect(block) {
    const pending = pendingQuotes();
    if (!pending.length) return;
    const accounts = [merchantId, ...tokenContracts.filter((token) => pending.some((q) => q.asset === "usdc" && q.tokenContract === token))];
    const receipts = await readNearPaymentReceipts(rpc, block.header.hash, accounts);
    const transactions = new Set();
    for (const receiptId of receipts) {
      const tx = await readNearReceiptTransaction(rpc, receiptId, Number(block.header.height));
      if (transactions.has(tx.transaction_hash)) continue;
      transactions.add(tx.transaction_hash);
      await observeTransfer(tx.transaction_hash, tx.sender_account_id);
    }
  }

  async function scan() {
    const latest = await rpc.block({ finality: "final" });
    const headAt = assertFreshBlock(latest, { now: now(), maxHeadAgeMs, maxClockSkewMs });
    const height = Number(latest.header.height), hash = latest.header.hash;
    if (state && (height < state.height || (height === state.height && hash !== state.hash)
      || (state.coveredThroughMs != null && headAt < state.coveredThroughMs))) {
      throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher RPC disagrees with its finalized cursor");
    }
    // Older cursors did not prove which quote windows were fully inspected.
    if (!state || state.coveredThroughMs === undefined) {
      const pending = pendingQuotes();
      save({ height, hash, coveredThroughMs: pending.length ? null : headAt, backfill: pending.length
        ? { nextHash: hash, cutoffMs: Math.min(...pending.map((q) => q.createdAt)) } : null });
    }
    // Advance coverage only when the current finalized head and any older gap
    // have both been inspected. Each checkpoint is persisted after inspection.
    const saveProgress = next => save(next.height === height && !next.backfill ? { ...next, coveredThroughMs: headAt } : next);
    let remaining = maxBlocksPerTick;
    // With no quotes there is nothing to buy. Top-ups are never interpreted as jobs.
    if (!pendingQuotes().length) {
      if (state.height !== height || state.backfill || state.coveredThroughMs !== headAt) {
        save({ height, hash, backfill: null, coveredThroughMs: headAt });
      }
    } else {
      // After a long outage, keep new payments live while recovering older
      // quotes newest-first. Rewalking a range is safe: the gate durably
      // consumes each payment hash before execution.
      if (height - state.height > maxBlocksPerTick) {
        const cutoffMs = Math.min(...pendingQuotes().map(q => q.createdAt), state.backfill?.cutoffMs ?? Infinity);
        await inspect(latest);
        remaining--;
        save({ ...state, height, hash, backfill: {
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
        saveProgress({ ...state, height: nextHeight, hash: block.header.hash });
        nextHeight++;
      }
      // Backfill runs newest-first without delaying live transfers at the tip.
      let budget = Math.max(0, remaining);
      while (state.backfill && budget-- > 0) {
        const block = await rpc.block({ blockId: state.backfill.nextHash });
        if (block.header.hash !== state.backfill.nextHash) throw new NearError("RPC_BAD_RESPONSE", "NEAR watcher backfill block mismatch");
        if (historicalTime(block) < state.backfill.cutoffMs) { saveProgress({ ...state, backfill: null }); break; }
        await inspect(block);
        save({ ...state, backfill: { ...state.backfill, nextHash: block.header.prev_hash } });
      }
    }
    lastScanAt = new Date(now()).toISOString();
    lastHeadAt = headAt;
    if (lastError) log("NEAR payment watcher recovered; finalized transfers are being checked again");
    failures = 0; lastError = null;
  }

  function tick() {
    if (inflight) return inflight;
    if (stopped) return Promise.resolve();
    inflight = (maintenance ? maintenance.run(scan, "background") : scan()).catch((e) => {
      if (e.code === "SERVICE_DRAINING") return; // Pause preserves the cursor and RPC error history.
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
    stop() {
      stopped = true;
      if (timer !== null) { cancel(timer); timer = null; }
      // A caller preparing to stop the process must await the actual scan and
      // payment-observation callback, not just cancellation of its next timer.
      return inflight || Promise.resolve();
    },
    status: () => {
      const fresh = lastHeadAt !== null && now() - lastHeadAt <= maxHeadAgeMs && lastHeadAt - now() <= maxClockSkewMs
        && lastScanAt !== null && now() - Date.parse(lastScanAt) <= 120_000 && now() >= Date.parse(lastScanAt);
      const paused = maintenance && !maintenance.accepting();
      return { listening: !stopped && !lastError && fresh && !paused, merchant: merchantId, height: state?.height ?? null,
        backfilling: !!state?.backfill, lastScanAt, headAt: lastHeadAt === null ? null : new Date(lastHeadAt).toISOString(),
        error: lastError || (paused ? "SERVICE_DRAINING" : !stopped && !fresh ? "RPC_STALE" : null) };
    },
  };
}
