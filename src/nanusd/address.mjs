// NanUSD (usd_) address parsing + validation.
// The NanUSD network is a Nano-protocol fork: addresses share Nano's
// encoding — prefix + 52 base32 chars of public key + 8 base32 chars of
// checksum (BLAKE2b-5 of the public key, byte-reversed). Only the prefix
// and the ledger differ. A `nano_` address is therefore a WRONG address
// on this network, and this module refuses it.

import { blake2b } from "./blake2b.mjs";

export const NANUSD_PREFIX = "usd_";
export const NANO_ALPHABET = "13456789abcdefghijkmnopqrstuwxyz";

function base32ToBits(str) {
  let bits = "";
  for (const ch of str) {
    const i = NANO_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, "0");
  }
  return bits;
}

function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function bytesToBase32(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += NANO_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/** Decode a usd_ address to its 32-byte public key, or throw with a reason. */
export function parseNanusdAddress(address) {
  if (typeof address !== "string") throw new TypeError("address must be a string");
  if (address.startsWith("nano_") || address.startsWith("ban_") || address.startsWith("xrb_")) {
    throw new Error(`wrong network prefix: ${address.slice(0, 5)} is not a NanUSD (usd_) address`);
  }
  if (!address.startsWith(NANUSD_PREFIX)) throw new Error("address must start with usd_");
  const body = address.slice(NANUSD_PREFIX.length);
  if (body.length !== 60) throw new Error(`address body must be 60 chars, got ${body.length}`);
  const keyBits = base32ToBits(body.slice(0, 52));
  const checkBits = base32ToBits(body.slice(52));
  if (keyBits === null || checkBits === null) throw new Error("address contains characters outside the Nano base32 alphabet");
  // 52 chars * 5 bits = 260 bits; the first 4 bits are padding, the rest is the 256-bit public key.
  const publicKey = bitsToBytes(keyBits.slice(4));
  if (publicKey.length !== 32) throw new Error("decoded public key is not 32 bytes");
  const digest = blake2b(publicKey, 5);
  const expectedCheck = bytesToBase32(Buffer.from(digest).reverse());
  if (expectedCheck !== body.slice(52)) throw new Error("address checksum mismatch");
  return { address, publicKey: publicKey.toString("hex") };
}

/** Build the usd_ address for a 32-byte public key (hex or Buffer). */
export function nanusdAddressFromPublicKey(publicKey) {
  const key = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey, "hex");
  if (key.length !== 32) throw new Error("public key must be 32 bytes");
  const keyBits = "0000" + [...key].map((b) => b.toString(2).padStart(8, "0")).join("");
  let encoded = "";
  for (let i = 0; i + 5 <= keyBits.length; i += 5) encoded += NANO_ALPHABET[parseInt(keyBits.slice(i, i + 5), 2)];
  const digest = blake2b(key, 5);
  return NANUSD_PREFIX + encoded + bytesToBase32(Buffer.from(digest).reverse());
}

export function isValidNanusdAddress(address) {
  try { parseNanusdAddress(address); return true; } catch { return false; }
}
