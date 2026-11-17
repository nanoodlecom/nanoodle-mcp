import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAddress, deriveSecretKey, derivePublicKey } from "nanocurrency";
import { freePort } from "../scripts/near-simulate.mjs";
import { nanoNode } from "../scripts/dual-simulate.mjs";
import { createFakeChain, nanoGptMock, throwawayNearKey, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { callMcp } from "../src/near-site-browser.mjs";
import { USDC_CONTRACTS } from "../src/near/ft.mjs";

for (const optedIn of [true, false]) test(`hosted workflows: NEAR/USDC locks, execution, change and replay ${optedIn ? "with creator payout" : "without creator payout"}`, { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-e2e-")); await mkdir(join(dir, "graphs"));
  await writeFile(join(dir, "graphs", "poster.json"), JSON.stringify(WORKED_GRAPH));
  const chain = createFakeChain(), key = await throwawayNearKey(), provider = nanoGptMock(), node = await nanoNode();
  chain.addAccount("merchant.testnet", 10n ** 25n, key.publicKey); chain.addAccount("payer.testnet", 10n ** 25n);
  chain.addFt(USDC_CONTRACTS.testnet, { "merchant.testnet": 0n, "payer.testnet": 10_000_000n });
  await chain.listen(); await provider.listen();
  const port = await freePort(), base = `http://127.0.0.1:${port}`, author = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 2)), { useNanoPrefix: true });
  const policyFile = join(dir, "state-policy.json");
  if (optedIn) {
    await mkdir(join(dir, "out"));
    await writeFile(join(dir, "out", "near-state.json"), JSON.stringify({ v: 1, network: "testnet", merchant: "merchant.testnet", quotes: {}, consumedTx: {}, refunds: {}, payouts: {}, meta: {} }));
    await writeFile(policyFile, JSON.stringify({ v: 1, outDir: join(dir, "out"),
      nanoAddress: deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 0)), { useNanoPrefix: true }), chargeNano: false,
      near: { network: "testnet", merchant: "merchant.testnet" }, marketRoot: null, marketHandles: [] }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, [new URL("../bin/nanoodle-mcp.mjs", import.meta.url).pathname, "--graphs", join(dir, "graphs"), "--out", join(dir, "out"), "--serve", `127.0.0.1:${port}`, "--public-url", base,
    "--near-merchant", "merchant.testnet", "--near-network", "testnet", "--near-rpc", chain.url, "--near-usd", "3.64", "--xno-usd", "0.5", "--nano-rpc", node.url, "--no-local-work"], {
    env: { PATH: process.env.PATH, HOME: dir, NANOODLE_WRITER_LOCK_DIR: join(dir, "writer-locks"), NANOGPT_API_KEY: "test", NANOGPT_BASE_URL: provider.url, NEAR_PRIVATE_KEY: key.secretKey, NEAR_USDC: "1", NANO_SEED: "0".repeat(64), ...(optedIn ? { NANOODLE_STATE_POLICY: policyFile } : {}) }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  try {
    for (let i = 0; !stderr.includes("MCP over HTTP on"); i++) { assert.equal(child.exitCode, null, stderr); assert.ok(i < 500, stderr); await new Promise(r => setTimeout(r, 20)); }
    if (optedIn) assert.match(stderr, /required payment state verified \(1 files\)/);
    const response = await fetch(base + "/creators/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ graph: { ...WORKED_GRAPH, ...(optedIn ? { x402: { author } } : {}) }, name: "Hosted poster", description: "Make a poster" }) });
    assert.equal(response.status, 201); const hosted = await response.json(), snapshots = [];
    const request = (name, args, opts) => callMcp(name, args, { endpoint: hosted.mcpUrl, ...opts });
    const price = await request("price_workflow", { Idea: "a lighthouse" }); assert.ok(price.structuredContent.pricing); assert.equal(provider.runs(), 0);
    assert.ok(!JSON.stringify(price).includes("Write one vivid image prompt"));
    for (const asset of ["near", "usdc"]) {
      const args = { Idea: "A lighthouse at dawn", _pay_with: asset }, quote = await request("run_workflow", args), payment = quote.structuredContent.payment;
      assert.equal(provider.runs(), asset === "near" ? 0 : 1, "quote cannot execute a model before payment");
      assert.ok(BigInt(payment.amountAtomic || payment.amountYocto) > 0n);
      assert.equal(!!payment.authorPayout, optedIn);
      if (asset === "near") chain.transfer("payer.testnet", "merchant.testnet", BigInt(payment.amountYocto), { blockTimeMs: Date.now() + 1 });
      else chain.ftTransfer(USDC_CONTRACTS.testnet, "payer.testnet", "merchant.testnet", BigInt(payment.amountAtomic), { blockTimeMs: Date.now() + 1 });
      const paid = await (await fetch(payment.statusUrl + "?wait=1")).json(); assert.equal(paid.status, "paid"); assert.equal(paid.tool, "run_workflow"); assert.match(paid.next, /Call run_workflow/);
      // Two subscribers can resume the same quote; the shared gate executes it once.
      const results = await Promise.all([request("run_workflow", { ...args, _payment_id: payment.paymentId }, { onWorkflow: state => snapshots.push(state) }), request("run_workflow", { ...args, _payment_id: payment.paymentId })]);
      for (const result of results) { assert.equal(result.structuredContent.receipt.outcome, "succeeded"); if (optedIn) assert.equal(result.structuredContent.receipt.authorPayout.to, author);
        else assert.equal(result.structuredContent.receipt.authorPayout, undefined);
        const receipt = result.structuredContent.receipt;
        assert.equal(receipt.refund.to, "payer.testnet"); assert.equal(receipt.refund.status, "sent");
        if (asset === "usdc") { assert.equal(receipt.asset, "USDC"); assert.equal(BigInt(receipt.deposit.amountAtomic)-BigInt(receipt.refund.amountAtomic), BigInt(receipt.charged.amountAtomic)); } }
      const saved = await (await fetch(`${base}/near/result/${payment.paymentId}`)).json(); assert.equal(saved.structuredContent.receipt.outcome, "succeeded");
    }
    assert.equal(provider.runs(), 2); assert.ok(snapshots.some(s => s.nodes.some(n => n.status === "running"))); assert.ok(snapshots.some(s => s.finishedAt));
  } finally { child.kill("SIGKILL"); await chain.close(); await provider.close(); await node.close(); }
});
