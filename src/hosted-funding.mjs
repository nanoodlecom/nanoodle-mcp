import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { nanoFundingLiabilities, nearCreatorLiabilities, marketCreatorLiabilities } from "./funding-liabilities.mjs";
import { creatorNanoTransferClaims, gateNanoTransferClaims, hasOtherNanoTransferClaim } from "./nano-transfer-journal.mjs";
import { marketCreatorPayoutTerms, sameCreatorPayout } from "./creator-payout-evidence.mjs";

const MAX_READY_AGE_MS = 60_000;

function read(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw Error("funding-state-unreadable", { cause: error }); }
}
function rows(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid-funding-state");
  return Object.values(value);
}

/** Register live ledger owners before they resume/start work. Disabled profiles
 * still contribute their recorded debts through read-only disk fallback. */
export function createHostedFundingSources({ nanoFile, nearFile, marketRoot, now = () => performance.now() }) {
  let requiredFiles = new Set();
  function readState(file) {
    const value = read(file);
    if (value === null && requiredFiles.has(resolve(file))) throw Error("funding-state-missing");
    return value;
  }
  let nanoLive = null, nanoTransfersLive = null, nearLive = null, payoutsLive = null;
  let quoteReady = false, storageReady = true, readyAt = null, readyForMs = 0;
  let quoteFundsRaw = null;
  const marketLive = new Map();
  function nanoDisk() {
    const s = readState(nanoFile);
    if (s && ![1, 2].includes(s.v)) throw Error("invalid-funding-state");
    return s ?? { quotes: [], owed: [] };
  }
  function nearDisk() {
    const s = readState(nearFile);
    if (s && s.v !== 1) throw Error("invalid-funding-state");
    return s ? { quotes: rows(s.quotes), payouts: rows(s.payouts ?? {}) } : { quotes: [], payouts: [] };
  }
  function marketFiles() {
    const files = new Set(marketLive.keys());
    if (!marketRoot) return files;
    for (const file of requiredFiles) {
      if (file.startsWith(resolve(marketRoot) + "/") && file.endsWith("/market-state.json")) files.add(file);
    }
    files.add(join(marketRoot, "market-state.json"));
    let entries;
    try { entries = readdirSync(marketRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return files; throw Error("funding-state-unreadable", { cause: error }); }
    for (const e of entries) if (e.isDirectory()) files.add(join(marketRoot, e.name, "market-state.json"));
    return files;
  }
  function* marketRecords() {
    for (const file of marketFiles()) {
      if (marketLive.has(file)) yield* marketLive.get(file)();
      else {
        const s = readState(file);
        if (!s) continue;
        if (s.v !== 1) throw Error("invalid-funding-state");
        yield* rows(s.assignments);
      }
    }
  }
  function ready() {
    if (!quoteReady || !storageReady) return false;
    // Expire even when the refresh task is stuck on the wallet queue. Use a
    // monotonic clock so wall-clock changes cannot extend a healthy lease.
    const age = now() - readyAt;
    if (!Number.isFinite(age) || age < 0 || age >= readyForMs) {
      quoteReady = false; readyAt = null;
    }
    return quoteReady;
  }
  return {
    requireFiles(files) { requiredFiles = new Set(files.map(file => resolve(file))); },
    ready,
    canFundQuote(requiredRaw) {
      return ready() && quoteFundsRaw !== null && typeof requiredRaw === "bigint" && requiredRaw > 0n && requiredRaw <= quoteFundsRaw;
    },
    setReady(value, maxAgeMs = MAX_READY_AGE_MS, availableRaw = null) {
      quoteReady = storageReady && value === true && Number.isFinite(maxAgeMs) && maxAgeMs > 0;
      readyForMs = quoteReady ? Math.min(maxAgeMs, MAX_READY_AGE_MS) : 0;
      readyAt = quoteReady ? now() : null;
      quoteFundsRaw = quoteReady && typeof availableRaw === "bigint" && availableRaw >= 0n ? availableRaw : null;
    },
    setStorageReady(value) { storageReady = value === true; if (!storageReady) { quoteReady = false; readyAt = null; } },
    registerNano(reader, transfers) { nanoLive = reader; nanoTransfersLive = transfers; },
    registerNear(reader, payouts) { nearLive = reader; payoutsLive = payouts; },
    registerMarket(file, reader) { marketLive.set(resolve(file), reader); },
    nanoTransferClaimed(hash, id) {
      const nano = nanoTransfersLive ? nanoTransfersLive() : gateNanoTransferClaims(nanoDisk());
      const creators = creatorNanoTransferClaims(payoutsLive ? payoutsLive() : nearDisk().payouts);
      return hasOtherNanoTransferClaim(nano, hash, id) || hasOtherNanoTransferClaim(creators, hash, id);
    },
    marketPayoutMatches(payout) {
      for (const record of marketRecords()) {
        if (`market_${record.id}` !== payout.paymentId) continue;
        const expected = marketCreatorPayoutTerms(record);
        if (!expected || !sameCreatorPayout(expected, payout)) return false;
      }
      // A matching standalone outbox can survive its pruned assignment.
      return true;
    },
    liabilitiesRaw(context) {
      // Recovery telemetry can read debts while storage is unavailable; it
      // grants no spending authority. Actual authorizations remain paused.
      if (!storageReady && !context?.readOnly) throw Error("funding-state-unwritable");
      let total = nanoLive ? nanoLive(context) : nanoFundingLiabilities(nanoDisk());
      const near = nearLive ? null : nearDisk();
      const payouts = payoutsLive ? payoutsLive() : near?.payouts ?? nearDisk().payouts;
      total += nearLive ? nearLive(context) : nearCreatorLiabilities(near, context);
      total += marketCreatorLiabilities([...marketRecords()], { ...context, payouts });
      return total;
    },
  };
}
