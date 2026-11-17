import { createHash } from "node:crypto";

export const MAX_RPC_RETRY_MS = 86_400_000;

/** Provider JSON retry_after uses seconds; Retry-After can also be an HTTP date. */
export function rpcRetryAfterMs({ body, header, now = Date.now() } = {}) {
  const seconds = value => {
    if (!((typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 128 && /^\d+(?:\.\d+)?$/.test(value.trim())))) return null;
    const number = Number(value);
    return number >= 0 ? Math.min(MAX_RPC_RETRY_MS, Math.ceil(number * 1000)) : null;
  };
  const values = [seconds(body)];
  let fromHeader = seconds(header);
  if (fromHeader === null && typeof header === "string" && header.length <= 128 && /[A-Za-z]/.test(header)) {
    const at = Date.parse(header);
    if (Number.isFinite(at)) fromHeader = Math.min(MAX_RPC_RETRY_MS, Math.max(0, Math.ceil(at - now)));
  }
  values.push(fromHeader);
  const valid = values.filter(value => value !== null);
  return valid.length ? Math.max(...valid) : null;
}

/** Bind indexed cooldowns to the same endpoint list without copying URLs. */
export function rpcPeerSetId(bases) {
  if (!Array.isArray(bases) || bases.length < 1 || bases.length > 8 || bases.some(base => typeof base !== "string")) throw TypeError("Invalid RPC peer configuration");
  const normalized = bases.map(base => base.trim().replace(/\/+$/, ""));
  if (normalized.some(base => !base) || new Set(normalized).size !== bases.length) throw TypeError("Invalid RPC peer configuration");
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Select only peer index and deadline; malformed telemetry fails closed. */
export function selectRpcCooldowns(value, peers, now = Date.now()) {
  if (!Number.isSafeInteger(peers) || peers < 1 || peers > 8 || !Array.isArray(value) || value.length > peers) throw TypeError("Invalid RPC cooldown observation");
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !Number.isSafeInteger(item.peer) || item.peer < 0 || item.peer >= peers
      || seen.has(item.peer) || !Number.isSafeInteger(item.until) || item.until < 0 || item.until > now + MAX_RPC_RETRY_MS + 30_000) throw TypeError("Invalid RPC cooldown observation");
    seen.add(item.peer);
    return { peer: item.peer, until: item.until };
  }).filter(item => item.until > now).sort((a, b) => a.peer - b.peer);
}
