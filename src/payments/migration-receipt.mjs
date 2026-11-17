/** Keyless validation of the immutable boundary from legacy JSON to schema 3. */
import { createHash } from "node:crypto";
import { checkAddress, derivePublicKey, hashBlock, verifyBlock } from "nanocurrency";
import { NANO_GENESIS } from "../nano-read-pool.mjs";

const uint = value => typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) < 2n ** 128n;
const hash = value => typeof value === "string" && /^[A-F0-9]{64}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, required, optional = []) => value && typeof value === "object" && !Array.isArray(value)
  && required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const fail = () => { throw Object.assign(Error("Migration receipt is missing, invalid or mismatched"), { code: "RECOVERY_MIGRATION_INVALID" }); };
export const receiptDigest = receipt => createHash("sha256").update(JSON.stringify(receipt)).digest("hex");

export function validateInitialHead(account, head) {
  try {
    if (!checkAddress(account) || !keys(head, ["hash", "blockCount", "balance", "representative", "block"])
      || !hash(head.hash) || !uint(head.blockCount) || BigInt(head.blockCount) === 0n
      || !uint(head.balance) || !checkAddress(head.representative)) fail();
    const b = head.block;
    if (!keys(b, ["type", "account", "previous", "representative", "balance", "link", "signature", "work"], ["link_as_account"])
      || b.type !== "state" || b.account !== account || b.balance !== head.balance || b.representative !== head.representative
      || !hash(b.previous) || !hash(b.link) || typeof b.work !== "string" || !/^[A-Fa-f0-9]{16}$/.test(b.work)
      || typeof b.signature !== "string" || !/^[A-Fa-f0-9]{128}$/.test(b.signature)
      || Object.hasOwn(b, "link_as_account") && !checkAddress(b.link_as_account)
      || hashBlock(b) !== head.hash || !verifyBlock({ hash: head.hash, signature: b.signature, publicKey: derivePublicKey(account) })) fail();
    return head;
  } catch { fail(); }
}

/** RPCs may attach unsigned display/provider fields. Retain only the state
 * block's signed core and work; verify that core before storing any receipt. */
export function initialHeadFromRpc(account, { hash, blockCount, block }) {
  try {
    if (typeof block === "string") block = JSON.parse(block);
    const selected = Object.fromEntries(["type", "account", "previous", "representative", "balance", "link", "signature", "work"]
      .map(key => [key, block?.[key]]));
    return validateInitialHead(account, { hash, blockCount, balance: selected.balance, representative: selected.representative, block: selected });
  } catch { fail(); }
}

export function validateMigrationReceipt(receipt, { account, legacySha256 = null, receiptSha256 = null, scopes = null } = {}) {
  try {
    if (!keys(receipt, ["v", "schema", "account", "networkGenesis", "createdAt", "legacySha256", "sourceSetSha256", "sources", "initialHead"])
      || receipt.v !== 1 || receipt.schema !== 3 || receipt.account !== account || receipt.networkGenesis !== NANO_GENESIS || !digest(receipt.legacySha256)
      || !digest(receipt.sourceSetSha256) || !Number.isSafeInteger(receipt.createdAt) || receipt.createdAt <= 0
      || !Array.isArray(receipt.sources) || receipt.sources.length < 1 || receipt.sources.length > 1000) fail();
    const seen = new Set();
    for (const source of receipt.sources) {
      if (!keys(source, ["scope", "sha256"]) || !/^(nano|near|market:(?:[a-z0-9][a-z0-9-]{0,63})?)$/.test(source.scope)
        || !digest(source.sha256) || seen.has(source.scope)) fail();
      seen.add(source.scope);
    }
    if (scopes !== null && (!Array.isArray(scopes)
      || JSON.stringify([...seen].sort()) !== JSON.stringify([...scopes].sort()))) fail();
    if (receipt.sources.find(s => s.scope === "nano")?.sha256 !== receipt.legacySha256
      || createHash("sha256").update(JSON.stringify(receipt.sources)).digest("hex") !== receipt.sourceSetSha256
      || legacySha256 !== null && receipt.legacySha256 !== legacySha256
      || receiptSha256 !== null && receiptDigest(receipt) !== receiptSha256) fail();
    validateInitialHead(account, receipt.initialHead);
    return receipt;
  } catch { fail(); }
}
