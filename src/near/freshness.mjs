import { NearError } from "./errors.mjs";

export const MAX_HEAD_AGE_MS = 90_000;
export const MAX_CLOCK_SKEW_MS = 30_000;

/** Historical payment blocks are deliberately not subject to a wall-clock limit. */
export function assertFreshTime(at, { now = Date.now(), maxHeadAgeMs = MAX_HEAD_AGE_MS, maxClockSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
  if (!Number.isSafeInteger(at) || at < 0) throw new NearError("RPC_BAD_RESPONSE", "NEAR RPC returned an invalid head timestamp");
  if (now - at > maxHeadAgeMs || at - now > maxClockSkewMs) {
    throw new NearError("RPC_STALE", "NEAR RPC head is stale or ahead of the server clock");
  }
  return at;
}

export function assertFreshBlock(block, options) {
  const h = block?.header;
  const height = typeof h?.height === "number" ? h.height
    : typeof h?.height === "string" && /^\d+$/.test(h.height) ? Number(h.height) : NaN;
  if (!h || !Number.isSafeInteger(height) || height <= 0 || typeof h.hash !== "string" || !h.hash
    || typeof h.timestamp_nanosec !== "string" || !/^\d+$/.test(h.timestamp_nanosec)) {
    throw new NearError("RPC_BAD_RESPONSE", "NEAR RPC returned an invalid finalized head");
  }
  return assertFreshTime(Number(BigInt(h.timestamp_nanosec) / 1_000_000n), options);
}

export function assertFreshStatus(status, options) {
  const sync = status?.sync_info;
  if (sync?.syncing === true) throw new NearError("RPC_SYNCING", "NEAR RPC is still syncing");
  if (sync?.syncing !== false || typeof sync.latest_block_time !== "string" || !/^\d{4}-\d\d-\d\dT/.test(sync.latest_block_time)) {
    throw new NearError("RPC_BAD_RESPONSE", "NEAR RPC returned no head freshness information");
  }
  return assertFreshTime(Date.parse(sync.latest_block_time), options);
}
