/**
 * scripts/near-pay.mjs run offline: the real server binary in NEAR mode and
 * the script's payer side against the chain stand-in. This is the script an
 * operator points at a live server (testnet or mainnet) to pay one real call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeChain, nanoGptMock, throwawayNearKey, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { startServer, freePort } from "../scripts/near-simulate.mjs";
import { MOCK_MODEL } from "../scripts/near-testnet-e2e.mjs";
import { runNearPay } from "../scripts/near-pay.mjs";
import { parseNearToYocto } from "../src/near/amount.mjs";

const MERCHANT = "merchant.testnet", PAYER = "payer.testnet";
const noSleep = async () => {};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "near-pay-"));
  const graphsDir = join(dir, "noodles"), outDir = join(dir, "out");
  await mkdir(graphsDir, { recursive: true });
  await writeFile(join(graphsDir, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
  const chain = createFakeChain();
  const mk = await throwawayNearKey(), pk = await throwawayNearKey();
  chain.addAccount(MERCHANT, parseNearToYocto("10"), mk.publicKey);
  chain.addAccount(PAYER, parseNearToYocto("5"), pk.publicKey);
  const nano = nanoGptMock();
  await chain.listen();
  await nano.listen();
  const pFile = join(dir, `${PAYER}.json`);
  await writeFile(pFile, JSON.stringify({ account_id: PAYER, public_key: pk.publicKey, private_key: pk.secretKey }), { mode: 0o600 });
  const port = await freePort();
  const srv = await startServer({ graphsDir, outDir, chainUrl: chain.url, nanoUrl: nano.url, secretKey: mk.secretKey, port });
  const base = `http://127.0.0.1:${port}`;
  const close = async () => { await srv.kill(); await chain.close(); await nano.close(); };
  return { chain, nano, pk, pFile, base, close };
}

async function pay(argv) {
  const lines = [];
  const code = await runNearPay(argv, { print: (l) => lines.push(String(l)), sleep: noSleep });
  return { code, out: lines.join("\n") };
}

test("near-pay: quote, pay, run, refund and on-chain checks all pass; the key is never printed", { timeout: 120_000 }, async () => {
  const s = await setup();
  try {
    const before = s.chain.balance(PAYER), runs = s.nano.runs();
    const common = ["--url", s.base + "/mcp", "--network", "testnet", "--rpc", s.chain.url, "--payer", PAYER, "--model", MOCK_MODEL];

    // --quote-only needs no key and moves nothing
    let r = await pay([...common, "--quote-only"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /quote only: no funds moved/);
    assert.equal(s.chain.balance(PAYER), before);

    r = await pay([...common, "--payer-key-file", s.pFile]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /^FAIL/m);
    assert.match(r.out, /PASS — \d+\/\d+ checks passed/);
    assert.match(r.out, /payment: https:\/\/testnet\.nearblocks\.io\/txns\//);
    assert.match(r.out, /refund: {2}https:\/\/testnet\.nearblocks\.io\/txns\//);
    assert.match(r.out, /Paid [\d.]+ NEAR, charged [\d.]+ NEAR.*, refunded [\d.]+ NEAR\./);
    assert.equal(s.nano.runs(), runs + 1, "the model ran exactly once");
    assert.ok(s.chain.balance(PAYER) < before);
    assert.ok(!r.out.includes(s.pk.secretKey), "the payer key is never printed");
  } finally { await s.close(); }
});

test("near-pay: refuses to send on the wrong network or above --max-near, and reports usage errors", { timeout: 120_000 }, async () => {
  const s = await setup();
  try {
    const before = s.chain.balance(PAYER);
    const common = ["--url", s.base, "--rpc", s.chain.url, "--payer", PAYER, "--payer-key-file", s.pFile, "--model", MOCK_MODEL];

    let r = await pay([...common, "--network", "mainnet"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}the quote is for mainnet — server says testnet/);
    assert.match(r.out, /nothing was sent/);

    r = await pay([...common, "--network", "testnet", "--max-near", "0.000001"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}the amount is within --max-near/);
    assert.equal(s.chain.balance(PAYER), before, "no funds moved in either refusal");

    assert.equal((await pay(["--url", s.base, "--payer", PAYER])).code, 2);
    assert.equal((await pay(["--url", s.base, "--network", "testnet", "--payer", PAYER])).code, 2); // no key, not quote-only
    assert.equal((await pay(["--network", "testnet", "--payer", PAYER, "--quote-only"])).code, 2);
  } finally { await s.close(); }
});
