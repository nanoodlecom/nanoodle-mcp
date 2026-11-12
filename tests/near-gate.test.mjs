/**
 * NEAR gate: quote → verify → run once → settle → refund → replay, in process.
 *
 * A real tool registry (loadTools) runs the worked-example graph against a
 * mocked NanoGPT; payments and refunds go through the real NEAR rail modules
 * against the in-memory chain in tests/fixtures/near-fake-chain.mjs. Offline:
 * no network, no real keys, no funds.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { createNearGate } from "../src/near-gate.mjs";
import {
  createNearRpc, openNearLedger, createNearUsdRate, createRefunder, parseNearSecretKey, parseNearToYocto,
} from "../src/near/index.mjs";
import { createFakeChain, throwawayNearKey, GAS_YOCTO, WORKED_GRAPH, nanoGptMock } from "./fixtures/near-fake-chain.mjs";

const MERCHANT = "merchant.testnet";
const PAYER = "payer.testnet";
const DEPOSIT = 8379000000000000000000n;          // docs/near-payments.md#worked-example
const CHARGED = 3102197802197802197803n;
const REFUND = 5276802197802197802197n;
const INPUTS = { Idea: "a lighthouse at dawn" };

let realFetch, mock, key, graphsDir;

before(async () => {
  realFetch = globalThis.fetch;
  mock = nanoGptMock();
  globalThis.fetch = mock.fetch; // the registry's Workflows and catalog fetches read the global
  key = await throwawayNearKey();
  graphsDir = await mkdtemp(join(tmpdir(), "near-gate-graphs-"));
  await writeFile(join(graphsDir, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
});
after(() => { globalThis.fetch = realFetch; });

async function world({ limits, dust = 137, publicBase } = {}) {
  const out = await mkdtemp(join(tmpdir(), "near-gate-out-"));
  await mkdir(out, { recursive: true });
  const chain = createFakeChain();
  chain.addAccount(MERCHANT, parseNearToYocto("10"), key.publicKey);
  chain.addAccount(PAYER, parseNearToYocto("5"));
  const registry = await loadTools({ dirs: [graphsDir], apiKey: "test-key", outDir: out, publicBase: "http://127.0.0.1:1", log: () => {} });
  const file = join(out, "near-state.json");
  const events = [];
  const make = () => {
    const rpc = createNearRpc({ url: "https://rpc.fake", fetch: chain.fetch });
    const ledger = openNearLedger({ file, network: "testnet", merchant: MERCHANT });
    const signer = parseNearSecretKey(key.secretKey);
    const refunder = createRefunder({ rpc, signer, accountId: MERCHANT, ledger, schedule: () => null });
    const gate = createNearGate({
      merchantId: MERCHANT, network: "testnet", rpc, ledger, refunder,
      rate: createNearUsdRate({ staticUsd: "3.64" }),
      // The first quote gets the worked example's dust (137 steps); later ones count up from there.
      limits, fetch: mock.fetch, randomInt: () => dust++, publicBase,
      usage: (event, fields) => events.push({ event, ...fields }),
    });
    const { listTools, callTool } = gate.wrapRegistry(registry);
    return { gate, ledger, refunder, listTools, callTool };
  };
  const g = make();
  return { ...g, chain, registry, file, out, events, restart: async () => { const n = make(); await n.gate.resume(); return n; } };
}

const call = (w, name, args) => w.callTool({ name, arguments: args });
const text = (r) => r.content.map((c) => c.text || "").join("\n");

test("wallet page confirms payment without running; the original MCP call resumes with only its id", async () => {
  const w = await world({ publicBase: "https://mcp-near.nanoodle.com" });
  const q = await call(w, "idea-poster", INPUTS);
  const p = q.structuredContent.payment;
  assert.equal(p.payUrl, `https://mcp-near.nanoodle.com/pay/${p.paymentId}`);
  assert.match(p.next, /monitor payment/);
  const tx = w.chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto));
  const before = mock.runs();
  const waiting = w.gate.waitForPayment(p.paymentId);
  const confirmed = await w.gate.confirmPayment(p.paymentId, tx, PAYER);
  await waiting;
  assert.equal(confirmed.status, "paid");
  assert.equal(confirmed.done, true);
  assert.equal(w.ledger.consumedBy(tx), p.paymentId);
  assert.equal(mock.runs(), before, "confirming must not run models");
  assert.ok(!JSON.stringify(confirmed).includes(INPUTS.Idea), "payment surface has no workflow inputs");
  const mismatched = await call(w, "idea-poster", { Idea: "a different idea", _payment_id: p.paymentId });
  assert.ok(mismatched.isError);
  assert.equal(w.gate.quote(p.paymentId).status, "paid");
  const result = await call(w, "idea-poster", { ...INPUTS, _payment_id: p.paymentId });
  assert.equal(result.structuredContent.receipt.outcome, "succeeded");
  assert.equal(result.structuredContent.receipt.refund.status, "sent");
  assert.equal(w.gate.quote(p.paymentId).status, "settled");
  const repeated = await w.gate.confirmPayment(p.paymentId, tx, PAYER);
  assert.equal(repeated.status, "settled");
});

test("wallet confirmation persists across restart and retains transaction reuse protection", async () => {
  const w = await world();
  const { p, tx } = await quoteAndPay(w, "idea-poster", INPUTS);
  assert.equal((await w.gate.confirmPayment(p.paymentId, tx, PAYER)).status, "paid");
  const n = await w.restart();
  assert.equal(n.gate.quote(p.paymentId).status, "paid");
  const second = (await call(n, "idea-poster", INPUTS)).structuredContent.payment;
  assert.match((await n.gate.confirmPayment(second.paymentId, tx, PAYER)).error, /already used/);
  const result = await call(n, "idea-poster", { ...INPUTS, _payment_id: p.paymentId });
  assert.equal(result.structuredContent.receipt.outcome, "succeeded");
});

test("wallet confirmation refunds wrong and late transfers without running a model", async () => {
  for (const late of [false, true]) {
    const w = await world();
    const { p, tx } = await quoteAndPay(w, "idea-poster", INPUTS, late
      ? { blockTimeMs: Date.now() + 31 * 60_000 }
      : { amount: 1_000_000_000_000_000_000_000n });
    const confirmed = await w.gate.confirmPayment(p.paymentId, tx, PAYER);
    assert.equal(confirmed.status, "rejected");
    assert.equal(confirmed.receipt.refund.status, "sent");
    assert.equal(confirmed.receipt.charged.yocto, "0");
    assert.equal(confirmed.receipt.outcome, late ? "late_payment" : "wrong_amount");
  }
});

async function quoteAndPay(w, name, args, { amount, blockTimeMs } = {}) {
  const q = await call(w, name, args);
  assert.ok(!q.isError, text(q));
  const p = q.structuredContent.payment;
  const tx = w.chain.transfer(PAYER, MERCHANT, amount ?? BigInt(p.amountYocto), { blockTimeMs });
  return { p, tx, pay: () => call(w, name, { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER }) };
}

test("tools/list offers run_noodle, the free helpers and safe saved graphs, with payment arguments", async () => {
  const w = await world();
  const names = w.listTools().map((t) => t.name).sort();
  assert.deepEqual(names, ["idea-poster", "noodle_guide", "price_noodle", "run_noodle"]);
  const rn = w.listTools().find((t) => t.name === "run_noodle");
  assert.match(rn.description, /paid in NEAR on testnet: a deposit is held up front, you are charged the actual model cost \+ 20% service fee, and the rest is refunded automatically/);
  for (const k of ["_payment_id", "_payment_tx", "_payment_sender", "graph", "url", "inputs"]) assert.ok(rn.inputSchema.properties[k], k);
  const price = w.listTools().find((t) => t.name === "price_noodle");
  assert.equal(price.inputSchema.properties._payment_id, undefined, "price_noodle is never paid");
});

test("price_noodle answers with the pricing vocabulary and NEAR figures, and creates no quote", async () => {
  const w = await world();
  const r = await call(w, "price_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  assert.ok(!r.isError);
  const { pricing, near } = r.structuredContent;
  assert.equal(pricing.estimatedCost.usd, "0.00962");
  assert.equal(pricing.likelyCharge.usd, "0.0115");
  assert.equal(pricing.deposit.usd, "0.03");
  assert.equal(pricing.safety.ok, true);
  assert.equal(near.likelyChargeNear, "0.003172");
  assert.equal(near.depositNear, "0.008242");
  assert.match(text(r), /You will most likely pay about \$0\.0115 \(0\.003172 NEAR\)/);
  assert.equal(w.ledger.quotes().length, 0);

  const bad = await call(w, "price_noodle", { graph: { nodes: [{ id: "u", type: "upload", fields: {} }], links: [] } });
  assert.ok(!bad.isError, "unsafe graphs are reported, not errors");
  assert.equal(bad.structuredContent.pricing.safety.ok, false);
  assert.equal(bad.structuredContent.pricing.safety.refusals[0].code, "NODE_NOT_ALLOWED");
});

test("a quote carries the exact deposit with dust, the locked rate and the itemized pricing", async () => {
  const w = await world();
  const runs = mock.runs();
  const r = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  assert.ok(!r.isError, text(r));
  const { payment, pricing } = r.structuredContent;
  assert.equal(payment.rail, "near");
  assert.equal(payment.status, "payment_required");
  assert.equal(payment.network, "testnet");
  assert.equal(payment.payTo, MERCHANT);
  assert.equal(payment.amountYocto, DEPOSIT.toString());
  assert.equal(payment.amountNear, "0.008379");
  assert.equal(payment.depositUsd, "0.03");
  assert.equal(payment.likelyChargeNear, "0.003172");
  assert.equal(payment.rate.nearUsd, "3.64");
  assert.match(payment.paymentId, /^nq_[A-Za-z0-9_-]{12}$/);
  const rec = w.ledger.getQuote(payment.paymentId);
  assert.equal(rec.expiresAt - rec.createdAt, 30 * 60_000); // the default quote lifetime
  assert.equal(payment.expiresAt, new Date(rec.expiresAt).toISOString());
  assert.equal(pricing.estimatedCost.items.length, 2);
  assert.match(text(r), /Send exactly 0\.008379 NEAR \(8379000000000000000000 yoctoNEAR\) to merchant\.testnet on testnet/);
  const q = w.ledger.getQuote(payment.paymentId);
  assert.equal(q.status, "pending");
  assert.deepEqual(q.rate.usdNano, "3640000000");

  assert.equal(mock.runs(), runs, "quoting never runs");

  // the saved graph is quoted the same way
  const saved = await call(w, "idea-poster", INPUTS);
  assert.ok(!saved.isError, text(saved));
  assert.notEqual(saved.structuredContent.payment.amountYocto, DEPOSIT.toString(), "dust keeps open amounts unique");
});

test("refused graphs never create a quote: upload, endpoint, unpriced model, deposit cap, short link", async () => {
  const runsBefore = mock.runs();
  const w = await world();
  const cases = [
    [{ graph: { nodes: [{ id: "u", type: "upload", name: "Photo", fields: {} }, { id: "e", type: "edit", fields: { model: "blackforestlabs/flux-3/klein/edit-image", prompt: "x" } }], links: [{ from: { node: "u", port: "image" }, to: { node: "e", port: "image" } }] } }, "NODE_NOT_ALLOWED"],
    [{ graph: { nodes: [{ id: "x", type: "endpoint", fields: { url: "" } }], links: [] } }, "NODE_NOT_ALLOWED"],
    [{ graph: { nodes: [{ id: "m", type: "llm", fields: { model: "made-up/model", prompt: "hi" } }], links: [] } }, "UNPRICED_NODE"],
    [{ url: "https://da.gd/abcd" }, "SHORT_LINK"],
  ];
  for (const [args, code] of cases) {
    const r = await call(w, "run_noodle", args);
    assert.equal(r.isError, true, code);
    assert.ok(r.structuredContent.refusals.some((x) => x.code === code), `${code}: ${text(r)}`);
  }
  const unpriced = await call(w, "run_noodle", cases[2][0]);
  assert.match(text(unpriced), /made-up\/model/, "the refusal names the model");

  const capped = await world({ limits: { maxDepositUsd: 0.02 } });
  const r = await call(capped, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.refusals[0].code, "DEPOSIT_TOO_HIGH");

  // argument-shape errors are -32602, also before any quote
  await assert.rejects(call(w, "run_noodle", { graph: WORKED_GRAPH, url: "https://nanoodle.com/#g=x" }), (e) => e.mcpCode === -32602);
  await assert.rejects(call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Nope: "x" } }), (e) => e.mcpCode === -32602);
  assert.equal(w.ledger.quotes().length, 0);
  assert.equal(capped.ledger.quotes().length, 0);
  assert.equal(mock.runs(), runsBefore);
});

test("happy path: verify, run once, settle to the worked example, refund the rest", async () => {
  const w = await world();
  const payerStart = w.chain.balance(PAYER), merchantStart = w.chain.balance(MERCHANT);
  const { p, tx, pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const runs = mock.runs();
  const r = await pay();
  assert.ok(!r.isError, text(r));
  assert.equal(mock.runs(), runs + 1);
  const rc = r.structuredContent.receipt;
  assert.equal(rc.outcome, "succeeded");
  assert.equal(rc.deposit.yocto, DEPOSIT.toString());
  assert.equal(rc.deposit.txHash, tx);
  assert.equal(rc.deposit.explorerUrl, `https://testnet.nearblocks.io/txns/${tx}`);
  assert.equal(rc.actualCost.usd, "0.00941");
  assert.equal(rc.serviceFee.usd, "0.001882");
  assert.equal(rc.charged.yocto, CHARGED.toString());
  assert.equal(rc.charged.usd, "0.011292");
  assert.equal(rc.refund.yocto, REFUND.toString());
  assert.equal(rc.refund.to, PAYER);
  assert.equal(rc.refund.status, "sent");
  assert.ok(w.chain.txs.has(rc.refund.txHash), "the refund landed on chain");
  assert.match(text(r), /Actual model cost \$0\.00941 \+ 20% service fee = \$0\.011292/);
  assert.ok(r.content.some((c) => /^Image: http/.test(c.text || "")), "the media link comes first");

  // balances: deposit − refund = charged, gas aside
  assert.equal(payerStart - w.chain.balance(PAYER), CHARGED + GAS_YOCTO);
  assert.equal(w.chain.balance(MERCHANT) - merchantStart, CHARGED - GAS_YOCTO);

  const q = w.ledger.getQuote(p.paymentId);
  assert.equal(q.status, "settled");
  assert.equal(w.ledger.consumedBy(tx), p.paymentId);
  assert.deepEqual(w.events.map((e) => e.event), ["quote", "paid", "change"]);
  assert.ok(w.events.every((e) => e.rail === "near"));
});

test("replay returns the same result and never runs, charges or refunds again", async () => {
  const w = await world();
  const { pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const first = await pay();
  const runs = mock.runs(), sends = w.chain.sendTxCount, payer = w.chain.balance(PAYER);
  const again = await pay();
  assert.deepEqual(again, first);
  assert.equal(mock.runs(), runs);
  assert.equal(w.chain.sendTxCount, sends);
  assert.equal(w.chain.balance(PAYER), payer);

  // also after a restart (media-only results are kept; the receipt is rebuilt)
  const n = await w.restart();
  const later = await n.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS, _payment_id: first.structuredContent.receipt.paymentId, _payment_tx: first.structuredContent.receipt.deposit.txHash, _payment_sender: PAYER } });
  assert.deepEqual(later.structuredContent.receipt, first.structuredContent.receipt);
  assert.ok(later.content.some((c) => /^Image: http/.test(c.text || "")));
  assert.equal(mock.runs(), runs);

  // a different argument with the same id is refused
  const other = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "something else" }, _payment_id: first.structuredContent.receipt.paymentId, _payment_tx: first.structuredContent.receipt.deposit.txHash, _payment_sender: PAYER });
  assert.equal(other.isError, true);
  assert.match(text(other), /different call/);
});

test("the same transaction cannot pay a second quote", async () => {
  const w = await world();
  const a = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  await a.pay();
  const q2 = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "a second idea" } });
  const runs = mock.runs();
  const r = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "a second idea" }, _payment_id: q2.structuredContent.payment.paymentId, _payment_tx: a.tx, _payment_sender: PAYER });
  assert.equal(r.isError, true);
  assert.match(text(r), /already used for another payment/);
  assert.equal(mock.runs(), runs);
  assert.equal(w.ledger.getQuote(q2.structuredContent.payment.paymentId).status, "pending");
});

test("wrong amount and late payment: no run, everything refunded", async () => {
  const w = await world();
  const runs = mock.runs();
  const under = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS }, { amount: DEPOSIT - 10n ** 18n });
  const before = w.chain.balance(PAYER);
  const r = await under.pay();
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.receipt.outcome, "wrong_amount");
  assert.equal(r.structuredContent.receipt.charged.yocto, "0");
  assert.equal(r.structuredContent.receipt.refund.yocto, (DEPOSIT - 10n ** 18n).toString());
  assert.equal(w.chain.balance(PAYER) - before, DEPOSIT - 10n ** 18n);
  assert.match(text(r), /not the quoted amount, so nothing ran/);

  const q = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "late" } });
  const p = q.structuredContent.payment;
  const tx = w.chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto), { blockTimeMs: Date.parse(p.expiresAt) + 60_000 });
  const late = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "late" }, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER });
  assert.equal(late.isError, true);
  assert.equal(late.structuredContent.receipt.outcome, "late_payment");
  assert.equal(late.structuredContent.receipt.refund.yocto, p.amountYocto);
  assert.equal(mock.runs(), runs, "neither ran");
});

test("a transaction older than the quote is refused and not consumed; a missing one is retryable", async () => {
  const w = await world();
  const q = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const p = q.structuredContent.payment;
  const args = { graph: WORKED_GRAPH, inputs: INPUTS, _payment_id: p.paymentId, _payment_sender: PAYER };
  const old = w.chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto), { blockTimeMs: Date.now() - 60 * 60_000 });
  const r = await call(w, "run_noodle", { ...args, _payment_tx: old });
  assert.equal(r.isError, true);
  assert.match(text(r), /older than this quote/);
  assert.equal(w.ledger.consumedBy(old), null);

  const tx = w.chain.transfer(PAYER, MERCHANT, BigInt(p.amountYocto));
  w.chain.hideTx = 1;
  const nf = await call(w, "run_noodle", { ...args, _payment_tx: tx });
  assert.equal(nf.isError, true);
  assert.match(text(nf), /was not found as final on testnet\. If you just sent it, wait 3 seconds/);
  assert.equal(w.ledger.consumedBy(tx), null);
  const ok = await call(w, "run_noodle", { ...args, _payment_tx: tx });
  assert.ok(!ok.isError, text(ok));
  assert.equal(ok.structuredContent.receipt.outcome, "succeeded");

  const fresh = await call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "another" } });
  await assert.rejects(call(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "another" }, _payment_id: fresh.structuredContent.payment.paymentId }), (e) => e.mcpCode === -32602, "tx and sender are required");
});

test("a run that fails refunds the whole deposit", async () => {
  const w = await world();
  const { pay, p } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "FAIL please" } });
  const before = w.chain.balance(PAYER);
  const r = await pay();
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.receipt.outcome, "run_failed");
  assert.equal(r.structuredContent.receipt.refund.yocto, p.amountYocto);
  assert.equal(w.chain.balance(PAYER) - before, BigInt(p.amountYocto));
  assert.match(text(r), /Details: /);
  const q = w.ledger.getQuote(p.paymentId);
  assert.equal(q.status, "failed");
  assert.doesNotMatch(q.error, /Details|stub/, "upstream error text is never stored");
});

test("restart while running: interrupted, whole deposit refunded, never re-run", async () => {
  const w = await world();
  const { pay, p } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "HOLD this one" } });
  const pending = pay(); // the model call hangs: the process "dies" here
  pending.catch(() => {});
  while (w.ledger.getQuote(p.paymentId).status !== "running") await new Promise((r) => setTimeout(r, 5));
  const runs = mock.runs();
  const before = w.chain.balance(PAYER);

  const n = await w.restart();
  const q = n.ledger.getQuote(p.paymentId);
  assert.equal(q.status, "failed");
  assert.equal(q.outcome, "interrupted");
  assert.equal(w.chain.balance(PAYER) - before, BigInt(p.amountYocto));
  const again = await n.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "HOLD this one" }, _payment_id: p.paymentId, _payment_tx: q.payTx, _payment_sender: PAYER } });
  assert.equal(again.isError, true);
  assert.equal(again.structuredContent.receipt.outcome, "interrupted");
  assert.equal(mock.runs(), runs, "no second run");
  await n.gate.resume();
  assert.equal(w.chain.balance(PAYER) - before, BigInt(p.amountYocto), "a second resume refunds nothing more");
});

test("restart between refund intent and broadcast: the same signed refund goes out once", async () => {
  const w = await world();
  w.chain.failSendTx = 1; // the first broadcast hits an RPC outage
  const { pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const r = await pay();
  assert.equal(r.structuredContent.receipt.refund.status, "pending");
  const signed = w.ledger.refunds()[0];
  assert.equal(signed.status, "signed");
  const before = w.chain.balance(PAYER);

  const n = await w.restart();
  assert.equal(n.ledger.getRefund(signed.id).status, "sent");
  assert.ok(w.chain.txs.has(signed.txHash), "the recorded hash is the one that landed");
  assert.equal(w.chain.balance(PAYER) - before, REFUND);
  const replay = await n.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS, _payment_id: r.structuredContent.receipt.paymentId, _payment_tx: r.structuredContent.receipt.deposit.txHash, _payment_sender: PAYER } });
  assert.equal(replay.structuredContent.receipt.refund.status, "sent");
  assert.equal(replay.structuredContent.receipt.refund.txHash, signed.txHash);
  await n.gate.resume();
  assert.equal(w.chain.balance(PAYER) - before, REFUND, "never refunded twice");
});

test("restart after settlement was recorded but before the refund intent finishes the settlement", async () => {
  const w = await world();
  const { p, tx } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  // Simulate a crash right after the settlement write: the quote is running with a settlement.
  w.ledger.consumeTx(tx, p.paymentId);
  w.ledger.updateQuote(p.paymentId, {
    status: "running", payTx: tx, payer: PAYER, paidYocto: p.amountYocto, paidAtBlockMs: Date.now(),
    settlement: { costUsd: 0.00941, exact: true, costYocto: "2585164835164835164836", feeYocto: "517032967032967032967", chargedYocto: CHARGED.toString(), refundYocto: REFUND.toString() },
  });
  const before = w.chain.balance(PAYER);
  const n = await w.restart();
  const q = n.ledger.getQuote(p.paymentId);
  assert.equal(q.status, "settled");
  assert.equal(w.chain.balance(PAYER) - before, REFUND, "the change, not the whole deposit");
  const replay = await n.callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: PAYER } });
  assert.match(text(replay), /not retained across a server restart/);
  assert.equal(replay.structuredContent.receipt.charged.yocto, CHARGED.toString());
});

test("concurrent duplicate paying calls run once", async () => {
  const w = await world();
  const { pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const runs = mock.runs();
  const [a, b] = await Promise.all([pay(), pay()]);
  assert.equal(mock.runs(), runs + 1);
  assert.deepEqual(a, b);
  assert.equal(w.ledger.refunds().length, 1);
});

test("text output is never written to near-state.json", async () => {
  const w = await world();
  const textGraph = {
    nodes: [
      { id: "t", type: "text", name: "Topic", fields: { text: "" } },
      { id: "l", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write a haiku." } },
    ],
    links: [{ from: { node: "t", port: "text" }, to: { node: "l", port: "prompt" } }],
  };
  const { pay, p } = await quoteAndPay(w, "run_noodle", { graph: textGraph, inputs: { Topic: "tides" } });
  const r = await pay();
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).includes(mock.REPLY));
  const disk = await readFile(w.file, "utf8");
  assert.ok(!disk.includes(mock.REPLY), "the paid text stays in memory");
  assert.ok(!disk.includes("tides"), "inputs are not stored either");
  const n = await w.restart();
  const replay = await n.callTool({ name: "run_noodle", arguments: { graph: textGraph, inputs: { Topic: "tides" }, _payment_id: p.paymentId, _payment_tx: r.structuredContent.receipt.deposit.txHash, _payment_sender: PAYER } });
  assert.match(text(replay), /not retained across a server restart; the run is not repeated/);
  assert.ok(!text(replay).includes(mock.REPLY));
});

test("no rate, no quote", async () => {
  const w = await world();
  const ledger = w.ledger;
  const gate = createNearGate({
    merchantId: MERCHANT, network: "testnet", rpc: createNearRpc({ url: "https://rpc.fake", fetch: w.chain.fetch }), ledger,
    refunder: w.refunder, fetch: mock.fetch,
    rate: { current: async () => { const { NearError } = await import("../src/near/index.mjs"); throw new NearError("RATE_UNAVAILABLE", "x"); } },
  });
  const { callTool } = gate.wrapRegistry(w.registry);
  const r = await callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  assert.equal(r.isError, true);
  assert.match(text(r), /no current NEAR\/USD rate/);
  assert.equal(ledger.quotes().length, 0);
  const price = await callTool({ name: "price_noodle", arguments: { graph: WORKED_GRAPH, inputs: INPUTS } });
  assert.ok(!price.isError);
  assert.equal(price.structuredContent.near, undefined);
  assert.match(text(price), /USD only/);
});

/* ---------------- review regressions ---------------- */

test("someone else's public transfer cannot be burned against a free quote of one's own (front-running)", async () => {
  const w = await world();
  const alice = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  // An attacker with no funds quotes another call and presents Alice's transaction hash.
  const atkArgs = { graph: WORKED_GRAPH, inputs: { Idea: "attacker" } };
  const qb = (await call(w, "run_noodle", atkArgs)).structuredContent.payment;
  const runs = mock.runs();
  const atk = await call(w, "run_noodle", { ...atkArgs, _payment_id: qb.paymentId, _payment_tx: alice.tx, _payment_sender: PAYER });
  assert.equal(atk.isError, true);
  assert.match(text(atk), /the exact amount of a different quote, so it was not used for this one.*Nothing was consumed/);
  assert.equal(w.ledger.consumedBy(alice.tx), null, "not consumed");
  assert.equal(w.ledger.getQuote(qb.paymentId).status, "pending");
  assert.equal(w.ledger.refunds().length, 0, "no refund was sent for it");
  // Alice's own call still works.
  const ok = await alice.pay();
  assert.ok(!ok.isError, text(ok));
  assert.equal(ok.structuredContent.receipt.outcome, "succeeded");
  assert.equal(mock.runs(), runs + 1);
});

test("the paid run is the priced graph: an llm without maxTokens is sent max_tokens (also for saved tools)", async () => {
  const w = await world();
  const before = mock.chatBodies().length;
  const a = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  assert.ok(!(await a.pay()).isError);
  const b = await quoteAndPay(w, "idea-poster", INPUTS);
  const saved = await b.pay();
  assert.ok(!saved.isError, text(saved));
  const sent = mock.chatBodies().slice(before);
  assert.equal(sent.length, 2);
  for (const body of sent) {
    assert.equal(body.model, "z-ai/glm-5.3-flash");
    assert.equal(body.max_tokens, 2000);
  }
});

test("a paid result shows what was charged, never a bare model 'cost:' line, and its USD figures reconcile", async () => {
  const w = await world();
  const { pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  const r = await pay();
  const lines = r.content.filter((c) => c.type === "text").map((c) => c.text);
  assert.ok(!lines.some((l) => /^cost: \$/.test(l)), lines.join("\n"));
  assert.ok(lines.includes("charged: $0.011292 (≈0.003102 NEAR): model cost $0.00941 + 20% service fee; refund ≈0.005277 NEAR sent"), lines.join("\n"));
  const rc = r.structuredContent.receipt;
  assert.equal(rc.deposit.quotedUsd, "0.03");
  assert.equal(rc.deposit.usd, "0.03049956"); // 0.008379 NEAR at $3.64: the $0.03 deposit plus its dust
  const nano = (x) => Math.round(Number(x) * 1e9);
  assert.ok(Math.abs(nano(rc.deposit.usd) - nano(rc.charged.usd) - nano(rc.refund.usd)) <= 1, JSON.stringify(rc));
  assert.doesNotMatch(text(r), /\d\.\d{7,} NEAR/, "readable NEAR amounts in text");
});

test("a run whose provider did not report the full cost is charged the estimated cost, not the lower bound", async () => {
  const w = await world();
  const { pay } = await quoteAndPay(w, "run_noodle", { graph: WORKED_GRAPH, inputs: { Idea: "NOCOST please" } });
  const r = await pay();
  assert.ok(!r.isError, text(r));
  const rc = r.structuredContent.receipt;
  assert.equal(rc.actualCost.billedAs, "estimate");
  assert.equal(rc.actualCost.reportedUsd, "0.009"); // only the image reported a price
  assert.ok(Number(rc.actualCost.usd) > 0.0096 && Number(rc.actualCost.usd) < 0.0097, rc.actualCost.usd);
  assert.ok(BigInt(rc.charged.yocto) > 0n);
  assert.match(text(r), /The provider reported only \$0\.009 for this run, so you are charged the estimated cost/);
});

test("quotes are capped and stale unpaid quotes are pruned while the server runs", async () => {
  const w = await world();
  // cap: a second world with a cap of 2 open quotes
  const out = await mkdtemp(join(tmpdir(), "near-gate-cap-"));
  const chain = createFakeChain();
  chain.addAccount(MERCHANT, parseNearToYocto("10"), key.publicKey);
  const rpc = createNearRpc({ url: "https://rpc.fake", fetch: chain.fetch });
  let t = Date.now();
  const ledger = openNearLedger({ file: join(out, "s.json"), network: "testnet", merchant: MERCHANT, now: () => t });
  const refunder = createRefunder({ rpc, signer: parseNearSecretKey(key.secretKey), accountId: MERCHANT, ledger, schedule: () => null });
  const gate = createNearGate({
    merchantId: MERCHANT, network: "testnet", rpc, ledger, refunder, rate: createNearUsdRate({ staticUsd: "3.64" }),
    fetch: mock.fetch, maxOpenQuotes: 2, expiredRetainMs: 60_000, now: () => t,
  });
  const { callTool } = gate.wrapRegistry(w.registry);
  const q = (i) => callTool({ name: "run_noodle", arguments: { graph: WORKED_GRAPH, inputs: { Idea: "idea " + i } } });
  assert.ok(!(await q(1)).isError);
  assert.ok(!(await q(2)).isError);
  const busy = await q(3);
  assert.equal(busy.isError, true);
  assert.match(text(busy), /too many open quotes/);
  assert.equal(ledger.quotes().length, 2);
  // quotes expire (30 min by default) and, past the retention, are pruned on the next quote
  t += 30 * 60_000 + 60_000 + 61_000;
  assert.ok(!(await q(4)).isError);
  assert.deepEqual(ledger.quotes().map((x) => x.status), ["pending"]);
  // a stored quote keeps only what payment and settlement need
  const stored = ledger.quotes()[0];
  assert.equal(stored.pricing, undefined);
  assert.equal(typeof stored.estimatedCostUsd, "string");
});

test("NEAR price_noodle: an unpriced node makes safety.ok false; vision, modelOpts and live-priced models are refused", async () => {
  const w = await world();
  const noModel = await call(w, "price_noodle", { graph: { nodes: [{ id: "t", type: "text", name: "Idea", fields: { text: "hi" } }, { id: "l", type: "llm", fields: {} }], links: [{ from: { node: "t", port: "text" }, to: { node: "l", port: "prompt" } }] } });
  const s = noModel.structuredContent.pricing.safety;
  assert.equal(s.ok, false);
  assert.equal(s.refusals[0].code, "UNPRICED_NODE");
  assert.equal(s.refusals[0].message, 'node "LLM" (llm) has no model set; set fields.model to a chat model listed by noodle_guide');
  const vision = await call(w, "run_noodle", { graph: { nodes: [{ id: "v", type: "vision", fields: { model: "z-ai/glm-5.3-flash" } }], links: [] } });
  assert.equal(vision.isError, true);
  assert.equal(vision.structuredContent.refusals[0].code, "NODE_NOT_ALLOWED");
  const opts = await call(w, "run_noodle", { graph: { nodes: [{ id: "l", type: "llm", fields: { model: "z-ai/glm-5.3-flash", prompt: "hi", maxTokens: "abc" } }], links: [] } });
  assert.equal(opts.isError, true);
  assert.equal(opts.structuredContent.refusals[0].code, "BAD_FIELD");
  assert.equal(w.ledger.quotes().length, 0);
});

test("NEAR tool schemas describe what this server accepts (no media inputs, no short links)", async () => {
  const w = await world();
  for (const name of ["run_noodle", "price_noodle"]) {
    const t = w.listTools().find((x) => x.name === name);
    assert.match(t.inputSchema.properties.inputs.description, /accepts no media inputs/);
    assert.match(t.inputSchema.properties.url.description, /short links are refused here/);
  }
  const rn = w.listTools().find((x) => x.name === "run_noodle");
  assert.doesNotMatch(rn.description, /da\.gd|TinyURL|fragment-less short links trigger/);
});
