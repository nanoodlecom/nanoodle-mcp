import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { nanoFundingLiabilities, nearCreatorLiabilities, marketCreatorLiabilities } from "./funding-liabilities.mjs";

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
export function createHostedFundingSources({ nanoFile, nearFile, marketRoot }) {
  let nanoLive = null, nearLive = null, payoutsLive = null;
  let quoteReady = false, storageReady = true;
  const marketLive = new Map();
  function nearDisk() {
    const s = read(nearFile);
    if (s && s.v !== 1) throw Error("invalid-funding-state");
    return s ? { quotes: rows(s.quotes), payouts: rows(s.payouts ?? {}) } : { quotes: [], payouts: [] };
  }
  function marketFiles() {
    const files = new Set(marketLive.keys());
    if (!marketRoot) return files;
    files.add(join(marketRoot, "market-state.json"));
    let entries;
    try { entries = readdirSync(marketRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return files; throw Error("funding-state-unreadable", { cause: error }); }
    for (const e of entries) if (e.isDirectory()) files.add(join(marketRoot, e.name, "market-state.json"));
    return files;
  }
  return {
    ready: () => quoteReady,
    setReady(value) { quoteReady = value === true; },
    setStorageReady(value) { storageReady = value === true; if (!storageReady) quoteReady = false; },
    registerNano(reader) { nanoLive = reader; },
    registerNear(reader, payouts) { nearLive = reader; payoutsLive = payouts; },
    registerMarket(file, reader) { marketLive.set(resolve(file), reader); },
    liabilitiesRaw(context) {
      // Recovery telemetry can read debts while storage is unavailable; it
      // grants no spending authority. Actual authorizations remain paused.
      if (!storageReady && !context?.readOnly) throw Error("funding-state-unwritable");
      let total;
      if (nanoLive) total = nanoLive(context);
      else {
        const s = read(nanoFile);
        if (s && ![1, 2].includes(s.v)) throw Error("invalid-funding-state");
        total = s ? nanoFundingLiabilities(s) : 0n;
      }
      const near = nearLive ? null : nearDisk();
      const payouts = payoutsLive ? payoutsLive() : near?.payouts ?? nearDisk().payouts;
      total += nearLive ? nearLive(context) : nearCreatorLiabilities(near, context);
      for (const file of marketFiles()) {
        let records;
        if (marketLive.has(file)) records = marketLive.get(file)();
        else {
          const s = read(file);
          if (!s) continue;
          if (s.v !== 1) throw Error("invalid-funding-state");
          records = rows(s.assignments);
        }
        total += marketCreatorLiabilities(records, { ...context, payouts });
      }
      return total;
    },
  };
}
