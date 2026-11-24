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

test("discovery: the nanusd flavour names the asset, the network, and the guide", () => {
  const tools = [{ name: "sing", inputSchema: { properties: {} } }];
  const txt = endpointDiscovery({ name: "nanoodle-mcp", tools, publicBase: "https://nanusd.nanoodle.com", nanusd: true });
  assert.match(txt, /NanoUSD \(NANUSD\) on the NanUSD network/);
  assert.match(txt, /quotes: NanoUSD \(NANUSD\)/);
  assert.match(txt, /docs\/nanusd-payments\.md/);
  assert.doesNotMatch(txt, /takes NEAR/);
});
