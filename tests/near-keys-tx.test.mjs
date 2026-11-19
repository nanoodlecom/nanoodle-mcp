/**
 * ed25519 keys, base58, Borsh transfer serialization and signing.
 *
 * Known-good vectors come from near-api-js's own unit tests
 * (test/unit/transactions/serialize.test.ts): the "serialize transfer tx"
 * expected bytes, and the published test key whose public key appears in the
 * "serialize multi-action tx" bytes. They are public library test vectors, not
 * keys for any account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createHash, createPublicKey, verify, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Encode, base58Decode } from "../src/near/base58.mjs";
import { parseNearSecretKey, loadNearSigner } from "../src/near/keys.mjs";
import { serializeTransferTx, signTransfer } from "../src/near/tx.mjs";

const SEED = Buffer.alloc(32, 1); // test-only seed
function keyFromSeed(seed, { full = true } = {}) {
  const pub = parseNearSecretKey(`ed25519:${base58Encode(seed)}`).publicKeyBytes;
  return `ed25519:${base58Encode(full ? Buffer.concat([seed, pub]) : seed)}`;
}

function spki(pub) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
}

// near-api-js published vectors
const SDK_TRANSFER_HEX = "09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000";
const SDK_TEST_KEY = "ed25519:2wyRcSwSuHtRVmkMCGjPwnzZmQLeXLzLLyED1NDMt4BjnKgQL6tF85yBx6Jr26D2dUNeC716RBoTxntVHsegogYw";
const SDK_TEST_PUB_HEX = "0f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef8";
const SDK_BLOCK_HASH = "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM";

test("base58 vectors and round trips", () => {
  assert.equal(base58Encode(Buffer.alloc(32)), "11111111111111111111111111111111");
  assert.deepEqual(base58Decode("11111111111111111111111111111111", 32), Buffer.alloc(32));
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.equal(base58Encode(Buffer.from([0, 0, 1])), "112");
  assert.equal(base58Encode(Buffer.from("hello world")), "StV1DL6CwTryKyV");
  const h = base58Decode("HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", 32);
  assert.equal(h.length, 32);
  assert.equal(base58Encode(h), "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1");
  for (let i = 0; i < 200; i++) {
    const len = 1 + (i % 70);
    const b = randomBytes(len);
    if (i % 5 === 0) b.fill(0, 0, Math.min(3, len)); // leading zero bytes
    assert.deepEqual(base58Decode(base58Encode(b), len), b);
  }
  for (const bad of ["0abc", "Iabc", "lol", "O", "", "abc+"]) {
    assert.throws(() => base58Decode(bad), { name: "NearError", code: "BAD_BASE58" }, bad);
  }
  assert.throws(() => base58Decode("HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1", 31), { code: "BAD_BASE58" });
  assert.throws(() => base58Decode(123), { code: "BAD_BASE58" });
});

test("parse a published near-api-js test key: derived public key matches the SDK vector", () => {
  const s = parseNearSecretKey(SDK_TEST_KEY);
  assert.equal(s.publicKeyBytes.toString("hex"), SDK_TEST_PUB_HEX);
  assert.equal(s.publicKey, `ed25519:${base58Encode(Buffer.from(SDK_TEST_PUB_HEX, "hex"))}`);
});

test("parse 64-byte and 32-byte keys from a generated seed", () => {
  const full = parseNearSecretKey(keyFromSeed(SEED));
  const short = parseNearSecretKey(keyFromSeed(SEED, { full: false }));
  assert.equal(full.publicKey, short.publicKey);
  assert.match(full.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(full.publicKeyBytes.length, 32);
  const msg = Buffer.from("hello");
  const sig = full.sign(msg);
  assert.equal(sig.length, 64);
  assert.equal(verify(null, msg, spki(full.publicKeyBytes), sig), true);
  assert.deepEqual(short.sign(msg), sig); // ed25519 is deterministic
});

test("a 64-byte key whose public half does not match is rejected", () => {
  const other = parseNearSecretKey(keyFromSeed(Buffer.alloc(32, 2))).publicKeyBytes;
  const bad = `ed25519:${base58Encode(Buffer.concat([SEED, other]))}`;
  assert.throws(() => parseNearSecretKey(bad), { code: "BAD_KEY" });
  for (const junk of ["", "ed25519:", "secp256k1:abc", `ed25519:${base58Encode(Buffer.alloc(48, 3))}`, "ed25519:0OIl", 42, null]) {
    assert.throws(() => parseNearSecretKey(junk), { code: "BAD_KEY" });
  }
});

test("error messages never echo the key text", () => {
  const secretish = `ed25519:${base58Encode(Buffer.alloc(48, 9))}`;
  try {
    parseNearSecretKey(secretish);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!e.message.includes(secretish.slice(8)));
  }
});

test("JSON.stringify and util.inspect never reveal the seed", () => {
  const text = keyFromSeed(SEED);
  const s = parseNearSecretKey(text);
  const seedB58 = base58Encode(SEED);
  const seedHex = SEED.toString("hex");
  const outputs = [JSON.stringify(s), JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 10, showHidden: true }), String(s), `${s}`];
  for (const out of outputs) {
    assert.ok(!out.includes(seedB58), out);
    assert.ok(!out.includes(seedHex), out);
    assert.ok(!out.includes(text.slice(8)), out);
    assert.match(out, /\[NearSigner ed25519:/);
  }
  assert.ok(Object.isFrozen(s));
  assert.deepEqual(Object.keys(s).sort(), ["publicKey", "publicKeyBytes", "sign", "toJSON", "toString"]);
});

test("loadNearSigner precedence and account checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-keys-"));
  try {
    const keyA = keyFromSeed(Buffer.alloc(32, 0xa));
    const keyB = keyFromSeed(Buffer.alloc(32, 0xb));
    const keyC = keyFromSeed(Buffer.alloc(32, 0xc));
    const pubA = parseNearSecretKey(keyA).publicKey;
    const pubB = parseNearSecretKey(keyB).publicKey;
    const pubC = parseNearSecretKey(keyC).publicKey;
    const keyFile = join(dir, "merchant.testnet.json");
    await writeFile(keyFile, JSON.stringify({ account_id: "merchant.testnet", public_key: pubA, private_key: keyA }));
    const envFileText = `# comment\nOTHER=1\nexport NEAR_PRIVATE_KEY="${keyB}"\n`;
    const env = { NEAR_PRIVATE_KEY: keyC };

    assert.equal((await loadNearSigner({ accountId: "merchant.testnet", keyFile, envFileText, env })).publicKey, pubA);
    assert.equal((await loadNearSigner({ accountId: "merchant.testnet", envFileText, env })).publicKey, pubB);
    assert.equal((await loadNearSigner({ accountId: "merchant.testnet", env })).publicKey, pubC);
    assert.equal((await loadNearSigner({ accountId: "merchant.testnet", envFileText: "NEAR_PRIVATE_KEY=" + keyB, env: {} })).publicKey, pubB);
    await assert.rejects(loadNearSigner({ accountId: "merchant.testnet", env: {} }), { code: "BAD_KEY", message: /no NEAR refund key configured/ });

    await assert.rejects(loadNearSigner({ accountId: "other.testnet", keyFile, env: {} }), { code: "KEY_ACCOUNT_MISMATCH" });

    const secretKeyFile = join(dir, "sk.json");
    await writeFile(secretKeyFile, JSON.stringify({ account_id: "merchant.testnet", secret_key: keyA }));
    assert.equal((await loadNearSigner({ accountId: "merchant.testnet", keyFile: secretKeyFile, env: {} })).publicKey, pubA);

    const wrongPub = join(dir, "wrong.json");
    await writeFile(wrongPub, JSON.stringify({ account_id: "merchant.testnet", public_key: pubB, private_key: keyA }));
    await assert.rejects(loadNearSigner({ accountId: "merchant.testnet", keyFile: wrongPub, env: {} }), { code: "BAD_KEY" });

    const junk = join(dir, "junk.json");
    await writeFile(junk, `{"private_key":"${keyA}"`);
    await assert.rejects(loadNearSigner({ accountId: "merchant.testnet", keyFile: junk, env: {} }), (e) => {
      assert.equal(e.code, "BAD_KEY");
      assert.ok(!e.message.includes(keyA.slice(8)));
      return true;
    });
    await assert.rejects(loadNearSigner({ accountId: "merchant.testnet", keyFile: join(dir, "missing.json"), env: {} }), { code: "BAD_KEY" });
    await assert.rejects(loadNearSigner({ accountId: "BAD", env }), { code: "BAD_ACCOUNT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Borsh transfer bytes match the near-api-js published vector", () => {
  const bytes = serializeTransferTx({
    signerId: "test.near",
    publicKeyBytes: base58Decode("Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC", 32),
    nonce: 1n,
    receiverId: "whatever.near",
    blockHash: base58Decode(SDK_BLOCK_HASH, 32),
    amountYocto: 1n,
  });
  assert.equal(bytes.toString("hex"), SDK_TRANSFER_HEX);
});

test("Borsh layout offsets field by field", () => {
  const signer = parseNearSecretKey(keyFromSeed(SEED));
  const blockHash = createHash("sha256").update("block").digest();
  const amount = (1n << 100n) + 7n;
  const b = serializeTransferTx({ signerId: "merchant.testnet", publicKeyBytes: signer.publicKeyBytes, nonce: 275735371000006n, receiverId: "payer.testnet", blockHash, amountYocto: amount });
  let at = 0;
  assert.equal(b.readUInt32LE(at), 16); at += 4;
  assert.equal(b.subarray(at, at + 16).toString(), "merchant.testnet"); at += 16;
  assert.equal(b[at], 0); at += 1; // ed25519
  assert.deepEqual(b.subarray(at, at + 32), signer.publicKeyBytes); at += 32;
  assert.equal(b.readBigUInt64LE(at), 275735371000006n); at += 8;
  assert.equal(b.readUInt32LE(at), 13); at += 4;
  assert.equal(b.subarray(at, at + 13).toString(), "payer.testnet"); at += 13;
  assert.deepEqual(b.subarray(at, at + 32), blockHash); at += 32;
  assert.equal(b.readUInt32LE(at), 1); at += 4; // one action
  assert.equal(b[at], 3); at += 1; // Transfer
  // u128 little-endian of 2^100 + 7: low u64 = 7, high u64 = 2^36
  const u128 = b.subarray(at, at + 16);
  assert.equal(u128.toString("hex"), "07000000000000000000000010000000");
  assert.equal(u128.readBigUInt64LE(0) + (u128.readBigUInt64LE(8) << 64n), amount);
  at += 16;
  assert.equal(at, b.length);
  assert.equal(b.length, 4 + 16 + 1 + 32 + 8 + 4 + 13 + 32 + 4 + 1 + 16);
});

test("serializeTransferTx rejects out-of-range values", () => {
  const base = { signerId: "a.testnet", publicKeyBytes: Buffer.alloc(32), nonce: 1n, receiverId: "b.testnet", blockHash: Buffer.alloc(32), amountYocto: 1n };
  assert.throws(() => serializeTransferTx({ ...base, amountYocto: 1n << 128n }), { code: "BAD_AMOUNT" });
  assert.throws(() => serializeTransferTx({ ...base, amountYocto: -1n }), { code: "BAD_AMOUNT" });
  assert.throws(() => serializeTransferTx({ ...base, amountYocto: 5 }), { code: "BAD_AMOUNT" });
  assert.throws(() => serializeTransferTx({ ...base, nonce: 1n << 64n }), { code: "BAD_AMOUNT" });
  assert.throws(() => serializeTransferTx({ ...base, publicKeyBytes: Buffer.alloc(31) }), TypeError);
  assert.throws(() => serializeTransferTx({ ...base, receiverId: "Bad" }), { code: "BAD_ACCOUNT" });
  assert.equal(serializeTransferTx({ ...base, amountYocto: (1n << 128n) - 1n }).subarray(-16).toString("hex"), "ff".repeat(16));
});

test("signTransfer: signature verifies over sha256(tx), hash is base58(sha256(tx))", () => {
  const signer = parseNearSecretKey(keyFromSeed(SEED));
  const blockHashBytes = createHash("sha256").update("recent block").digest();
  const blockHash = base58Encode(blockHashBytes);
  const out = signTransfer({ signer, signerId: "merchant.testnet", receiverId: "payer.testnet", nonce: 42n, blockHash, amountYocto: 5276802197802197802197n });
  assert.equal(out.nonce, "42");
  assert.equal(out.blockHash, blockHash);
  const signed = Buffer.from(out.signedTxBase64, "base64");
  const txBytes = serializeTransferTx({ signerId: "merchant.testnet", publicKeyBytes: signer.publicKeyBytes, nonce: 42n, receiverId: "payer.testnet", blockHash: blockHashBytes, amountYocto: 5276802197802197802197n });
  assert.equal(signed.length, txBytes.length + 1 + 64);
  assert.deepEqual(signed.subarray(0, txBytes.length), txBytes);
  assert.equal(signed[txBytes.length], 0); // ed25519 signature tag
  const sig = signed.subarray(txBytes.length + 1);
  const digest = createHash("sha256").update(txBytes).digest();
  assert.equal(verify(null, digest, spki(signer.publicKeyBytes), sig), true);
  assert.equal(verify(null, txBytes, spki(signer.publicKeyBytes), sig), false); // signs the digest, not the bytes
  assert.equal(out.txHash, base58Encode(digest));
  assert.deepEqual(base58Decode(out.txHash, 32), digest);
  // deterministic: same inputs, same bytes and hash
  const again = signTransfer({ signer, signerId: "merchant.testnet", receiverId: "payer.testnet", nonce: 42n, blockHash, amountYocto: 5276802197802197802197n });
  assert.equal(again.signedTxBase64, out.signedTxBase64);
  assert.throws(() => signTransfer({ signer, signerId: "merchant.testnet", receiverId: "payer.testnet", nonce: 42n, blockHash: "short", amountYocto: 1n }), { code: "BAD_BASE58" });
});
