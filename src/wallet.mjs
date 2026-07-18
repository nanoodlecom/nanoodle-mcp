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

/** raw → XNO display string (1 XNO = 10^30 raw), trimmed to something readable. */
function rawToXno(raw) {
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
 * @param {{ secretKey: string, rpcUrl?: string, workUrl?: string|null, fetch?: typeof fetch, maxUsd?: number|null, log?: (line: string) => void }} opts
 * @returns {{ address: string, payment: (invoice: object) => Promise<void> }}
 */
export function createNanoWallet({ secretKey, rpcUrl = DEFAULT_NANO_RPC, workUrl = null, fetch = globalThis.fetch, maxUsd = null, log = () => {} }) {
  if (!checkKey(secretKey)) throw new Error("wallet secret key must be a 64-hex-character Nano secret key");
  const publicKey = derivePublicKey(secretKey);
  const address = deriveAddress(publicKey, { useNanoPrefix: true });
  const rpcBase = String(rpcUrl).replace(/\/+$/, "");
  const workBase = workUrl ? String(workUrl).replace(/\/+$/, "") : null;

  async function rpc(body, base = rpcBase) {
    let r;
    try {
      r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
        "raise the cap to allow calls this expensive");
    }

    const info = await rpc({ action: "account_info", account: address, representative: "true" }).catch((e) => {
      if (/Account not found/i.test(e.message)) {
        throw new Error(
          `wallet ${address} is empty or unopened — fund it with a little XNO first ` +
          "(pending deposits also need one receive; open the account in any Nano wallet)");
      }
      throw e;
    });

    const amount = BigInt(invoice.amountRaw);
    const balance = BigInt(info.balance);
    if (amount > balance) {
      throw new Error(
        `insufficient wallet balance: invoice is ${rawToXno(amount)} XNO` +
        (invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "") +
        ` but ${address} holds ${rawToXno(balance)} XNO — top up the wallet to continue`);
    }

    // Work: dedicated work server first (--work-rpc, e.g. a local nano-work-server —
    // public nodes routinely refuse or throttle work_generate), then the main RPC
    // node, then local CPU work so a work-less setup still functions, just slowly.
    let work;
    const workSources = workBase ? [["work server " + workBase, workBase], ["Nano RPC", rpcBase]] : [["Nano RPC", rpcBase]];
    for (const [label, base] of workSources) {
      try {
        work = (await rpc({ action: "work_generate", hash: info.frontier, difficulty: SEND_WORK_THRESHOLD }, base)).work;
        break;
      } catch (e) {
        log(`work_generate via ${label} failed (${e.message})`);
      }
    }
    if (!work) {
      log("computing work locally, this can take a while");
      work = await computeWork(info.frontier, { workThreshold: SEND_WORK_THRESHOLD });
    }

    const { hash, block } = createBlock(secretKey, {
      work,
      previous: info.frontier,
      representative: info.representative,
      balance: (balance - amount).toString(),
      link: invoice.payTo,
    });
    // createBlock renders addresses with the legacy xrb_ prefix; same account, and the
    // signature covers the public key, so normalizing the display form is safe
    block.account = address;
    block.link_as_account = invoice.payTo;
    await rpc({ action: "process", json_block: "true", subtype: "send", block });
    log(`x402: paid ${rawToXno(amount)} XNO` +
      (invoice.amountUsd != null ? ` (~$${invoice.amountUsd.toFixed(4)})` : "") +
      ` to ${invoice.payTo} (block ${hash})`);
  }

  // Serialize sends — the queue survives failures (a rejected link must not wedge later payments).
  let queue = Promise.resolve();
  const payment = (invoice) => {
    const next = queue.then(() => paySend(invoice));
    queue = next.catch(() => {});
    return next;
  };

  return { address, payment };
}
