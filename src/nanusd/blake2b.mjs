// Minimal BLAKE2b (RFC 7693), unkeyed, variable digest length (1..64).
// Needed because Nano-style address checksums use BLAKE2b with a 5-byte
// digest, which Node's OpenSSL binding does not expose in this build.
// Pure JS with BigInt words; correctness is pinned by the RFC 7693
// Appendix A test vector in test/proof.mjs and by the published NanUSD
// genesis account checksum.

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const MASK = (1n << 64n) - 1n;
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;

function compress(h, block, count, isLast) {
  const m = new Array(16);
  for (let i = 0; i < 16; i++) {
    let v = 0n;
    for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(block[i * 8 + j]);
    m[i] = v;
  }
  const v = [...h, ...IV];
  v[12] ^= BigInt(count);
  if (isLast) v[14] ^= MASK;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & MASK; v[b] = rotr(v[b] ^ v[c], 63);
  };
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
    G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
    G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

export function blake2b(input, outLength = 32) {
  if (outLength < 1 || outLength > 64) throw new RangeError("blake2b digest 1..64");
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLength); // unkeyed param block: fanout=1, depth=1
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0, count = 0;
  while (bytes.length - offset > 128) {
    compress(h, bytes.subarray(offset, offset + 128), count + 128, false);
    count += 128; offset += 128;
  }
  const last = Buffer.alloc(128);
  bytes.copy(last, 0, offset);
  compress(h, last, count + (bytes.length - offset), true);
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) {
    let v = h[i];
    for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(v & 0xffn); v >>= 8n; }
  }
  return out.subarray(0, outLength);
}
