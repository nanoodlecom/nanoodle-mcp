/**
 * Shared helpers for the real-testnet tooling:
 *   scripts/near-testnet-accounts.mjs  create (or adopt) the merchant and payer accounts
 *   scripts/near-testnet-e2e.mjs       prove pay -> run -> refund on real testnet
 *
 * Everything here reuses the server's own NEAR code (src/near/): the same RPC
 * client, key loader, Borsh transfer signer and payment verifier. Secret keys
 * only ever live in near-cli credential files (mode 0600) and in the opaque
 * signer objects of src/near/keys.mjs; nothing here prints or returns them.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  base58Encode, createNearRpc, explorerAccountUrl, explorerTxUrl, formatYoctoAsNear, isNearAccountId, NEAR_NETWORKS,
  NearError, parseNearSecretKey, parseNearToYocto, readPaymentTransfer, signTransfer,
} from "../src/near/index.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_KEYS_DIR = join(ROOT, ".near-testnet");
export const ACCOUNTS_FILE = "accounts.json";
export const NETWORK = "testnet";

/**
 * Account-creation ("faucet") helper endpoints, in the order tried.
 *  1. near-cli-rs src/config/mod.rs: `faucet_url` of the testnet network configs,
 *     used by `near account create-account sponsor-by-faucet-service`.
 *  2. docs.near.org snippets/faucet.jsx (the "Get Testnet Tokens" page).
 * Both take POST JSON { newAccountId, newAccountPublicKey }.
 */
export const FAUCET_URLS = Object.freeze([
  "https://helper.nearprotocol.com/account",
  "https://helper.testnet.near.org/account",
]);

/** Storage staking price on NEAR: 10^19 yocto per byte (1 NEAR per 100 kB). */
export const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
/** Generous upper bound for the gas of one plain transfer (real cost is ~0.0000446 NEAR). */
export const GAS_CAP_YOCTO = parseNearToYocto("0.001");
/** Spendable balance the e2e run wants: the merchant pays refund gas, the payer two small deposits. */
export const MIN_MERCHANT_YOCTO = parseNearToYocto("0.05");
export const MIN_PAYER_YOCTO = parseNearToYocto("0.1");

/**
 * The repo's RPC client, with retries for reads: free public RPCs answer
 * HTTP 429 under load (seen on test.rpc.fastnear.com while this was written).
 * Reads retry on RPC_HTTP / RPC_TIMEOUT with backoff; `send_tx` is never
 * retried here (sendTransfer resolves it by hash instead).
 */
export function rpcFor(rpcUrl, fetchImpl, { retries = 4, backoffMs = 1_500, sleep = defaultSleep } = {}) {
  const base = createNearRpc({ url: rpcUrl || NEAR_NETWORKS[NETWORK].rpcUrl, timeoutMs: 20_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  async function call(method, params, opts) {
    for (let i = 0; ; i++) {
      try {
        return await base.call(method, params, opts);
      } catch (e) {
        if (method === "send_tx" || i >= retries || !["RPC_HTTP", "RPC_TIMEOUT"].includes(e?.code)) throw e;
        await sleep(backoffMs * (i + 1));
      }
    }
  }
  return {
    url: base.url,
    call,
    status: () => call("status", []),
    block(ref) {
      if (ref && typeof ref.blockId === "string") return call("block", { block_id: ref.blockId });
      if (ref && typeof ref.finality === "string") return call("block", { finality: ref.finality });
      throw new TypeError("block() needs { finality } or { blockId }");
    },
    txStatus: ({ txHash, senderId, waitUntil = "FINAL", timeoutMs } = {}) =>
      call("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil }, { timeoutMs }),
    viewAccessKey: ({ accountId, publicKey }) =>
      call("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey }),
    sendTx: (signedTxBase64, waitUntil = "INCLUDED_FINAL", { timeoutMs } = {}) =>
      base.sendTx(signedTxBase64, waitUntil, { timeoutMs }),
  };
}

/* ----------------------------- arguments ------------------------------ */

/** `--flag value` and boolean `--flag`; `booleans` lists the flags that take no value. */
export function parseArgs(argv, booleans = []) {
  const opts = {};
  const bools = new Set(booleans);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (bools.has(k)) { opts[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    opts[k] = v;
  }
  return opts;
}

export function absPath(p, base = process.cwd()) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/")) p = join(process.env.HOME || "", p.slice(1));
  return isAbsolute(p) ? p : resolve(base, p);
}

/* ------------------------------- keys --------------------------------- */

/**
 * A fresh ed25519 key in NEAR's text format. Returns the secret as an opaque
 * holder: write it with writeKeyFile; it is never printed.
 */
export function generateNearKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const secret = "ed25519:" + base58Encode(Buffer.concat([seed, pub]));
  seed.fill(0);
  const holder = { publicKey: "ed25519:" + base58Encode(pub), implicitAccountId: Buffer.from(pub).toString("hex") };
  Object.defineProperty(holder, "secret", { value: secret, enumerable: false });
  holder.toJSON = () => ({ publicKey: holder.publicKey });
  holder[Symbol.for("nodejs.util.inspect.custom")] = () => `[NearKey ${holder.publicKey}]`;
  return holder;
}

/**
 * Write a near-cli "legacy keychain" credentials file
 * ({ account_id, public_key, private_key }, the format near-cli-rs
 * `save-to-legacy-keychain` writes and `--near-key-file` reads) with mode 0600.
 * Refuses to overwrite an existing file.
 */
export async function writeKeyFile(path, accountId, key) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ account_id: accountId, public_key: key.publicKey, private_key: key.secret }, null, 2) + "\n";
  const fh = await open(path, "wx", 0o600);
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Adopt an existing credentials file. The server's --near-key-file wants
 * { account_id, public_key, private_key } with account_id equal to the
 * account; near-cli-rs `save-to-legacy-keychain` files carry no account_id
 * (they have implicit_account_id, seed phrase fields, public_key,
 * private_key). When the source already names this account it is used as is;
 * otherwise a normalized copy with only the three fields is written to
 * `normalizedPath` (mode 0600). Returns { keyFile, publicKey, copied }.
 */
export async function adoptKeyFile(sourcePath, accountId, normalizedPath) {
  let json;
  try {
    json = JSON.parse(await readFile(sourcePath, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${sourcePath} as JSON (${e.code || "parse error"})`);
  }
  const secret = json?.private_key ?? json?.secret_key;
  if (typeof secret !== "string") throw new Error(`${sourcePath} has no private_key`);
  if (json.account_id != null && json.account_id !== accountId) {
    throw new Error(`${sourcePath} is for account ${JSON.stringify(json.account_id)}, not ${accountId}`);
  }
  let signer;
  try {
    signer = parseNearSecretKey(secret);
  } catch (e) {
    throw new Error(`${sourcePath}: ${e.message}`);
  }
  if (json.public_key != null && json.public_key !== signer.publicKey) throw new Error(`${sourcePath}: public_key does not match private_key`);
  if (json.account_id === accountId) return { keyFile: sourcePath, publicKey: signer.publicKey, copied: false };
  if (existsSync(normalizedPath)) {
    const prev = await publicKeyOfKeyFile(normalizedPath);
    if (prev.accountId === accountId && prev.publicKey === signer.publicKey) return { keyFile: normalizedPath, publicKey: signer.publicKey, copied: false };
    throw new Error(`${normalizedPath} already exists with a different key; move it away first`);
  }
  const holder = { publicKey: signer.publicKey };
  Object.defineProperty(holder, "secret", { value: secret.trim(), enumerable: false });
  await writeKeyFile(normalizedPath, accountId, holder);
  return { keyFile: normalizedPath, publicKey: signer.publicKey, copied: true };
}

/** The public key in a credentials file, without holding the secret. */
export async function publicKeyOfKeyFile(path) {
  const json = JSON.parse(await readFile(path, "utf8"));
  return { accountId: json.account_id, publicKey: json.public_key };
}

/** null when the file is private to its owner, else a warning sentence. */
export function keyFileModeWarning(path) {
  if (process.platform === "win32") return null;
  try {
    const mode = statSync(path).mode & 0o777;
    return mode & 0o077 ? `${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}` : null;
  } catch {
    return null;
  }
}

/* ----------------------------- git ignore ----------------------------- */

/**
 * Keys must never land in a tracked file. When `dir` is inside a git work tree
 * it must be ignored. Returns { ok, reason }.
 */
export function checkKeysDirIgnored(dir) {
  let probe = dir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const inTree = spawnSync("git", ["-C", probe, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inTree.error || inTree.status !== 0 || inTree.stdout.trim() !== "true") return { ok: true, reason: "not inside a git work tree" };
  const ignored = spawnSync("git", ["-C", probe, "check-ignore", "-q", join(dir, ACCOUNTS_FILE)], { encoding: "utf8" });
  if (ignored.status === 0) return { ok: true, reason: "git-ignored" };
  return {
    ok: false,
    reason: `${dir} is inside a git work tree and is not git-ignored, so a key written there could be committed. ` +
      `Add "${dir.startsWith(ROOT + "/") ? dir.slice(ROOT.length + 1) + "/" : dir}" to .gitignore, or pass --keys-dir with a directory outside the repository ` +
      "(for example ~/.near-credentials/testnet, the near-cli legacy keychain).",
  };
}

/* --------------------------- accounts config -------------------------- */

/** accounts.json: account ids and key-file paths only — never key material. */
export async function writeAccountsConfig(keysDir, config) {
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const path = join(keysDir, ACCOUNTS_FILE);
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

export async function readAccountsConfig(path) {
  let json;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path} (${e.code || e.message}); create it with: node scripts/near-testnet-accounts.mjs`);
  }
  for (const role of ["merchant", "payer"]) {
    if (!json?.[role]?.accountId || !json[role].keyFile) throw new Error(`${path} has no ${role}.accountId / ${role}.keyFile`);
  }
  if (json.network && json.network !== NETWORK) throw new Error(`${path} is for ${json.network}; this tooling is testnet-only`);
  return json;
}

/* ------------------------------ chain reads --------------------------- */

/** view_account → { amount, locked, storageUsage, available } (bigints), or null if the account does not exist. */
export async function viewAccount(rpc, accountId) {
  let r;
  try {
    r = await rpc.call("query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch (e) {
    if (e?.code === "UNKNOWN_ACCOUNT" || (e?.code === "QUERY_ERROR" && /does not exist/.test(e.message))) return null;
    throw e;
  }
  const amount = BigInt(r.amount);
  const locked = BigInt(r.locked ?? 0);
  const storageUsage = BigInt(r.storage_usage ?? 0);
  const reserved = storageUsage * STORAGE_YOCTO_PER_BYTE;
  const available = amount > reserved ? amount - reserved : 0n;
  return { amount, locked, storageUsage, available };
}

/** The access key's permission and nonce, or null when the key is not on the account. */
export async function viewAccessKey(rpc, accountId, publicKey) {
  try {
    const r = await rpc.viewAccessKey({ accountId, publicKey });
    return { permission: r.permission, nonce: BigInt(r.nonce), blockHash: r.block_hash };
  } catch (e) {
    if (e?.code === "QUERY_ERROR" || e?.code === "UNKNOWN_ACCESS_KEY" || e?.code === "UNKNOWN_ACCOUNT") return null;
    throw e;
  }
}

/**
 * Read the balance until two reads agree (a load-balanced public RPC can
 * answer from a node one block behind).
 */
export async function settledBalance(rpc, accountId, { tries = 6, delayMs = 1500, sleep = defaultSleep } = {}) {
  let prev = null;
  for (let i = 0; i < tries; i++) {
    const a = await viewAccount(rpc, accountId);
    if (!a) throw new Error(`account ${accountId} does not exist`);
    if (prev !== null && prev === a.amount) return a.amount;
    prev = a.amount;
    if (i < tries - 1) await sleep(delayMs);
  }
  return prev;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Total tokens burnt by a transaction (its own outcome plus every receipt). */
export function tokensBurnt(txResult) {
  const outs = [txResult?.transaction_outcome, ...(txResult?.receipts_outcome || [])];
  return outs.reduce((s, o) => s + BigInt(o?.outcome?.tokens_burnt ?? 0), 0n);
}

const has = (o, k) => o !== null && typeof o === "object" && Object.hasOwn(o, k);

function txSucceeded(r) {
  return r && r.final_execution_status === "FINAL" && has(r.status, "SuccessValue")
    && !(r.receipts_outcome || []).some((ro) => has(ro?.outcome?.status, "Failure"));
}

/* ----------------------------- the payer side -------------------------- */

/**
 * Sign and broadcast ONE native transfer from `signerId` with the repo's own
 * Borsh signer (src/near/tx.mjs), and wait until it is FINAL.
 *
 * The hash is known before broadcast, so every uncertain outcome (timeout,
 * transport error, an RPC that answered before execution) is resolved by
 * looking the hash up, and a retry re-sends the same bytes (idempotent).
 * A definitive rejection (INVALID_TRANSACTION) is thrown with its detail.
 *
 * `nonceState.last` keeps nonces increasing across consecutive transfers even
 * when the RPC's view of the key lags one block behind.
 */
export async function sendTransfer({ rpc, signer, signerId, receiverId, amountYocto, nonceState = {}, sleep = defaultSleep, waitMs = 90_000 }) {
  const ak = await rpc.viewAccessKey({ accountId: signerId, publicKey: signer.publicKey });
  const chainNonce = BigInt(ak.nonce);
  const last = nonceState.last ?? 0n;
  const nonce = (chainNonce > last ? chainNonce : last) + 1n;
  const signed = signTransfer({ signer, signerId, receiverId, nonce, blockHash: ak.block_hash, amountYocto: BigInt(amountYocto) });
  nonceState.last = nonce;

  const lookup = async (timeoutMs = 15_000) => {
    try {
      return await rpc.txStatus({ txHash: signed.txHash, senderId: signerId, waitUntil: "FINAL", timeoutMs });
    } catch (e) {
      if (["UNKNOWN_TRANSACTION", "TIMEOUT_ERROR", "RPC_TIMEOUT", "RPC_HTTP", "RPC_BAD_RESPONSE"].includes(e?.code)) return null;
      throw e;
    }
  };

  let result = null;
  let lastErr = null;
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; !result && Date.now() < deadline; attempt++) {
    try {
      const r = await rpc.sendTx(signed.signedTxBase64, "FINAL", { timeoutMs: 60_000 });
      result = r && r.final_execution_status === "FINAL" ? r : await lookup(40_000);
    } catch (e) {
      lastErr = e;
      result = await lookup();
      if (!result && e?.code === "INVALID_TRANSACTION") {
        throw new NearError("TRANSFER_REJECTED", `the network rejected the transfer ${signed.txHash}: ${e.message}`, { cause: e });
      }
    }
    if (!result) await sleep(Math.min(2_000 * (attempt + 1), 10_000));
  }
  if (!result) {
    throw new NearError("TRANSFER_UNCONFIRMED",
      `transfer ${signed.txHash} was not confirmed FINAL within ${Math.round(waitMs / 1000)} s` +
      (lastErr ? ` (last error ${lastErr.code}: ${lastErr.message})` : "") + "; look it up in the explorer before sending again",
      { data: { txHash: signed.txHash } });
  }
  if (!txSucceeded(result)) {
    throw new NearError("TRANSFER_FAILED", `transfer ${signed.txHash} executed but did not succeed: ${JSON.stringify(result.status)}`, { data: { txHash: signed.txHash } });
  }
  return { txHash: signed.txHash, nonce, result, burnt: tokensBurnt(result) };
}

/* --------------------------- independent checks ------------------------ */

/**
 * The checks of scripts/near-check-tx.mjs as a function: read a transfer at
 * FINAL from RPC and check every rule the server applies, then run the
 * server's own verifier (readPaymentTransfer) on it. Returns
 * { ok, rules: [{ ok, text }], burnt, blockTimeMs, signer }.
 *
 * To check a refund, pass the payer as `receiver` and the merchant as `sender`.
 */
export async function checkTransferOnChain({ rpc, txHash, sender, receiver, amountYocto, notBeforeMs = null, notAfterMs = null }) {
  const rules = [];
  const rule = (ok, text) => { rules.push({ ok: !!ok, text }); return ok; };
  let r;
  try {
    r = await rpc.txStatus({ txHash, senderId: sender, waitUntil: "FINAL", timeoutMs: 45_000 });
  } catch (e) {
    rule(false, `the RPC knows ${txHash} as final (${e.code || "error"}: ${e.message})`);
    return { ok: false, rules, burnt: null, blockTimeMs: null, signer: null };
  }
  rule(r.final_execution_status === "FINAL", `finality is FINAL (got ${r.final_execution_status})`);
  const failedReceipt = (r.receipts_outcome || []).some((ro) => has(ro?.outcome?.status, "Failure"));
  rule(has(r.status, "SuccessValue") && !failedReceipt, "the transaction and all its receipts succeeded");
  const tx = r.transaction || {};
  rule(tx.hash === txHash, "the RPC returned this exact transaction");
  rule(tx.signer_id === sender, `signer is ${sender} (got ${tx.signer_id})`);
  rule(tx.receiver_id === receiver, `receiver is ${receiver} (got ${tx.receiver_id})`);
  const acts = tx.actions || [];
  const single = acts.length === 1 && acts[0] && Object.keys(acts[0]).length === 1 && has(acts[0], "Transfer");
  rule(single, "exactly one native Transfer action");
  const deposit = single ? BigInt(acts[0].Transfer.deposit) : null;
  if (amountYocto != null) {
    rule(deposit === BigInt(amountYocto), `amount is ${formatYoctoAsNear(BigInt(amountYocto))} NEAR = ${amountYocto} yocto (got ${deposit})`);
  }
  let blockTimeMs = null;
  try {
    const b = await rpc.block({ blockId: r.transaction_outcome.block_hash });
    blockTimeMs = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
    if (notBeforeMs != null) rule(blockTimeMs >= notBeforeMs - 120_000, `included after the quote was created (block ${new Date(blockTimeMs).toISOString()})`);
    if (notAfterMs != null) rule(blockTimeMs <= notAfterMs, `included before the quote expired (${new Date(notAfterMs).toISOString()})`);
  } catch (e) {
    rule(false, `the transaction's block can be read (${e.code || "error"}: ${e.message})`);
  }
  try {
    const t = await readPaymentTransfer({ rpc, txHash, senderId: sender, merchantId: receiver, txTimeoutMs: 45_000 });
    rule(t.payer === sender && (amountYocto == null || t.amountYocto === BigInt(amountYocto)), `the server's own verifier accepts it (payer ${t.payer}, ${formatYoctoAsNear(t.amountYocto)} NEAR)`);
  } catch (e) {
    rule(false, `the server's own verifier accepts it (${e.code}: ${e.message})`);
  }
  return { ok: rules.every((x) => x.ok), rules, burnt: tokensBurnt(r), blockTimeMs, signer: tx.signer_id };
}

/** The equivalent standalone command, for the owner to re-run later. */
export function checkTxCommand({ txHash, sender, receiver, amountYocto, rpcUrl }) {
  return `node scripts/near-check-tx.mjs --network testnet --merchant ${receiver} --sender ${sender} --tx ${txHash}` +
    (amountYocto != null ? ` --amount-yocto ${amountYocto}` : "") + (rpcUrl && rpcUrl !== NEAR_NETWORKS[NETWORK].rpcUrl ? ` --rpc ${rpcUrl}` : "");
}

export { explorerAccountUrl, explorerTxUrl, formatYoctoAsNear, isNearAccountId, parseNearToYocto };

/* ------------------------------ faucet --------------------------------- */

/**
 * POST { newAccountId, newAccountPublicKey } to one helper endpoint, exactly
 * as near-cli-rs `before_creating_account` does (reqwest `.json(&data)`).
 * Returns { ok, status, txHash, detail }. Never throws for HTTP outcomes.
 *
 * Response handling mirrors near-cli-rs `print_account_creation_status`:
 * status >= 400 is a failure; a 2xx body is an RPC transaction response whose
 * `status.SuccessValue` is base64 "false" ("ZmFsc2U=") when the account was
 * not created. Callers still confirm the result on chain.
 */
export async function requestFaucetAccount({ url, accountId, publicKey, fetch = globalThis.fetch, timeoutMs = 60_000 }) {
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: null, txHash: null, detail: `request failed: ${e?.cause?.code || e?.name || ""} ${e?.message || e}`.trim() };
  }
  const snippet = String(text || "").replace(/\s+/g, " ").slice(0, 300);
  if (res.status >= 400) return { ok: false, status: res.status, txHash: null, detail: `HTTP ${res.status}: ${snippet || "(empty body)"}` };
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const outcome = body && (body.final_execution_outcome || body);
  const txHash = outcome?.transaction_outcome?.id || outcome?.transaction?.hash || null;
  const sv = outcome?.status?.SuccessValue;
  if (sv === "ZmFsc2U=") return { ok: false, status: res.status, txHash, detail: "the helper answered that the account was not created (SuccessValue false)" };
  if (has(outcome?.status, "Failure")) return { ok: false, status: res.status, txHash, detail: `the creation transaction failed: ${JSON.stringify(outcome.status.Failure).slice(0, 300)}` };
  return { ok: true, status: res.status, txHash, detail: body ? "accepted" : `accepted (non-JSON body: ${snippet})` };
}

/** Fallback commands, verified against near-cli-rs source (see the accounts script header). */
export function fallbackCommands({ accountId, publicKey }) {
  return [
    "Fallback A — near-cli-rs, same key (keeps the key file this script wrote):",
    `  near account create-account sponsor-by-faucet-service ${accountId} use-manually-provided-public-key ${publicKey} network-config testnet create`,
    "  (near-cli-rs calls the same helper service, so this only helps if the service was briefly down.)",
    "Fallback B — near-cli-rs creates its own key in the legacy keychain, then adopt it here:",
    `  near account create-account sponsor-by-faucet-service ${accountId} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`,
    `  then: node scripts/near-testnet-accounts.mjs --use-existing --merchant <id> --merchant-key-file ~/.near-credentials/testnet/<id>.json --payer <id> --payer-key-file ~/.near-credentials/testnet/<id>.json`,
    "Fallback C — no helper service at all: implicit accounts (the account id is the key's hex public key):",
    "  node scripts/near-testnet-accounts.mjs --implicit",
    "  writes two fresh keys, prints their implicit account ids, and on a re-run checks their funding.",
    "  Fund each id from any funded testnet wallet or a web faucet (https://near-faucet.io/).",
  ];
}
