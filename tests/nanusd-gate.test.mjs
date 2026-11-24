// NanoUSD gate + shared payment-route core — offline tests.
// No network, no real funds: an in-process mock NanUSD node stands in for
// the chain, and a toy claim-mode adapter proves the core is
// asset-agnostic (the same lifecycle the Nano and NEAR gates implement).
import { test } from "node:test";
import assert from "node:assert/strict";
import { blake2b } from "../src/nanusd/blake2b.mjs";
import { parseNanusdAddress, isValidNanusdAddress, nanusdAddressFromPublicKey } from "../src/nanusd/address.mjs";
import { createNanusdRpc, createMockNanusdNode } from "../src/nanusd/rpc.mjs";
import { createNanusdGate, nanusdPaymentView } from "../src/nanusd/gate.mjs";
import { createPaymentRoute } from "../src/pay/route-core.mjs";
import { parseUsdNano, usdNanoToAtomic, atomicToUsdNano } from "../src/pay/money.mjs";
import { endpointDiscovery } from "../src/discovery.mjs";
import { createRailRouter } from "../src/rail-router.mjs";

const GENESIS = "usd_1gzne9cau473gmnx3meopyi1trxiw4cu54bzkrm1p6khhpfinwj55k9d4eeq";

test("blake2b-512 matches the RFC 7693 vector", () => {
  assert.equal(blake2b(Buffer.from("abc"), 64).toString("hex"),
    "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");
});

test("the published NanUSD genesis account validates and round-trips", () => {
  const parsed = parseNanusdAddress(GENESIS);
  assert.equal(parsed.publicKey.length, 64);
  assert.equal(nanusdAddressFromPublicKey(parsed.publicKey), GENESIS);
});

test("wrong-network and corrupted addresses are refused", () => {
  assert.equal(isValidNanusdAddress(GENESIS.replace("usd_", "nano_")), false);
  assert.equal(isValidNanusdAddress(GENESIS.slice(0, -1) + "1"), false);
  assert.throws(() => createNanusdGate({
    rpc: createNanusdRpc({ transport: createMockNanusdNode().transport }),
    merchantAccount: GENESIS.replace("usd_", "nano_"), broadcast: async () => "x",
  }), /wrong network prefix/);
});

test("money: exact pair conversions floor/ceil as documented", () => {
  const pair = { usdNano: 2_500_000_000n, atomic: 1_000_000n }; // $2.50 per unit of 1e6 atomic
  assert.equal(parseUsdNano("3.64"), 3_640_000_000n);
  assert.equal(usdNanoToAtomic(5_000_000_000n, pair), 2_000_000n);
  assert.equal(atomicToUsdNano(2_000_000n, pair), 5_000_000_000n);
});

function nanusdFixture() {
  const mock = createMockNanusdNode();
  const rpc = createNanusdRpc({ transport: mock.transport });
  const payer = nanusdAddressFromPublicKey(blake2b(Buffer.from("test-payer"), 32));
  let seq = 0;
  const gate = createNanusdGate({
    rpc, merchantAccount: GENESIS,
    broadcast: async (entry) => {
      const hash = `TEST${(++seq).toString(16).padStart(60, "0")}`.toUpperCase();
      mock.recordOutbound({ hash, from: GENESIS, to: entry.to, amountRaw: entry.amountAtomic });
      return hash;
    },
  });
  return { mock, gate, payer };
}

test("nanusd: quote → detect → settle at cost+20% with NANUSD change and a three-leg receipt", async () => {
  const { mock, gate, payer } = nanusdFixture();
  const q = await gate.issueQuote({ tool: "run_noodle", usdEstimate: "0.50" });
  assert.match(q.id, /^uq_/);
  assert.equal(q.pair.source.startsWith("peg"), true);
  mock.injectSend({ hash: "PAY1".padEnd(64, "0"), from: payer, to: GENESIS, amountRaw: q.depositAtomic });
  assert.equal((await gate.detectPayments()).length, 1);
  const receipt = await gate.settle(q.id, { actualUsd: "0.30", runOk: true });
  assert.equal(receipt.chargedUsd, "0.36");
  assert.equal(receipt.legs.modelPayment.derived, true);
  assert.equal(receipt.legs.refund.kind, "change");
  assert.equal(receipt.legs.refund.to, payer);
  assert.equal(mock.outbound.length, 1);
  // Replay: same receipt object, no second send.
  assert.equal(await gate.settle(q.id, { actualUsd: "0.30", runOk: true }), receipt);
  assert.equal(mock.outbound.length, 1);
  const view = nanusdPaymentView(gate.quote(q.id));
  assert.equal(view.status, "settled");
  assert.equal(view.done, true);
});

test("nanusd: failed run refunds the full deposit; wrong amount never marks paid", async () => {
  const { mock, gate, payer } = nanusdFixture();
  const q = await gate.issueQuote({ tool: "sing", usdEstimate: "0.23" });
  mock.injectSend({ hash: "PAY2".padEnd(64, "0"), from: payer, to: GENESIS, amountRaw: q.depositAtomic });
  await gate.detectPayments();
  const r = await gate.settle(q.id, { actualUsd: "0", runOk: false });
  assert.equal(r.chargedUsd, "0");
  assert.equal(r.legs.refund.amountAtomic, q.depositAtomic);

  const q2 = await gate.issueQuote({ tool: "sing", usdEstimate: "0.10" });
  mock.injectSend({ hash: "PAY3".padEnd(64, "0"), from: payer, to: GENESIS, amountRaw: (BigInt(q2.depositAtomic) - 1n).toString() });
  assert.equal((await gate.detectPayments()).find((x) => x.id === q2.id), undefined);
  assert.equal(gate.quote(q2.id).status, "pending");
});

test("core: a claim-mode adapter with different units and a fetched rate runs the same lifecycle", async () => {
  const chain = new Map();
  const sent = [];
  let tag = 0;
  const route = createPaymentRoute({
    adapter: {
      rail: "toy", assets: ["toy"], idPrefix: "tq_", asset: "TOK6", network: "ToyNet",
      ttlMs: 30 * 60 * 1000, merchant: "tok_merchant_1", detection: "claim",
      validateAddress: (a) => { if (!String(a).startsWith("tok_")) throw new Error("bad toy address"); },
      formatAtomic: (a) => `${Number(a) / 1e6} TOK6`,
      rate: { current: async () => Object.freeze({ usdNano: 2_500_000_000n, atomic: 1_000_000n, source: "test-feed", at: null }) },
      tagging: { tag(base) { const t = BigInt(++tag) * 1000n; return { depositAtomic: base + t, tag: t.toString() }; } },
      async verifyClaim(q, { txHash }) {
        const tx = chain.get(txHash);
        if (!tx?.final) throw new Error("tx not final");
        if (tx.to !== q.merchant) throw new Error("wrong recipient");
        return { ref: txHash, payer: tx.from, amountAtomic: tx.amountAtomic };
      },
      sendBack: async (entry) => { sent.push(entry); return `BACK-${entry.idempotencyKey}`; },
    },
  });
  const q = await route.issueQuote({ tool: "run_noodle", usdEstimate: "5.00" });
  assert.equal(q.depositUsd, "5.0025");
  chain.set("TX1", { from: "tok_alice", to: "tok_merchant_1", amountAtomic: BigInt(q.depositAtomic), final: true });
  await route.confirmPayment(q.id, { txHash: "TX1" });
  const r = await route.settle(q.id, { actualUsd: "3.00", runOk: true });
  assert.equal(r.chargedUsd, "3.6");
  assert.equal(r.legs.refund.amountAtomic, (BigInt(q.depositAtomic) - 1_440_000n).toString());
  assert.equal(sent.length, 1);
  const q2 = await route.issueQuote({ tool: "run_noodle", usdEstimate: "5.00" });
  await assert.rejects(() => route.confirmPayment(q2.id, { txHash: "TX1" }), /already consumed/);
});

function fakeRegistry() {
  const tools = [
    { name: "run_noodle", description: "Run a workflow", inputSchema: { type: "object", properties: { graph: { type: "object" } } } },
    { name: "price_noodle", description: "Price a workflow", inputSchema: { type: "object", properties: {} } },
    { name: "sing", description: "Make a song", inputSchema: { type: "object", properties: { idea: { type: "string" } } } },
  ];
  const state = { runs: 0, freeCalls: [] };
  return {
    tools, state,
    listTools: () => tools,
    prepareCall: () => {},
    callTool: async (params) => {
      if (params.name === "run_noodle" || params.name === "sing") { state.runs++; return { content: [{ type: "text", text: "ran" }], costUsd: 0.30 }; }
      state.freeCalls.push(params);
      return { content: [{ type: "text", text: "priced" }] };
    },
  };
}

test("execution reuse: wrapRegistry sells tools through the nanusd gate — quote, pay, run once, settle, replay", async () => {
  const { mock, gate, payer } = nanusdFixture();
  const registry = fakeRegistry();
  const wrapped = gate.wrapRegistry(registry, { estimate: async () => "0.50", publicBase: "https://nanusd.nanoodle.com" });

  const listed = wrapped.listTools();
  const runTool = listed.find((t) => t.name === "run_noodle");
  assert.ok(runTool.inputSchema.properties._payment_id, "paid tool carries the payment field");
  assert.match(runTool.description, /paid in NANUSD/);
  assert.equal(wrapped.sells("run_noodle"), true);
  assert.equal(wrapped.railOnly.has("run_noodle"), true);

  // Free tools pass through untouched.
  const free = await wrapped.callTool({ name: "price_noodle", arguments: { graph: {} } });
  assert.equal(free.content[0].text, "priced");
  assert.equal(registry.state.runs, 0);

  // No payment id → a quote, nothing runs.
  const quote = await wrapped.callTool({ name: "run_noodle", arguments: { graph: {} } });
  const payment = quote.structuredContent.payment;
  assert.match(payment.paymentId, /^uq_/);
  assert.equal(payment.payUrl, `https://nanusd.nanoodle.com/nanusd/pay/${payment.paymentId}`);
  assert.equal(registry.state.runs, 0);

  // Pay the exact deposit, resume → runs once, settles at cost + 20%.
  const q = gate.quote(payment.paymentId);
  mock.injectSend({ hash: "PAY9".padEnd(64, "0"), from: payer, to: GENESIS, amountRaw: q.depositAtomic });
  const done = await wrapped.callTool({ name: "run_noodle", arguments: { graph: {}, _payment_id: payment.paymentId } });
  assert.equal(done.content[0].text, "ran");
  assert.equal(done.structuredContent.receipt.chargedUsd, "0.36");
  assert.equal(registry.state.runs, 1);

  // Replay returns the stored result; nothing runs or charges again.
  const replay = await wrapped.callTool({ name: "run_noodle", arguments: { graph: {}, _payment_id: payment.paymentId } });
  assert.equal(replay, done);
  assert.equal(registry.state.runs, 1);
});

test("router reuse: nanusd registers as the composition rail beside nano", async () => {
  const { gate } = nanusdFixture();
  const registry = fakeRegistry();
  const nanusd = gate.wrapRegistry(registry, { estimate: async () => "0.50" });
  const nanoTool = { name: "sing", description: "Make a song", inputSchema: { type: "object", properties: {} } };
  const nano = { listTools: () => [nanoTool], callTool: async () => ({ content: [{ type: "text", text: "nano" }] }) };
  const router = createRailRouter({ nano, nanusd });
  const R = (name, args) => router.route({ name, arguments: args });
  assert.equal(R("run_noodle", { graph: {} }).gate, "nanusd");
  assert.equal(R("sing", { _payment_id: "uq_abc" }).gate, "nanusd");
  assert.equal(R("sing", { _pay_with: "nanusd" }).gate, "nanusd");
  assert.equal(R("sing", { _payment_id: "pay_abc" }).gate, "nano");
  assert.equal(R("sing", {}).gate, "nano");
  assert.match(R("sing", { _pay_with: "near" }).refusal || "", /_pay_with must be "nano" or "nanusd"/);
  assert.match(R("run_noodle", { graph: {}, _pay_with: "nano" }).refusal || "", /does not accept Nano \(XNO\) payments/);
  const names = router.listTools().map((t) => t.name);
  assert.ok(names.includes("run_noodle") && names.includes("sing"));
  const quote = await router.callTool({ name: "run_noodle", arguments: { graph: {} } });
  assert.match(quote.structuredContent.payment.paymentId, /^uq_/);
  assert.throws(() => createRailRouter({ nano, near: { nearOnly: new Set() }, nanusd }), /alternative composition rails/);
});

test("discovery: the nanusd flavour names the asset, the network, and the guide", () => {
  const tools = [{ name: "sing", inputSchema: { properties: {} } }];
  const txt = endpointDiscovery({ name: "nanoodle-mcp", tools, publicBase: "https://nanusd.nanoodle.com", nanusd: true });
  assert.match(txt, /NanoUSD \(NANUSD\) on the NanUSD network/);
  assert.match(txt, /quotes: NanoUSD \(NANUSD\)/);
  assert.match(txt, /docs\/nanusd-payments\.md/);
  assert.doesNotMatch(txt, /takes NEAR/);
});
