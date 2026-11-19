/**
 * Bitcoin-alphabet base58, as NEAR uses for hashes, keys and signatures.
 * Each leading '1' is one leading zero byte.
 */
import { NearError } from "./errors.mjs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("base58Encode expects a Uint8Array");
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Little-endian base-58 digits of the big-endian byte string.
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function base58Decode(text, expectedLength) {
  if (typeof text !== "string" || text.length === 0 || text.length > 512) {
    throw new NearError("BAD_BASE58", "not a base58 string");
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  // Little-endian bytes of the number.
  const bytes = [];
  for (let i = zeros; i < text.length; i++) {
    const v = INDEX.get(text[i]);
    if (v === undefined) throw new NearError("BAD_BASE58", "invalid base58 character");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new NearError("BAD_BASE58", `expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}
