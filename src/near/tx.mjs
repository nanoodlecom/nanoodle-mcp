/**
 * Borsh encoding of a NEAR Transaction (V0, untagged) with exactly one
 * Transfer action, and its signature. Little-endian throughout.
 *
 *   Transaction {
 *     signer_id:   string     (u32 length + utf8)
 *     public_key:  PublicKey  (u8 key type 0 = ed25519, 32 bytes)
 *     nonce:       u64
 *     receiver_id: string
 *     block_hash:  [u8; 32]
 *     actions:     Vec<Action> (u32 count = 1; u8 tag 3 = Transfer; u128 deposit)
 *   }
 *   SignedTransaction { transaction, signature: Signature (u8 0 = ed25519, 64 bytes) }
 *
 * The transaction hash is sha256(borsh(Transaction)); that digest is what gets
 * signed and, in base58, is the hash explorers and RPC show.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { assertNearAccountId } from "./account.mjs";
import { base58Decode, base58Encode } from "./base58.mjs";
import { NearError } from "./errors.mjs";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
export const DEFAULT_FUNCTION_CALL_GAS = 30_000_000_000_000n;

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n) {
  if (typeof n !== "bigint" || n < 0n || n > U64_MAX) throw new NearError("BAD_AMOUNT", "nonce must be a u64 bigint");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function u128(n) {
  if (typeof n !== "bigint" || n < 0n || n > U128_MAX) throw new NearError("BAD_AMOUNT", "amount must be a u128 bigint");
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & U64_MAX, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

function str(s) {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function bytes32(b, what) {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new TypeError(`${what} must be 32 bytes`);
  return Buffer.from(b);
}

/** Check the signed V0 transaction's hash and access-key nonce before renewal. */
export function matchesSignedNonce({ signedTxBase64, txHash, signerId, publicKeyBytes, nonce }) {
  if (typeof signedTxBase64 !== "string" || signedTxBase64.length > 32_768) return false;
  const signed = Buffer.from(signedTxBase64, "base64");
  const prefix = Buffer.concat([str(signerId), Buffer.from([0]), bytes32(publicKeyBytes, "publicKeyBytes"), u64(nonce)]);
  if (signed.length <= prefix.length + 65 || signed.at(-65) !== 0) return false;
  const payload = signed.subarray(0, -65);
  return payload.subarray(0, prefix.length).equals(prefix)
    && base58Encode(createHash("sha256").update(payload).digest()) === txHash;
}

/** Re-encode the expected transaction with its original public key, then verify its signature. */
export function matchesSignedTransaction({ signedTxBase64, txHash, signerId }, serialize) {
  if (typeof signedTxBase64 !== "string" || signedTxBase64.length > 32_768) return false;
  const signed = Buffer.from(signedTxBase64, "base64");
  const publicKeyAt = str(signerId).length + 1;
  if (signed.length <= publicKeyAt + 32 + 65 || signed.at(-65) !== 0 || signed.toString("base64") !== signedTxBase64) return false;
  const originalKey = signed.subarray(publicKeyAt, publicKeyAt + 32);
  const payload = signed.subarray(0, -65);
  if (!payload.equals(serialize(originalKey))) return false;
  const digest = createHash("sha256").update(payload).digest();
  if (base58Encode(digest) !== txHash) return false;
  const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: originalKey.toString("base64url") } });
  return verify(null, digest, key, signed.subarray(-64));
}

export function serializeTransferTx({ signerId, publicKeyBytes, nonce, receiverId, blockHash, amountYocto }) {
  assertNearAccountId(signerId);
  assertNearAccountId(receiverId);
  return Buffer.concat([
    str(signerId),
    Buffer.from([0]),
    bytes32(publicKeyBytes, "publicKeyBytes"),
    u64(nonce),
    str(receiverId),
    bytes32(blockHash, "blockHash"),
    u32(1),
    Buffer.from([3]),
    u128(amountYocto),
  ]);
}

export function signTransfer({ signer, signerId, receiverId, nonce, blockHash, amountYocto }) {
  const txBytes = serializeTransferTx({
    signerId,
    publicKeyBytes: signer.publicKeyBytes,
    nonce,
    receiverId,
    blockHash: base58Decode(blockHash, 32),
    amountYocto,
  });
  return signBytes(signer, txBytes, nonce, blockHash);
}

export function serializeFunctionCallTx({ signerId, publicKeyBytes, receiverId, nonce, blockHash, methodName, args,
  gas = DEFAULT_FUNCTION_CALL_GAS, depositYocto = 1n }) {
  assertNearAccountId(signerId);
  assertNearAccountId(receiverId);
  if (typeof methodName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(methodName)) throw new TypeError("invalid FunctionCall method");
  const argBytes = Buffer.from(JSON.stringify(args));
  if (argBytes.length > 16_384) throw new RangeError("FunctionCall arguments too large");
  return Buffer.concat([
    str(signerId), Buffer.from([0]), bytes32(publicKeyBytes, "publicKeyBytes"), u64(nonce), str(receiverId),
    bytes32(base58Decode(blockHash, 32), "blockHash"), u32(1), Buffer.from([2]), str(methodName),
    u32(argBytes.length), argBytes, u64(gas), u128(depositYocto),
  ]);
}

/** One NEAR FunctionCall, used for NEP-141 transfers and storage registration. */
export function signFunctionCall({ signer, ...fields }) {
  return signBytes(signer, serializeFunctionCallTx({ ...fields, publicKeyBytes: signer.publicKeyBytes }), fields.nonce, fields.blockHash);
}

function signBytes(signer, txBytes, nonce, blockHash) {
  const digest = createHash("sha256").update(txBytes).digest();
  const signature = signer.sign(digest);
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new NearError("BAD_KEY", "signer returned a malformed signature");
  const signed = Buffer.concat([txBytes, Buffer.from([0]), Buffer.from(signature)]);
  return {
    txHash: base58Encode(digest),
    signedTxBase64: signed.toString("base64"),
    nonce: nonce.toString(),
    blockHash,
  };
}
