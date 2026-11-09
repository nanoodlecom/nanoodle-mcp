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
import { createHash } from "node:crypto";
import { assertNearAccountId } from "./account.mjs";
import { base58Decode, base58Encode } from "./base58.mjs";
import { NearError } from "./errors.mjs";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

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
