/**
 * ed25519 signing keys for refunds. The secret stays inside a node:crypto
 * KeyObject held in a closure: a signer serializes, inspects and logs as its
 * public key only, and no error message ever includes the key text.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertNearAccountId } from "./account.mjs";
import { base58Decode, base58Encode } from "./base58.mjs";
import { NearError } from "./errors.mjs";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function badKey(message) {
  return new NearError("BAD_KEY", message);
}

export function parseNearSecretKey(text) {
  if (typeof text !== "string") throw badKey("a NEAR secret key must be a string");
  const trimmed = text.trim();
  if (!trimmed.startsWith("ed25519:")) throw badKey('a NEAR secret key must start with "ed25519:"');
  let raw;
  try {
    raw = base58Decode(trimmed.slice("ed25519:".length));
  } catch {
    throw badKey("the NEAR secret key is not valid base58");
  }
  if (raw.length !== 64 && raw.length !== 32) {
    raw.fill(0);
    throw badKey("a NEAR ed25519 secret key must decode to 32 or 64 bytes");
  }
  const seed = Buffer.from(raw.subarray(0, 32));
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  let key;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw badKey("the NEAR secret key could not be loaded");
  } finally {
    der.fill(0);
    seed.fill(0);
  }
  const publicKeyBytes = Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
  if (raw.length === 64 && !raw.subarray(32).equals(publicKeyBytes)) {
    raw.fill(0);
    throw badKey("the NEAR secret key's public half does not match its seed");
  }
  raw.fill(0);
  const publicKey = `ed25519:${base58Encode(publicKeyBytes)}`;
  const label = `[NearSigner ${publicKey}]`;
  const signer = {
    publicKey,
    publicKeyBytes,
    sign(message) {
      if (!(message instanceof Uint8Array)) throw new TypeError("sign expects a Uint8Array");
      return cryptoSign(null, message, key);
    },
    toJSON() {
      return label;
    },
    toString() {
      return label;
    },
    [Symbol.for("nodejs.util.inspect.custom")]() {
      return label;
    },
  };
  return Object.freeze(signer);
}

function keyFromEnvText(text) {
  let found = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?NEAR_PRIVATE_KEY\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[1];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) found = v; // the last assignment wins, as in shell
  }
  return found;
}

/**
 * Load the refund signer. Precedence: keyFile (near-cli credentials JSON) >
 * NEAR_PRIVATE_KEY in envFileText > env.NEAR_PRIVATE_KEY.
 */
export async function loadNearSigner({ accountId, keyFile = null, envFileText = null, env = process.env } = {}) {
  assertNearAccountId(accountId);
  if (keyFile) {
    let json;
    try {
      json = JSON.parse(await readFile(keyFile, "utf8"));
    } catch {
      throw badKey("the NEAR key file could not be read as JSON");
    }
    if (!json || typeof json !== "object") throw badKey("the NEAR key file is not a JSON object");
    if (json.account_id !== accountId) {
      throw new NearError("KEY_ACCOUNT_MISMATCH", `the NEAR key file is for a different account than ${accountId}`);
    }
    const secret = json.private_key ?? json.secret_key;
    if (typeof secret !== "string") throw badKey("the NEAR key file has no private_key");
    const signer = parseNearSecretKey(secret);
    if (json.public_key != null && json.public_key !== signer.publicKey) {
      throw badKey("the NEAR key file's public_key does not match its private_key");
    }
    return signer;
  }
  const fromEnvFile = envFileText != null ? keyFromEnvText(envFileText) : null;
  if (fromEnvFile) return parseNearSecretKey(fromEnvFile);
  const fromEnv = env?.NEAR_PRIVATE_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) return parseNearSecretKey(fromEnv);
  throw badKey("no NEAR refund key configured: pass --near-key-file or set NEAR_PRIVATE_KEY");
}
