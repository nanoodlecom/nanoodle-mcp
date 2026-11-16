import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheck } from "../scripts/near-check.mjs";
import { createNearRpcPool, loadNearSigner, parseNearToYocto } from "../src/near/index.mjs";
import { generateNearKey, writeKeyFile, sendTransfer } from "../scripts/near-testnet-lib.mjs";
import { createFakeChain } from "./fixtures/near-fake-chain.mjs";
import { WORKFLOW_META_KEY } from "../src/workflow-progress.mjs";

// The boundary speaks real MCP/SSE and real signed NEAR RPC, without external funds.
async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "near-check-")), payer = "payer.testnet", merchant = "merchant.testnet";
  const key = generateNearKey(), merchantKey = generateNearKey(), keyFile = join(stateDir, "payer.json"), merchantFile = join(stateDir, "merchant.json");
  await writeKeyFile(keyFile, payer, key); await writeKeyFile(merchantFile, merchant, merchantKey);
  const signer = await loadNearSigner({ accountId: merchant, keyFile: merchantFile, env: {} });
  const chain = createFakeChain(); chain.addAccount(payer, parseNearToYocto("1"), key.publicKey); chain.addAccount(merchant, parseNearToYocto("10"), merchantKey.publicKey);
  const rpc = createNearRpcPool({ urls: ["http://chain.test"], chainId: "testnet", fetch: chain.fetch });
  const config = { stateDir, payer, merchant, keyFile, url: "http://mcp.test", network: "testnet", twoSteps: true };
  let day = Date.now(), result, quotes = 0, runs = 0;
  const change = {}, seen = [];
  const response = body => Response.json(body);
  const deps = { rpc, sleep: async () => {}, now: () => day, fetch: async (url, init) => {
    if (String(url).includes("/near/status/")) return response({ status: "paid" });
    if (String(url).includes("/near/result/")) return response(result);
    const req = JSON.parse(init.body); seen.push(req);
    const ok = value => response({ jsonrpc: "2.0", id: req.id, result: value });
    if (req.method === "initialize") return ok({ protocolVersion: "2025-06-18" });
    if (req.method === "tools/list") return ok({ tools: ["run_noodle", "price_noodle", "noodle_guide"].map(name => ({ name })) });
    if (req.params.name === "noodle_guide") return ok({ content: [{ type: "text", text: "guide" }] });
    if (req.params.name === "price_noodle") return ok({ structuredContent: { pricing: { safety: { ok: true }, estimatedCost: { usd: change.price ?? "0.0002" } } } });
    const args = req.params.arguments;
    if (!args._payment_id) {
      quotes++; result = null;
      return ok({ structuredContent: { payment: { status: "payment_required", paymentId: `nq_quote${quotes}`, network: change.network || "testnet", payTo: change.payTo || merchant,
        amountYocto: parseNearToYocto(change.deposit || "0.004").toString(), depositUsd: "0.01", expiresAt: new Date(day + 600_000).toISOString() } } });
    }
    assert.equal(args._payment_tx, undefined, "the canary must exercise discovery without hints");
    if (!result) {
      runs++;
      const state = JSON.parse(readFileSync(join(stateDir, "state.json")));
      const deposit = BigInt(state.quote.amountYocto), charged = parseNearToYocto("0.0001"), refunded = deposit - charged;
      const refund = await sendTransfer({ rpc, signer, signerId: merchant, receiverId: payer, amountYocto: refunded });
      result = { content: [{ type: "text", text: change.wrongOutput ? "wrong" : `Answer: NANOODLE_OK:${state.marker}` }], structuredContent: { receipt: {
        outcome: "succeeded", deposit: { yocto: deposit.toString(), txHash: state.signed.txHash }, charged: { yocto: charged.toString(), usd: "0.0003" },
        refund: { yocto: refunded.toString(), txHash: refund.txHash, to: change.wrongRefund ? merchant : payer, status: "sent" },
      } } };
    }
    if (new Headers(init.headers).get("accept") !== "text/event-stream") return ok(result);
    const workflow = { v: 1, status: "running", nodes: [{ id: "extract", status: "running" }], links: [] };
    const events = [change.noProgress ? null : { jsonrpc: "2.0", method: "notifications/progress", params: { _meta: { [WORKFLOW_META_KEY]: workflow } } }, { jsonrpc: "2.0", id: req.id, result }].filter(Boolean);
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } };
  return { config, deps, chain, change, seen, quotes: () => quotes, runs: () => runs, nextDay: () => { day += 86_400_000; } };
}

test("daily canary resumes an ambiguous broadcast, verifies the refund, and pays at most once per day", async () => {
  const f = await fixture(), send = f.deps.rpc.sendTx;
  let interrupted = false;
  f.deps.rpc.sendTx = async (...args) => { const tx = await send(...args); if (!interrupted) { interrupted = true; throw Error("connection lost after broadcast"); } return tx; };
  await assert.rejects(runCheck(f.config, f.deps), /interrupted/);
  assert.equal(f.chain.sendTxCount, 1, "the payment landed despite a lost response");
  const retained = JSON.parse(readFileSync(join(f.config.stateDir, "state.json")));
  const report = await runCheck(f.config, f.deps);
  assert.equal(report.ok, true); assert.equal(report.modelSteps, 2); assert.equal(f.quotes(), 1); assert.equal(f.runs(), 1);
  assert.equal(f.chain.sendTxCount, 2, "one deposit and one refund; no replacement deposit");
  assert.equal(report.paymentTx, retained.signed.txHash);
  assert.equal(statSync(join(f.config.stateDir, "state.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(f.config.stateDir, "latest.json"), "utf8"), /nq_quote|signedTxBase64|private_key/);
  assert.equal((await runCheck(f.config, f.deps)).reused, true);
  assert.equal(f.chain.sendTxCount, 2); assert.equal(f.runs(), 1);
  f.nextDay(); assert.equal((await runCheck(f.config, f.deps)).ok, true);
  assert.equal(f.chain.sendTxCount, 4); assert.equal(f.runs(), 2);
});

test("price, deposit, network and destination guards stop before any payment", async t => {
  for (const change of [{ price: "0.1" }, { deposit: "0.02" }, { network: "mainnet" }, { payTo: "other.testnet" }]) await t.test(JSON.stringify(change), async () => {
    const f = await fixture(); Object.assign(f.change, change);
    await assert.rejects(runCheck(f.config, f.deps));
    assert.equal(f.chain.sendTxCount, 0); assert.equal(f.runs(), 0);
  });
});

test("incorrect model output, missing live progress, and wrong refund recipient fail without repaying", async t => {
  for (const change of [{ wrongOutput: true }, { noProgress: true }, { wrongRefund: true }]) await t.test(JSON.stringify(change), async () => {
    const f = await fixture(); Object.assign(f.change, change);
    await assert.rejects(runCheck(f.config, f.deps));
    await assert.rejects(runCheck(f.config, f.deps));
    assert.equal(f.chain.sendTxCount, 2); assert.equal(f.runs(), 1); assert.equal(f.quotes(), 1);
    assert.equal(JSON.parse(readFileSync(join(f.config.stateDir, "latest.json"))).ok, false);
  });
});
