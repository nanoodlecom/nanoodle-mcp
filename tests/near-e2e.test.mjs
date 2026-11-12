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
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, startServer, mcpClient, freePort } from "../scripts/near-simulate.mjs";
import { runDualSimulation, nanoNode } from "../scripts/dual-simulate.mjs";
import { randomBytes } from "node:crypto";
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

/** Start the bin with both rails and wait until it serves; resolves { stderr(), kill }. */
async function startDual({ graphsDir, outDir, port, nearRpc, nanoRpc, nanoUrl, secretKey, nearPort }) {
  const child = spawn(process.execPath, [
    BIN, "--graphs", graphsDir, "--out", outDir, "--serve", `127.0.0.1:${port}`,
    "--charge-usd", "0.05", "--nano-rpc", nanoRpc, "--no-local-work", "--near-usd", "3.64",
    "--near-merchant", "merchant.testnet", "--near-network", "testnet", "--near-rpc", nearRpc,
    ...(nearPort ? ["--near-serve", `127.0.0.1:${nearPort}`, "--near-public-url", `http://127.0.0.1:${nearPort}`] : []),
  ], {
    env: { PATH: process.env.PATH, HOME: outDir, NANOGPT_API_KEY: "test-key", NANOGPT_BASE_URL: nanoUrl, NANO_SEED: randomBytes(32).toString("hex"), NEAR_PRIVATE_KEY: secretKey },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const t0 = Date.now();
  while (!/MCP over HTTP on/.test(stderr)) {
    if (child.exitCode !== null) throw new Error("server exited during startup:\n" + stderr);
    if (Date.now() - t0 > 30_000) { child.kill("SIGKILL"); throw new Error("server did not start:\n" + stderr); }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { stderr: () => stderr, kill: () => new Promise((r) => { child.once("exit", r); child.kill("SIGKILL"); }) };
}

test("NEAR hostname shares one process: wallet page, confirmation, monitor, automatic resume and native change", { timeout: 60_000 }, async () => {
  const { graphsDir, outDir } = await fixtureDirs();
  const chain = createFakeChain();
  const key = await throwawayNearKey();
  chain.addAccount("merchant.testnet", parseNearToYocto("1"), key.publicKey);
  chain.addAccount("payer.testnet", parseNearToYocto("2"));
  const nano = nanoGptMock();
  await chain.listen();
  await nano.listen();
  const node = await nanoNode();
  const port = await freePort(), nearPort = await freePort();
  const srv = await startDual({ graphsDir, outDir, port, nearPort, nearRpc: chain.url, nanoRpc: node.url, nanoUrl: nano.url, secretKey: key.secretKey });
  const base = `http://127.0.0.1:${nearPort}`;
  try {
    assert.match(srv.stderr(), /shared Nano funding pool/);
    const mcp = mcpClient(base);
    const tools = await mcp.list();
    assert.ok(tools.some((t) => t.name === "run_noodle"));
    const args = { graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse at dawn" } };
    const q = await mcp.call("run_noodle", args);
    const p = q.structuredContent.payment;
    assert.equal(p.rail, "near");
    assert.equal(p.payUrl, `${base}/pay/${p.paymentId}`);
    const page = await fetch(p.payUrl);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(await page.text(), /Connect wallet &amp; pay/);
    assert.equal((await fetch(base + "/near-wallet.js")).status, 200);
    assert.match(await (await fetch(base + "/")).text(), /AI workflows, paid in NEAR/);
    assert.match(await (await fetch(base + "/llms.txt")).text(), /No transaction hash needs to be copied/);
    const txHash = chain.transfer("payer.testnet", "merchant.testnet", BigInt(p.amountYocto));
    const submit = (body, headers = {}) => fetch(`${base}/near/pay/${p.paymentId}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await submit({ txHash, senderId: "payer.testnet" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await submit([])).status, 400);
    const watched = await fetch(p.watchUrl);
    const frames = watched.text();
    const confirmed = await submit({ txHash, senderId: "payer.testnet" });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).status, "paid");
    const stream = await frames;
    assert.match(stream, /"status":"pending"/);
    assert.match(stream, /"status":"paid"/);
    assert.match(stream, /"done":true/);
    const result = await mcp.call("run_noodle", { ...args, _payment_id: p.paymentId });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.receipt.refund.status, "sent");
    assert.equal(result.structuredContent.receipt.refund.to, "payer.testnet");
    const after = await (await fetch(p.statusUrl)).json();
    assert.equal(after.status, "settled");
    assert.equal(after.receipt.outcome, "succeeded");
    // The original hostname's default remains Nano in the same running process.
    const nanoQ = await mcpClient(`http://127.0.0.1:${port}`).call("idea-poster", { Idea: "another lighthouse" });
    assert.match(nanoQ.structuredContent.x402.paymentId, /^pay_/);
  } finally {
    await srv.kill(); await chain.close(); await nano.close(); await node.close();
  }
});

test("a busy secondary port leaves the primary paid MCP listener serving", { timeout: 60_000 }, async () => {
  const { graphsDir, outDir } = await fixtureDirs();
  const chain = createFakeChain();
  const key = await throwawayNearKey();
  chain.addAccount("merchant.testnet", parseNearToYocto("1"), key.publicKey);
  const nano = nanoGptMock();
  await chain.listen(); await nano.listen();
  const node = await nanoNode();
  const occupied = http.createServer((req, res) => res.end("another service"));
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  const srv = await startDual({ graphsDir, outDir, port, nearPort: occupied.address().port, nearRpc: chain.url, nanoRpc: node.url, nanoUrl: nano.url, secretKey: key.secretKey });
  try {
    assert.match(srv.stderr(), /NEAR endpoint .*could not listen.*EADDRINUSE/);
    assert.match(srv.stderr(), /primary MCP listener remains available/);
    const q = await mcpClient(`http://127.0.0.1:${port}`).call("idea-poster", { Idea: "a lighthouse" });
    assert.match(q.structuredContent.x402.paymentId, /^pay_/);
  } finally {
    await srv.kill(); await chain.close(); await nano.close(); await node.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("both rails: a dead first NEAR RPC fails over; a broken NEAR setup leaves Nano serving with NEAR off", { timeout: 90_000 }, async () => {
  const { graphsDir, outDir } = await fixtureDirs();
  const chain = createFakeChain();
  const key = await throwawayNearKey();
  chain.addAccount("merchant.testnet", parseNearToYocto("1"), key.publicKey);
  const nano = nanoGptMock();
  await chain.listen();
  await nano.listen();
  const node = await nanoNode();
  const dead = `http://127.0.0.1:${await freePort()}`; // nothing listens here
  try {
    // 1. first endpoint refuses connections, second is fine → NEAR is on
    let port = await freePort();
    let srv = await startDual({ graphsDir, outDir, port, nearRpc: `${dead},${chain.url}`, nanoRpc: node.url, nanoUrl: nano.url, secretKey: key.secretKey });
    try {
      assert.match(srv.stderr(), /failed \(RPC_HTTP\); trying the next endpoint/);
      assert.match(srv.stderr(), /paid in Nano \(XNO to nano_\w+\) or in NEAR on testnet to merchant\.testnet/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/rates`)).status, 200);
    } finally { await srv.kill(); }

    // 2. the key is not the merchant's → NEAR off, Nano still serves every saved tool
    const other = await throwawayNearKey();
    port = await freePort();
    const disabledNearPort = await freePort();
    srv = await startDual({ graphsDir, outDir, port, nearPort: disabledNearPort, nearRpc: chain.url, nanoRpc: node.url, nanoUrl: nano.url, secretKey: other.secretKey });
    try {
      assert.match(srv.stderr(), /NEAR PAYMENTS ARE OFF — the refund key ed25519:\w+ is not an access key of merchant\.testnet/);
      assert.match(srv.stderr(), /the Nano rail is serving normally/);
      assert.ok(!srv.stderr().includes(other.secretKey), "the secret key is never printed");
      assert.doesNotMatch(srv.stderr(), /or in NEAR on/);
      const mcp = mcpClient(`http://127.0.0.1:${port}`);
      await mcp.initialize();
      const names = (await mcp.list()).map((t) => t.name);
      assert.ok(names.includes("idea_poster") || names.length >= 1, `tools listed: ${names}`);
      assert.ok(!names.includes("price_noodle"), "NEAR-only tools are not offered while NEAR is off");
      assert.equal((await fetch(`http://127.0.0.1:${port}/rates`)).status, 404);
      const disabledNear = mcpClient(`http://127.0.0.1:${disabledNearPort}`);
      assert.deepEqual(await disabledNear.list(), [], "unavailable NEAR endpoint must expose no runnable workflows");
      assert.equal((await disabledNear.call("run_noodle", { graph: WORKED_GRAPH })).isError, true, "NEAR failure must not make workflow execution free");
    } finally { await srv.kill(); }
  } finally {
    await chain.close();
    await nano.close();
    await node.close();
  }
});
