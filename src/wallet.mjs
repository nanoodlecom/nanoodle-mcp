/**
 * x402 wallet mode — a Nano (XNO) hot wallet that pays NanoGPT invoices.
 *
 * The `nanoodle` library never touches funds or keys by design: keyless runs
 * surface each HTTP 402 as an invoice to a `payment` callback. This module is
 * that callback's home. It holds the secret key (this is the application
 * layer — use a dedicated wallet with a small balance), builds and signs the
 * send block locally, and only ever ships the *signed block* to a Nano RPC
 * node. The seed/secret key never leaves the process.
 *
 * Sends are serialized through an internal queue: concurrent tool calls would
 * otherwise race on the account frontier and one block would bounce.
 */
import {
  checkAddress,
  checkKey,
  checkSeed,
  computeWork,
  createBlock,
  deriveAddress,
  derivePublicKey,
  deriveSecretKey,
} from "nanocurrency";

export const DEFAULT_NANO_RPC = "https://rpc.nano.to";

/** Network send threshold since Nano v21 — nanocurrency's default is the old, lower one. */
const SEND_WORK_THRESHOLD = "fffffff800000000";
/** Receive blocks are allowed much cheaper work since v21. */
const RECEIVE_WORK_THRESHOLD = "fffffe0000000000";

/** raw → XNO display string (1 XNO = 10^30 raw), trimmed to something readable. */
export function rawToXno(raw) {
  const s = BigInt(raw).toString().padStart(31, "0");
  const whole = s.slice(0, -30);
  const frac = s.slice(-30, -30 + 8).replace(/0+$/, "");
  return whole + (frac ? "." + frac : "");
}

/**
 * Resolve NANO_PRIVATE_KEY / NANO_SEED material to a secret key, or null when
 * neither is set. Throws with a readable message on malformed values.
 */
export function resolveWalletKey({ privateKey, seed } = {}) {
  if (privateKey) {
    if (!checkKey(privateKey)) throw new Error("NANO_PRIVATE_KEY must be a 64-hex-character Nano secret key");
    return privateKey;
  }
  if (seed) {
    if (!checkSeed(seed)) throw new Error("NANO_SEED must be a 64-hex-character Nano seed");
    return deriveSecretKey(seed, 0); // account index 0, like every Nano wallet's first account
  }
  return null;
}

/**
 * Build the wallet: derives the address and returns the x402 `payment`
 * callback to pass to the nanoodle Workflow.
 *
 * @param {{ secretKey: string, rpcUrl?: string, workUrl?: string|null, workKey?: string|null, workTimeoutMs?: number, fetch?: typeof fetch, maxUsd?: number|null, log?: (line: string) => void }} opts
 * @returns {{ address: string, payment: (invoice: object) => Promise<void> }}
 */
export function createNanoWallet({ secretKey, rpcUrl = DEFAULT_NANO_RPC, workUrl = null, workKey = null, workTimeoutMs = 120_000, fetch = globalThis.fetch, maxUsd = null, log = () => {} }) {
  if (!checkKey(secretKey)) throw new Error("wallet secret key must be a 64-hex-character Nano secret key");
  const publicKey = derivePublicKey(secretKey);
  const address = deriveAddress(publicKey, { useNanoPrefix: true });
  const rpcBase = String(rpcUrl).replace(/\/+$/, "");
  const workBase = workUrl ? String(workUrl).replace(/\/+$/, "") : null;

  async function rpc(body, base = rpcBase, { headers = {}, signal } = {}) {
    let r;
    try {
      r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new Error(`Nano RPC ${base} unreachable (action ${body.action}): ${e.message}`);
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok || json == null) {
      throw new Error(`Nano RPC ${body.action} failed (HTTP ${r.status}): ${text.slice(0, 200)}`);
    }
    if (json.error) throw new Error(`Nano RPC ${body.action}: ${json.error}`);
    return json;
  }

  async function accountState() {
    const info = await rpc({ action: "account_info", account: address, representative: "true" }).catch((e) => {
      if (/Account not found/i.test(e.message)) {
        throw new Error(
          `wallet ${address} is empty or unopened — fund it with a little XNO first ` +
          "(pending deposits also need one receive; open the account in any Nano wallet)");
      }
      throw e;
    });
    return { frontier: info.frontier, balance: BigInt(info.balance), representative: info.representative };
  }

  // Work: dedicated work server first (--work-rpc, e.g. a local nano-work-server
  // or a hosted GPU work API — public nodes routinely refuse or throttle
  // work_generate), then the main RPC node, then local CPU work so a work-less
  // setup still functions, just slowly. Remote asks carry a timeout so a dead
  // or hopelessly congested work source falls through instead of hanging the
  // payment — set ABOVE worst-case CPU work-server time (~1min at send
  // difficulty), because aborting throws away compute the server has already
  // sunk into the request.
  // With `workKey` set, the dedicated server gets it both as a `key` body field
  // (nano.to style) and a `nodes-api-key` header (Nanswap style).
  async function remoteWork(frontier, threshold) {
    const workSources = workBase ? [["work server " + workBase, workBase], ["Nano RPC", rpcBase]] : [["Nano RPC", rpcBase]];
    for (const [label, base] of workSources) {
      const withKey = workKey && base === workBase;
      try {
        return (await rpc(
          { action: "work_generate", hash: frontier, difficulty: threshold, ...(withKey ? { key: workKey } : {}) },
          base,
          { headers: withKey ? { "nodes-api-key": workKey } : {}, signal: AbortSignal.timeout(workTimeoutMs) },
        )).work;
      } catch (e) {
        log(`work_generate via ${label} failed (${e.message})`);
      }
    }
    return null;
  }

  // Work generated at the send threshold is valid for any block type, so one
  // precomputed value serves whatever block the frontier grows next. The cache
  // is filled fire-and-forget after every published block — sends and receives
  // are serialized on the queue, so by the time the next block needs work it is
  // usually already there and the caller-facing wait drops to ~0.
  const workCache = new Map(); // frontier hash -> Promise<string|null>
  function precomputeWork(frontier) {
    if (workCache.has(frontier)) return;
    if (workCache.size >= 8) workCache.clear(); // superseded frontiers; only the newest matters
    workCache.set(frontier, remoteWork(frontier, SEND_WORK_THRESHOLD).then((w) => {
      if (w == null) workCache.delete(frontier); // don't cache failure; the live path retries + has local CPU
      return w;
    }));
  }

  async function workFor(frontier, threshold) {
    const cached = workCache.get(frontier);
    if (cached) {
      const w = await cached;
      workCache.delete(frontier); // single-use: the frontier advances once this block publishes
      if (w != null) return w;
    }
    const w = await remoteWork(frontier, threshold);
    if (w != null) return w;
    log("computing work locally, this can take a while");
    return computeWork(frontier, { workThreshold: threshold });
  }

  /**
   * Pocket everything receivable. NanoGPT invoices charge the *maximum* a call
   * could cost and refund the difference as a Nano send back to this wallet —
   * without receiving those blocks the refunds never rejoin the spendable
   * balance and the wallet drains far faster than the calls actually cost.
   * Best-effort by design: a receive failure logs and moves on, never blocks
   * the payment that triggered it.
   */
  async function pocketReceivables(state) {
    let blocks;
    try {
      const r = await rpc({ action: "receivable", account: address, count: "20", threshold: "1" });
      blocks = r.blocks && typeof r.blocks === "object" ? Object.entries(r.blocks) : [];
    } catch {
      return state;
    }
    for (const [sendHash, v] of blocks) {
      const amountRaw = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
      if (!/^[0-9A-F]{64}$/i.test(sendHash) || !/^\d+$/.test(String(amountRaw || ""))) continue;
      try {
        const work = await workFor(state.frontier, RECEIVE_WORK_THRESHOLD);
        const { hash, block } = createBlock(secretKey, {
          work,
          previous: state.frontier,
          representative: state.representative,
          balance: (state.balance + BigInt(amountRaw)).toString(),
          link: sendHash,
        });
        block.account = address;
        delete block.link_as_account; // link is a block hash here, not an account
        await rpc({ action: "process", json_block: "true", subtype: "receive", block });
        precomputeWork(hash);
        state = { ...state, frontier: hash, balance: state.balance + BigInt(amountRaw) };
        log(`x402: received ${rawToXno(amountRaw)} XNO (refund/deposit ${sendHash.slice(0, 8)}…, block ${hash})`);
      } catch (e) {
        log(`receive of ${sendHash.slice(0, 8)}… failed (${e.message}) — continuing with current balance`);
        break; // frontier state is now uncertain; stop and let the send path refetch if needed
      }
    }
    return state;
  }

  /**
   * Recover from a transport failure while publishing a send: the response was
   * lost, so the node may or may not have the block. The same signed block is
   * idempotent (same previous), so check the frontier and republish if it
   * didn't land. Returns true once the block is known to be on the account.
   */
  async function settleAfterTransportError(hash, block) {
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1500 * i));
      try {
        const info = await rpc({ action: "account_info", account: address });
        if (info.frontier === hash) return true; // first publish did land, only the response was lost
        await rpc({ action: "process", json_block: "true", subtype: "send", block });
        return true;
      } catch (e) {
        log(`republish attempt ${i} failed (${e.message})`);
      }
    }
    return false;
  }

  /**
   * Build, sign, and publish one send block from a known state. Handles the
   * lost-response republish and the one stale-frontier rebuild. Returns the
   * block hash. `describe` labels the log line ("paid", "refunded", …).
   */
  async function sendFrom(state, to, amount, describe = "sent", extra = "") {
    const insufficient = () => new Error(
      `insufficient wallet balance: send is ${rawToXno(amount)} XNO` +
      ` but ${address} holds ${rawToXno(state.balance)} XNO — top up the wallet to continue`);
    if (amount > state.balance) throw insufficient();
    for (let attempt = 0; ; attempt++) {
      const work = await workFor(state.frontier, SEND_WORK_THRESHOLD);
      const { hash, block } = createBlock(secretKey, {
        work,
        previous: state.frontier,
        representative: state.representative,
        balance: (state.balance - amount).toString(),
        link: to,
      });
      // createBlock renders addresses with the legacy xrb_ prefix; same account, and the
      // signature covers the public key, so normalizing the display form is safe
      block.account = address;
      block.link_as_account = to;
      try {
        await rpc({ action: "process", json_block: "true", subtype: "send", block });
      } catch (e) {
        // Lost response mid-publish: the node may already have the block — verify,
        // republish the identical block if not, and only then give up.
        if (/unreachable/.test(e.message)) {
          log(`process transport failure (${e.message}) — verifying and republishing`);
          if (await settleAfterTransportError(hash, block)) { /* landed */ }
          else throw e;
        }
        // Public RPC proxies (rpc.nano.to) can serve a cached account_info for a
        // few seconds after a block lands, so the first build may sit on a stale
        // frontier. One refetch-and-rebuild covers it; a second bounce is real.
        else if (attempt === 0 && /fork|gap previous|old block|invalid block balance/i.test(e.message)) {
          log(`send bounced (${e.message}) — refetching frontier and retrying once`);
          state = await accountState();
          if (amount > state.balance) throw insufficient();
          continue;
        }
        else throw e;
      }
      precomputeWork(hash);
      log(`x402: ${describe} ${rawToXno(amount)} XNO${extra} to ${to} (block ${hash})`);
      return hash;
    }
  }

  async function paySend(invoice) {
    if (!/^\d+$/.test(String(invoice.amountRaw || ""))) {
      throw new Error("x402 invoice has no usable Nano amount — refusing to pay");
    }
    if (!checkAddress(String(invoice.payTo || ""))) {
      throw new Error(`x402 invoice payTo is not a valid Nano address: ${invoice.payTo}`);
    }
    if (maxUsd != null && invoice.amountUsd != null && invoice.amountUsd > maxUsd) {
      throw new Error(
        `x402 invoice is $${invoice.amountUsd.toFixed(4)}, over the --max-usd cap of $${maxUsd} — ` +
        "raise the cap to allow calls this expensive (invoices are priced at the call's maximum; " +
        "unused amount is refunded)");
    }

    const amount = BigInt(invoice.amountRaw);
    const state = await pocketReceivables(await accountState());
    if (amount > state.balance) {
      throw new Error(
        `insufficient wallet balance: invoice is ${rawToXno(amount)} XNO` +
        (invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "") +
        ` but ${address} holds ${rawToXno(state.balance)} XNO — top up the wallet to continue`);
    }
    await sendFrom(state, invoice.payTo, amount, "paid",
      invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "");
  }

  // Serialize sends — the queue survives failures (a rejected link must not wedge later payments).
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const payment = (invoice) => enqueue(() => paySend(invoice));

  return {
    address,
    payment,
    /**
     * Low-level operations for co-owners of this account (the --charge gate):
     * everything that publishes blocks goes through the same queue as payments,
     * so two writers never race on the frontier. `transfer` pockets receivables
     * first — a refund's source funds usually ARE a pending receivable.
     */
    ops: {
      rpc,
      transfer: (to, amountRaw, describe = "sent") => enqueue(async () => {
        if (!checkAddress(String(to || ""))) throw new Error(`not a valid Nano address: ${to}`);
        const state = await pocketReceivables(await accountState());
        return sendFrom(state, to, BigInt(amountRaw), describe);
      }),
      pocket: () => enqueue(async () => pocketReceivables(await accountState())),
      /**
       * Kick off work precompute for the current frontier so the first block of
       * the session doesn't wait on work generation. Best-effort and off the
       * queue — meant for long-lived serve mode at boot, not per-session stdio
       * (a session that never pays would burn one work per boot for nothing).
       */
      prewarm: () => accountState()
        .then((s) => precomputeWork(s.frontier))
        .catch((e) => log(`work prewarm skipped (${e.message})`)),
    },
  };
}
