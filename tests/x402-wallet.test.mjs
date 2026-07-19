/**
 * Wallet mode (accountless x402): unit tests for the Nano payer against a
 * stubbed RPC, plus a full E2E — the real server, keyless, settles a staged
 * HTTP 402 by "sending" XNO to a local Nano RPC stub. Fully offline.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAddress, derivePublicKey, deriveSecretKey, verifyBlock } from "nanocurrency";
import { createNanoWallet, resolveWalletKey, DEFAULT_NANO_RPC } from "../src/wallet.mjs";

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

/** In-memory Nano RPC: account_info / work_generate / receivable / process, with a frontier that advances. */
function fakeRpc(overrides = {}) {
  const state = { frontier: FRONTIER, balance: BALANCE, processed: [], workDifficulties: [], infoCalls: 0 };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (overrides[body.action]) return overrides[body.action](body, state, reply);
    if (body.action === "account_info") {
      state.infoCalls++;
      return reply({ frontier: state.frontier, balance: state.balance, representative: ADDRESS });
    }
    if (body.action === "work_generate") {
      state.workDifficulties.push(body.difficulty);
      assert.ok(["fffffff800000000", "fffffe0000000000"].includes(body.difficulty),
        "work difficulty must be the v21 send or receive threshold");
      return reply({ work: WORK });
    }
    if (body.action === "receivable") {
      return reply({ blocks: "" }); // a real node returns "" when nothing is receivable
    }
    if (body.action === "process") {
      state.processed.push(body);
      state.frontier = "C".repeat(63) + state.processed.length; // advance the chain
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

test("paySend: concurrent invoices are serialized on the advancing frontier", async () => {
  const rpc = fakeRpc();
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await Promise.all([wallet.payment(invoice()), wallet.payment(invoice({ paymentId: "pay_2" }))]);
  const [first, second] = rpc.state.processed.map((p) => p.block);
  assert.equal(first.previous, FRONTIER);
  assert.equal(second.previous, "C".repeat(63) + "1", "second send must chain on the first's hash");
  assert.equal(BigInt(second.balance), BigInt(BALANCE) - 2n * BigInt(AMOUNT));
});

test("paySend: workUrl routes work_generate to the work server, everything else to the node", async () => {
  const rpc = fakeRpc();
  const calls = [];
  const spyFetch = (url, init) => { calls.push({ url, action: JSON.parse(init.body).action }); return rpc.fetch(url, init); };
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: spyFetch, workUrl: "http://127.0.0.1:7076/" });
  await wallet.payment(invoice());
  assert.deepEqual(
    calls.map((c) => [c.action, c.url]),
    [
      ["account_info", DEFAULT_NANO_RPC],
      ["receivable", DEFAULT_NANO_RPC],
      ["work_generate", "http://127.0.0.1:7076"], // trailing slash trimmed
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

test("paySend: pockets receivable refunds before sending", async () => {
  const REFUND = "2000000000000000000000000000"; // 0.002 XNO refund waiting
  const REFUND_HASH = "E".repeat(64);
  const rpc = fakeRpc({
    receivable: (_b, state, reply) =>
      // only the first ask has a pending block — once received it's gone
      reply({ blocks: state.processed.length ? "" : { [REFUND_HASH]: REFUND } }),
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());

  assert.equal(rpc.state.processed.length, 2);
  const [receive, send] = rpc.state.processed;
  assert.equal(receive.subtype, "receive");
  assert.equal(receive.block.previous, FRONTIER);
  assert.equal(receive.block.link, REFUND_HASH);
  assert.equal(receive.block.link_as_account, undefined, "receive link is a hash, not an account");
  assert.equal(BigInt(receive.block.balance), BigInt(BALANCE) + BigInt(REFUND));
  assert.equal(send.subtype, "send");
  const { hashBlock } = await import("nanocurrency");
  const receiveHash = hashBlock({
    account: receive.block.account, previous: receive.block.previous,
    representative: receive.block.representative, balance: receive.block.balance, link: receive.block.link,
  });
  assert.equal(send.block.previous, receiveHash, "send must chain on the receive block's real hash");
  assert.equal(BigInt(send.block.balance), BigInt(BALANCE) + BigInt(REFUND) - BigInt(AMOUNT));
  // receive work is allowed the cheap threshold; the send still uses the v21 send threshold
  assert.deepEqual(rpc.state.workDifficulties, ["fffffe0000000000", "fffffff800000000"]);
});

test("paySend: a refund can cover an invoice the bare balance cannot", async () => {
  const rpc = fakeRpc({
    account_info: (_b, state, reply) => { state.infoCalls++; return reply({ frontier: state.frontier, balance: "1", representative: ADDRESS }); },
    receivable: (_b, state, reply) => reply({ blocks: state.processed.length ? "" : { ["E".repeat(64)]: BALANCE } }),
    process: (body, state, reply) => { state.processed.push(body); state.frontier = "C".repeat(63) + state.processed.length; return reply({ hash: state.frontier }); },
  });
  const wallet = createNanoWallet({ secretKey: SECRET, fetch: rpc.fetch });
  await wallet.payment(invoice());
  assert.equal(rpc.state.processed.length, 2, "receive then send");
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
      return reply({ hash: "C".repeat(64) });
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
      return reply({ hash: "C".repeat(64) });
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
      return reply({ hash: "C".repeat(64) });
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
    if (body.action === "process") { processed.push(body.block); return send({ hash: "D".repeat(64) }); }
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
  const env = { ...process.env, NANOGPT_BASE_URL: apiUrl, NANO_SEED: SEED, NANO_RPC_URL: nanoRpcUrl };
  delete env.NANOGPT_API_KEY;
  const child = spawn(process.execPath, [BIN, "--graphs", FIXTURES, "--max-usd", "1"], { env, stdio: ["pipe", "pipe", "pipe"] });
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
      child.stdout.on("data", () => {
        if (stdout.split("\n").filter(Boolean).length >= 3) { clearTimeout(t); resolve(); }
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
