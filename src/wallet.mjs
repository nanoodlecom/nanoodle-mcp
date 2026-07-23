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
 * Block publishes are serialized through an internal queue: Nano gives this
 * account a single chain, so concurrent writers would race on the frontier and
 * one block would bounce. The queue is priority-ordered — x402 payments (a
 * caller's run is blocked on them) jump ahead of housekeeping (change, payouts,
 * refunds, receivable sweeps) — and chain state is maintained locally between
 * blocks, so a queued payment costs one work fetch (usually precomputed) plus
 * one publish, not a fresh account scan. N parallel tool calls therefore start
 * their runs within ~N × work-time, not N × full-payment-time. Running
 * receivable sweeps yield between blocks when a payment is queued, and use
 * receive-grade work (~64× cheaper than send-grade) so housekeeping never
 * monopolizes the chain or the work server while customers wait.
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
import { redactUrl } from "./redact.mjs";

export const DEFAULT_NANO_RPC = "https://rpc.nano.to";

/**
 * Default read/publish endpoint chain, tried in order with failover. The whole
 * point of a distributed ledger is that one node saying "429" or timing out
 * must not end a settlement — so ship more than one public proxy out of the box.
 * A dead entry costs a single wasted attempt (then failover), never a failure,
 * which is why plausibly-good extras are safe to include. Operators with their
 * own node should override the lot via NANO_RPC_URL (comma-separated).
 * All four probed live and account_info-correct on 2026-07-23; public proxies
 * drift, but a dead one just costs one failover hop, so the chain self-heals.
 */
export const DEFAULT_NANO_RPCS = [
  DEFAULT_NANO_RPC,                     // rpc.nano.to — full node, primary
  "https://node.somenano.com/proxy",
  "https://rainstorm.city/api",
  "https://nanoslo.0x.no/proxy",
];

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
export function createNanoWallet({ secretKey, rpcUrl = null, workUrl = null, workKey = null, workTimeoutMs = 120_000, localWork = true, fetch = globalThis.fetch, maxUsd = null, log = () => {} }) {
  if (!checkKey(secretKey)) throw new Error("wallet secret key must be a 64-hex-character Nano secret key");
  const publicKey = derivePublicKey(secretKey);
  const address = deriveAddress(publicKey, { useNanoPrefix: true });
  // rpcUrl accepts a comma-separated list, tried in order with failover — so one
  // proxy throttling or dropping does not end a settlement. Empty/unset falls
  // back to the resilient default chain rather than a single node.
  const rpcBases = (rpcUrl ? String(rpcUrl).split(",") : DEFAULT_NANO_RPCS)
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (!rpcBases.length) rpcBases.push(DEFAULT_NANO_RPC);
  // workUrl accepts a comma-separated list, tried in order — e.g. a GPU box on
  // the tailnet first, a public work API second. `workKey` (if set) goes to
  // every listed work server, so list only servers that accept it (or set none).
  const workBases = workUrl
    ? String(workUrl).split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean)
    : [];

  // One endpoint, one attempt. Errors are tagged so the failover layer knows how
  // far it may safely retry:
  //   .authoritative — the node returned a valid JSON-RPC answer that is itself
  //     an error ("Account not found", "Fork", "Old block"). That is the
  //     network's real answer; asking a different node would be wrong.
  //   .rejected — the request was refused BEFORE it could take effect (HTTP 429
  //     from a throttling proxy). The block definitely did not land, so even a
  //     publish is safe to retry on another node.
  //   neither — ambiguous (dropped connection, proxy 5xx, non-JSON). A read may
  //     safely retry; a publish must NOT (the node may have accepted it and only
  //     the response died), so that case is left to settleAfterTransportError.
  async function rpcOnce(body, base, { headers = {}, signal } = {}) {
    let r;
    try {
      r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new Error(`Nano RPC ${redactUrl(base)} unreachable (action ${body.action}): ${e.message}`);
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok || json == null) {
      const e = new Error(`Nano RPC ${body.action} failed at ${redactUrl(base)} (HTTP ${r.status}): ${text.slice(0, 200)}`);
      if (r.status === 429) e.rejected = true; // throttled: request never reached the node
      throw e;
    }
    if (json.error) {
      const e = new Error(`Nano RPC ${body.action}: ${json.error}`);
      e.authoritative = true;
      throw e;
    }
    return json;
  }

  // Read/publish RPC with failover across the endpoint chain. `base` defaults to
  // the whole list; the work path passes a single explicit base so it keeps
  // driving its own source order (workBases → public RPC). A read fails over on
  // any non-authoritative error. A publish fails over ONLY on an explicit
  // rejection (429) — where the block provably did not land; an ambiguous
  // transport failure stops here so settleAfterTransportError (which re-checks
  // the frontier) can decide whether to republish, avoiding a double-submit.
  async function rpc(body, base = rpcBases, opts = {}) {
    const bases = Array.isArray(base) ? base : [base];
    const isPublish = body.action === "process";
    let lastErr;
    for (let i = 0; i < bases.length; i++) {
      try {
        return await rpcOnce(body, bases[i], opts);
      } catch (e) {
        if (e.authoritative) throw e;       // the network answered — don't shop around
        if (isPublish && !e.rejected) throw e; // ambiguous publish — hand to recovery
        lastErr = e;
        if (bases.length > 1 && i < bases.length - 1) {
          log(`Nano RPC ${body.action} failing over past ${redactUrl(bases[i])} (${e.message})`);
        }
      }
    }
    throw lastErr;
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

  /*
   * Chain state maintained locally between blocks. This process is the
   * account's only signer (the charge gate shares the wallet THROUGH this
   * queue), so after a successful publish the new frontier and balance are
   * known without asking the node — a queued send skips the account_info
   * round-trip entirely. Invalidated whenever a publish leaves the chain
   * uncertain (lost response, failed receive) and refetched on demand.
   */
  let chain = null;
  async function currentState(fresh = false) {
    if (!fresh && chain) return chain;
    chain = null; // a failed refetch must not leave the suspect cache behind
    chain = await accountState();
    return chain;
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
    const workSources = [
      ...workBases.map((b) => ["work server " + redactUrl(b), b]),
      ...rpcBases.map((b) => ["Nano RPC " + redactUrl(b), b]),
    ];
    for (const [label, base] of workSources) {
      const withKey = workKey && workBases.includes(base);
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

  // Work precomputed fire-and-forget after every published block — sends and
  // receives are serialized on the queue, so by the time the next block needs
  // work it is usually already there and the caller-facing wait drops to ~0.
  // The cache is THRESHOLD-AWARE: receive blocks are allowed ~64× cheaper work
  // than sends, and a receive sweep that precomputed send-grade work for every
  // interior block would hog the work server for seconds — exactly when a
  // burst of customer payments needs it. So the sweep precomputes receive-grade
  // work between its own blocks (near-instant) and send-grade only for the
  // frontier a send might grow next. Send-grade work satisfies any block;
  // receive-grade work never satisfies a send.
  const atLeast = (have, need) => BigInt("0x" + have) >= BigInt("0x" + need);
  const workCache = new Map(); // frontier hash -> { threshold, promise }
  function precomputeWork(frontier, threshold = SEND_WORK_THRESHOLD) {
    const existing = workCache.get(frontier);
    if (existing && atLeast(existing.threshold, threshold)) return; // already as strong or stronger
    if (!existing && workCache.size >= 8) workCache.clear(); // superseded frontiers; only the newest matters
    const promise = remoteWork(frontier, threshold).then((w) => {
      // don't cache failure (the live path retries + has local CPU) — but only
      // evict our own entry; a concurrent upgrade may have replaced it
      if (w == null && workCache.get(frontier)?.promise === promise) workCache.delete(frontier);
      return w;
    });
    workCache.set(frontier, { threshold, promise });
  }

  async function workFor(frontier, threshold) {
    const cached = workCache.get(frontier);
    if (cached && atLeast(cached.threshold, threshold)) {
      const w = await cached.promise;
      workCache.delete(frontier); // single-use: the frontier advances once this block publishes
      if (w != null) return w;
    } else if (cached) {
      workCache.delete(frontier); // cached at a weaker threshold than this block needs
    }
    const w = await remoteWork(frontier, threshold);
    if (w != null) return w;
    if (!localWork) {
      // Local CPU work runs on the main thread — in serve mode a send-difficulty
      // grind (minutes) would freeze the whole HTTP server, so operators with
      // dependable remote work sources turn it off and let the send fail cleanly
      // (a failed payment is refused up front; a failed refund/payout send stays
      // in the wallet and the next settle's pocket/queue picks the balance up).
      throw new Error("every remote work source failed and local CPU work is disabled (--no-local-work)");
    }
    log("computing work locally, this can take a while");
    return computeWork(frontier, { workThreshold: threshold });
  }

  /**
   * Pocket everything receivable. NanoGPT invoices charge the *maximum* a call
   * could cost and refund the difference as a Nano send back to this wallet —
   * without receiving those blocks the refunds never rejoin the spendable
   * balance and the wallet drains far faster than the calls actually cost.
   * Best-effort by design: a receive failure logs and moves on, never blocks
   * the payment that triggered it. Off the payment hot path — payments only
   * pocket when the bare balance can't cover the invoice; otherwise refunds
   * are swept by a queued housekeeping pass.
   *
   * `stopEarly(state)`, checked between blocks (after at least one), ends the
   * pass with whatever has been pocketed so far — housekeeping passes use it to
   * yield to a queued URGENT payment (a sweep of 50 must never make a paying
   * customer wait out 50 publishes), and a short-balance payment uses it to
   * stop the moment the invoice is covered. Whatever is left stays safely
   * receivable for the next pass.
   */
  async function pocketReceivables(fresh = false, stopEarly = null) {
    let state = await currentState(fresh);
    let blocks;
    try {
      const r = await rpc({ action: "receivable", account: address, count: "50", threshold: "1" });
      blocks = r.blocks && typeof r.blocks === "object" ? Object.entries(r.blocks) : [];
    } catch {
      return state;
    }
    let pocketed = 0;
    for (let i = 0; i < blocks.length; i++) {
      const [sendHash, v] = blocks[i];
      const amountRaw = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
      if (!/^[0-9A-F]{64}$/i.test(sendHash) || !/^\d+$/.test(String(amountRaw || ""))) continue;
      if (pocketed > 0 && stopEarly && stopEarly(state)) break;
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
        // next block's work computes while this one publishes — receive-grade
        // between receives, send-grade for the frontier a send might grow next
        precomputeWork(hash, i < blocks.length - 1 ? RECEIVE_WORK_THRESHOLD : SEND_WORK_THRESHOLD);
        await rpc({ action: "process", json_block: "true", subtype: "receive", block });
        chain = state = { ...state, frontier: hash, balance: state.balance + BigInt(amountRaw) };
        pocketed++;
        log(`x402: received ${rawToXno(amountRaw)} XNO (refund/deposit ${sendHash.slice(0, 8)}…, block ${hash})`);
      } catch (e) {
        log(`receive of ${sendHash.slice(0, 8)}… failed (${e.message}) — continuing with current balance`);
        chain = null; // the publish may have half-landed; refetch before the next block
        return state;
      }
    }
    // The pass may have ended mid-list (yield, stop, skips) with only
    // receive-grade work in flight — upgrade the frontier to send-grade so the
    // block that preempted us (usually a customer's payment) finds warm work.
    precomputeWork(state.frontier, SEND_WORK_THRESHOLD);
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
      precomputeWork(hash); // next block's work computes while this one publishes
      try {
        await rpc({ action: "process", json_block: "true", subtype: "send", block });
      } catch (e) {
        // Lost response mid-publish — dead transport or a fronting proxy's
        // HTTP-5xx: the node may already have the block. Verify, republish
        // the identical block if not, and only then give up.
        if (/unreachable|failed(?: at \S+)? \(HTTP 5\d\d\)/.test(e.message)) {
          chain = null; // until settled, the frontier is uncertain
          log(`process transport failure (${e.message}) — verifying and republishing`);
          if (await settleAfterTransportError(hash, block)) { /* landed */ }
          else throw e;
        }
        // Public RPC proxies (rpc.nano.to) can serve a cached account_info for a
        // few seconds after a block lands, so the first build may sit on a stale
        // frontier. One refetch-and-rebuild covers it; a second bounce is real.
        else if (attempt === 0 && /fork|gap previous|old block|invalid block balance/i.test(e.message)) {
          log(`send bounced (${e.message}) — refetching frontier and retrying once`);
          state = await currentState(true);
          if (amount > state.balance) throw insufficient();
          continue;
        }
        // Anything else is ambiguous — an HTTP-5xx from a fronting proxy can
        // mean the node accepted the block and the response died. Drop the
        // cache so the next send rebuilds from the node's own frontier.
        else { chain = null; throw e; }
      }
      chain = { frontier: hash, balance: state.balance - amount, representative: state.representative };
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
    // Hot path: send straight off the locally-tracked state. Receivables are
    // only pulled in when the bare balance can't cover the invoice (refunds
    // and deposits waiting to be pocketed usually can) — and only until it can:
    // the caller is waiting, the rest sweeps later.
    let state = await currentState();
    if (amount > state.balance) state = await pocketReceivables(true, (s) => amount <= s.balance);
    if (amount > state.balance) {
      throw new Error(
        `insufficient wallet balance: invoice is ${rawToXno(amount)} XNO` +
        (invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "") +
        ` but ${address} holds ${rawToXno(state.balance)} XNO — top up the wallet to continue`);
    }
    await sendFrom(state, invoice.payTo, amount, "paid",
      invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "");
  }

  /*
   * One queue serializes every block publish (single account = single chain),
   * priority-ordered: payments are URGENT — a caller's tool run is blocked on
   * them — and jump ahead of queued housekeeping (change, payouts, refunds,
   * receivable sweeps). The queue survives failures: a rejected link must not
   * wedge later payments.
   */
  const URGENT = 0, HOUSEKEEPING = 1;
  const tasks = [];
  let draining = false;
  // A customer's payment is queued RIGHT NOW — running housekeeping passes
  // check this between blocks and hand the chain over instead of finishing.
  const urgentWaiting = () => tasks.length > 0 && tasks[0].priority === URGENT;
  function enqueue(fn, priority = HOUSEKEEPING) {
    return new Promise((resolve, reject) => {
      const task = { fn, priority, resolve, reject };
      const at = priority === URGENT ? tasks.findIndex((t) => t.priority !== URGENT) : -1;
      if (at === -1) tasks.push(task); else tasks.splice(at, 0, task);
      if (!draining) drain();
    });
  }
  async function drain() {
    draining = true;
    while (tasks.length) {
      const t = tasks.shift();
      try { t.resolve(await t.fn()); } catch (e) { t.reject(e); }
    }
    draining = false;
  }

  // After each successful payment, sweep receivables once the queue is quiet —
  // NanoGPT's max-cost refunds rejoin the balance without ever costing a
  // waiting caller anything. Deduped: one queued sweep at a time.
  let sweepQueued = false;
  function queueSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    enqueue(() => { sweepQueued = false; return pocketReceivables(false, urgentWaiting); }).catch(() => {});
  }
  const payment = (invoice) => {
    const p = enqueue(() => paySend(invoice), URGENT);
    p.then(queueSweep, () => {});
    return p;
  };

  return {
    address,
    payment,
    /**
     * Low-level operations for co-owners of this account (the --charge gate):
     * everything that publishes blocks goes through the same queue as payments,
     * so two writers never race on the frontier — at housekeeping priority, so
     * a change-send never delays a caller's payment. `transfer` pockets
     * receivables first — a refund's source funds usually ARE a pending
     * receivable.
     */
    ops: {
      rpc,
      transfer: (to, amountRaw, describe = "sent") => enqueue(async () => {
        if (!checkAddress(String(to || ""))) throw new Error(`not a valid Nano address: ${to}`);
        // sweep first (a refund's source funds usually ARE a pending receivable),
        // but yield to a waiting payment once this send itself is covered
        const state = await pocketReceivables(false, (s) => urgentWaiting() && BigInt(amountRaw) <= s.balance);
        return sendFrom(state, to, BigInt(amountRaw), describe);
      }),
      pocket: () => enqueue(() => pocketReceivables(false, urgentWaiting)),
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
