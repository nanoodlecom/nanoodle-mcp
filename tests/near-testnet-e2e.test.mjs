/**
 * scripts/near-testnet-e2e.mjs run offline: the real server binary in NEAR
 * mode and this script's own payer-side code (sign, broadcast, re-verify,
 * balance checks, replay, wrong amount, reuse) against the local chain
 * stand-in in tests/fixtures/near-fake-chain.mjs, which checks every
 * signature and nonce the script produces. So the script is known to work
 * before anyone runs it against real testnet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeChain, nanoGptMock, throwawayNearKey, GAS_YOCTO } from "./fixtures/near-fake-chain.mjs";
import http from "node:http";
import { parseNearToYocto, rateFromNearUsd } from "../src/near/amount.mjs";
import { runTestnetE2E, expectedChargeYocto, MOCK_CHAT_COST_USD } from "../scripts/near-testnet-e2e.mjs";
import { sendTransfer, checkTransferOnChain, rpcFor } from "../scripts/near-testnet-lib.mjs";
import { loadNearSigner } from "../src/near/keys.mjs";

const MERCHANT = "e2e-m-0a1b2c3d4e.testnet";
const PAYER = "e2e-p-0a1b2c3d4e.testnet";
const noSleep = async () => {};

async function setup({ payerBalance = "5", merchantKeyOnChain = true, chainId = "testnet" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "near-testnet-e2e-"));
  const chain = createFakeChain({ chainId });
  const mk = await throwawayNearKey(), pk = await throwawayNearKey();
  chain.addAccount(MERCHANT, parseNearToYocto("10"), merchantKeyOnChain ? mk.publicKey : null);
  chain.addAccount(PAYER, parseNearToYocto(payerBalance), pk.publicKey);
  await chain.listen();
  const mFile = join(dir, `${MERCHANT}.json`), pFile = join(dir, `${PAYER}.json`);
  await writeFile(mFile, JSON.stringify({ account_id: MERCHANT, public_key: mk.publicKey, private_key: mk.secretKey }), { mode: 0o600 });
  await writeFile(pFile, JSON.stringify({ account_id: PAYER, public_key: pk.publicKey, private_key: pk.secretKey }), { mode: 0o600 });
  const accounts = join(dir, "accounts.json");
  await writeFile(accounts, JSON.stringify({ v: 1, network: "testnet", merchant: { accountId: MERCHANT, keyFile: mFile }, payer: { accountId: PAYER, keyFile: pFile } }));
  return { dir, chain, mk, pk, mFile, pFile, accounts };
}

function run(argv, extra = {}) {
  const lines = [];
  return runTestnetE2E(argv, { print: (l) => lines.push(String(l)), sleep: noSleep, env: { PATH: process.env.PATH }, ...extra })
    .then((r) => ({ ...r, out: lines.join("\n") }));
}

test("--mock-model: the whole live flow passes against the chain stand-in, and the chain agrees", { timeout: 120_000 }, async () => {
  const s = await setup();
  const nano = nanoGptMock();
  await nano.listen();
  try {
    const startM = s.chain.balance(MERCHANT), startP = s.chain.balance(PAYER);
    const r = await run(["--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--out", join(s.dir, "out")], { nano });
    assert.equal(r.exitCode, 0, r.out);
    assert.ok(!r.rows.some((x) => x.status === "FAIL"), r.out);
    assert.ok(r.rows.length >= 30, `ran ${r.rows.length} checks\n${r.out}`);
    assert.match(r.out, /PASS: \d+\/\d+ checks passed/);

    // four transfers: payment, refund, wrong-amount payment, its refund — and nothing else
    assert.deepEqual(r.txs.map((t) => t.label), ["payment", "refund", "wrong-amount payment", "wrong-amount refund"]);
    for (const t of r.txs) assert.ok(s.chain.txs.has(t.hash), `${t.label} is on the chain`);
    const fromMerchant = [...s.chain.txs.values()].filter((t) => t.transaction.signer_id === MERCHANT);
    assert.equal(fromMerchant.length, 2, "exactly two refunds: replay and reuse refunded nothing");
    assert.equal(nano.runs(), 1, "the model ran once in the whole script");

    // balances reconcile: charged once, every transaction burns gas from its signer
    const paidTx = s.chain.txs.get(r.txs[0].hash), refundTx = s.chain.txs.get(r.txs[1].hash);
    const charged = BigInt(paidTx.transaction.actions[0].Transfer.deposit) - BigInt(refundTx.transaction.actions[0].Transfer.deposit);
    assert.equal(startP - s.chain.balance(PAYER), charged + 2n * GAS_YOCTO);
    assert.equal(s.chain.balance(MERCHANT) - startM, charged - 2n * GAS_YOCTO);

    // the transcript shows explorer links and re-check commands, and never a secret key
    assert.match(r.out, /https:\/\/testnet\.nearblocks\.io\/txns\//);
    assert.match(r.out, /node scripts\/near-check-tx\.mjs --network testnet --merchant e2e-m-0a1b2c3d4e\.testnet --sender e2e-p-0a1b2c3d4e\.testnet --tx /);
    assert.ok(!r.out.includes(s.mk.secretKey.slice(8)) && !r.out.includes(s.pk.secretKey.slice(8)), "no secret key in the output");
    assert.match(r.out, /payer gas vs tokens_burnt of the payment tx: exact match/);

    // the charge is checked against the stand-in's own reported cost, not only against the receipt
    const charge = r.rows.filter((x) => x.id === "charge");
    assert.ok(charge.length >= 3 && charge.every((x) => x.status === "PASS"), r.out);
    assert.match(r.out, /PASS {2}charged = the stand-in's own reported model cost \(\$0\.00041\) \+ 20%/);
    assert.equal(charged, expectedChargeYocto(MOCK_CHAT_COST_USD, rateFromNearUsd("3.64"), BigInt(paidTx.transaction.actions[0].Transfer.deposit)));
  } finally {
    await s.chain.close();
    await nano.close();
  }
});

test("expectedChargeYocto follows the settlement rule (the README's worked example)", () => {
  const rate = rateFromNearUsd("3.64");
  assert.equal(expectedChargeYocto("0.00941", rate, parseNearToYocto("0.008379")), parseNearToYocto("0.003102197802197802197803"));
  assert.equal(expectedChargeYocto("5", rate, 123n), 123n, "capped at the deposit");
});

test("--mock-model: a charge that is not the model cost + 20% fails the run even though chain and receipt agree", { timeout: 120_000 }, async () => {
  const s = await setup();
  const nano = nanoGptMock();
  await nano.listen();
  // A NanoGPT stand-in that reports a different cost than MOCK_CHAT_COST_USD: the server charges
  // that cost + 20%, the receipt and the chain stay consistent, and only the charge check can tell.
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const up = await fetch(nano.url + req.url, { method: req.method, headers: { "content-type": "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    let body = await up.text();
    if (req.url.includes("/chat/completions")) body = body.replace(/"costUsd":0\.00041/, '"costUsd":0.0009');
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${proxy.address().port}`;
    const r = await run(["--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--out", join(s.dir, "out")], { nano: { url, runs: nano.runs } });
    assert.equal(r.exitCode, 1, r.out);
    const failed = r.rows.filter((x) => x.status === "FAIL");
    assert.deepEqual([...new Set(failed.map((x) => x.id))], ["charge"], r.out);
    assert.ok(r.rows.some((x) => x.id === "receipt" && x.status === "PASS" && /deposit − refund = charged/.test(x.name)), "the receipt arithmetic alone still passes");
    assert.match(r.out, /- charge: The charge must be the model cost \+ 20%/);
  } finally {
    await new Promise((r) => proxy.close(r));
    await s.chain.close();
    await nano.close();
  }
});

test("--dry-run: every read-only step passes and nothing is broadcast", { timeout: 60_000 }, async () => {
  const s = await setup();
  try {
    const before = [s.chain.balance(MERCHANT), s.chain.balance(PAYER)];
    const r = await run(["--dry-run", "--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--out", join(s.dir, "out")]);
    assert.equal(r.exitCode, 0, r.out);
    assert.match(r.out, /DRY RUN: stopping before the first transfer/);
    assert.equal(s.chain.sendTxCount, 0, "no send_tx");
    assert.deepEqual([s.chain.balance(MERCHANT), s.chain.balance(PAYER)], before);
    assert.deepEqual(r.txs, []);
    const names = r.rows.map((x) => x.name).join("\n");
    for (const want of ["RPC is on testnet", "both keys are full-access keys", "NEAR/USD rate available", "price_noodle: the graph is safe", "run_noodle returns a quote"]) {
      assert.ok(names.includes(want), `dry run checks: ${want}`);
    }
  } finally {
    await s.chain.close();
  }
});

test("preflight failures are explicit, exit 1, and say what to check", { timeout: 60_000 }, async () => {
  // merchant key not on the account
  let s = await setup({ merchantKeyOnChain: false });
  try {
    const r = await run(["--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--out", join(s.dir, "out")]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /FAIL {2}both keys are full-access keys of their accounts — e2e-m-0a1b2c3d4e\.testnet: not a key of this account/);
    assert.match(r.out, /What to check:\n {2}- accounts: /);
    assert.equal(s.chain.sendTxCount, 0);
  } finally { await s.chain.close(); }

  // payer too poor: a live run stops before the server starts
  s = await setup({ payerBalance: "0.01" });
  try {
    const r = await run(["--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--out", join(s.dir, "out")]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /FAIL {2}balances are enough for the run/);
    assert.match(r.out, /- balances: Funding/);
    assert.equal(s.chain.sendTxCount, 0);
  } finally { await s.chain.close(); }

  // an RPC on the wrong network
  s = await setup({ chainId: "mainnet" });
  try {
    const r = await run(["--mock-model", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /FAIL {2}RPC is on testnet — .* chain_id mainnet/);
  } finally { await s.chain.close(); }

  // a missing accounts file
  const r = await run(["--accounts", join(tmpdir(), "no-such-dir-near", "accounts.json")]);
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /create it with: node scripts\/near-testnet-accounts\.mjs/);

  // real-model mode with no NanoGPT source
  s = await setup();
  try {
    const r2 = await run(["--dry-run", "--accounts", s.accounts, "--rpc", s.chain.url, "--near-usd", "3.64", "--env-file", join(s.dir, "missing.env")]);
    assert.equal(r2.exitCode, 1);
    assert.match(r2.out, /--env-file .*missing\.env does not exist/);
  } finally { await s.chain.close(); }
});

test("bad usage exits 2", async () => {
  assert.equal((await run(["--bogus"])).exitCode, 2);
  assert.equal((await run(["--mock-model", "--model", "x/y"])).exitCode, 2);
  assert.equal((await run(["--network", "mainnet"])).exitCode, 2);
});

test("sendTransfer: increasing nonces back to back, idempotent recovery when the broadcast answer is lost", async () => {
  const s = await setup();
  try {
    const rpc = rpcFor(s.chain.url);
    const signer = await loadNearSigner({ accountId: PAYER, keyFile: s.pFile, env: {} });
    const nonceState = {};
    const a = await sendTransfer({ rpc, signer, signerId: PAYER, receiverId: MERCHANT, amountYocto: 10n ** 21n, nonceState, sleep: noSleep });
    const b = await sendTransfer({ rpc, signer, signerId: PAYER, receiverId: MERCHANT, amountYocto: 10n ** 21n, nonceState, sleep: noSleep });
    assert.equal(b.nonce, a.nonce + 1n);
    assert.equal(a.burnt, GAS_YOCTO);

    // the RPC refuses the broadcast twice (HTTP 503): the same bytes are re-sent and land once
    s.chain.failSendTx = 2;
    const before = s.chain.balance(PAYER);
    const c = await sendTransfer({ rpc, signer, signerId: PAYER, receiverId: MERCHANT, amountYocto: 10n ** 21n, nonceState, sleep: noSleep });
    assert.ok(s.chain.txs.has(c.txHash));
    assert.equal(before - s.chain.balance(PAYER), 10n ** 21n + GAS_YOCTO, "charged once");

    // a definitive rejection is reported with the network's reason, and nothing moves
    const rejecting = async (url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "send_tx") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { signer_id: PAYER } } } } } }), { status: 200 });
      }
      return s.chain.fetch(url, init);
    };
    const balance0 = s.chain.balance(PAYER);
    await assert.rejects(
      sendTransfer({ rpc: rpcFor(s.chain.url, rejecting), signer, signerId: PAYER, receiverId: MERCHANT, amountYocto: 10n ** 21n, nonceState, sleep: noSleep }),
      (e) => e.code === "TRANSFER_REJECTED" && /NotEnoughBalance/.test(e.message),
    );
    assert.equal(s.chain.balance(PAYER), balance0);
    const chk = await checkTransferOnChain({ rpc, txHash: a.txHash, sender: PAYER, receiver: MERCHANT, amountYocto: 10n ** 21n });
    assert.ok(chk.ok, JSON.stringify(chk.rules));
    const bad = await checkTransferOnChain({ rpc, txHash: a.txHash, sender: PAYER, receiver: MERCHANT, amountYocto: 2n });
    assert.equal(bad.ok, false);
    assert.ok(bad.rules.some((r) => !r.ok && /amount is/.test(r.text)));
    assert.equal((await stat(s.pFile)).mode & 0o777, 0o600);
  } finally {
    await s.chain.close();
  }
});
