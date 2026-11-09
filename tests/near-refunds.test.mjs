/**
 * Refund sender: persist-before-broadcast, identical rebroadcasts, re-signing
 * only when the old transaction is provably dead, one refund per payment, and
 * restart recovery. The chain is a mock fetch; the key is a test-only seed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createNearRpc } from "../src/near/rpc.mjs";
import { openNearLedger } from "../src/near/ledger.mjs";
import { createRefunder } from "../src/near/refunds.mjs";
import { parseNearSecretKey } from "../src/near/keys.mjs";
import { base58Encode, base58Decode } from "../src/near/base58.mjs";

const SIGNER = parseNearSecretKey(`ed25519:${base58Encode(Buffer.alloc(32, 7))}`); // test-only seed
const MERCHANT = "merchant.testnet";
const BLOCK_A = base58Encode(createHash("sha256").update("block A").digest());
const BLOCK_B = base58Encode(createHash("sha256").update("block B").digest());
const AMOUNT = 5276802197802197802197n;
/** A transfer outcome at FINAL: status and its executed receipt. */
const DONE = Object.freeze({
  final_execution_status: "FINAL",
  status: { SuccessValue: "" },
  receipts_outcome: [{ id: "r1", outcome: { status: { SuccessValue: "" } } }],
});

const RPC_ERR = {
  expired: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: "Expired" } } },
  invalidNonce: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 5, ak_nonce: 9 } } } } },
  notEnoughBalance: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: MERCHANT, balance: "1", cost: "2" } } } } },
  unknownTx: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: "Transaction doesn't exist" },
  timeout: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} }, code: -32000, message: "Server error", data: "Timeout" },
};

/**
 * Mock chain. `onSend(signedTxBase64, n)` returns {result} | {error} | {http}.
 * `onTx(txHash)` returns {result} | {error}. `key` is the access key view.
 */
function mockChain({ onSend, onTx = () => ({ error: RPC_ERR.unknownTx }), key = { nonce: 100, block_hash: BLOCK_A } } = {}) {
  const log = { sends: [], txs: [], keys: 0 };
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    let a;
    if (req.method === "send_tx") {
      log.sends.push(req.params.signed_tx_base64);
      assert.equal(req.params.wait_until, "FINAL");
      a = await onSend(req.params.signed_tx_base64, log.sends.length);
    } else if (req.method === "tx") {
      log.txs.push(req.params);
      a = onTx(req.params.tx_hash);
    } else if (req.method === "query") {
      log.keys++;
      const k = typeof key === "function" ? key() : key;
      a = { result: { block_height: 1, permission: "FullAccess", ...k } };
    } else throw new Error(`unexpected ${req.method}`);
    if (a.http) return new Response("bad gateway", { status: a.http });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, ...(a.error ? { error: a.error } : { result: a.result }) }), { status: 200 });
  };
  return { rpc: createNearRpc({ url: "https://rpc.example.test", fetch }), log };
}

async function withLedger(fn) {
  const dir = await mkdtemp(join(tmpdir(), "near-refunds-"));
  try {
    const file = join(dir, "near-state.json");
    await fn({ file, open: () => openNearLedger({ file, network: "testnet", merchant: MERCHANT }) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function make(rpc, ledger, extra = {}) {
  const timers = [];
  const lines = [];
  let t = 1_000_000;
  const refunder = createRefunder({
    rpc, signer: SIGNER, accountId: MERCHANT, ledger,
    now: () => t,
    log: (l) => lines.push(l),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    ...extra,
  });
  return { refunder, timers, lines, advance: (ms) => { t += ms; } };
}

function decodeSigned(b64) {
  const b = Buffer.from(b64, "base64");
  const txBytes = b.subarray(0, b.length - 65);
  let at = 0;
  const str = () => { const n = b.readUInt32LE(at); at += 4; const s = b.subarray(at, at + n).toString(); at += n; return s; };
  const signerId = str();
  at += 1;
  const pub = b.subarray(at, at + 32); at += 32;
  const nonce = b.readBigUInt64LE(at); at += 8;
  const receiverId = str();
  const blockHash = base58Encode(b.subarray(at, at + 32)); at += 32;
  at += 4 + 1;
  const amount = b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n);
  const digest = createHash("sha256").update(txBytes).digest();
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
  return { signerId, receiverId, nonce, blockHash, amount, hash: base58Encode(digest), sigOk: verify(null, digest, key, b.subarray(b.length - 64)) };
}

test("the signed record (with hash) is on disk when send_tx is called; success -> sent", async () => {
  await withLedger(async ({ file, open }) => {
    const ledger = open();
    let seenOnDisk = null;
    const { rpc, log } = mockChain({
      onSend: (signed) => {
        const disk = JSON.parse(readFileSync(file, "utf8"));
        seenOnDisk = Object.values(disk.refunds)[0];
        assert.equal(seenOnDisk.signedTxBase64, signed);
        return { result: DONE };
      },
    });
    const { refunder } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(seenOnDisk.status, "signed");
    assert.match(seenOnDisk.txHash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.equal(seenOnDisk.paymentId, "nq_a");
    assert.equal(seenOnDisk.amountYocto, AMOUNT.toString());
    assert.equal(seenOnDisk.nonce, "101");
    assert.equal(seenOnDisk.blockHash, BLOCK_A);
    assert.deepEqual(out, { refundId: seenOnDisk.id, status: "sent", txHash: seenOnDisk.txHash });
    assert.match(out.refundId, /^rf_[A-Za-z0-9_-]{12}$/);
    assert.equal(ledger.getRefund(out.refundId).status, "sent");
    assert.equal(refunder.get(out.refundId).status, "sent");
    assert.equal(ledger.getMeta("lastNonce"), "101");
    const tx = decodeSigned(log.sends[0]);
    assert.deepEqual({ ...tx }, { signerId: MERCHANT, receiverId: "payer.testnet", nonce: 101n, blockHash: BLOCK_A, amount: AMOUNT, hash: out.txHash, sigOk: true });
    // the file never contains key material
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(base58Encode(Buffer.alloc(32, 7))));
  });
});

test("transient failure -> pending; a later tick rebroadcasts identical bytes", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const answers = [{ http: 503 }, { error: RPC_ERR.timeout }, { result: DONE }];
    const { rpc, log } = mockChain({ onSend: (s, n) => answers[n - 1] });
    const { refunder, timers, advance } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "run_failed" });
    assert.equal(out.status, "pending");
    assert.ok(out.txHash);
    let rec = ledger.getRefund(out.refundId);
    assert.equal(rec.attempts, 1);
    assert.equal(rec.nextAttemptAt, 1_000_000 + 30_000);
    assert.equal(timers.at(-1).ms, 30_000);

    await refunder.tick(); // not due yet
    assert.equal(log.sends.length, 1);
    advance(30_000);
    await refunder.tick();
    rec = ledger.getRefund(out.refundId);
    assert.equal(rec.attempts, 2);
    assert.equal(timers.at(-1).ms, 60_000);
    advance(60_000);
    timers.at(-1).fn(); // the scheduled tick
    await refunder.tick();
    assert.equal(ledger.getRefund(out.refundId).status, "sent");
    assert.equal(new Set(log.sends).size, 1, "every broadcast used identical bytes");
    assert.ok(log.sends.length >= 3);
    assert.equal(log.keys, 1, "signed once");
  });
});

test("Expired + old hash unknown -> re-signed with a fresh nonce, old hash kept", async () => {
  await withLedger(async ({ file, open }) => {
    const ledger = open();
    let keyView = { nonce: 100, block_hash: BLOCK_A };
    let resignedOnDisk = null;
    const { rpc, log } = mockChain({
      key: () => keyView,
      onSend: (signed, n) => {
        if (n === 1) {
          keyView = { nonce: 100, block_hash: BLOCK_B };
          return { error: RPC_ERR.expired };
        }
        resignedOnDisk = Object.values(JSON.parse(readFileSync(file, "utf8")).refunds)[0];
        return { result: DONE };
      },
      onTx: () => ({ error: RPC_ERR.unknownTx }),
    });
    const { refunder } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "sent");
    assert.equal(log.sends.length, 2);
    const first = decodeSigned(log.sends[0]);
    const second = decodeSigned(log.sends[1]);
    assert.equal(first.nonce, 101n);
    assert.equal(second.nonce, 102n);
    assert.equal(second.blockHash, BLOCK_B);
    assert.notEqual(first.hash, second.hash);
    assert.equal(out.txHash, second.hash);
    assert.deepEqual(log.txs, [{ tx_hash: first.hash, sender_account_id: MERCHANT, wait_until: "NONE" }]);
    // the new record was persisted before its broadcast, under the same id
    assert.equal(resignedOnDisk.id, out.refundId);
    assert.equal(resignedOnDisk.txHash, second.hash);
    assert.deepEqual(resignedOnDisk.supersededTxHashes, [first.hash]);
    assert.equal(resignedOnDisk.status, "signed");
    assert.deepEqual(ledger.getRefund(out.refundId).supersededTxHashes, [first.hash]);
    assert.equal(ledger.refunds().length, 1);
  });
});

test("InvalidNonce + old hash found -> sent, no re-sign", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const { rpc, log } = mockChain({
      onSend: () => ({ error: RPC_ERR.invalidNonce }),
      onTx: () => ({ result: DONE }),
    });
    const { refunder } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "sent");
    assert.equal(log.sends.length, 1);
    assert.equal(log.keys, 1);
    assert.equal(ledger.getRefund(out.refundId).supersededTxHashes, undefined);
  });
});

test("Expired but the status lookup itself fails -> pending, no re-sign", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const { rpc, log } = mockChain({ onSend: () => ({ error: RPC_ERR.expired }), onTx: () => ({ error: RPC_ERR.timeout }) });
    const { refunder } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "pending");
    assert.equal(log.keys, 1);
  });
});

test("other INVALID_TRANSACTION (NotEnoughBalance) retries the same bytes", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    let broke = true;
    const { rpc, log } = mockChain({ onSend: () => (broke ? { error: RPC_ERR.notEnoughBalance } : { result: DONE }) });
    const { refunder, advance } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "pending");
    assert.equal(log.txs.length, 0);
    broke = false; // operator topped up
    advance(30_000);
    await refunder.tick();
    assert.equal(ledger.getRefund(out.refundId).status, "sent");
    assert.equal(new Set(log.sends).size, 1);
  });
});

test("a second refund() for the same payment returns the existing record and sends nothing", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const { rpc, log } = mockChain({ onSend: () => ({ result: DONE }) });
    const { refunder } = make(rpc, ledger);
    const a = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    const b = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.deepEqual(b, a);
    assert.equal(log.sends.length, 1);
    // concurrent duplicates also collapse to one
    const [c, d] = await Promise.all([
      refunder.refund({ paymentId: "nq_b", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" }),
      refunder.refund({ paymentId: "nq_b", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" }),
    ]);
    assert.deepEqual(c, d);
    assert.equal(log.sends.length, 2);
    assert.equal(ledger.refunds().length, 2);
  });
});

test("sends are serialized and nonces increase", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    let inFlight = 0;
    let maxInFlight = 0;
    const { rpc, log } = mockChain({
      onSend: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { result: DONE };
      },
    });
    const { refunder } = make(rpc, ledger);
    await Promise.all(["nq_1", "nq_2", "nq_3"].map((p) => refunder.refund({ paymentId: p, to: "payer.testnet", amountYocto: AMOUNT, reason: "change" })));
    assert.equal(maxInFlight, 1);
    assert.deepEqual(log.sends.map((s) => decodeSigned(s).nonce), [101n, 102n, 103n]);
  });
});

test("resume() after reopening the ledger rebroadcasts the signed record", async () => {
  await withLedger(async ({ open }) => {
    // First process: signs, then the broadcast fails transiently and the process "dies".
    const first = mockChain({ onSend: () => ({ http: 502 }) });
    const r1 = make(first.rpc, open());
    const out = await r1.refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "interrupted" });
    assert.equal(out.status, "pending");

    // Second process: a fresh ledger handle on the same file.
    const ledger = open();
    const second = mockChain({ onSend: () => ({ result: DONE }) });
    const r2 = make(second.rpc, ledger);
    await r2.refunder.resume();
    assert.equal(second.log.keys, 0, "no re-sign on resume");
    assert.deepEqual(second.log.sends, first.log.sends);
    assert.equal(ledger.getRefund(out.refundId).status, "sent");
    // and a duplicate refund() after restart still sends nothing new
    const again = await r2.refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "interrupted" });
    assert.equal(again.status, "sent");
    assert.equal(second.log.sends.length, 1);
  });
});

test("an RPC outage while building leaves a queued record that is signed later", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    let down = true;
    const fetchLog = { sends: 0 };
    const fetch = async (url, init) => {
      const req = JSON.parse(init.body);
      if (down) return new Response("down", { status: 503 });
      if (req.method === "query") return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { nonce: 5, block_hash: BLOCK_A, permission: "FullAccess" } }));
      fetchLog.sends++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: DONE }));
    };
    const { refunder, advance } = make(createNearRpc({ url: "https://rpc.example.test", fetch }), ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "pending");
    assert.equal(out.txHash, null);
    assert.equal(ledger.getRefund(out.refundId).status, "queued");
    down = false;
    advance(30_000);
    await refunder.tick();
    const rec = ledger.getRefund(out.refundId);
    assert.equal(rec.status, "sent");
    assert.equal(rec.nonce, "6");
    assert.equal(fetchLog.sends, 1);
  });
});

test("below the minimum (including zero) -> none, nothing persisted or sent", async () => {
  await withLedger(async ({ file, open }) => {
    const ledger = open();
    const { rpc, log } = mockChain({ onSend: () => ({ result: DONE }) });
    const { refunder } = make(rpc, ledger);
    for (const amountYocto of [0n, 1n, 10n ** 19n - 1n]) {
      assert.deepEqual(await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto, reason: "change" }), { refundId: null, status: "none", txHash: null });
    }
    assert.equal(log.sends.length, 0);
    assert.equal(log.keys, 0);
    assert.equal(ledger.refunds().length, 0);
    assert.throws(() => readFileSync(file), { code: "ENOENT" });
    const exact = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: 10n ** 19n, reason: "change" });
    assert.equal(exact.status, "sent");
  });
});

test("maxAttempts -> failed_permanent with an operator log line (no key material)", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const { rpc } = mockChain({ onSend: () => ({ http: 500 }) });
    const { refunder, lines, advance } = make(rpc, ledger, { maxAttempts: 3 });
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "pending");
    advance(30_000);
    await refunder.tick();
    advance(60_000);
    await refunder.tick();
    const rec = ledger.getRefund(out.refundId);
    assert.equal(rec.status, "failed_permanent");
    assert.equal(rec.attempts, 3);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /nq_a/);
    assert.match(lines[0], /0\.005276802197802197802197 NEAR/);
    assert.match(lines[0], /payer\.testnet/);
    assert.ok(!lines[0].includes(base58Encode(Buffer.alloc(32, 7))));
    // no further sends once permanent
    advance(10_000_000);
    await refunder.tick();
    assert.equal(ledger.getRefund(out.refundId).attempts, 3);
    assert.equal((await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" })).status, "failed_permanent");
  });
});

test("argument validation", async () => {
  await withLedger(async ({ open }) => {
    const { rpc } = mockChain({ onSend: () => ({ result: DONE }) });
    const { refunder } = make(rpc, open());
    await assert.rejects(refunder.refund({ paymentId: "nq_a", to: "Bad", amountYocto: AMOUNT, reason: "change" }), { code: "BAD_ACCOUNT" });
    await assert.rejects(refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: 5, reason: "change" }), TypeError);
    await assert.rejects(refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "gift" }), TypeError);
    assert.ok(base58Decode(BLOCK_A, 32));
  });
});

test("a refund whose transfer receipt failed on chain is failed_permanent and logged, never 'sent'", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const failed = {
      final_execution_status: "FINAL",
      status: { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "gone.testnet" } } } } },
      receipts_outcome: [{ id: "r1", outcome: { status: { Failure: {} } } }],
    };
    const { rpc } = mockChain({ onSend: () => ({ result: failed }) });
    const { refunder, lines } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "gone.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "failed_permanent");
    assert.match(lines.join("\n"), /failed on chain.*send them manually/);
  });
});

test("send_tx that returns before the receipt executed is confirmed with tx at FINAL before 'sent'", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const included = { final_execution_status: "INCLUDED_FINAL" };
    const { rpc, log } = mockChain({ onSend: () => ({ result: included }), onTx: () => ({ result: DONE }) });
    const { refunder } = make(rpc, ledger);
    const out = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(out.status, "sent");
    assert.equal(log.txs.length, 1);
    assert.equal(log.txs[0].wait_until, "FINAL");
  });
});

test("an old refund whose hash the RPC no longer knows is not re-signed (no double refund after RPC garbage collection)", async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    let n = 0;
    const { rpc, log } = mockChain({
      // first broadcast: transport failure (crash window); later: Expired, hash unknown
      onSend: () => (++n === 1 ? { http: 503 } : { error: RPC_ERR.expired }),
      onTx: () => ({ error: RPC_ERR.unknownTx }),
    });
    const { refunder, lines, advance } = make(rpc, ledger);
    const first = await refunder.refund({ paymentId: "nq_a", to: "payer.testnet", amountYocto: AMOUNT, reason: "change" });
    assert.equal(first.status, "pending");
    advance(3 * 86_400_000); // past the window a regular RPC node remembers transactions
    await refunder.tick();
    const rec = ledger.getRefund(first.refundId);
    assert.equal(rec.status, "failed_permanent");
    assert.equal(rec.lastError, "UNPROVABLE");
    assert.equal(log.sends.length, 2, "no third (re-signed) broadcast");
    assert.match(lines.join("\n"), /could not be confirmed/);
  });
});
