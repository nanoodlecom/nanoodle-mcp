import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { createNearGate } from "../src/near-gate.mjs";
import { createNearRpc, openNearLedger, createRefunder, parseNearSecretKey, parseNearToYocto, createNearWatcher, readPaymentTransfer } from "../src/near/index.mjs";
import { USDC_CONTRACTS, USDC_RATE, formatUsdc, usdcDeposit, checkUsdcMerchant } from "../src/near/ft.mjs";
import { createFakeChain, throwawayNearKey, WORKED_GRAPH, nanoGptMock } from "./fixtures/near-fake-chain.mjs";

const M = "merchant.testnet", P = "payer.testnet", TOKEN = USDC_CONTRACTS.testnet;
let originalFetch, mock, key, graphs;
before(async () => {
  originalFetch = globalThis.fetch; mock = nanoGptMock(); globalThis.fetch = mock.fetch;
  key = await throwawayNearKey(); graphs = await mkdtemp(join(tmpdir(), "usdc-graphs-"));
  await writeFile(join(graphs, "poster.json"), JSON.stringify(WORKED_GRAPH));
});
after(() => { globalThis.fetch = originalFetch; });
async function world() {
  const out = await mkdtemp(join(tmpdir(), "usdc-state-"));
  const chain = createFakeChain(); chain.addAccount(M, parseNearToYocto("10"), key.publicKey); chain.addAccount(P, parseNearToYocto("5"));
  chain.addFt(TOKEN, { [M]: 0n, [P]: 10_000_000n });
  const rpc = createNearRpc({ url: "https://rpc.fake", fetch: chain.fetch });
  const registry = await loadTools({ dirs: [graphs], apiKey: "test-key", outDir: out, log: () => {} });
  const make = (token = TOKEN) => {
    const ledger = openNearLedger({ file: join(out, "state.json"), network: "testnet", merchant: M });
    const refunder = createRefunder({ rpc, signer: parseNearSecretKey(key.secretKey), accountId: M, ledger, usdcToken: TOKEN, schedule: () => null });
    let dust = 10;
    const gate = createNearGate({ merchantId: M, network: "testnet", rpc, ledger, refunder, usdcToken: token, usdcEnabled: true,
      rate: { current: async () => ({ usdNano: 3_000_000_000n, yocto: 10n ** 24n, nearUsd: "3", source: "test", at: new Date().toISOString() }),
        currentUsdc: async () => ({ ...USDC_RATE, usdcUsd: "1", source: "USDC denomination", at: new Date().toISOString() }) },
      fetch: mock.fetch, randomInt: () => dust++, publicBase: "https://near.nanoodle.com" });
    const wrapped = gate.wrapRegistry(registry);
    return { ledger, refunder, gate, call: (name, args) => wrapped.callTool({ name, arguments: args }) };
  };
  return { chain, rpc, ...make(), make };
}
const argsFor = (name) => name === "run_noodle" ? { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } } : { Idea: "a lighthouse" };

for (const name of ["run_noodle", "poster"]) test(`USDC: ${name} quotes, detects, executes once, refunds and replays`, async () => {
  const w = await world(), args = argsFor(name), start = mock.runs();
  assert.deepEqual(await checkUsdcMerchant({ rpc: w.rpc, network: "testnet", merchantId: M }), { tokenContract: TOKEN, symbol: "USDC", decimals: 6 });
  const p = (await w.call(name, { ...args, _pay_with: "usdc" })).structuredContent.payment;
  assert.equal(p.asset, "USDC"); assert.equal(p.tokenContract, TOKEN); assert.equal(p.amount, formatUsdc(p.amountAtomic));
  assert.ok(!Object.hasOwn(p, "amountYocto")); assert.ok(!Object.hasOwn(p, "amountNear"));
  assert.equal(mock.runs(), start, "quoting cannot run providers");
  const watch = createNearWatcher({ rpc: w.rpc, ledger: w.ledger, merchantId: M, tokenContracts: [TOKEN], pendingQuotes: w.gate.pendingQuotes,
    observeTransfer: w.gate.observeTransfer, schedule: () => null });
  await watch.start();
  const tx = w.chain.ftTransfer(TOKEN, P, M, BigInt(p.amountAtomic), { blockTimeMs: Date.now() + 1 });
  await watch.tick(); watch.stop();
  assert.equal(w.gate.quote(p.paymentId).status, "paid", "contract account changes discover USDC without a callback");
  assert.equal(mock.runs(), start);
  const result = await w.call(name, { ...args, _payment_id: p.paymentId });
  const receipt = result.structuredContent.receipt;
  assert.equal(receipt.outcome, "succeeded"); assert.equal(receipt.asset, "USDC");
  assert.equal(receipt.deposit.txHash, tx); assert.equal(receipt.refund.to, P); assert.equal(receipt.refund.status, "sent");
  assert.equal(BigInt(receipt.deposit.amountAtomic) - BigInt(receipt.refund.amountAtomic), BigInt(receipt.charged.amountAtomic));
  assert.equal(w.chain.ftBalance(TOKEN, M), BigInt(receipt.charged.amountAtomic));
  assert.equal(w.chain.ftBalance(TOKEN, P), 10_000_000n - BigInt(receipt.charged.amountAtomic));
  assert.ok(!Object.hasOwn(receipt.deposit, "yocto")); assert.ok(!Object.hasOwn(receipt.refund, "near"));
  const ran = mock.runs(), sends = w.chain.sendTxCount;
  const restarted = w.make(); await restarted.gate.resume();
  const replay = await restarted.call(name, { ...args, _payment_id: p.paymentId });
  assert.equal(replay.structuredContent.receipt.refund.txHash, receipt.refund.txHash);
  assert.equal(mock.runs(), ran); assert.equal(w.chain.sendTxCount, sends);
});

test("USDC verification rejects wrong tokens, native transfers, missing events, multiactions and wrong amounts in events", async () => {
  const w = await world();
  const tx = w.chain.ftTransfer(TOKEN, P, M, 10000n), result = w.chain.txs.get(tx);
  const verify = () => readPaymentTransfer({ rpc: w.rpc, txHash: tx, senderId: "someone-else.testnet", merchantId: M, tokenContract: TOKEN });
  assert.equal((await verify()).payer, P, "claimed sender cannot steal the refund");
  const original = structuredClone(result);
  const mutations = [
    r => { r.transaction.receiver_id = "wrong-token.testnet"; },
    r => { r.transaction.actions = [{ Transfer: { deposit: "10000" } }]; },
    r => { r.transaction.actions.push({ Transfer: { deposit: "1" } }); },
    r => { r.receipts_outcome[0].outcome.logs = []; },
    r => { r.receipts_outcome[0].outcome.executor_id = "fake-token.testnet"; },
    r => { r.receipts_outcome[0].outcome.logs[0] = r.receipts_outcome[0].outcome.logs[0].replace('"10000"', '"9999"'); },
    r => { r.receipts_outcome[0].outcome.logs.push(r.receipts_outcome[0].outcome.logs[0]); },
    r => { r.transaction.actions[0].FunctionCall.deposit = "0"; },
    r => { r.transaction.actions[0].FunctionCall.method_name = "ft_transfer_call"; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); w.chain.txs.set(tx, changed); await assert.rejects(verify()); }
});

test("USDC wrong amount refunds in USDC, and a quote cannot consume a different asset or change arguments", async () => {
  const w = await world(), args = argsFor("poster");
  const p = (await w.call("poster", { ...args, _pay_with: "usdc" })).structuredContent.payment;
  const native = w.chain.transfer(P, M, 1n);
  assert.ok((await w.gate.confirmPayment(p.paymentId, native, P)).error);
  assert.equal(w.ledger.consumedBy(native), null);
  const wrong = BigInt(p.amountAtomic) - 1n;
  const tx = w.chain.ftTransfer(TOKEN, P, M, wrong);
  const before = mock.runs();
  const refused = await w.call("poster", { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: P });
  assert.equal(refused.structuredContent.receipt.outcome, "wrong_amount");
  assert.equal(refused.structuredContent.receipt.refund.amountAtomic, wrong.toString());
  assert.equal(w.chain.ftBalance(TOKEN, P), 10_000_000n); assert.equal(mock.runs(), before);
  await assert.rejects(w.call("poster", { ...args, _payment_id: p.paymentId, _pay_with: "near" }), /asset cannot change/);
  const fresh = (await w.call("poster", { ...args, _pay_with: "usdc" })).structuredContent.payment;
  assert.match((await w.gate.confirmPayment(fresh.paymentId, tx, P)).error, /already used/);
  const mismatch = await w.call("poster", { Idea: "changed", _payment_id: fresh.paymentId });
  assert.ok(mismatch.isError);
});

test("mixed NEAR/USDC refunds share one nonce queue, including one micro-USDC refunds", async () => {
  const w = await world(); w.chain.addFt(TOKEN, { [M]: 100000n, [P]: 100000n });
  const [native, token] = await Promise.all([
    w.refunder.refund({ paymentId: "native", to: P, amountYocto: parseNearToYocto("0.01"), reason: "change" }),
    w.refunder.refund({ paymentId: "token", to: P, amountYocto: 1n, reason: "change", asset: "usdc", tokenContract: TOKEN }),
  ]);
  assert.equal(native.status, "sent"); assert.equal(token.status, "sent");
  assert.notEqual(w.ledger.getRefund(native.refundId).nonce, w.ledger.getRefund(token.refundId).nonce);
  assert.equal(w.chain.ftBalance(TOKEN, P), 100001n);
  assert.equal((await w.refunder.refund({ paymentId: "token", to: P, amountYocto: 1n, reason: "change", asset: "usdc", tokenContract: TOKEN })).txHash, token.txHash);
});

test("USDC unit formatting and unique dust stay within six-decimal token precision", () => {
  assert.equal(formatUsdc(1n), "0.000001"); assert.equal(formatUsdc(1000000n), "1");
  assert.equal(usdcDeposit("0.01", () => false, () => 999), 10999n);
  assert.throws(() => usdcDeposit("0.01", () => true), { code: "NO_UNIQUE_AMOUNT" });
});
