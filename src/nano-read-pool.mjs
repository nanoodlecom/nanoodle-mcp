export const NANO_GENESIS = "991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948";
const GENESIS_KEY = "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA";
const GENESIS_ACCOUNT = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const HASH = /^[A-F0-9]{64}$/i, U128 = (1n << 128n) - 1n;
const fail = (code, message = "Nano RPC peers cannot provide a consistent current account view") => Object.assign(Error(message), { code });
const hash = value => typeof value === "string" && HASH.test(value) && !/^0+$/.test(value);
const raw = value => { if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128) throw fail("NANO_RPC_BAD_VIEW"); return BigInt(value); };
const yes = value => value === true || value === "true";
const canonical = account => String(account || "").replace(/^xrb_/, "nano_");

export function checkNanoGenesis(value) {
  let block = value?.contents;
  try { if (typeof block === "string") block = JSON.parse(block); } catch { throw fail("NANO_RPC_WRONG_NETWORK"); }
  if (!yes(value?.confirmed) || block?.type !== "open" || block.source !== GENESIS_KEY
      || canonical(block.account) !== GENESIS_ACCOUNT || canonical(block.representative) !== GENESIS_ACCOUNT) {
    throw fail("NANO_RPC_WRONG_NETWORK", "Nano RPC does not prove the mainnet genesis block");
  }
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

function checkedReceivable(value, body, view, checkAddress) {
  const blocks = value?.blocks;
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

function checkedHistory(value, checkAddress) {
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
export function createNanoReadPool({ bases, rpc, account, checkAddress, hashBlock, now = Date.now, networkTtlMs = 30_000 }) {
  if (!Array.isArray(bases) || !bases.length || bases.length > 8 || bases.some(b => typeof b !== "string" || !b)) throw new TypeError("Nano read pool needs between one and eight endpoint identifiers");
  if (new Set(bases).size !== bases.length) throw new TypeError("Duplicate Nano RPC endpoints are not independent peers");
  if (typeof checkAddress !== "function" || typeof hashBlock !== "function") throw new TypeError("Nano read pool needs wallet-owned address and hash validators");
  const minimum = Math.min(2, bases.length), networks = new Map();
  let high = null, final = null, blocked = false, lastReadAt = null, readPeers = 0, preferred = [], inflightNetwork = null;
  const expired = (at, ttl) => now() < at || now() - at >= ttl;
  async function networkBases() {
    if (inflightNetwork) return inflightNetwork;
    inflightNetwork = (async () => {
      await Promise.all(bases.map(async base => {
        const prior = networks.get(base);
        if (prior && !expired(prior.at, prior.ok ? networkTtlMs : 5_000)) return;
        try { checkNanoGenesis(await rpc({ action: "block_info", hash: NANO_GENESIS, json_block: "true" }, base)); networks.set(base, { ok: true, at: now() }); }
        catch { networks.set(base, { ok: false, at: now() }); }
      }));
      return bases.filter(base => networks.get(base)?.ok && !expired(networks.get(base).at, networkTtlMs));
    })().finally(() => { inflightNetwork = null; });
    return inflightNetwork;
  }
  const infoRequest = () => ({ action: "account_info", account, representative: "true", include_confirmed: "true", receivable: "true" });
  function select(rows) {
    readPeers = 0;
    if (blocked) throw fail("NANO_RPC_CONFLICT");
    if (rows.length < minimum) throw fail("NANO_RPC_READ_QUORUM", "Not enough readable mainnet Nano peers; new spending is paused");
    const confirmed = new Map(), heads = new Map();
    for (const row of rows) {
      const v = row.view, key = v.height.toString(), ck = v.confirmedHeight.toString();
      const head = `${v.frontier}:${v.balance}:${v.representative}`;
      const c = `${v.confirmedFrontier}:${v.confirmedBalance}:${v.confirmedRepresentative}`;
      if ((heads.has(key) && heads.get(key) !== head) || (confirmed.has(ck) && confirmed.get(ck) !== c)) throw fail("NANO_RPC_CONFLICT");
      heads.set(key, head); confirmed.set(ck, c);
    }
    for (const [height, state] of confirmed) if (heads.has(height) && heads.get(height) !== state) throw fail("NANO_RPC_CONFLICT");
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
    high = { ...v, local: knownLocal }; final = { ...latestConfirmed }; lastReadAt = now(); readPeers = rows.length;
    preferred = rows.filter(r => r.view.height === v.height && r.view.pending === v.pending).map(r => r.base);
    return best;
  }
  async function read(body) {
    if (!["account_info", "receivable", "account_history"].includes(body.action)) throw fail("NANO_RPC_READ_ACTION");
    if (body.account !== account) throw fail("NANO_RPC_ACCOUNT_SCOPE");
    const eligible = await networkBases(), rows = [], errors = [];
    if (eligible.length < minimum) { readPeers = 0; throw fail("NANO_RPC_NETWORK_QUORUM"); }
    await Promise.all(eligible.map(async base => {
      try {
        let data = body.action === "account_info" ? null : await rpc({ ...body, ...(body.action === "receivable" ? { include_only_confirmed: "true" } : {}) }, base);
        const info = await rpc(infoRequest(), base), view = nanoAccountView(info, checkAddress);
        if (body.action === "receivable") data = checkedReceivable(data, body, view, checkAddress);
        if (body.action === "account_history") data = checkedHistory(data, checkAddress);
        rows.push({ base, info, view, data });
      } catch (error) { errors.push(error); }
    }));
    if (rows.length === 0 && errors.length === eligible.length && errors.every(e => e.authoritative && /Account not found/i.test(e.message))) { readPeers = 0; throw errors[0]; }
    const best = select(rows);
    return body.action === "account_info" ? best.info : best.data;
  }
  function observe({ frontier, balance, blockCount, representative }) {
    if (blockCount == null) return true;
    const height = BigInt(blockCount);
    // Preserve success of a known publish if a read observed a descendant.
    if (high && height < high.height) return false;
    if (high && height === high.height && high.frontier !== frontier.toUpperCase()) { blocked = true; return false; }
    if (!high || height > high.height) high = { height, frontier: frontier.toUpperCase(), balance: BigInt(balance), representative, pending: null, local: true };
    return true;
  }
  return {
    read,
    async block(body) {
      if (body.action !== "block_info" || !hash(body.hash)) throw fail("NANO_RPC_READ_ACTION");
      const eligible = await networkBases(), found = [], missing = [];
      if (eligible.length < minimum) throw fail("NANO_RPC_NETWORK_QUORUM");
      await Promise.all(eligible.map(async base => {
        try {
          const data = await rpc({ ...body, json_block: "true" }, base);
          if (![true, false, "true", "false"].includes(data.confirmed)) throw fail("NANO_RPC_BAD_BLOCK");
          let block = data.contents;
          if (typeof block === "string") block = JSON.parse(block);
          if (!block || !["state", "open", "send", "receive", "change"].includes(block.type)) throw fail("NANO_RPC_BAD_BLOCK");
          if (block.type === "state" && hashBlock(block).toUpperCase() !== body.hash.toUpperCase()) throw fail("NANO_RPC_BAD_BLOCK");
          if (yes(data.confirmed) && block.type === "state" && canonical(block.account) === account && raw(data.height) < 1n) throw fail("NANO_RPC_BAD_BLOCK");
          found.push({ data, block });
        } catch (e) { if (e.authoritative && /block not found|unknown block/i.test(e.message)) missing.push(e); }
      }));
      const confirmed = found.find(d => yes(d.data.confirmed));
      if (confirmed) {
        const { data, block } = confirmed;
        if (block.type === "state" && canonical(block.account) === account) {
          observe({ frontier: body.hash, balance: block.balance, representative: block.representative, blockCount: data.height });
          const height = BigInt(data.height);
          if (final && final.confirmedHeight === height && final.confirmedFrontier !== body.hash.toUpperCase()) blocked = true;
          if (!final || height > final.confirmedHeight) final = { confirmedHeight: height, confirmedFrontier: body.hash.toUpperCase() };
        }
        return data;
      }
      if (found.length) return found[0].data; // A known unconfirmed block may still land.
      if (missing.length === eligible.length) throw missing[0];
      throw fail("NANO_RPC_BLOCK_UNCERTAIN", "Nano block lookup could not establish its outcome");
    },
    async publishBases() {
      if (blocked) throw fail("NANO_RPC_CONFLICT");
      const eligible = await networkBases();
      if (!eligible.length) throw fail("NANO_RPC_NETWORK_QUORUM");
      return [...preferred.filter(b => eligible.includes(b)), ...eligible.filter(b => !preferred.includes(b))];
    },
    observe,
    status: () => ({ enforced: true, configuredPeers: bases.length, minimumPeers: minimum, readablePeers: readPeers,
      networkPeers: bases.filter(b => networks.get(b)?.ok && !expired(networks.get(b).at, networkTtlMs)).length, lastReadAt,
      checkpoint: high && final && !blocked ? { v: 1, networkGenesis: NANO_GENESIS, account,
        head: { hash: high.frontier, blockCount: high.height.toString() },
        confirmed: { hash: final.confirmedFrontier, blockCount: final.confirmedHeight.toString() } } : null }),
  };
}
