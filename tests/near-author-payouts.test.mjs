import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { deriveAddress, derivePublicKey, deriveSecretKey, hashBlock } from "nanocurrency";
import { freePort, mcpClient } from "../scripts/near-simulate.mjs";
import { loadTools, editorShareUrl } from "../src/tools.mjs";
import { createNearGate } from "../src/near-gate.mjs";
import { createAuthorPayouts, authorPayoutRaw } from "../src/author-payouts.mjs";
import { parseUsdNano } from "../src/gate.mjs";
import { createNearRpc, openNearLedger, createRefunder, parseNearSecretKey, parseNearToYocto } from "../src/near/index.mjs";
import { USDC_CONTRACTS, USDC_RATE } from "../src/near/ft.mjs";
import { createFakeChain, throwawayNearKey, WORKED_GRAPH, nanoGptMock } from "./fixtures/near-fake-chain.mjs";

const AUTHOR = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 1)), { useNanoPrefix: true });
const OTHER = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 2)), { useNanoPrefix: true });
const M = "merchant.testnet", P = "payer.testnet", TOKEN = USDC_CONTRACTS.testnet;
const GRAPH = { ...WORKED_GRAPH, x402: { author: AUTHOR } }, INPUTS = { Idea: "a lighthouse" };
let previousFetch, mock, key, graphs;
before(async () => {
  previousFetch = globalThis.fetch; mock = nanoGptMock(); globalThis.fetch = mock.fetch;
  key = await throwawayNearKey(); graphs = await mkdtemp(join(tmpdir(), "near-author-graphs-"));
  await writeFile(join(graphs, "poster.json"), JSON.stringify(GRAPH));
});
after(() => { globalThis.fetch = previousFetch; });

async function world({ wallet = true, xno = "0.50" } = {}) {
  const out = await mkdtemp(join(tmpdir(), "near-author-state-")), file = join(out, "state.json");
  const chain = createFakeChain(); chain.addAccount(M, parseNearToYocto("10"), key.publicKey); chain.addAccount(P, parseNearToYocto("5"));
  chain.addFt(TOKEN, { [M]: 0n, [P]: 10_000_000n });
  const rpc = createNearRpc({ url: "https://rpc.fake", fetch: chain.fetch });
  const registry = await loadTools({ dirs: [graphs], apiKey: "test-key", outDir: out, log: () => {} });
  const sends = [], published = new Set(); let unavailable = false, seq = 0, lockedXno = xno;
  const make = () => {
    const ledger = openNearLedger({ file, network: "testnet", merchant: M });
    const ops = { async transferOnce(to, amountRaw, { prepared, onPrepared }) {
      if (!prepared) { prepared = { hash: String(++seq).padStart(64, "0") }; onPrepared(prepared); }
      assert.ok(ledger.payouts().some(p => p.prepared?.hash === prepared.hash), "signed block must be durable before publishing");
      if (!published.has(prepared.hash)) { published.add(prepared.hash); sends.push({ to, amountRaw, hash: prepared.hash }); }
      if (unavailable) throw new Error("publish response was lost");
      return prepared.hash;
    } };
    const payouts = wallet ? createAuthorPayouts({ ledger, ops, schedule: () => null }) : null;
    const refunder = createRefunder({ rpc, signer: parseNearSecretKey(key.secretKey), accountId: M, ledger, usdcToken: TOKEN, schedule: () => null });
    let dust = 20;
    const gate = createNearGate({ merchantId: M, network: "testnet", rpc, ledger, refunder, usdcToken: TOKEN, usdcEnabled: true, authorPayouts: payouts,
      rate: { current: async () => ({ usdNano: 3_000_000_000n, yocto: 10n ** 24n, nearUsd: "3", source: "test", at: "test", xnoUsd: lockedXno }),
        currentUsdc: async () => ({ ...USDC_RATE, source: "USDC", at: "test", xnoUsd: lockedXno }) },
      fetch: mock.fetch, randomInt: () => dust++ });
    const wrapped = gate.wrapRegistry(registry);
    return { ledger, payouts, gate, call: (name, args) => wrapped.callTool({ name, arguments: args }) };
  };
  return { ...make(), make, registry, chain, sends, rate: value => { lockedXno = value; }, offline: value => { unavailable = value; } };
}

async function quoteAndPay(w, asset, name = "poster", args = INPUTS) {
  const quote = await w.call(name, { ...args, _pay_with: asset });
  assert.ok(!quote.isError, JSON.stringify(quote));
  const p = quote.structuredContent.payment;
  const tx = asset === "usdc" ? w.chain.ftTransfer(TOKEN, P, M, BigInt(p.amountAtomic)) : w.chain.transfer(P, M, BigInt(p.amountYocto));
  return { p, pay: () => w.call(name, { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: P }) };
}

for (const asset of ["near", "usdc"]) for (const name of ["poster", "run_noodle"]) {
  test(`${asset}: ${name} pays its author in Nano at the locked rate and replays without another send`, async () => {
    const w = await world(), args = name === "poster" ? INPUTS : { graph: GRAPH, inputs: INPUTS };
    const { p, pay } = await quoteAndPay(w, asset, name, args);
    assert.equal(p.authorPayout.to, AUTHOR); assert.equal(w.sends.length, 0);
    w.rate("1.00"); // Settlement must use the quote's rate, not this new rate.
    if (name === "poster") w.registry.tools[0].x402.author = OTHER;
    const result = await pay(); await w.payouts.tick();
    const receipt = (await pay()).structuredContent.receipt;
    assert.equal(receipt.authorPayout.asset, "XNO"); assert.equal(receipt.authorPayout.to, AUTHOR);
    assert.equal(receipt.authorPayout.status, "sent"); assert.equal(w.sends.length, 1);
    const q = w.ledger.getQuote(p.paymentId), s = q.settlement;
    assert.equal(BigInt(w.sends[0].amountRaw), authorPayoutRaw(s, q.rate, parseUsdNano("0.50")));
    assert.ok(BigInt(w.sends[0].amountRaw) > 0n);
    assert.equal(receipt.refund.status, "sent"); assert.equal(receipt.refund.to, P);
    assert.equal(receipt.legs[3].leg, "author payout");
    assert.match(result.content.map(c => c.text || "").join("\n"), /Leg 4, workflow author:/);
    const modelRuns = mock.runs(), refundSends = w.chain.sendTxCount;
    const restarted = w.make(); await restarted.gate.resume();
    assert.equal((await restarted.call(name, { ...args, _payment_id: p.paymentId })).structuredContent.receipt.authorPayout.status, "sent");
    assert.equal(w.sends.length, 1); assert.equal(mock.runs(), modelRuns); assert.equal(w.chain.sendTxCount, refundSends);
  });
}

test("lost Nano publish response does not delay change; restart retries the same signed block after quote pruning", async () => {
  const w = await world(); w.offline(true);
  const { p, pay } = await quoteAndPay(w, "usdc"); await pay(); await w.payouts.tick();
  const receipt = (await pay()).structuredContent.receipt;
  assert.equal(receipt.refund.status, "sent"); assert.equal(receipt.authorPayout.status, "pending");
  assert.equal(w.sends.length, 1);
  w.ledger.updateQuote(p.paymentId, { finishedAt: 1 }); w.ledger.prune();
  assert.equal(w.ledger.getQuote(p.paymentId), null); assert.equal(w.ledger.payouts().length, 1);
  w.offline(false); const restarted = w.make(); await restarted.gate.resume();
  assert.equal(restarted.ledger.getPayout(p.paymentId).status, "sent"); assert.equal(w.sends.length, 1);
});

test("recovery creates a missing payout intent from the durable settlement exactly once", async () => {
  const w = await world(), { p, pay } = await quoteAndPay(w, "near");
  w.payouts.enqueue = () => { throw new Error("stopped after settlement fsync"); };
  await assert.rejects(pay(), /stopped after settlement/);
  assert.ok(w.ledger.getQuote(p.paymentId).settlement.authorPayout); assert.equal(w.sends.length, 0);
  const restarted = w.make(); await restarted.gate.resume(); await restarted.payouts.tick();
  assert.equal(restarted.ledger.getQuote(p.paymentId).status, "settled");
  assert.equal(restarted.ledger.getPayout(p.paymentId).status, "sent"); assert.equal(w.sends.length, 1);
  await restarted.gate.resume(); assert.equal(w.sends.length, 1);
});

test("failed runs and model-cost overruns never pay the author", async () => {
  for (const failure of [true, false]) {
    const w = await world(), { p, pay } = await quoteAndPay(w, "usdc");
    const real = w.registry.callTool.bind(w.registry);
    w.registry.callTool = async (...args) => { if (failure) throw new Error("provider failed"); return { ...await real(...args), costUsd: 99 }; };
    const result = await pay(); await w.payouts.tick();
    assert.equal(w.sends.length, 0); assert.equal(w.ledger.payouts().length, 0);
    if (failure) assert.equal(result.structuredContent.receipt.refund.amountAtomic, p.amountAtomic);
    else assert.equal(result.structuredContent.receipt.charged.amountAtomic, p.amountAtomic);
  }
});

test("authored graphs require a payout wallet and rate before taking payment; invalid addresses are rejected", async () => {
  for (const options of [{ wallet: false }, { xno: null }]) {
    const w = await world(options), result = await w.call("poster", INPUTS);
    assert.equal(result.isError, true); assert.equal(w.ledger.quotes().length, 0);
  }
  const w = await world();
  await assert.rejects(w.call("run_noodle", { graph: { ...GRAPH, x402: { author: "nanoodle.near" } }, inputs: INPUTS }), /valid Nano address/);
  const result = await w.call("run_noodle", { graph: WORKED_GRAPH, inputs: INPUTS });
  assert.ok(!result.isError); assert.equal(result.structuredContent.payment.authorPayout, undefined);
});

test("creator fee conversion caps at remaining deposit and preserves atomic precision", () => {
  const rate = { usdNano: "1000000000", yocto: "1000000" }, xno = parseUsdNano("0.5");
  assert.equal(authorPayoutRaw({ costYocto: "1000000", feeYocto: "200000", chargedYocto: "1100000" }, rate, xno), 2n * 10n ** 29n);
  assert.equal(authorPayoutRaw({ costYocto: "100", feeYocto: "20", chargedYocto: "50" }, rate, xno), 0n);
  assert.equal(authorPayoutRaw({ costYocto: "5", feeYocto: "1", chargedYocto: "6" }, rate, xno), 2n * 10n ** 24n);
});

test("author metadata survives JSON-string graphs and editor share links", async () => {
  for (const graphArgs of [{ graph: JSON.stringify(GRAPH) }, { url: editorShareUrl(JSON.stringify(GRAPH)) }]) {
    const w = await world(), { pay } = await quoteAndPay(w, "usdc", "run_noodle", { ...graphArgs, inputs: INPUTS });
    await pay(); await w.payouts.tick();
    assert.equal(w.sends.length, 1); assert.equal(w.sends[0].to, AUTHOR);
  }
});

test("the real server pays saved and custom creators from one Nano queue when an API key funds models", { timeout: 30_000 }, async () => {
  globalThis.fetch = previousFetch;
  const out = await mkdtemp(join(tmpdir(), "near-author-bin-")), chain = createFakeChain(), provider = nanoGptMock();
  chain.addAccount(M, parseNearToYocto("10"), key.publicKey); chain.addAccount(P, parseNearToYocto("5"));
  chain.addFt(TOKEN, { [M]: 0n, [P]: 10_000_000n });
  const blocks = new Map(); let frontier = "B".repeat(64), balance = 5n * 10n ** 30n;
  const node = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); let answer;
    if (body.action === "account_info") answer = { frontier, balance: String(balance), representative: AUTHOR };
    else if (body.action === "receivable") answer = { blocks: "" };
    else if (body.action === "work_generate") answer = { work: "bbbbbbbbbbbbbbbb" };
    else if (body.action === "process") {
      const hash = hashBlock(body.block);
      if (blocks.has(hash)) answer = { error: "Old block" };
      else if (body.block.previous !== frontier) answer = { error: "Fork" };
      else { frontier = hash; balance = BigInt(body.block.balance); blocks.set(hash, body.block); answer = { hash }; }
    } else if (body.action === "block_info") answer = blocks.has(body.hash) ? { confirmed: "true" } : { error: "Block not found" };
    else answer = { error: "Unsupported stand-in request" };
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(answer));
  });
  let child, stderr = "";
  try {
    await chain.listen(); await provider.listen(); await new Promise(r => node.listen(0, "127.0.0.1", r));
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["bin/nanoodle-mcp.mjs", "--graphs", graphs, "--out", out, "--serve", `127.0.0.1:${port}`,
      "--public-url", base, "--near-merchant", M, "--near-network", "testnet", "--near-rpc", chain.url,
      "--near-usd", "3", "--xno-usd", "0.5", "--nano-rpc", `http://127.0.0.1:${node.address().port}`, "--no-local-work"],
    { env: { PATH: process.env.PATH, HOME: out, NANOGPT_API_KEY: "test-only", NANOGPT_BASE_URL: provider.url,
      NANO_SEED: "0".repeat(64), NEAR_PRIVATE_KEY: key.secretKey, NEAR_USDC: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", c => { stderr += c; });
    for (let i = 0; i < 300 && !stderr.includes("MCP over HTTP on"); i++) {
      assert.equal(child.exitCode, null, "server exited before listening"); await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(stderr.includes("MCP over HTTP on"), "server must start");
    const mcp = mcpClient(base);
    await Promise.all(["near", "usdc"].flatMap(asset => ["poster", "run_noodle"].map(async name => {
      const args = name === "poster" ? INPUTS : { graph: GRAPH, inputs: INPUTS };
      const quoted = await mcp.call(name, { ...args, _pay_with: asset });
      assert.ok(quoted.structuredContent?.payment, JSON.stringify(quoted));
      const p = quoted.structuredContent.payment;
      assert.equal(p.authorPayout.to, AUTHOR);
      const tx = asset === "usdc" ? chain.ftTransfer(TOKEN, P, M, BigInt(p.amountAtomic)) : chain.transfer(P, M, BigInt(p.amountYocto));
      const result = await mcp.call(name, { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: P });
      assert.equal(result.structuredContent.receipt.outcome, "succeeded");
      let receipt;
      for (let i = 0; i < 100; i++) {
        receipt = (await (await fetch(`${base}/near/status/${p.paymentId}`)).json()).receipt;
        if (receipt.authorPayout.status === "sent") break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.equal(receipt.authorPayout.status, "sent"); assert.equal(receipt.refund.status, "sent");
      assert.equal(receipt.legs[1].fundedBy, "api_key");
    })));
    assert.equal(blocks.size, 4, "four successful runs must make exactly four creator sends through the shared wallet");
    assert.ok([...blocks.values()].every(b => b.link_as_account === AUTHOR));
  } finally {
    globalThis.fetch = mock.fetch;
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await new Promise(r => child.once("exit", r)); }
    node.closeAllConnections?.(); await new Promise(r => node.close(r)); await chain.close(); await provider.close();
  }
});
