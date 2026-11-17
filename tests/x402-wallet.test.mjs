/**
 * Wallet mode (accountless x402): unit tests for the Nano payer against a
 * stubbed RPC, plus a full E2E — the real server, keyless, settles a staged
 * HTTP 402 by "sending" XNO to a local Nano RPC stub. Fully offline.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAddress, derivePublicKey, deriveSecretKey, verifyBlock, hashBlock, createBlock } from "nanocurrency";
import { createMaintenanceBarrier } from "../src/maintenance.mjs";
import { createNanoWallet, resolveWalletKey, DEFAULT_NANO_RPC } from "../src/wallet.mjs";
import { createFakeChain, nanoGptMock, throwawayNearKey, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { USDC_CONTRACTS, parseNearToYocto } from "../src/near/index.mjs";
import { mcpClient, freePort, stopServerChild } from "../scripts/near-simulate.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "nanoodle-mcp.mjs");
const FIXTURES = join(here, "fixtures");

/* Zero seed — documented Nano test vector. Account 0 pays; account 1 receives. */
const SEED = "0".repeat(64);
const SECRET = deriveSecretKey(SEED, 0);
const ADDRESS = deriveAddress(derivePublicKey(SECRET), { useNanoPrefix: true });
const PAY_TO = deriveAddress(derivePublicKey(deriveSecretKey(SEED, 1)), { useNanoPrefix: true });

const FRONTIER = "B".repeat(64);
const BALANCE = "5000000000000000000000000000000"; // 5 XNO in raw
const AMOUNT = "1230000000000000000000000000";     // 0.00123 XNO
const WORK = "bbbbbbbbbbbbbbbb";

test("hosted wallet funding runs Nano, NEAR and USDC saved/custom graphs through the actual server", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "hosted-wallet-funding-"));
  const graphs = join(dir, "graphs"), out = join(dir, "out");
  await mkdir(graphs); await mkdir(out);
  const graph = structuredClone(WORKED_GRAPH);
  delete graph.nodes.find(n => n.type === "llm").fields.maxTokens;
  graph.x402 = { author: PAY_TO };
  await writeFile(join(graphs, "poster.json"), JSON.stringify(graph));
  const deposits = new Map(), providerBlocks = new Set();
  let frozenReads = 0, frozenPublishes = 0;
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => {
      const received = new Set(state.processed.filter(p => p.subtype === "receive").map(p => p.block.link.toUpperCase()));
      const pending = [...deposits].filter(([h]) => !received.has(h)).reduce((n, [, value]) => n + BigInt(value.amount), 0n);
      return reply(nanoAccountInfo({ frontier: state.frontier, balance: state.balance, representative: ADDRESS, height: state.processed.length + 1, pending: pending.toString() }));
    },
    receivable: (_b, state, reply) => {
      const received = new Set(state.processed.filter(p => p.subtype === "receive").map(p => p.block.link.toUpperCase()));
      return reply({ blocks: Object.fromEntries([...deposits].filter(([hash]) => !received.has(hash))) });
    },
    account_history: (_b, state, reply) => reply({ history: state.processed.filter(p => p.subtype === "receive").map(p => ({
      type: "receive", hash: hashBlock(p.block), account: PAY_TO, amount: deposits.get(p.block.link.toUpperCase()).amount, confirmed: "true",
    })) }),
    block_info: (body, state, reply) => {
      const p = state.processed.find(p => hashBlock(p.block) === body.hash);
      return p ? reply({ confirmed: "true", contents: p.block, height: String(state.processed.indexOf(p) + 2) }) : reply({ error: "Block not found" });
    },
  });
  const rpcServer = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const rawBody = Buffer.concat(chunks).toString(), body = JSON.parse(rawBody);
    if (req.url === "/frozen") {
      const answer = body.action === "account_info" ? nanoAccountInfo({ frontier: FRONTIER, balance: BALANCE, representative: ADDRESS, height: 1 })
        : body.action === "receivable" ? { blocks: "" }
        : body.action === "account_history" ? { history: [] }
        : body.action === "work_generate" ? { work: WORK }
        : body.action === "block_info" && body.hash === NANO_GENESIS_HASH ? NANO_GENESIS_REPLY
        : { error: "Block not found" };
      if (body.action === "process") frozenPublishes++; else frozenReads++;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(answer)); return;
    }
    const reply = await rpc.fetch("http://fixture.rpc", { body: rawBody });
    res.writeHead(reply.status, { "content-type": "application/json" }); res.end(await reply.text());
  });
  const near = createFakeChain(), key = await throwawayNearKey();
  near.addAccount("merchant.testnet", parseNearToYocto("10"), key.publicKey);
  near.addAccount("payer.testnet", parseNearToYocto("5"));
  near.addFt(USDC_CONTRACTS.testnet, { "merchant.testnet": 0n, "payer.testnet": 1_000_000n });
  const nano = nanoGptMock({ walletPayments: true, walletPaymentSeen(invoice) {
    let previous = BigInt(BALANCE);
    for (const p of rpc.state.processed) {
      const amount = previous - BigInt(p.block.balance); previous = BigInt(p.block.balance);
      const hash = hashBlock(p.block);
      if (p.subtype === "send" && p.block.link_as_account === "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet"
        && amount === BigInt(invoice.amountRaw) && !providerBlocks.has(hash)) {
        providerBlocks.add(hash); return true;
      }
    }
    return false;
  } });
  let child, stderr = "";
  try {
    await new Promise(resolve => rpcServer.listen(0, "127.0.0.1", resolve));
    await near.listen(); await nano.listen();
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [BIN, "--graphs", graphs, "--out", out, "--serve", `127.0.0.1:${port}`, "--public-url", base,
      "--charge-usd", "0.05", "--xno-usd", "0.5", "--no-local-work", "--near-merchant", "merchant.testnet", "--near-network", "testnet",
      "--near-rpc", near.url, "--near-usd", "3.64"], { env: {
        PATH: process.env.PATH, HOME: dir, NANOODLE_WRITER_LOCK_DIR: join(dir, "writer-locks"), NANO_SEED: SEED, NANO_RPC_URL: ["frozen", "fresh-a", "fresh-b"].map(p => `http://127.0.0.1:${rpcServer.address().port}/${p}`).join(","),
        NANOGPT_BASE_URL: nano.url, NEAR_PRIVATE_KEY: key.secretKey, NEAR_USDC: "1", NANOODLE_RUN_TIMEOUT_MS: "2000",
      }, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", part => { stderr += part; });
    const started = Date.now();
    while (!stderr.includes("MCP over HTTP on")) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() - started > 20_000) throw Error(`fixture startup failed: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const client = mcpClient(base); await client.initialize();
    const health = await (await fetch(base + "/near/health")).json();
    assert.equal(health.funding.enforced, true); assert.equal(health.funding.ok, true);
    near.accounts.get("merchant.testnet").balance = 0n;
    for (const asset of ["near", "usdc"]) {
      const refused = await client.call("run_noodle", { graph, inputs: { Idea: "no refund gas" }, _pay_with: asset });
      assert.equal(refused.isError, true); assert.equal(refused.structuredContent?.payment, undefined);
      assert.equal(providerBlocks.size, 0, "gas refusal must not pay a model invoice");
    }
    near.accounts.get("merchant.testnet").balance = parseNearToYocto("10");
    for (const [asset, name] of [["nano", "poster"], ["near", "poster"], ["near", "run_noodle"], ["usdc", "run_noodle"]]) {
      const args = name === "run_noodle" ? { graph, inputs: { Idea: "a lighthouse" }, _pay_with: asset }
        : { Idea: "a lighthouse", ...(asset === "nano" ? {} : { _pay_with: asset }) };
      const quote = await client.call(name, args);
      assert.ok(!quote.isError, JSON.stringify(quote));
      if (asset === "nano") {
        const p = quote.structuredContent.x402;
        deposits.set("C".repeat(64), { amount: p.amountRaw, source: PAY_TO });
        const result = await client.call(name, { ...args, _payment_id: p.paymentId });
        assert.ok(!result.isError, JSON.stringify(result));
      } else {
        const p = quote.structuredContent.payment;
        const tx = asset === "usdc" ? near.ftTransfer(USDC_CONTRACTS.testnet, "payer.testnet", "merchant.testnet", BigInt(p.amountAtomic))
          : near.transfer("payer.testnet", "merchant.testnet", BigInt(p.amountYocto));
        if (asset === "usdc") {
          const held = near.accounts.get("merchant.testnet").balance, invoices = providerBlocks.size;
          near.accounts.get("merchant.testnet").balance = 0n;
          const paused = await client.call(name, { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: "payer.testnet" });
          assert.equal(paused.isError, true); assert.match(JSON.stringify(paused), /same payment id/);
          assert.equal(providerBlocks.size, invoices, "a verified USDC deposit cannot start inference without native refund gas");
          near.accounts.get("merchant.testnet").balance = held;
        }
        const result = await client.call(name, { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: "payer.testnet" });
        assert.equal(result.structuredContent?.receipt?.outcome, "succeeded", JSON.stringify(result));
      }
    }
    assert.equal(providerBlocks.size, 8, "four workflows each pay exactly two provider invoices");
    assert.ok(nano.chatBodies().every(body => body.max_tokens > 0), "funded saved and custom graphs send their priced token limits");
    for (const asset of ["nano", "near", "usdc"]) {
      const name = asset === "nano" ? "poster" : "run_noodle";
      const args = asset === "nano" ? { Idea: "HOLD" } : { graph, inputs: { Idea: "HOLD" }, _pay_with: asset };
      const quote = await client.call(name, args);
      assert.ok(!quote.isError, JSON.stringify(quote));
      let paidArgs;
      if (asset === "nano") {
        const p = quote.structuredContent.x402;
        deposits.set("D".repeat(64), { amount: p.amountRaw, source: PAY_TO });
        paidArgs = { ...args, _payment_id: p.paymentId };
      } else {
        const p = quote.structuredContent.payment;
        const tx = asset === "usdc" ? near.ftTransfer(USDC_CONTRACTS.testnet, "payer.testnet", "merchant.testnet", BigInt(p.amountAtomic))
          : near.transfer("payer.testnet", "merchant.testnet", BigInt(p.amountYocto));
        paidArgs = { ...args, _payment_id: p.paymentId, _payment_tx: tx, _payment_sender: "payer.testnet" };
      }
      const result = await client.call(name, paidArgs);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), /hosted execution limit/);
      if (asset !== "nano") {
        const r = result.structuredContent.receipt;
        assert.equal(r.outcome, "run_failed"); assert.equal(r.refund.status, "sent");
        assert.equal(r.charged.usd, "0");
        assert.equal(r.refund.amountAtomic ?? r.refund.yocto, r.deposit.amountAtomic ?? r.deposit.yocto);
      } else assert.match(JSON.stringify(result), /was refunded/);
      const count = providerBlocks.size;
      assert.equal((await client.call(name, paidArgs)).isError, true);
      assert.equal(providerBlocks.size, count, "replaying a timed-out payment cannot pay another invoice");
    }
    assert.equal(providerBlocks.size, 11, "each failed run pays at most its one started invoice and no downstream image");
    assert.ok(frozenReads > 0, "the preferred stale peer really answered the scanner and reconciliation reads");
    assert.equal(frozenPublishes, 0, "new sends use the current observed peers rather than the frozen first entry");
    assert.doesNotMatch(stderr, /unhandled|FUNDING_INVALID|cannot persist gate state/i);
  } finally {
    if (child) await stopServerChild(child);
    await near.close?.(); await nano.close?.();
    rpcServer.closeAllConnections();
    if (rpcServer.listening) await new Promise(resolve => rpcServer.close(resolve));
  }
});

test("one wallet enforces a cumulative budget across parallel provider invoices", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, requireFunding: true });
  await wallet.ops.withFunding({ id: "paid-run", maxRaw: BigInt(AMOUNT) * 2n, maxUsd: 0.2 }, async () => {
    const results = await Promise.allSettled([1, 2, 3].map(n => wallet.payment({ paymentId: `invoice-${n}`, payTo: PAY_TO, amountRaw: AMOUNT, amountUsd: 0.1 })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
    assert.equal(results.find(r => r.status === "rejected").reason.code, "FUNDING_OVER_BUDGET");
  });
  assert.equal(mock.state.processed.length, 2);
  assert.equal(BigInt(mock.state.balance), BigInt(BALANCE) - BigInt(AMOUNT) * 2n);
  assert.deepEqual(wallet.ops.fundingStatus(), { activeRuns: 0, reservedRaw: "0" });
  await assert.rejects(wallet.payment({ payTo: PAY_TO, amountRaw: AMOUNT }), { code: "FUNDING_REQUIRED" });
});

test("hosted funding observations refresh the read pool without signing, work or inference", async () => {
  let at = 1_000, height = 1, reads = 0;
  const mock = fakeRpc({ account_info: (_body, state, reply) => {
    reads++; return reply(nanoAccountInfo({ frontier: state.frontier, balance: state.balance, representative: ADDRESS, height }));
  } });
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "https://peer-a,https://peer-b", fetch: mock.fetch,
    verifyRpcReads: true, protectTransfers: true, requireFunding: true, now: () => at });
  const first = await wallet.ops.fundingReport();
  assert.equal(first.nanoRpc.readablePeers, 2); assert.equal(first.nanoRpc.networkPeers, 2);
  assert.equal(reads, 2);
  await wallet.ops.fundingReport(); assert.equal(reads, 2, "bounded cache avoids hammering the peers");
  height++; mock.state.frontier = "C".repeat(64); mock.state.balance = String(BigInt(BALANCE) - 1n); at += 30_001;
  const refreshed = await wallet.ops.fundingReport();
  assert.equal(refreshed.balanceRaw, mock.state.balance); assert.equal(reads, 4);
  assert.equal(refreshed.nanoRpc.lastReadAt, at);
  assert.equal(mock.state.processed.length, 0); assert.equal(mock.state.workHashes.length, 0);
});

test("insufficient mainnet read peers refuses the hosted run before execution or publication", async () => {
  const mock = fakeRpc(); let executed = false;
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "https://wrong,https://good", verifyRpcReads: true,
    fetch: (url, init) => url.includes("wrong") && JSON.parse(init.body).hash === NANO_GENESIS_HASH
      ? Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ error: "Block not found" }) }) : mock.fetch(url, init),
  });
  await assert.rejects(wallet.ops.withFunding({ id: "no-mainnet-quorum", maxUsd: 1, maxRaw: 1n }, () => { executed = true; }), { code: "NANO_RPC_NETWORK_QUORUM" });
  assert.equal(executed, false); assert.equal(mock.state.processed.length, 0);
});

test("the wallet captures each queued caller's budget rather than the queue drainer's context", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, requireFunding: true });
  await Promise.all(["first", "second"].map((id, n) => wallet.ops.withFunding({ id, maxRaw: BigInt(AMOUNT), maxUsd: (n + 1) * 0.1 },
    () => wallet.payment({ paymentId: `invoice-${id}`, payTo: PAY_TO, amountRaw: AMOUNT, amountUsd: (n + 1) * 0.1 }))));
  assert.equal(mock.state.processed.length, 2, "different runs retain their own distinct caps under one queue drainer");
});

test("live liabilities refuse a funded-looking run before work or a block is published", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, fundingLiabilities: () => BigInt(BALANCE) });
  let ran = false;
  await assert.rejects(wallet.ops.withFunding({ id: "blocked", maxRaw: 1n, maxUsd: 0.01 }, () => { ran = true; }), { code: "FUNDING_INSUFFICIENT" });
  assert.equal(ran, false); assert.equal(mock.state.processed.length, 0);
});

test("refunds fulfill their debt while withdrawals cannot consume another run's capital", async () => {
  const mock = fakeRpc(); let debt = 4n * 10n ** 30n;
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, protectTransfers: true,
    fundingLiabilities: () => debt });
  await wallet.ops.withFunding({ id: "running", maxRaw: 10n ** 30n, maxUsd: 0.5 }, async () => {
    await assert.rejects(wallet.ops.transfer(PAY_TO, (10n ** 30n).toString()), { code: "FUNDING_INSUFFICIENT" });
    await wallet.ops.transfer(PAY_TO, debt.toString(), "refund", { liabilityRaw: debt });
    debt = 0n;
    await wallet.payment({ paymentId: "after-refund", payTo: PAY_TO, amountRaw: (10n ** 30n).toString(), amountUsd: 0.5 });
  });
  assert.equal(mock.state.balance, "0");
  assert.equal(mock.state.processed.length, 2);
});

test("a creator payout consumes its overhead reservation rather than the model's remaining budget", async () => {
  const mock = fakeRpc(), overhead = 8n * 10n ** 29n;
  let debt = 0n;
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, protectTransfers: true,
    fundingLiabilities: ({ overheadRawByRun }) => {
      const covered = overheadRawByRun.get("near:q") ?? 0n;
      return debt > covered ? debt - covered : 0n;
    } });
  await wallet.ops.withFunding({ id: "near:q", maxRaw: 4n * 10n ** 30n, maxUsd: 0.4, overheadRaw: overhead }, async () => {
    debt = overhead;
    await wallet.ops.transfer(PAY_TO, overhead.toString(), "creator", { liabilityRaw: overhead, fundingRunId: "near:q" });
    debt = 0n;
    await wallet.payment({ paymentId: "after-creator", payTo: PAY_TO, amountRaw: (4n * 10n ** 30n).toString(), amountUsd: 0.4 });
  });
  assert.equal(BigInt(mock.state.balance), 2n * 10n ** 29n);
});

test("an unrecorded outgoing claim cannot bypass protected transfer funds", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, protectTransfers: true });
  await assert.rejects(wallet.ops.transfer(PAY_TO, "1", "invalid claim", { liabilityRaw: 1n }), { code: "FUNDING_INVALID" });
  assert.equal(mock.state.processed.length, 0);
});

test("durable Nano payouts journal before publishing and recover a lost response after other pool spending", async () => {
  const blocks = new Map(); let unavailable = true, journal;
  const mock = fakeRpc({
    process(body, state, reply) {
      const hash = hashBlock(body.block);
      if (blocks.has(hash)) return reply({ error: "Old block" });
      assert.ok(journal || body.block.link_as_account === ADDRESS, "payout must be journaled first");
      assert.equal(body.block.previous, state.frontier);
      blocks.set(hash, body.block); state.frontier = hash; state.balance = body.block.balance;
      state.processed.push(body); return reply({ hash });
    },
    block_info(body, state, reply) {
      if (unavailable) return { ok: false, status: 503, text: async () => "unavailable" };
      return blocks.has(body.hash) ? reply({ confirmed: "true", contents: blocks.get(body.hash) }) : reply({ error: "Block not found" });
    },
  });
  const make = () => createNanoWallet({ secretKey: SECRET, fetch: mock.fetch });
  const wallet = make(), options = { onPrepared: p => { journal = structuredClone(p); } };
  await assert.rejects(wallet.ops.transferOnce(PAY_TO, AMOUNT, options), /HTTP 503/);
  assert.ok(journal); assert.equal(mock.state.processed.length, 1);
  await wallet.ops.transfer(ADDRESS, "1", "provider payment");
  assert.equal(mock.state.processed.length, 2);
  unavailable = false;
  const restarted = make();
  const hash = await restarted.ops.transferOnce(PAY_TO, AMOUNT, { ...options, prepared: journal });
  assert.equal(hash, journal.hash); assert.equal(mock.state.processed.length, 2);
  assert.equal(BigInt(mock.state.balance), BigInt(BALANCE) - BigInt(AMOUNT) - 1n);
});

test("a durable Nano send is replaced only when a different successor is confirmed", async () => {
  const competing = "D".repeat(64), blocks = new Map(); let confirmed = false, journal, signed = 0;
  const mock = fakeRpc({
    process(body, state, reply) {
      if (body.block.previous === FRONTIER) {
        state.frontier = competing; state.balance = (BigInt(BALANCE) - 1n).toString();
        return reply({ error: "Fork" });
      }
      const hash = hashBlock(body.block);
      blocks.set(hash, body.block); state.processed.push(body); state.frontier = hash; state.balance = body.block.balance;
      return reply({ hash });
    },
    block_info(body, state, reply) {
      if (body.hash === FRONTIER) return reply({ successor: competing });
      if (body.hash === competing) return reply({ confirmed: String(confirmed) });
      return blocks.has(body.hash) ? reply({ confirmed: "true" }) : reply({ error: "Block not found" });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch });
  const options = () => ({ prepared: journal, onPrepared: p => { journal = structuredClone(p); signed++; } });
  await assert.rejects(wallet.ops.transferOnce(PAY_TO, AMOUNT, options()), /Fork/);
  const first = journal.hash;
  await assert.rejects(wallet.ops.transferOnce(PAY_TO, AMOUNT, options()), /Fork/);
  assert.equal(signed, 1); assert.equal(mock.state.processed.length, 0);
  confirmed = true;
  const hash = await wallet.ops.transferOnce(PAY_TO, AMOUNT, options());
  assert.notEqual(hash, first); assert.equal(signed, 2); assert.equal(mock.state.processed.length, 1);
});

test("a failed durable-send journal write publishes nothing", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch });
  await assert.rejects(wallet.ops.transferOnce(PAY_TO, AMOUNT, { onPrepared() { throw new Error("disk full"); } }), /disk full/);
  assert.equal(mock.state.processed.length, 0);
});

/** In-memory Nano RPC: account_info / work_generate / receivable / process, with a frontier that advances. */
function fakeRpc(overrides = {}) {
  const state = { frontier: FRONTIER, balance: BALANCE, processed: [], workDifficulties: [], workHashes: [], infoCalls: 0 };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (body.action === "block_info" && body.hash === NANO_GENESIS_HASH) return reply(NANO_GENESIS_REPLY);
    if (overrides[body.action]) return overrides[body.action](body, state, reply);
    if (body.action === "account_info") {
      state.infoCalls++;
      return reply(body.include_confirmed === "true" ? nanoAccountInfo({ frontier: state.frontier, balance: state.balance, representative: ADDRESS, height: state.processed.length + 1 })
        : { frontier: state.frontier, balance: state.balance, representative: ADDRESS });
    }
    if (body.action === "work_generate") {
      state.workDifficulties.push(body.difficulty);
      state.workHashes.push(body.hash);
      assert.ok(["fffffff800000000", "fffffe0000000000"].includes(body.difficulty),
        "work difficulty must be the v21 send or receive threshold");
      return reply({ work: WORK });
    }
    if (body.action === "receivable") {
      return reply({ blocks: "" }); // a real node returns "" when nothing is receivable
    }
    if (body.action === "process") {
      state.processed.push(body);
      state.frontier = hashBlock(body.block);
      state.balance = body.block.balance;
      return reply({ hash: state.frontier });
    }
    return reply({ error: "unknown action " + body.action });
  };
  return { state, fetch };
}

const invoice = (extra = {}) => ({
  scheme: "nano", paymentId: "pay_1", payTo: PAY_TO,
  amountRaw: AMOUNT, amountUsd: 0.0012, ...extra,
});

test("wallet rejects malformed invoices and cap bypasses before touching funds", async () => {
  const mock = fakeRpc(), wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch, maxUsd: 1 });
  for (const extra of [{ amountRaw: "0" }, { amountRaw: "-1" }, { amountRaw: "9".repeat(40) },
    { amountUsd: NaN }, { amountUsd: Infinity }, { amountUsd: -1 }, { amountUsd: "0.01" }, { amountUsd: undefined }, { amountUsd: 0 }]) {
    await assert.rejects(wallet.payment(invoice(extra)));
  }
  assert.equal(mock.state.infoCalls, 0); assert.equal(mock.state.processed.length, 0);
  await wallet.payment(invoice({ paymentId: "valid-after-rejections" }));
  assert.equal(mock.state.processed.length, 1, "refusals do not poison the wallet queue");
  for (const maxUsd of [NaN, Infinity, 0, -1]) assert.throws(() => createNanoWallet({ secretKey: SECRET, maxUsd }));
});

test("a stalled Nano read times out and uses the next node", async () => {
  const mock = fakeRpc(); let stalled = 0;
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "https://stalled.example,https://healthy.example", rpcTimeoutMs: 30,
    fetch: async (url, init) => {
      if (url.includes("stalled") && JSON.parse(init.body).action === "account_info") {
        stalled++;
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
      return mock.fetch(url, init);
    },
  });
  await wallet.payment(invoice());
  assert.equal(stalled, 1); assert.equal(mock.state.processed.length, 1);
});

test("a Nano response with a stalled body also has a deadline", async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: `http://127.0.0.1:${server.address().port}`, rpcTimeoutMs: 50 });
    await assert.rejects(wallet.ops.rpc({ action: "account_info", account: ADDRESS }), /unreachable/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("a publish response must identify the exact block; invalid account state cannot fund a payment", async () => {
  const prepared = createBlock(SECRET, { work: WORK, previous: FRONTIER, representative: ADDRESS, balance: "1", link: PAY_TO });
  prepared.block.account = ADDRESS;
  for (const response of [{}, { hash: "F".repeat(64) }]) {
    const mock = fakeRpc({ process: (_body, _state, reply) => reply(response) });
    const wallet = createNanoWallet({ secretKey: SECRET, fetch: mock.fetch });
    await assert.rejects(wallet.ops.rpc({ action: "process", block: prepared.block }), /matching block hash/);
  }
  const mock = fakeRpc({ account_info: (_body, _state, reply) => reply({ frontier: "not-a-hash", balance: "123", representative: ADDRESS }) });
  await assert.rejects(createNanoWallet({ secretKey: SECRET, fetch: mock.fetch }).payment(invoice()), /invalid wallet state/);
  assert.equal(mock.state.processed.length, 0);
});

test("resolveWalletKey: private key wins, seed derives account 0, junk is refused", () => {
  assert.equal(resolveWalletKey({ seed: SEED }), SECRET);
  assert.equal(resolveWalletKey({ privateKey: SECRET, seed: "f".repeat(64) }), SECRET);
  assert.equal(resolveWalletKey({}), null);
  assert.throws(() => resolveWalletKey({ seed: "not-hex" }), /NANO_SEED/);
  assert.throws(() => resolveWalletKey({ privateKey: "abc" }), /NANO_PRIVATE_KEY/);
  // zero-seed vector from the Nano docs
  assert.equal(ADDRESS, "nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7");
});

test("paySend: correct signed state block reaches process", async () => {
  const rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  assert.equal(wallet.address, ADDRESS);
  await wallet.payment(invoice());

  assert.equal(rpc.state.processed.length, 1);
  const req = rpc.state.processed[0];
  assert.equal(req.subtype, "send");
  assert.equal(req.json_block, "true");
  const b = req.block;
  assert.equal(b.account, ADDRESS);
  assert.equal(b.previous, FRONTIER);
  assert.equal(b.representative, ADDRESS);
  assert.equal(b.work, WORK);
  assert.equal(b.link_as_account, PAY_TO);
  assert.equal(BigInt(b.balance), BigInt(BALANCE) - BigInt(AMOUNT));
  // signature actually verifies for this account — the send is spendable, not a stub artifact
  const { hashBlock } = await import("nanocurrency");
  const hash = hashBlock({ account: b.account, previous: b.previous, representative: b.representative, balance: b.balance, link: b.link });
  assert.equal(verifyBlock({ hash, signature: b.signature, publicKey: derivePublicKey(SECRET) }), true);
});

test("paySend: concurrent invoices are serialized on the locally-tracked frontier", async () => {
  const { hashBlock } = await import("nanocurrency");
  const rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await Promise.all([wallet.payment(invoice()), wallet.payment(invoice({ paymentId: "pay_2" }))]);
  const [first, second] = rpc.state.processed.map((p) => p.block);
  assert.equal(first.previous, FRONTIER);
  // the chain advances on the block hash computed at signing time — no account_info between sends
  const firstHash = hashBlock({ account: first.account, previous: first.previous, representative: first.representative, balance: first.balance, link: first.link });
  assert.equal(second.previous, firstHash, "second send must chain on the first's hash");
  assert.equal(BigInt(second.balance), BigInt(BALANCE) - 2n * BigInt(AMOUNT));
  assert.equal(rpc.state.infoCalls, 1, "chain state is tracked locally — one account scan for both sends");
});

test("queue priority: a payment jumps ahead of queued housekeeping transfers", async () => {
  const rpc = fakeRpc();
  // stall the first block's work so the queue backs up behind a running task
  let releaseWork, reachedWork;
  const gate = new Promise((r) => { releaseWork = r; });
  const stalled = new Promise((r) => { reachedWork = r; });
  let gated = false;
  const gatedFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "work_generate" && !gated) {
      gated = true;
      reachedWork();
      await gate;
    }
    return rpc.fetch(url, init);
  };
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: gatedFetch });
  const order = [];
  const first = wallet.ops.transfer(PAY_TO, AMOUNT, "change:").then(() => order.push("transfer-1"));
  const second = wallet.ops.transfer(PAY_TO, AMOUNT, "change:").then(() => order.push("transfer-2"));
  const paid = wallet.payment(invoice()).then(() => order.push("payment"));
  await stalled; // the first transfer is mid-flight; the other two sit queued
  releaseWork();
  await Promise.all([first, second, paid]);
  assert.deepEqual(order, ["transfer-1", "payment", "transfer-2"],
    "the payment must overtake housekeeping that was queued before it");
});

test("paySend: workUrl routes work_generate to the work server, everything else to the node", async () => {
  const rpc = fakeRpc();
  const calls = [];
  const spyFetch = (url, init) => { calls.push({ url, action: JSON.parse(init.body).action }); return rpc.fetch(url, init); };
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: spyFetch, workUrl: "http://127.0.0.1:7076/" });
  await wallet.payment(invoice());
  assert.deepEqual(
    calls.slice(0, 4).map((c) => [c.action, c.url]), // the post-payment receivable sweep trails these
    [
      ["account_info", DEFAULT_NANO_RPC],
      ["work_generate", "http://127.0.0.1:7076"], // trailing slash trimmed
      ["work_generate", "http://127.0.0.1:7076"], // next frontier's precompute starts before the publish
      ["process", DEFAULT_NANO_RPC],
    ]);
  assert.equal(rpc.state.processed[0].block.work, WORK);
});

test("paySend: a dead work server falls back to the node's work_generate", async () => {
  const rpc = fakeRpc();
  const logs = [];
  const spyFetch = (url, init) => {
    if (url === "http://dead.local" ) throw new Error("ECONNREFUSED");
    return rpc.fetch(url, init);
  };
  const wallet = createNanoWallet({
    secretKey: SECRET, fetch: spyFetch, workUrl: "http://dead.local",
    log: (l) => logs.push(l),
  });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 1, "payment must still settle via the node's work");
  assert.equal(rpc.state.processed[0].block.work, WORK);
  assert.ok(logs.some((l) => /work_generate via work server http:\/\/dead\.local failed/.test(l)),
    "the fallback must be logged");
});

test("precompute: the next send finds work already generated for the fresh frontier", async () => {
  const { hashBlock } = await import("nanocurrency");
  // advance the fake frontier to the block's REAL hash, like a real node does —
  // that's what makes the precompute cache line up with the next account_info
  const rpc = fakeRpc({
    process: (body, state, reply) => {
      state.processed.push(body);
      const b = body.block;
      state.frontier = hashBlock({ account: b.account, previous: b.previous, representative: b.representative, balance: b.balance, link: b.link });
      state.balance = b.balance;
      return reply({ hash: state.frontier });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.deepEqual(rpc.state.workHashes, [FRONTIER, rpc.state.frontier],
    "publishing must precompute work for the new frontier");
  await wallet.payment(invoice({ paymentId: "pay_2" }));
  assert.equal(rpc.state.processed.length, 2);
  assert.equal(rpc.state.workHashes.length, 3,
    "the second send must consume the precomputed work instead of asking again");
  assert.equal(rpc.state.workHashes[2], rpc.state.frontier);
});

test("ops.prewarm readies work for the session's first block", async () => {
  const rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.ops.prewarm();
  assert.deepEqual(rpc.state.workHashes, [FRONTIER]);
  await wallet.payment(invoice());
  // the send consumed the prewarmed work — only the post-send precompute was added
  assert.equal(rpc.state.workHashes.length, 2);
  assert.equal(rpc.state.processed.length, 1);
  assert.equal(rpc.state.processed[0].block.work, WORK);
});

test("work API key goes to the dedicated work server only, as body key + header", async () => {
  const asks = [];
  const spy = (rpc) => (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "work_generate") asks.push({ url, key: body.key, header: init.headers["nodes-api-key"] });
    if (url === "http://dead.local") throw new Error("ECONNREFUSED");
    return rpc.fetch(url, init);
  };
  const ok = createNanoWallet({ secretKey: SECRET, fetch: spy(fakeRpc()), workUrl: "http://work.local", workKey: "k_test" });
  await ok.payment(invoice());
  const keyed = asks.find((a) => a.url === "http://work.local");
  assert.equal(keyed.key, "k_test");
  assert.equal(keyed.header, "k_test");

  asks.length = 0;
  const dead = createNanoWallet({ secretKey: SECRET, fetch: spy(fakeRpc()), workUrl: "http://dead.local", workKey: "k_test" });
  await dead.payment(invoice());
  const fallback = asks.find((a) => a.url === DEFAULT_NANO_RPC);
  assert.equal(fallback.key, undefined, "the node fallback must not leak the work API key");
  assert.equal(fallback.header, undefined);
});

test("workUrl list: a dead first work server falls through to the second", async () => {
  const rpc = fakeRpc();
  const calls = [];
  const spyFetch = (url, init) => {
    if (JSON.parse(init.body).action === "work_generate") calls.push(url);
    if (url === "http://gpu.local:7076") throw new Error("ECONNREFUSED");
    return rpc.fetch(url, init);
  };
  const wallet = createNanoWallet({
    secretKey: SECRET, fetch: spyFetch,
    workUrl: "http://gpu.local:7076, https://work2.local/",
  });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 1);
  assert.deepEqual(calls.slice(0, 2), ["http://gpu.local:7076", "https://work2.local"],
    "listed work servers must be tried in order (trimmed, slash-stripped)");
});

test("a hung work server times out and falls through to the node's work", async () => {
  const rpc = fakeRpc();
  const logs = [];
  const spyFetch = (url, init) => {
    if (url === "http://slow.local") {
      // never answers; only the abort signal ends it — like a congested shared work server
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    }
    return rpc.fetch(url, init);
  };
  const wallet = createNanoWallet({
    secretKey: SECRET, fetch: spyFetch, workUrl: "http://slow.local", workTimeoutMs: 30,
    log: (l) => logs.push(l),
  });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 1, "payment must still settle via the node's work");
  assert.equal(rpc.state.processed[0].block.work, WORK);
  assert.ok(logs.some((l) => /work_generate via work server http:\/\/slow\.local failed/.test(l)));
});

test("localWork: false fails the send cleanly when every remote work source is down", async () => {
  const rpc = fakeRpc({ work_generate: (_b, _s, reply) => reply({ error: "work generation is disabled" }) });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch, localWork: false });
  await assert.rejects(() => wallet.payment(invoice()), /remote work source failed.*--no-local-work/s);
  assert.equal(rpc.state.processed.length, 0, "no block may be published without work");
  // the queue survives: a later payment with working sources goes through
  const ok = fakeRpc();
  const wallet2 = createNanoWallet({ secretKey: SECRET, fetch: ok.fetch, localWork: false });
  await wallet2.payment(invoice());
  assert.equal(ok.state.processed.length, 1);
});

test("paySend: a failed payment doesn't wedge the queue", async () => {
  const rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch, maxUsd: 0.001 });
  await assert.rejects(() => wallet.payment(invoice()), /over the --max-usd cap/);
  const ok = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await ok.payment(invoice()); // sanity: same stub still processes fine
  // and on the capped wallet, a cheap invoice after the refusal still goes through
  await wallet.payment(invoice({ amountUsd: 0.0005, paymentId: "pay_3" }));
  assert.equal(rpc.state.processed.length, 2);
});

test("paySend: readable errors — insufficient balance, unopened account, bad invoice", async () => {
  const broke = fakeRpc({
    account_info: (_b, _s, reply) => reply({ frontier: FRONTIER, balance: "1", representative: ADDRESS }),
  });
  const w1 = createNanoWallet({ secretKey: SECRET, fetch: broke.fetch });
  await assert.rejects(() => w1.payment(invoice()), /insufficient wallet balance.*top up/s);

  const unopened = fakeRpc({ account_info: (_b, _s, reply) => reply({ error: "Account not found" }) });
  const w2 = createNanoWallet({ secretKey: SECRET, fetch: unopened.fetch });
  await assert.rejects(() => w2.payment(invoice()), /empty or unopened/);

  const w3 = createNanoWallet({ secretKey: SECRET, fetch: fakeRpc().fetch });
  await assert.rejects(() => w3.payment(invoice({ amountRaw: "" })), /no usable Nano amount/);
  await assert.rejects(() => w3.payment(invoice({ payTo: "nano_junk!" })), /not a valid Nano address/);
});

test("paySend: a funded wallet sends first; refunds are swept off the critical path", async () => {
  const REFUND = "2000000000000000000000000000"; // 0.002 XNO refund waiting
  const REFUND_HASH = "E".repeat(64);
  const rpc = fakeRpc({
    receivable: (_b, state, reply) =>
      // pending until received — a receive publish makes it disappear
      reply({ blocks: state.processed.some((p) => p.subtype === "receive") ? "" : { [REFUND_HASH]: REFUND } }),
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());

  // the payment never waited on the refund: the send is the FIRST published block
  assert.equal(rpc.state.processed[0].subtype, "send");
  const send = rpc.state.processed[0];
  assert.equal(send.block.previous, FRONTIER);
  assert.equal(BigInt(send.block.balance), BigInt(BALANCE) - BigInt(AMOUNT));

  // the post-payment sweep pockets the refund once the queue is quiet
  await wallet.ops.pocket(); // queued behind the auto-sweep — awaiting it flushes both
  assert.equal(rpc.state.processed.length, 2);
  const receive = rpc.state.processed[1];
  assert.equal(receive.subtype, "receive");
  assert.equal(receive.block.link, REFUND_HASH);
  assert.equal(receive.block.link_as_account, undefined, "receive link is a hash, not an account");
  const { hashBlock } = await import("nanocurrency");
  const sendHash = hashBlock({
    account: send.block.account, previous: send.block.previous,
    representative: send.block.representative, balance: send.block.balance, link: send.block.link,
  });
  assert.equal(receive.block.previous, sendHash, "the sweep's receive must chain on the send's real hash");
  assert.equal(BigInt(receive.block.balance), BigInt(BALANCE) - BigInt(AMOUNT) + BigInt(REFUND));
});

test("paySend: a short balance pulls in receivables on the spot, then sends", async () => {
  const REFUND = "2000000000000000000000000000"; // covers the invoice the bare balance can't
  const REFUND_HASH = "E".repeat(64);
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => { state.infoCalls++; return reply({ frontier: state.frontier, balance: "1", representative: ADDRESS }); },
    receivable: (_b, state, reply) =>
      reply({ blocks: state.processed.some((p) => p.subtype === "receive") ? "" : { [REFUND_HASH]: REFUND } }),
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  const [receive, send] = rpc.state.processed;
  assert.equal(receive.subtype, "receive");
  assert.equal(receive.block.previous, FRONTIER);
  assert.equal(send.subtype, "send");
  const { hashBlock } = await import("nanocurrency");
  const receiveHash = hashBlock({
    account: receive.block.account, previous: receive.block.previous,
    representative: receive.block.representative, balance: receive.block.balance, link: receive.block.link,
  });
  assert.equal(send.block.previous, receiveHash, "send must chain on the receive block's real hash");
  // The receive asks at the cheap threshold; its publish precomputes send-grade
  // work for the new frontier, which the send consumes from cache (send-threshold
  // work is valid for any block). The last entry is the send's own precompute.
  assert.deepEqual(rpc.state.workDifficulties, ["fffffe0000000000", "fffffff800000000", "fffffff800000000"]);
  assert.equal(rpc.state.workHashes[1], receiveHash, "the send's work must come from the precompute on the receive's hash");
});

/** Receivable override: entries disappear once a receive for them is processed. */
const pendingReceivables = (entries) => (_b, state, reply) => {
  const done = new Set(state.processed.filter((p) => p.subtype === "receive").map((p) => p.block.link.toUpperCase()));
  const left = Object.fromEntries(Object.entries(entries).filter(([h]) => !done.has(h)));
  return reply({ blocks: Object.keys(left).length ? left : "" });
};

test("a receive sweep asks for cheap receive-grade work between its blocks, send-grade only at the end", async () => {
  const { hashBlock } = await import("nanocurrency");
  const rpc = fakeRpc({
    receivable: pendingReceivables({ ["1".repeat(64)]: AMOUNT, ["2".repeat(64)]: AMOUNT, ["3".repeat(64)]: AMOUNT }),
    // advance the fake frontier to the block's REAL hash so the precompute cache lines up
    process: (body, state, reply) => {
      state.processed.push(body);
      const b = body.block;
      state.frontier = hashBlock({ account: b.account, previous: b.previous, representative: b.representative, balance: b.balance, link: b.link });
      state.balance = b.balance;
      return reply({ hash: state.frontier });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.ops.pocket();
  assert.equal(rpc.state.processed.length, 3);
  assert.deepEqual(rpc.state.workDifficulties,
    ["fffffe0000000000", "fffffe0000000000", "fffffe0000000000", "fffffff800000000"],
    "interior blocks must ride receive-grade work; only the final frontier warms send-grade");
});

test("a queued payment preempts a running receive sweep after at most one more block", async () => {
  const entries = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [(i + 1).toString(16).repeat(64).slice(0, 64).toUpperCase(), AMOUNT]));
  const rpc = fakeRpc({ receivable: pendingReceivables(entries) });
  let wallet = null;
  let payment = null;
  let receives = 0;
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    const res = await rpc.fetch(url, init);
    if (body.action === "process" && body.subtype === "receive" && ++receives === 2) {
      payment = wallet.payment(invoice()); // a customer pays while the sweep is mid-pass
    }
    return res;
  };
  wallet = createNanoWallet({ secretKey: SECRET, fetch: f });
  await wallet.ops.pocket();
  await payment;
  assert.deepEqual(rpc.state.processed.slice(0, 3).map((p) => p.subtype), ["receive", "receive", "send"],
    "the sweep must yield the chain to the payment instead of finishing all 10 receives");
  // nothing is lost: later sweeps pocket the rest
  await wallet.ops.pocket();
  await wallet.ops.pocket();
  assert.equal(rpc.state.processed.filter((p) => p.subtype === "receive").length, 10);
});

test("paySend: short-balance pocketing stops the moment the invoice is covered", async () => {
  const REFUND = "2000000000000000000000000000"; // each covers the 0.00123 XNO invoice alone
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => { state.infoCalls++; return reply({ frontier: state.frontier, balance: "1", representative: ADDRESS }); },
    receivable: pendingReceivables({ ["D".repeat(64)]: REFUND, ["E".repeat(64)]: REFUND, ["F".repeat(64)]: REFUND }),
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.deepEqual(rpc.state.processed.slice(0, 2).map((p) => p.subtype), ["receive", "send"],
    "one receive covers the invoice — the caller must not wait out the other two");
});

test("paySend: a refund can cover an invoice the bare balance cannot", async () => {
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => { state.infoCalls++; return reply({ frontier: state.frontier, balance: "1", representative: ADDRESS }); },
    receivable: (_b, state, reply) => reply({ blocks: state.processed.length ? "" : { ["E".repeat(64)]: BALANCE } }),
    process: (body, state, reply) => { state.processed.push(body); state.frontier = hashBlock(body.block); return reply({ hash: state.frontier }); },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 2, "receive then send");
});

test("paySend: an ambiguous publish failure drops the cache — the next send rebuilds from the node", async () => {
  let processCalls = 0;
  const rpc = fakeRpc({
    process: (body, state, reply) => {
      // first publish dies with a definite-looking but ambiguous node error
      if (++processCalls === 1) return reply({ error: "Gap source block" });
      state.processed.push(body);
      state.frontier = hashBlock(body.block);
      return reply({ hash: state.frontier });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await assert.rejects(() => wallet.payment(invoice()), /Gap source block/);
  await wallet.payment(invoice({ paymentId: "pay_2" }));
  assert.equal(rpc.state.infoCalls, 2, "the failure must invalidate the cache — the retry asks the node");
  assert.equal(rpc.state.processed[0].block.previous, FRONTIER, "the second send builds on the node's own frontier");
});

test("paySend: an HTTP-5xx from the RPC proxy verifies and republishes instead of losing the block", async () => {
  let processCalls = 0;
  const rpc = fakeRpc({
    process: (body, state, reply) => {
      processCalls++;
      if (processCalls === 1) return { ok: false, status: 502, text: async () => "bad gateway" }; // proxy died; node never saw it
      state.processed.push(body);
      return reply({ hash: hashBlock(body.block) });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 1);
  assert.equal(rpc.state.processed[0].block.previous, FRONTIER, "republish must be the same block, not a rebuild");
});

test("post-payment sweep: a failing receivable RPC never crashes or wedges the queue", async () => {
  const rpc = fakeRpc({ receivable: () => { throw new Error("boom"); } });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  await wallet.payment(invoice({ paymentId: "pay_2" })); // queue still drains after the sweep's failure
  assert.equal(rpc.state.processed.length, 2);
});

test("paySend: a bounced send refetches the frontier and retries exactly once", async () => {
  const TRUE_FRONTIER = "D".repeat(64);
  let processCalls = 0;
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => {
      state.infoCalls++;
      // first ask serves a stale cached frontier; the refetch sees the real one
      return reply({ frontier: state.infoCalls === 1 ? FRONTIER : TRUE_FRONTIER, balance: BALANCE, representative: ADDRESS });
    },
    process: (body, state, reply) => {
      processCalls++;
      if (processCalls === 1) return reply({ error: "Fork" });
      state.processed.push(body);
      return reply({ hash: hashBlock(body.block) });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());

  assert.equal(processCalls, 2);
  assert.equal(rpc.state.infoCalls, 2);
  assert.equal(rpc.state.processed[0].block.previous, TRUE_FRONTIER, "retry must build on the fresh frontier");

  // a second bounce is a real error, not an infinite retry
  const alwaysFork = fakeRpc({ process: (_b, _s, reply) => reply({ error: "Fork" }) });
  const w2 = createNanoWallet({ secretKey: SECRET, fetch: alwaysFork.fetch });
  await assert.rejects(() => w2.payment(invoice()), /Fork/);
  assert.equal(alwaysFork.state.infoCalls, 2, "exactly one refetch before giving up");
});

test("paySend: a lost process response republishes the identical block", async () => {
  let dropped = 0;
  const rpc = fakeRpc({
    process: (body, state, reply) => {
      if (dropped++ === 0) throw new Error("fetch failed"); // transport dies, node never saw it
      state.processed.push(body);
      return reply({ hash: hashBlock(body.block) });
    },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 1);
  assert.equal(rpc.state.processed[0].block.previous, FRONTIER, "republish must be the same block, not a rebuild");
});

test("paySend: a lost response for a block that DID land is not republished", async () => {
  const { hashBlock } = await import("nanocurrency");
  let sent = null;
  const rpc = fakeRpc({
    process: (body, state, reply) => {
      if (!sent) { sent = body.block; throw new Error("fetch failed"); } // accepted, response lost
      state.processed.push(body); // a second publish would land here
      return reply({ hash: hashBlock(body.block) });
    },
    account_info: (_b, _s, reply) => reply({
      frontier: sent
        ? hashBlock({ account: sent.account, previous: sent.previous, representative: sent.representative, balance: sent.balance, link: sent.link })
        : FRONTIER,
      balance: BALANCE, representative: ADDRESS,
    }),
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice()); // must resolve — the money moved
  assert.equal(rpc.state.processed.length, 0, "no double publish after the frontier confirms the block");
});

test("failover: a 429 on the primary settles on the secondary (reads AND publish)", async () => {
  // The real incident: the primary proxy 429s the whole settlement. A 429 is an
  // explicit refusal — the block never reaches the node — so even the publish is
  // safe to retry on a healthy peer. Distributed network: one node saying "no"
  // must not end the payment.
  const primaryActions = [];
  const good = fakeRpc();
  const fetch = async (url, init) => {
    if (url.startsWith("http://primary")) {
      primaryActions.push(JSON.parse(init.body).action);
      return { ok: false, status: 429, text: async () => "too many requests" };
    }
    return good.fetch(url, init);
  };
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "http://primary,http://good", fetch });
  await wallet.payment(invoice());
  assert.equal(good.state.processed.length, 1, "block published via the healthy secondary");
  assert.ok(primaryActions.includes("account_info"), "primary tried first for the read");
  assert.ok(primaryActions.includes("process"), "primary tried first for the publish, then failed over");
});

test("failover: an ambiguous 5xx on publish is verified, never cross-node republished", async () => {
  // A 5xx from a fronting proxy is NOT a clean refusal — the node may have taken
  // the block and only the response died. That must go through the frontier-check
  // recovery, never a blind republish to another node (which would double-submit).
  const { hashBlock } = await import("nanocurrency");
  let sent = null;
  const secondaryProcesses = [];
  const primary = fakeRpc({
    process: (body, state, reply) => {
      if (!sent) { sent = body.block; return { ok: false, status: 502, text: async () => "bad gateway" }; }
      state.processed.push(body);
      return reply({ hash: hashBlock(body.block) });
    },
    account_info: (_b, _s, reply) => reply({
      frontier: sent
        ? hashBlock({ account: sent.account, previous: sent.previous, representative: sent.representative, balance: sent.balance, link: sent.link })
        : FRONTIER,
      balance: BALANCE, representative: ADDRESS,
    }),
  });
  const fetch = async (url, init) => {
    if (url.startsWith("http://secondary")) {
      if (JSON.parse(init.body).action === "process") secondaryProcesses.push(1);
      return fakeRpc().fetch(url, init);
    }
    return primary.fetch(url, init);
  };
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "http://primary,http://secondary", fetch });
  await wallet.payment(invoice()); // resolves — the frontier check proves the block landed
  assert.equal(primary.state.processed.length, 0, "not republished on the primary");
  assert.equal(secondaryProcesses.length, 0, "and never failed a publish over to the secondary");
});

test("default RPC is rpc.nano.to", () => {
  assert.equal(DEFAULT_NANO_RPC, "https://rpc.nano.to");
});

/* ============================== E2E ============================== */

let nanoRpc, nanoRpcUrl, apiServer, apiUrl;
const processed = [];   // blocks the Nano RPC stub accepted
const apiRequests = []; // requests the NanoGPT stub saw

before(async () => {
  nanoRpc = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (body.action === "account_info") return send({ frontier: FRONTIER, balance: BALANCE, representative: ADDRESS });
    if (body.action === "work_generate") return send({ work: WORK });
    if (body.action === "process") { processed.push(body.block); return send({ hash: hashBlock(body.block) }); }
    send({ error: "unknown action" });
  });
  await new Promise((r) => nanoRpc.listen(0, "127.0.0.1", r));
  nanoRpcUrl = `http://127.0.0.1:${nanoRpc.address().port}`;

  apiServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    apiRequests.push({ path: req.url, headers: req.headers });
    if (req.method === "POST" && req.url === "/api/v1/chat/completions") {
      // keyless call → invoice; the complete endpoint replays the stored result after payment
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({
        accepts: [{
          scheme: "nano", payTo: PAY_TO, paymentId: "pay_e2e",
          maxAmountRequired: AMOUNT, maxAmountRequiredFormatted: "0.00123 XNO", maxAmountRequiredUSD: 0.0012,
          expiresAt: Math.floor(Date.now() / 1000) + 900,
        }],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/x402/complete/pay_e2e") {
      if (!processed.length) { res.writeHead(402, { "content-type": "application/json" }); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "pong" } }],
        x_nanogpt_pricing: { costUsd: 0.0012 },
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "stub: no route for " + req.method + " " + req.url }));
  });
  await new Promise((r) => apiServer.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
});

after(() => Promise.all([
  new Promise((r) => nanoRpc.close(r)),
  new Promise((r) => apiServer.close(r)),
]));

test("E2E: keyless server pays a 402 invoice from NANO_SEED and returns the result", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "nanoodle-mcp-x402-out-")); // keeps the cost sidecar out of the repo's ./nanoodle-out
  const env = { ...process.env, NANOGPT_BASE_URL: apiUrl, NANOODLE_WRITER_LOCK_DIR: join(outDir, "writer-locks"), NANO_SEED: SEED, NANO_RPC_URL: nanoRpcUrl };
  delete env.NANOGPT_API_KEY;
  const child = spawn(process.execPath, [BIN, "--graphs", FIXTURES, "--out", outDir, "--max-usd", "1"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => { stderr += c; });
  try {
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hello-noodle", arguments: { Idea: "say pong" } } });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out; stderr:\n" + stderr)), 20000);
      // wait for the tools/call REPLY specifically — the cost's list_changed
      // notification frame arrives first, so a bare line count would fire early
      child.stdout.on("data", () => {
        if (stdout.includes('"id":3')) { clearTimeout(t); resolve(); }
      });
    });
    const frames = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));

    // wallet mode is announced (stderr only), with the paying address and the cap
    assert.match(stderr, /wallet mode \(accountless x402\)/);
    assert.ok(stderr.includes(ADDRESS));
    assert.match(stderr, /capped at \$1\/call/);
    assert.doesNotMatch(stderr, /no NanoGPT API key/, "wallet mode must not warn about a missing key");

    // tool descriptions say where money comes from
    const list = frames.find((f) => f.id === 2);
    const rn = list.result.tools.find((t) => t.name === "run_noodle");
    assert.match(rn.description, /spends real credit from your x402 Nano wallet/);

    // the call succeeded off the replayed complete-endpoint result
    const call = frames.find((f) => f.id === 3);
    assert.equal(call.error, undefined);
    assert.ok(!call.result.isError, JSON.stringify(call.result));
    const texts = call.result.content.map((c) => c.text);
    assert.equal(texts[0], "pong");
    assert.equal(texts.at(-1), "cost: $0.0012");

    // the keyless request opted into x402 and never carried credentials
    const chat = apiRequests.find((r) => r.path === "/api/v1/chat/completions");
    assert.equal(chat.headers["x-x402"], "true");
    assert.equal(chat.headers.authorization, undefined);

    // and a real signed send for the right amount hit the Nano RPC
    assert.equal(processed.length, 1);
    assert.equal(processed[0].link_as_account, PAY_TO);
    assert.equal(BigInt(processed[0].balance), BigInt(BALANCE) - BigInt(AMOUNT));

    // the x402 payment line is logged, the seed never is
    assert.match(stderr, /x402: paid 0\.00123 XNO/);
    assert.ok(!stdout.includes(SEED) && !stderr.includes(SEED), "seed must never be logged");
  } finally {
    child.stdin.end();
    await new Promise((r) => { child.once("exit", r); setTimeout(() => child.kill(), 2000).unref(); });
  }
});

test("failover: a 200-wrapped {\"error\":\"429\"} is a refusal, not the network's answer", async () => {
  // Production 2026-07-24: `Nano RPC account_info: 429` killed a paid run and
  // its refund. That message is the json.error branch — a proxy answering HTTP
  // 200 with a rate-limit BODY. Classified authoritative it never failed over,
  // so one throttling proxy hard-failed the settlement while three healthy
  // endpoints sat unused. It must behave exactly like the 429 status.
  const primaryActions = [];
  const good = fakeRpc();
  const fetch = async (url, init) => {
    if (url.startsWith("http://primary")) {
      primaryActions.push(JSON.parse(init.body).action);
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: "429" }) };
    }
    return good.fetch(url, init);
  };
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "http://primary,http://good", fetch });
  await wallet.payment(invoice());
  assert.equal(good.state.processed.length, 1, "block published via the healthy secondary");
  assert.ok(primaryActions.includes("account_info"), "primary tried first for the read");
  assert.ok(primaryActions.includes("process"), "a refusal is safe to retry elsewhere, publish included");
});

test("a real node error still never fails over", async () => {
  // The guard on the fix above: only throttling is a refusal. A genuine answer
  // ("Account not found", "Fork", "Old block") must stay authoritative — asking
  // a different node would be wrong, and for a publish it would double-submit.
  const { isThrottleError } = await import("../src/wallet.mjs");
  for (const real of ["Account not found", "Fork", "Old block", "Gap previous block", "Bad signature"]) {
    assert.equal(isThrottleError(real), false, `${real} must not read as throttling`);
  }
  for (const throttle of ["429", " 429 ", "Too Many Requests", "rate limit exceeded", "rate-limited", "HTTP 429"]) {
    assert.equal(isThrottleError(throttle), true, `${throttle} must read as throttling`);
  }

  let tried = 0;
  const fetch = async () => { tried++; return { ok: true, status: 200, text: async () => JSON.stringify({ error: "Fork" }) }; };
  const wallet = createNanoWallet({ secretKey: SECRET, rpcUrl: "http://a,http://b,http://c", fetch });
  await assert.rejects(() => wallet.ops.rpc({ action: "account_info", account: ADDRESS }), /Fork/);
  assert.equal(tried, 1, "an authoritative error must stop at the first node");
});

async function maintenanceWorld(t) {
  const dir = await mkdtemp(join(tmpdir(), "wallet-maintenance-")), file = join(dir, "flag.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const maintenance = createMaintenanceBarrier({ file, ownerUid: process.getuid() });
  return { maintenance, pause: () => writeFile(file, JSON.stringify({ v: 1, token: "a".repeat(32), operation: "backup", revision: null }), { mode: 0o600 }) };
}

test("wallet drain counts queued transfers until publication and rejects new work during pause", async t => {
  const w = await maintenanceWorld(t), rpc = fakeRpc();
  let release, reached, blocked = false;
  const hold = new Promise(r => { release = r; }), entered = new Promise(r => { reached = r; });
  const wallet = createNanoWallet({ secretKey: SECRET, maintenance: w.maintenance, fetch: async (url, init) => {
    if (JSON.parse(init.body).action === "work_generate" && !blocked) { blocked = true; reached(); await hold; }
    return rpc.fetch(url, init);
  } });
  const first = wallet.ops.transfer(PAY_TO, AMOUNT);
  const queued = wallet.ops.transfer(PAY_TO, AMOUNT);
  await entered;
  assert.equal(w.maintenance.snapshot().counts.wallet, 2);
  await w.pause();
  await assert.rejects(wallet.ops.transfer(PAY_TO, AMOUNT), { code: "SERVICE_DRAINING" });
  assert.equal(rpc.state.processed.length, 0);
  release(); await Promise.all([first, queued]);
  assert.equal(rpc.state.processed.length, 2);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
  const report = await wallet.ops.fundingReport();
  assert.equal(report.balanceRaw, rpc.state.balance);
  assert.equal(w.maintenance.snapshot().activeOperations, 0, "read-only telemetry does not self-block the drain");
});

test("accepted requests can queue their refunds after pause even after releasing funding", async t => {
  const w = await maintenanceWorld(t), rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, maintenance: w.maintenance, fetch: rpc.fetch });
  await w.maintenance.run(async () => {
    await wallet.ops.withFunding({ id: "settlement-after-run", maxRaw: 1n, maxUsd: 0.01 }, async () => {});
    assert.equal(wallet.ops.fundingStatus().activeRuns, 0);
    await w.pause();
    await wallet.ops.transfer(PAY_TO, AMOUNT, "customer change");
  });
  assert.equal(rpc.state.processed.length, 1);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
  await assert.rejects(wallet.payment(invoice()), { code: "SERVICE_DRAINING" });
});

test("writer failures release tracked wallet work without wedging the queue", async t => {
  const w = await maintenanceWorld(t), rpc = fakeRpc(); let validWriter = false;
  const wallet = createNanoWallet({ secretKey: SECRET, maintenance: w.maintenance, fetch: rpc.fetch,
    assertWriter: () => { if (!validWriter) throw Error("writer lost"); } });
  await assert.rejects(wallet.ops.transfer(PAY_TO, AMOUNT), /writer lost/);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
  assert.equal(rpc.state.processed.length, 0);
  validWriter = true;
  await wallet.ops.transfer(PAY_TO, AMOUNT);
  assert.equal(rpc.state.processed.length, 1);
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});

test("a funded run remains admitted through pause and always releases its reservation", async t => {
  const w = await maintenanceWorld(t), rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, maintenance: w.maintenance, fetch: rpc.fetch, requireFunding: true });
  let entered, release;
  const reached = new Promise(r => { entered = r; }), hold = new Promise(r => { release = r; });
  const run = wallet.ops.withFunding({ id: "accepted-before-pause", maxRaw: BigInt(AMOUNT), maxUsd: 0.01 }, async () => {
    entered(); await hold;
    await wallet.payment(invoice());
  });
  await reached; await w.pause();
  assert.equal(wallet.ops.fundingStatus().activeRuns, 1);
  assert.ok(w.maintenance.snapshot().activeOperations > 0);
  await assert.rejects(wallet.ops.withFunding({ id: "late-run", maxRaw: 1n, maxUsd: 0.01 }, () => assert.fail("No late inference")), { code: "SERVICE_DRAINING", executionNotStarted: true });
  release(); await run;
  // Read-only report also waits behind any already-queued post-payment sweep.
  await wallet.ops.fundingReport();
  assert.equal(rpc.state.processed.length, 1);
  assert.deepEqual(wallet.ops.fundingStatus(), { activeRuns: 0, reservedRaw: "0" });
  assert.equal(w.maintenance.snapshot().activeOperations, 0);
});
