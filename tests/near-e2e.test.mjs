/**
 * End to end: the real server binary in NEAR mode, driven over MCP-over-HTTP,
 * against the local NEAR chain and NanoGPT stand-ins in
 * tests/fixtures/near-fake-chain.mjs. The full agent conversation (and its
 * refusal, replay and restart paths) is scripts/near-simulate.mjs, run here
 * silently; the remaining tests cover startup configuration. Offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, startServer, mcpClient, freePort } from "../scripts/near-simulate.mjs";
import { runDualSimulation } from "../scripts/dual-simulate.mjs";
import { createFakeChain, throwawayNearKey, nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { parseNearToYocto } from "../src/near/amount.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle-mcp.mjs");

test("the simulated agent conversation passes every check (quote, pay, receipt, replay, refusals, restarts, balances)", { timeout: 120_000 }, async () => {
  const lines = [];
  const { failures, checks, facts } = await runSimulation({ print: (l) => lines.push(l) });
  assert.deepEqual(failures, [], lines.join("\n"));
  assert.ok(checks >= 35, `ran ${checks} checks`);
  assert.equal(facts.receipt.charged.yocto, "3102197802197802197803");
  assert.equal(facts.receipt.outcome, "succeeded");
  assert.match(lines.join("\n"), /PASS: all \d+ checks passed/);
});

test("one server, both rails: Nano and NEAR quotes for one tool, a NEAR-paid custom graph, /rates refresh and SIGHUP reload", { timeout: 120_000 }, async () => {
  const lines = [];
  const { failures, checks } = await runDualSimulation({ print: (l) => lines.push(l) });
  assert.deepEqual(failures, [], lines.join("\n"));
  assert.ok(checks >= 20, `ran ${checks} checks`);
});

async function fixtureDirs() {
  const work = await mkdtemp(join(tmpdir(), "near-e2e-"));
  const graphsDir = join(work, "noodles"), outDir = join(work, "out");
  await mkdir(graphsDir, { recursive: true });
  await writeFile(join(graphsDir, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
  return { graphsDir, outDir };
}

/** Run the bin to completion (for configurations it must refuse). */
function runBin(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, NANOGPT_API_KEY: "test-key", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += c; });
    const t = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
}

test("NEAR mode serves llms.txt and the landing page with the NEAR payment note", { timeout: 60_000 }, async () => {
  const { graphsDir, outDir } = await fixtureDirs();
  const chain = createFakeChain();
  const key = await throwawayNearKey();
  chain.addAccount("merchant.testnet", parseNearToYocto("1"), key.publicKey);
  const nano = nanoGptMock();
  await chain.listen();
  await nano.listen();
  const port = await freePort();
  const srv = await startServer({ graphsDir, outDir, chainUrl: chain.url, nanoUrl: nano.url, secretKey: key.secretKey, port });
  try {
    const base = `http://127.0.0.1:${port}`;
    const llms = await (await fetch(base + "/llms.txt")).text();
    assert.match(llms, /## Payment\n\nEvery call is paid in native NEAR on testnet/);
    assert.doesNotMatch(llms, /Payment \(x402, Nano\/XNO\)/, "no Nano payment story on a NEAR server");
    const landing = await (await fetch(base + "/")).text();
    assert.match(landing, /paid in native NEAR on testnet/);
    const tools = await mcpClient(base).list();
    assert.ok(tools.some((t) => t.name === "price_noodle"));
    assert.doesNotMatch(srv.stderr, new RegExp(key.secretKey.slice(8, 30)), "the key is never logged");
  } finally {
    await srv.kill();
    await chain.close();
    await nano.close();
  }
});

test("NEAR mode refuses unsafe configurations at startup", { timeout: 60_000 }, async () => {
  const { graphsDir, outDir } = await fixtureDirs();
  const key = await throwawayNearKey();
  const base = ["--graphs", graphsDir, "--out", outDir];

  let r = await runBin([...base, "--near-merchant", "merchant.testnet"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--near-merchant only makes sense with --serve/);

  // Both rails together are allowed (one server, Nano or NEAR per call), but the Nano rail still needs its wallet.
  r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet", "--charge-usd", "0.05"]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /pick one/);
  assert.match(r.stderr, /--charge-usd needs a Nano wallet/);

  for (const [flag, v, msg] of [
    ["--near-swap-spread-bps", "2001", /swap spread must be a whole number of basis points from 0 to 2000/],
    ["--near-quote-ttl-min", "0", /--near-quote-ttl-min expects a whole number of minutes from 1 to 120/],
    ["--near-quote-ttl-min", "121", /--near-quote-ttl-min expects/],
    ["--near-rates-refresh-s", "-1", /--near-rates-refresh-s expects/],
  ]) {
    r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet", flag, v], { NEAR_PRIVATE_KEY: key.secretKey });
    assert.equal(r.code, 1, flag);
    assert.match(r.stderr, msg, flag);
  }
  r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-swap-spread-bps", "100"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the --near-\* options need --near-merchant/);

  r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet", "--near-key", "ed25519:abc"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not accepted: a key on the command line/);

  r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet"], { NANOGPT_API_KEY: "" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /needs a NanoGPT funding source/);

  // RPC on the wrong network, and a key that is not the merchant's
  const mainnet = createFakeChain({ chainId: "mainnet" });
  await mainnet.listen();
  const testnet = createFakeChain();
  testnet.addAccount("merchant.testnet", 1n); // no access key for our throwaway key
  await testnet.listen();
  try {
    r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet", "--near-rpc", mainnet.url], { NEAR_PRIVATE_KEY: key.secretKey });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is on "mainnet", not testnet/);
    assert.ok(!r.stderr.includes(key.secretKey), "the secret key is never printed");

    r = await runBin([...base, "--serve", "127.0.0.1:1", "--near-merchant", "merchant.testnet", "--near-rpc", testnet.url], { NEAR_PRIVATE_KEY: key.secretKey });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not an access key of merchant\.testnet on testnet/);
    assert.ok(!r.stderr.includes(key.secretKey));
  } finally {
    await mainnet.close();
    await testnet.close();
  }
});
