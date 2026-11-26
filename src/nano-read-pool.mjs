import { isIPv4 } from "node:net";
import { performance } from "node:perf_hooks";
import { MAX_RPC_RETRY_MS, rpcPeerSetId, selectRpcCooldowns } from "./rpc-backoff.mjs";
import { NANO_GENESIS, selectNanoCheckpoint } from "./nano-checkpoint.mjs";
import { completeAnchoredNanoHistory, isNanoBlockHeight, NANO_HISTORY_PAGE, NANO_RECEIVABLE_COUNT } from "./nano-payment-history.mjs";

export { NANO_GENESIS } from "./nano-checkpoint.mjs";
// Genesis, receivable, account_info, and history at that confirmed account head.
export const NANO_COLD_STANDBY_SCAN_REQUESTS = 4;
export const NANO_LEGACY_COLD_STANDBY_SCAN_REQUESTS = 5;
const GENESIS_KEY = "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA";
const GENESIS_ACCOUNT = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const HASH = /^[A-F0-9]{64}$/i, U128 = (1n << 128n) - 1n;
const MAX_CONFIRMED_HEIGHT_LAG = 2n;
export const NANO_STANDBY_BUDGET_MS = 60_000;
export const NANO_FUNDING_EVIDENCE_MS = 30_000;
const fail = (code, message = "Nano RPC peers cannot provide a consistent current account view") => Object.assign(Error(message), { code });
const unprovenCheckpoint = () => fail("NANO_RPC_CHECKPOINT_UNPROVEN", "Nano startup checkpoint lacks two confirmed peer views");
const conflictingCheckpoint = () => fail("NANO_RPC_CHECKPOINT_CONFLICT", "Nano peers disagree with the startup checkpoint or latest confirmed head");
const standbyBudgetExhausted = () => fail("NANO_RPC_STANDBY_BUDGET", "Nano standby read budget exhausted");
const hash = value => typeof value === "string" && HASH.test(value) && !/^0+$/.test(value);
const raw = value => { if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128) throw fail("NANO_RPC_BAD_VIEW"); return BigInt(value); };
const yes = value => value === true || value === "true";
const canonical = account => String(account || "").replace(/^xrb_/, "nano_");
const sameAccountView = (a, b) => Object.keys(a).every(key => a[key] === b[key]);

export function parseNanoRpcUrls(value) {
  return value.split(",").map(url => url.trim().replace(/\/+$/, "")).filter(Boolean);
}

export function assertDistinctNanoRpcPeers(bases) {
  if (!Array.isArray(bases) || !bases.length || bases.length > 8 || bases.some(base => typeof base !== "string" || !base)) {
    throw new TypeError("Nano read pool needs between one and eight endpoint identifiers");
  }
  const destinations = bases.map(base => {
    const url = URL.parse(base);
    if (!url || !["http:", "https:"].includes(url.protocol)) return base;
    // Fragments never reach the endpoint. The URL parser normalizes host case,
    // default ports and dot segments before a request is sent.
    url.hash = "";
    url.hostname = url.hostname.replace(/\.$/, "");
    return url.href;
  });
  if (new Set(destinations).size !== bases.length) {
    throw Object.assign(new TypeError("Duplicate Nano RPC endpoints are not independent peers"), { code: "NANO_RPC_DUPLICATE_PEER" });
  }
}

export function nanoOwnedPrimary(bases, enabled) {
  if (!enabled) return null;
  const url = URL.parse(bases[0]);
  // Trust is explicitly assigned to the first RPC on the private tailnet.
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash
      || !isIPv4(url.hostname) || bases.length < 3) {
    throw new TypeError("An owned Nano primary requires a first RPC at a Tailscale IPv4 address and two fallback endpoints");
  }
  const [first, second] = url.hostname.split(".").map(Number);
  if (first !== 100 || second < 64 || second > 127) {
    throw new TypeError("An owned Nano primary must use a Tailscale IPv4 address");
  }
  return bases[0];
}

export function nanoStandbyConfig(bases, { url, requestsPerMinute } = {}) {
  if (url === undefined && requestsPerMinute === undefined) return null;
  const endpoint = URL.parse(String(url ?? "").trim().replace(/\/+$/, ""));
  if (bases.length < 2 || bases.length >= 8 || !endpoint || !["http:", "https:"].includes(endpoint.protocol)
      || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError("Nano standby requires a separate HTTP(S) endpoint and two to seven primary peers");
  }
  const host = address => address.hostname.replace(/\.$/, "");
  for (const base of bases) {
    const primary = URL.parse(base);
    if (!primary || host(primary) === host(endpoint)) throw new TypeError("Nano standby must use a different hostname from all primary peers");
  }
  if (!/^[1-9]\d{0,2}$/.test(String(requestsPerMinute)) || Number(requestsPerMinute) < 3 || Number(requestsPerMinute) > 120) {
    throw new TypeError("Nano standby requires an explicit budget of 3 to 120 requests per minute");
  }
  return { url: String(url).trim().replace(/\/+$/, ""), requestsPerMinute: Number(requestsPerMinute) };
}

export function checkNanoGenesis(value) {
  let block = value?.contents;
  try { if (typeof block === "string") block = JSON.parse(block); } catch { throw fail("NANO_RPC_WRONG_NETWORK"); }
  if (!yes(value?.confirmed) || block?.type !== "open" || block.source !== GENESIS_KEY
      || canonical(block.account) !== GENESIS_ACCOUNT || canonical(block.representative) !== GENESIS_ACCOUNT) {
    throw fail("NANO_RPC_WRONG_NETWORK", "Nano RPC does not prove the mainnet genesis block");
  }
}

export function matchesNanoConfirmedBlock(value, { account, anchor, hashBlock }) {
  const height = BigInt(anchor.blockCount);
  if (!yes(value?.confirmed) || raw(value.height) !== height) return false;
  const block = typeof value.contents === "string" ? JSON.parse(value.contents) : value.contents;
  if (canonical(block?.account) !== account) return false;
  if (anchor.hash === NANO_GENESIS && height === 1n) {
    checkNanoGenesis(value);
    return true;
  }
  return block.type === "state" && hashBlock(block).toUpperCase() === anchor.hash;
}

export function nanoAccountView(value, checkAddress) {
  if (!hash(value?.frontier) || !hash(value?.confirmed_frontier) || !checkAddress(canonical(value?.representative))
      || !checkAddress(canonical(value?.confirmed_representative))) throw fail("NANO_RPC_BAD_VIEW");
  const height = raw(value.block_count), confirmedHeight = raw(value.confirmed_height);
  const balance = raw(value.balance), confirmedBalance = raw(value.confirmed_balance), pending = raw(value.confirmed_receivable);
  if (height < 1n || confirmedHeight < 1n || confirmedHeight > height
      || (height === confirmedHeight && (value.frontier.toUpperCase() !== value.confirmed_frontier.toUpperCase() || balance !== confirmedBalance))) {
    throw fail("NANO_RPC_BAD_VIEW");
  }
  return { height, confirmedHeight, balance, confirmedBalance, pending, frontier: value.frontier.toUpperCase(), confirmedFrontier: value.confirmed_frontier.toUpperCase(),
    representative: canonical(value.representative), confirmedRepresentative: canonical(value.confirmed_representative) };
}

/** Separate lagging account views while retaining conflict checks over all replies. */
export function qualifyNanoAccountViews(rows) {
  const confirmed = new Map(), heads = new Map();
  let latestConfirmed = null;
  for (const { view: v } of rows) {
    const key = v.height, ck = v.confirmedHeight;
    const head = `${v.frontier}:${v.balance}:${v.representative}`;
    const c = `${v.confirmedFrontier}:${v.confirmedBalance}:${v.confirmedRepresentative}`;
    if ((heads.has(key) && heads.get(key) !== head) || (confirmed.has(ck) && confirmed.get(ck) !== c)) throw fail("NANO_RPC_CONFLICT");
    heads.set(key, head); confirmed.set(ck, c);
    if (!latestConfirmed || ck > latestConfirmed.confirmedHeight) latestConfirmed = v;
  }
  for (const [height, state] of confirmed) if (heads.has(height) && heads.get(height) !== state) throw fail("NANO_RPC_CONFLICT");
  const current = [], lagging = [];
  for (const row of rows) {
    const group = latestConfirmed.confirmedHeight - row.view.confirmedHeight <= MAX_CONFIRMED_HEIGHT_LAG ? current : lagging;
    group.push(row);
  }
  return { current, lagging, latestConfirmed };
}

export function checkedReceivable(value, body, view, checkAddress) {
  // Some peers return an empty JSON array even when a source map was requested.
  const reply = value?.blocks;
  const blocks = Array.isArray(reply) && reply.length === 0 ? "" : reply;
  if (blocks !== "" && (!blocks || typeof blocks !== "object" || Array.isArray(blocks))) throw fail("NANO_RPC_BAD_RECEIVABLE");
  const entries = Object.entries(blocks || {}), normalized = {}, seen = new Set(); let sum = 0n;
  const count = Number(body.count);
  if (!Number.isSafeInteger(count) || count < 1 || entries.length > count) throw fail("NANO_RPC_BAD_RECEIVABLE");
  for (const [id, item] of entries) {
    if (!hash(id) || seen.has(id.toUpperCase())) throw fail("NANO_RPC_BAD_RECEIVABLE");
    seen.add(id.toUpperCase());
    const amount = raw(typeof item === "object" && item !== null ? item.amount : item);
    if (amount <= 0n) throw fail("NANO_RPC_BAD_RECEIVABLE");
    if (yes(body.source) && (!item || typeof item !== "object" || !checkAddress(canonical(item.source)))) throw fail("NANO_RPC_BAD_RECEIVABLE");
    normalized[id.toUpperCase()] = yes(body.source) ? { ...item, amount: amount.toString(), source: canonical(item.source) } : amount.toString();
    sum += amount;
  }
  // For the hosted scanner's threshold=1, a short page is the complete set.
  // A stale empty list must not override the atomic account_info pending total.
  if (sum > view.pending || (String(body.threshold ?? "0") === "1" && entries.length < count && sum !== view.pending)) throw fail("NANO_RPC_INCONSISTENT_RECEIVABLE");
  return { ...value, blocks: entries.length ? normalized : "" };
}

export function checkedHistory(value, checkAddress) {
  if (value?.history !== "" && !Array.isArray(value?.history)) throw fail("NANO_RPC_BAD_HISTORY");
  const history = [];
  for (const row of value.history || []) {
    if (!hash(row?.hash) || !["true", "false", true, false].includes(row.confirmed)) throw fail("NANO_RPC_BAD_HISTORY");
    if (row.type === "receive" && (!checkAddress(canonical(row.account)) || raw(row.amount) <= 0n)) throw fail("NANO_RPC_BAD_HISTORY");
    // Do not let the gate advance its scan marker past unconfirmed entries.
    if (yes(row.confirmed)) history.push(row);
  }
  if (value.previous != null && !(typeof value.previous === "string" && HASH.test(value.previous))) throw fail("NANO_RPC_BAD_HISTORY");
  return { ...value, history, ...(typeof value.previous === "string" && /^0+$/.test(value.previous) ? { previous: null } : {}) };
}

/** Read-only account ordering, shared by hosted wallet paths. No PoW, signing,
 * publication, inference or balance aggregation across different snapshots. */
export function createNanoReadPool({ bases, rpc, account, checkAddress, hashBlock, standby: standbyOptions, trustOwnedPrimary = false,
  persistConfirmed = null, previousFundingReport = null, now = Date.now, monotonicNow = () => performance.now(), networkTtlMs = 30_000 }) {
  assertDistinctNanoRpcPeers(bases);
  const ownedPrimary = nanoOwnedPrimary(bases, trustOwnedPrimary);
  const fallbackBases = ownedPrimary ? bases.slice(1) : bases;
  if (typeof checkAddress !== "function" || typeof hashBlock !== "function") throw new TypeError("Nano read pool needs wallet-owned address and hash validators");
  const standby = nanoStandbyConfig(bases, standbyOptions), standbyUrl = standby?.url;
  const allBases = standby ? [...bases, standbyUrl] : bases;
  const minimum = Math.min(2, bases.length), networks = new Map(), cooldowns = new Map(), laggingPeers = new Set();
  const configuration = rpcPeerSetId(allBases);
  const observedAt = Date.parse(previousFundingReport?.checkedAt);
  const priorRpc = previousFundingReport?.nanoRpc;
  const startedAt = now();
  if (previousFundingReport?.v === 1 && Number.isFinite(observedAt) && observedAt <= startedAt
      && priorRpc?.configuration === configuration && priorRpc.configuredPeers === allBases.length) {
    try {
      const saved = selectRpcCooldowns(priorRpc.cooldowns, allBases.length, observedAt);
      for (const { peer, until } of saved) if (until > startedAt) cooldowns.set(allBases[peer], { until, failures: 1 });
    } catch { /* Unusable advisory data confers no authority on any peer. */ }
  }
  let high = null, final = null, blocked = false, lastReadAt = null, readPeers = 0, preferred = [], inflightNetwork = null;
  let standbyInUse = false, ownedPrimaryInUse = false, lastReadBases = [], standbyTail = Promise.resolve();
  let paymentWindowPriorityUntil = -Infinity;
  let standbyAccountEvidence = null;
  const standbyAttempts = [];
  const historyRefused = new Map();
  const expired = (at, ttl) => now() < at || now() - at >= ttl;
  const cooling = base => (cooldowns.get(base)?.until ?? 0) > now();
  const requestBlocked = base => cooling(base) || historyRefused.has(base);
  const hasProof = base => !cooling(base) && networks.get(base)?.ok && !expired(networks.get(base).at, networkTtlMs);
  const availableProof = base => !historyRefused.has(base) && hasProof(base);
  const hasStandbyQuorum = () => readPeers >= minimum && availableProof(standbyUrl) && preferred.some(availableProof);
  function standbyBudgetAvailable(at, requests) {
    while (standbyAttempts.length && at - standbyAttempts[0] >= NANO_STANDBY_BUDGET_MS) standbyAttempts.shift();
    return standbyAttempts.length + requests <= standby.requestsPerMinute;
  }
  function readRpc(body, base) {
    if (requestBlocked(base)) throw fail("NANO_RPC_COOLDOWN", "Nano RPC peer is cooling down");
    if (base === standbyUrl) {
      const at = monotonicNow();
      if (!standbyBudgetAvailable(at, 1)) throw standbyBudgetExhausted();
      // An attempted standby observation supersedes the previous one. A
      // successful account quorum records its replacement in select().
      standbyAccountEvidence = null;
      standbyAttempts.push(at); // Charge attempts before I/O, including refusals.
    }
    return rpc(body, base);
  }
  function rateLimit(base, error) {
    if (error?.rateLimited !== true) return;
    const prior = cooldowns.get(base);
    const failures = Math.min((prior?.failures || 0) + 1, 5);
    const fallback = Math.min(300_000, 30_000 * 2 ** (failures - 1));
    const hint = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 ? Math.min(MAX_RPC_RETRY_MS, error.retryAfterMs) : 0;
    cooldowns.set(base, { until: Math.max(prior?.until ?? 0, now() + Math.max(fallback, hint)), failures });
    networks.set(base, { ok: false, at: now() });
  }
  async function proveNetwork(base) {
    if (requestBlocked(base)) return;
    const prior = networks.get(base);
    if (prior && !expired(prior.at, prior.ok ? networkTtlMs : 5_000)) return;
    try { checkNanoGenesis(await readRpc({ action: "block_info", hash: NANO_GENESIS, json_block: "true" }, base)); networks.set(base, { ok: true, at: now() }); }
    catch (error) { rateLimit(base, error); networks.set(base, { ok: false, at: now() }); }
  }
  async function networkBases() {
    if (inflightNetwork) return inflightNetwork;
    inflightNetwork = (async () => {
      await Promise.all(fallbackBases.map(proveNetwork));
      return fallbackBases.filter(availableProof);
    })().finally(() => { inflightNetwork = null; });
    return inflightNetwork;
  }
  function withStandbyReads(requests, read, { existingPayments = false, background = false } = {}) {
    // A concurrent checkpoint or block lookup must not spend the account_info
    // request needed to validate a receivable or history page already in flight.
    const attempt = standbyTail.then(async () => {
      if (requestBlocked(standbyUrl)) return null;
      const proved = hasProof(standbyUrl);
      const at = monotonicNow(), required = requests + Number(!proved);
      if (background && at < paymentWindowPriorityUntil) throw standbyBudgetExhausted();
      if (!standbyBudgetAvailable(at, required)) {
        // A periodic account check can otherwise consume fresh quota just
        // before every payment poll. Reserve it across the watcher's backoff.
        if (existingPayments && standby.requestsPerMinute >= NANO_COLD_STANDBY_SCAN_REQUESTS) {
          paymentWindowPriorityUntil = at + 2 * NANO_STANDBY_BUDGET_MS;
        }
        throw standbyBudgetExhausted();
      }
      if (!proved) await proveNetwork(standbyUrl);
      return hasProof(standbyUrl) ? read() : null;
    });
    standbyTail = attempt.then(() => {}, () => {});
    return attempt;
  }
  const infoRequest = () => ({ action: "account_info", account, representative: "true", include_confirmed: "true", receivable: "true" });
  function select(rows, required = minimum) {
    readPeers = 0;
    if (blocked) throw fail("NANO_RPC_CONFLICT");
    if (rows.length < required) throw fail("NANO_RPC_READ_QUORUM", "Not enough readable mainnet Nano peers; new spending is paused");
    const latestConfirmed = rows.reduce((a, b) => a.view.confirmedHeight >= b.view.confirmedHeight ? a : b).view;
    if (final && (latestConfirmed.confirmedHeight < final.confirmedHeight
        || (latestConfirmed.confirmedHeight === final.confirmedHeight && latestConfirmed.confirmedFrontier !== final.confirmedFrontier))) throw fail("NANO_RPC_REGRESSION");
    rows.sort((a, b) => a.view.height !== b.view.height ? a.view.height > b.view.height ? -1 : 1
      : a.view.pending !== b.view.pending ? a.view.pending > b.view.pending ? -1 : 1
      : a.view.confirmedHeight !== b.view.confirmedHeight ? a.view.confirmedHeight > b.view.confirmedHeight ? -1 : 1 : 0);
    const best = rows[0], v = best.view;
    const knownLocal = high?.local === true && high.height === v.height && high.frontier === v.frontier;
    if (v.height > latestConfirmed.confirmedHeight && !knownLocal) throw fail("NANO_RPC_UNCONFIRMED_FRONTIER", "Nano account has an unknown unconfirmed head; new spending is paused");
    if (high && (v.height < high.height || (v.height === high.height && (v.frontier !== high.frontier || v.balance !== high.balance
        || (high.pending != null && v.pending < high.pending))))) throw fail("NANO_RPC_REGRESSION");
    if (persistConfirmed) {
      // A readable fallback can still lag. Each required witness must
      // confirm the same block before the new checkpoint is persisted.
      const witnesses = required === 1 && best.base === ownedPrimary ? 1 : 2;
      if (rows.filter(({ view }) => view.confirmedHeight === latestConfirmed.confirmedHeight).length < witnesses) throw unprovenCheckpoint();
      const head = { hash: latestConfirmed.confirmedFrontier, blockCount: latestConfirmed.confirmedHeight.toString() };
      persistConfirmed({ v: 1, networkGenesis: NANO_GENESIS, account, head, confirmed: head });
    }
    high = { ...v, local: knownLocal }; final = { ...latestConfirmed }; lastReadAt = now(); readPeers = rows.length;
    lastReadBases = rows.map(row => row.base);
    ownedPrimaryInUse = ownedPrimary !== null && best.base === ownedPrimary;
    standbyInUse = rows.some(r => r.base === standbyUrl);
    preferred = rows.filter(r => r.base !== standbyUrl && r.view.height === v.height && r.view.pending === v.pending).map(r => r.base);
    standbyAccountEvidence = standbyInUse ? { base: preferred[0], view: v, monotonicAt: monotonicNow() } : null;
    return best;
  }
  async function anchoredRows(rows, anchor, required = minimum) {
    if (rows.length < required) throw unprovenCheckpoint();
    const height = BigInt(anchor.blockCount);
    const newest = rows.reduce((best, row) => row.view.confirmedHeight > best ? row.view.confirmedHeight : best, 0n);
    if (newest < height) throw unprovenCheckpoint();
    if (rows.some(({ view }) => view.confirmedHeight === height && view.confirmedFrontier !== anchor.hash)) {
      throw conflictingCheckpoint();
    }
    const current = rows.filter(({ view }) => view.confirmedHeight === newest);
    if (current.length < required) throw unprovenCheckpoint();
    if (!current.every(({ view }) => view.confirmedFrontier === current[0].view.confirmedFrontier
        && view.confirmedBalance === current[0].view.confirmedBalance
        && view.confirmedRepresentative === current[0].view.confirmedRepresentative)) {
      throw conflictingCheckpoint();
    }
    if (newest === height) return current;
    // At a greater height use each peer's own confirmed historical block.
    // A trusted mainnet node only confirms one block per account height.
    const witnesses = (await Promise.all(current.map(async row => {
      try {
        const historic = await readRpc({ action: "block_info", hash: anchor.hash, json_block: "true" }, row.base);
        return matchesNanoConfirmedBlock(historic, { account, anchor, hashBlock }) ? row : null;
      } catch (error) { rateLimit(row.base, error); return null; }
    }))).filter(row => row && hasProof(row.base));
    if (witnesses.length < required) throw unprovenCheckpoint();
    return witnesses;
  }
  function currentAnchor(confirmedHeight) {
    if (high && (!final || high.height > final.confirmedHeight) && confirmedHeight >= high.height) {
      return { hash: high.frontier, blockCount: high.height.toString() };
    }
    return final && { hash: final.confirmedFrontier, blockCount: final.confirmedHeight.toString() };
  }
  function reusedFundingView(primary) {
    const evidence = standbyAccountEvidence;
    if (!evidence || !availableProof(standbyUrl) || !availableProof(primary.base)) return null;
    const at = now(), elapsed = monotonicNow() - evidence.monotonicAt;
    if (at < lastReadAt || elapsed < 0) return null;
    const fundingEvidenceExpiresAt = Math.floor(Math.min(lastReadAt + NANO_FUNDING_EVIDENCE_MS,
      at + NANO_FUNDING_EVIDENCE_MS - elapsed, networks.get(standbyUrl).at + networkTtlMs,
      networks.get(primary.base).at + networkTtlMs));
    if (!(fundingEvidenceExpiresAt > at)) return null;
    const nanoRpc = status();
    // The exact same current account view was read again from the primary.
    // Only telemetry can reuse its still-fresh standby corroboration.
    return { info: primary.info, reused: true, nanoRpc: { ...nanoRpc, fundingEvidenceExpiresAt,
      readablePeers: minimum, networkPeers: Math.max(minimum, nanoRpc.networkPeers),
      standby: { ...nanoRpc.standby, inUse: true } } };
  }
  async function read(body, anchor, options) {
    try { return await readAccount(body, anchor, options); }
    catch (error) {
      if (error?.code !== "NANO_RPC_STANDBY_BUDGET") standbyAccountEvidence = null;
      throw error;
    }
  }
  async function readAccount(body, anchor = null, {
    paymentWindow = null, existingPayments = false, background = false, fundingReport = false, receivableState = false,
  } = {}) {
    if (!["account_info", "receivable", "account_history"].includes(body.action)) throw fail("NANO_RPC_READ_ACTION");
    if (body.account !== account) throw fail("NANO_RPC_ACCOUNT_SCOPE");
    const errors = [], primaryViews = [];
    async function readPeer(base) {
      if (!hasProof(base)) return null;
      const priorCooldown = cooldowns.get(base);
      try {
        let data = body.action === "account_info" ? null : await readRpc({ ...body, ...(body.action === "receivable" ? { include_only_confirmed: "true" } : {}) }, base);
        const info = await readRpc(infoRequest(), base), view = nanoAccountView(info, checkAddress);
        const row = { base, info, view };
        if (base !== standbyUrl && base !== ownedPrimary) primaryViews.push(row);
        if (body.action === "receivable") data = checkedReceivable(data, body, view, checkAddress);
        // The standby has a fixed RPC budget for a cold scan.
        const historyProof = { rpc: base === standbyUrl ? null : request => readRpc(request, base), checkAddress, hashBlock };
        if (body.action === "account_history") {
          data = body.head && yes(body.raw)
            ? await completeAnchoredNanoHistory(data, body, { ...historyProof,
              height: view.confirmedFrontier === body.head.toUpperCase() ? view.confirmedHeight : null })
            : checkedHistory(data, checkAddress);
        }
        let history = null;
        if (paymentWindow) {
          const head = paymentWindow.historyHead ?? view.confirmedFrontier;
          const request = { action: "account_history", account, head, count: String(NANO_HISTORY_PAGE), raw: "true" };
          try {
            const height = paymentWindow.historyHeight;
            const frontierHeight = head === view.confirmedFrontier ? view.confirmedHeight : null;
            if (height !== null && frontierHeight !== null && BigInt(height) !== frontierHeight) throw fail("NANO_RPC_UNPROVEN_HISTORY");
            const proved = await completeAnchoredNanoHistory(await readRpc(request, base), request, { ...historyProof, height: frontierHeight ?? height });
            if (BigInt(proved.history[0].height) <= view.confirmedHeight) history = proved;
          } catch (error) {
            if (error?.rateLimited === true) {
              // Suppress new I/O as soon as the peer refuses history. Delay
              // invalidating this window's already verified account view.
              historyRefused.set(base, (historyRefused.get(base) ?? 0) + 1);
              paymentWindow.historyRefusals.push({ base, error });
            }
          }
        }
        // An older in-flight success cannot erase a newer concurrent refusal.
        if (cooldowns.get(base) === priorCooldown) cooldowns.delete(base);
        return { ...row, data, history };
      } catch (error) { rateLimit(base, error); errors.push(error); }
      return null;
    }
    function result(best, candidates, required) {
      if (fundingReport) return { info: best.info, nanoRpc: status() };
      if (receivableState) return { info: best.info, receivable: best.data };
      if (paymentWindow) {
        const complete = candidates.filter(row => row.history && row.view.confirmedFrontier === final.confirmedFrontier
          && row.view.confirmedHeight === final.confirmedHeight);
        return { receivable: best.data, history: complete.length >= required ? complete[0].history : null };
      }
      return body.action === "account_info" ? best.info : best.data;
    }
    let ownedError;
    if (ownedPrimary) {
      await proveNetwork(ownedPrimary);
      const row = await readPeer(ownedPrimary);
      if (row && hasProof(ownedPrimary) && (!paymentWindow || row.history)) {
        try {
          const floor = anchor ?? currentAnchor(row.view.confirmedHeight);
          const verified = floor ? await anchoredRows([row], floor, 1) : [row];
          return result(select(verified, 1), verified, 1);
        } catch (error) { ownedError = error; }
      }
      errors.length = 0;
    }
    const eligible = await networkBases();
    if (eligible.length < minimum && (!standby || eligible.length !== 1)) {
      readPeers = 0; throw ownedError ?? fail("NANO_RPC_NETWORK_QUORUM");
    }
    const replies = (await Promise.all(eligible.map(readPeer))).filter(row => row && hasProof(row.base));
    if (replies.length === 0 && eligible.length >= minimum && errors.length === eligible.length
        && errors.every(e => e.authoritative && /Account not found/i.test(e.message))) {
      readPeers = 0; throw errors[0];
    }
    const previousReadPeers = readPeers;
    readPeers = 0;
    const { current, lagging, latestConfirmed } = qualifyNanoAccountViews(primaryViews.filter(row => hasProof(row.base)));
    // An older, overlapping read cannot requalify a peer behind the last
    // confirmed observation, even if its own responses agreed with each other.
    if (final && latestConfirmed && latestConfirmed.confirmedHeight < final.confirmedHeight) throw fail("NANO_RPC_REGRESSION");
    const confirmedNow = row => !persistConfirmed || row.view.confirmedHeight === latestConfirmed.confirmedHeight;
    for (const row of current) {
      if (confirmedNow(row)) laggingPeers.delete(row.base);
      else laggingPeers.add(row.base);
    }
    for (const { base } of lagging) laggingPeers.add(base);
    const rows = replies.filter(row => !laggingPeers.has(row.base));
    async function finish(candidates) {
      const valid = candidates.filter(row => hasProof(row.base));
      if (!anchor && valid.length < minimum) {
        if (persistConfirmed && current.some(row => !confirmedNow(row))) throw unprovenCheckpoint();
        if (lagging.length) throw fail("NANO_RPC_LAGGING_PEERS", "Not enough Nano peers have a current confirmed account view");
        if (ownedPrimary) throw fail("NANO_RPC_READ_QUORUM", "Not enough readable mainnet Nano peers; new spending is paused");
      }
      const floor = anchor ?? (ownedPrimary && latestConfirmed ? currentAnchor(latestConfirmed.confirmedHeight) : null);
      const verified = floor ? await anchoredRows(valid, floor) : valid;
      return result(select(verified), verified, minimum);
    }
    if (rows.length === 1 && standby && !blocked) {
      const { base, view: primary } = rows[0];
      // An invalid history or receivable response does not erase a valid,
      // competing account view the primary returned during that request.
      if (current.some(row => confirmedNow(row) && !sameAccountView(primary, row.view))) {
        readPeers = 0; throw fail("NANO_RPC_CONFLICT");
      }
      if (standbyAccountEvidence && (standbyAccountEvidence.base !== base || !sameAccountView(standbyAccountEvidence.view, primary))) {
        standbyAccountEvidence = null;
      }
      if (fundingReport) {
        const reused = reusedFundingView(rows[0]);
        if (reused) {
          readPeers = previousReadPeers;
          return reused;
        }
      }
      const readRequests = paymentWindow ? NANO_COLD_STANDBY_SCAN_REQUESTS - 1 : body.action === "account_info" ? 1 : 2;
      const floor = anchor ?? (ownedPrimary ? currentAnchor(primary.confirmedHeight) : null);
      const historicWitness = floor !== null && primary.confirmedHeight > BigInt(floor.blockCount);
      const confirmed = await withStandbyReads(readRequests + Number(historicWitness), async () => {
        if (!hasProof(base)) return null;
        const other = await readPeer(standbyUrl);
        if (!other || !hasProof(standbyUrl) || !hasProof(base)) return null;
        if (!sameAccountView(primary, other.view)) {
          readPeers = 0; throw fail("NANO_RPC_STANDBY_DISAGREES");
        }
        return finish([...rows, other]);
      }, { existingPayments, background });
      if (confirmed) return confirmed;
    }
    return finish(rows);
  }
  function observe({ frontier, balance, blockCount, representative }) {
    if (blockCount == null) return true;
    const height = BigInt(blockCount);
    // Preserve success of a known publish if a read observed a descendant.
    if (high && height < high.height) return false;
    if (high && height === high.height && high.frontier !== frontier.toUpperCase()) {
      standbyAccountEvidence = null;
      blocked = true;
      return false;
    }
    if (!high || height > high.height) {
      standbyAccountEvidence = null;
      high = { height, frontier: frontier.toUpperCase(), balance: BigInt(balance), representative, pending: null, local: true };
    }
    return true;
  }
  function status() {
    const availableReads = ownedPrimary ? Math.min(readPeers, lastReadBases.filter(availableProof).length) : readPeers;
    return { enforced: true, configuredPeers: allBases.length, minimumPeers: ownedPrimaryInUse ? 1 : minimum,
      readablePeers: standbyInUse && !hasStandbyQuorum() ? 0 : availableReads,
      networkPeers: bases.filter(availableProof).length + Number(standbyInUse && hasStandbyQuorum()), lastReadAt,
      configuration, cooldowns: allBases.flatMap((base, peer) => cooling(base) ? [{ peer, until: cooldowns.get(base).until }] : []),
      ...(ownedPrimary && { ownedPrimaryInUse }),
      ...(standby && { standby: { inUse: standbyInUse && hasStandbyQuorum(), requestsPerMinute: standby.requestsPerMinute,
        coldPaymentScanRequests: NANO_COLD_STANDBY_SCAN_REQUESTS } }),
      checkpoint: high && final && !blocked ? { v: 1, networkGenesis: NANO_GENESIS, account,
        head: { hash: high.frontier, blockCount: high.height.toString() },
        confirmed: { hash: final.confirmedFrontier, blockCount: final.confirmedHeight.toString() } } : null };
  }
  return {
    read: (body, anchor) => read(body, anchor),
    readFundingInfo: () => read(infoRequest(), null, { background: true, fundingReport: true }),
    readReceivableState: body => read(body, null, { receivableState: true }),
    readPaymentHistory: body => read(body, null, { existingPayments: true }),
    async readPaymentWindow({ existingPayments = false, historyHead = null, historyHeight = null } = {}) {
      if (historyHead !== null && (!existingPayments || !hash(historyHead))) throw fail("NANO_RPC_UNPROVEN_HISTORY");
      if (historyHeight !== null && (historyHead === null || !isNanoBlockHeight(historyHeight))) throw fail("NANO_RPC_UNPROVEN_HISTORY");
      const historyRefusals = [];
      try {
        const window = await read({ action: "receivable", account, count: String(NANO_RECEIVABLE_COUNT), threshold: "1",
          source: "true" }, null, { paymentWindow: { historyHead: historyHead?.toUpperCase(), historyHeight, historyRefusals }, existingPayments,
          background: !existingPayments });
        if (existingPayments && window.history) paymentWindowPriorityUntil = -Infinity;
        return window;
      } finally {
        // A refusal of the later history request cools the endpoint for
        // future reads without discarding its already verified receivables.
        for (const { base, error } of historyRefusals) {
          rateLimit(base, error);
          const pending = historyRefused.get(base) - 1;
          if (pending) historyRefused.set(base, pending);
          else historyRefused.delete(base);
        }
      }
    },
    async verifyCheckpoint(value) {
      const checkpoint = selectNanoCheckpoint(value, account);
      if (minimum < 2) throw unprovenCheckpoint();
      try { await read(infoRequest(), checkpoint.head); }
      catch (error) {
        if (error.code === "NANO_RPC_CONFLICT") throw conflictingCheckpoint();
        throw error;
      }
    },
    isCooling: base => bases.includes(base) && requestBlocked(base),
    async block(body) {
      if (body.action !== "block_info" || !hash(body.hash)) throw fail("NANO_RPC_READ_ACTION");
      const found = [], missing = [];
      async function lookup(base) {
        if (requestBlocked(base)) return;
        const priorCooldown = cooldowns.get(base);
        try {
          const data = await readRpc({ ...body, json_block: "true" }, base);
          if (![true, false, "true", "false"].includes(data.confirmed)) throw fail("NANO_RPC_BAD_BLOCK");
          let block = data.contents;
          if (typeof block === "string") block = JSON.parse(block);
          if (!block || !["state", "open", "send", "receive", "change"].includes(block.type)) throw fail("NANO_RPC_BAD_BLOCK");
          if (block.type === "state" && hashBlock(block).toUpperCase() !== body.hash.toUpperCase()) throw fail("NANO_RPC_BAD_BLOCK");
          if (yes(data.confirmed) && block.type === "state" && canonical(block.account) === account && raw(data.height) < 1n) throw fail("NANO_RPC_BAD_BLOCK");
          found.push({ data, block });
          if (cooldowns.get(base) === priorCooldown) cooldowns.delete(base);
        } catch (e) { rateLimit(base, e); if (e.authoritative && /block not found|unknown block/i.test(e.message)) missing.push(e); }
      }
      let eligible;
      if (ownedPrimary) {
        await proveNetwork(ownedPrimary);
        if (availableProof(ownedPrimary)) {
          await lookup(ownedPrimary);
          if (availableProof(ownedPrimary) && (found.some(row => yes(row.data.confirmed))
              || (ownedPrimaryInUse && readPeers === 1 && (found.length || missing.length)))) {
            eligible = [ownedPrimary];
          }
        }
        if (!eligible) { found.length = 0; missing.length = 0; }
      }
      if (!eligible) {
        const primary = await networkBases();
        eligible = primary;
        if (primary.length === 1 && standby) {
          // With both network proofs still fresh, a positive confirmation
          // already meets policy. Absence still needs the standby.
          const lookedUpPrimary = hasProof(standbyUrl);
          if (lookedUpPrimary) await lookup(primary[0]);
          if (!(hasProof(primary[0]) && hasProof(standbyUrl) && found.some(row => yes(row.data.confirmed)))) {
            const checked = await withStandbyReads(1, async () => {
              if (!hasProof(primary[0])) return false;
              await Promise.all(lookedUpPrimary ? [lookup(standbyUrl)] : [lookup(primary[0]), lookup(standbyUrl)]);
              return true;
            });
            if (!checked) throw fail("NANO_RPC_NETWORK_QUORUM");
          }
          eligible = [...primary, standbyUrl];
        } else {
          if (eligible.length < minimum) throw fail("NANO_RPC_NETWORK_QUORUM");
          await Promise.all(eligible.map(lookup));
        }
      }
      const confirmed = found.find(d => yes(d.data.confirmed));
      if (confirmed) {
        const { data, block } = confirmed;
        if (block.type === "state" && canonical(block.account) === account) {
          observe({ frontier: body.hash, balance: block.balance, representative: block.representative, blockCount: data.height });
          const height = BigInt(data.height);
          if (final && final.confirmedHeight === height && final.confirmedFrontier !== body.hash.toUpperCase()) blocked = true;
          if (!final || height > final.confirmedHeight) {
            standbyAccountEvidence = null;
            final = { confirmedHeight: height, confirmedFrontier: body.hash.toUpperCase() };
          }
        }
        return data;
      }
      if (found.length) return found[0].data; // A known unconfirmed block may still land.
      if (missing.length === eligible.length) throw missing[0];
      throw fail("NANO_RPC_BLOCK_UNCERTAIN", "Nano block lookup could not establish its outcome");
    },
    async publishBases() {
      if (blocked) throw fail("NANO_RPC_CONFLICT");
      if (ownedPrimaryInUse) {
        await proveNetwork(ownedPrimary);
        if (readPeers !== 1 || !availableProof(ownedPrimary)) throw fail("NANO_RPC_NETWORK_QUORUM");
        return [ownedPrimary];
      }
      const eligible = (await networkBases()).filter(base => !laggingPeers.has(base));
      const validated = preferred.filter(b => eligible.includes(b));
      if (standbyInUse) {
        if (!hasStandbyQuorum() || !validated.length) throw fail("NANO_RPC_NETWORK_QUORUM");
        return validated;
      }
      if (ownedPrimary) {
        if (readPeers < minimum || lastReadBases.filter(availableProof).length < minimum || !validated.length) {
          throw fail("NANO_RPC_NETWORK_QUORUM");
        }
        return validated;
      }
      if (!eligible.length) throw fail("NANO_RPC_NETWORK_QUORUM");
      return [...validated, ...eligible.filter(b => !preferred.includes(b))];
    },
    observe,
    status,
  };
}
