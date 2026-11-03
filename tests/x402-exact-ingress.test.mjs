import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { loadTools } from "../src/tools.mjs";
import { createDispatcher } from "../src/server.mjs";
import { createX402ExactIngress, BASE, SOLANA, canonical } from "../src/integrations/x402-exact-ingress.mjs";
import { sdkPayload, verifyOffline, evmSigner, svmSigner, svmSeller, svmFeePayer } from "./fixtures/x402/sdk-fixtures.mjs";

const clone = x => JSON.parse(JSON.stringify(x));
const digest = x => createHash("sha256").update(canonical(x)).digest("hex");
const params = { name: "hello-noodle", arguments: { Name: "Ada" } };
const secret = "SECRET upstream request contents";
function harness(options = {}) {
  let time = Date.now(), serial = 0;
  const quotes = new Map(), reservations = new Map(), deliveries = new Map();
  const counts = { verify: 0, settle: 0, dispatch: 0, prepare: 0, quote: 0, supported: 0 };
  const ctx = { requestId: "server-request-1", customerScope: "authenticated-customer", workflowDigest: "a".repeat(64),
    resource: { url: "https://offline.invalid/tools/hello-noodle", mimeType: "application/json" } };
  const routes = options.routes ?? [{ network: BASE, payTo: "0x1111111111111111111111111111111111111111" },
    { network: SOLANA, payTo: svmSeller.address }];
  const supported = { kinds: routes.map(r => ({ x402Version: 2, scheme: "exact", network: r.network,
    ...(r.network === SOLANA ? { extra: { feePayer: svmFeePayer.address } } : {}) })), extensions: [], signers: {} };
  const boundary = {
    async issueQuote({ request, binding, buildRequirements }) {
      counts.quote++;
      const previous = quotes.get(request.requestId);
      if (previous) { assert.equal(previous.binding, binding); return clone(previous); }
      const q = { quoteId: `quote-${++serial}`, binding, resource: request.resource, issuedAt: time, expiresAt: time + 60_000,
        downstream: { asset: "XNO", unit: "raw", amountAtomic: "1000000000000000000000000000" },
        requirements: await Promise.all(routes.map(r => buildRequirements({ network: r.network, amountAtomic: "10000", maxTimeoutSeconds: 60 }))) };
      quotes.set(request.requestId, clone(q)); return clone(q);
    },
    async lookupQuote({ request, binding }) { const q = quotes.get(request.requestId); assert.equal(q.binding, binding); return clone(q); },
    async lookupReservation(input) {
      const r = reservations.get(input.authorizationKey); return r ? clone(r) : null;
    },
    // Test-only memory implementation. Production MUST implement these as
    // durable transactions, including global authorization/receipt uniqueness.
    async reserve(input) {
      const existing = reservations.get(input.authorizationKey);
      if (existing) {
        for (const k of ["quoteId", "binding", "paymentDigest"]) assert.equal(existing[k], input[k]);
        return clone(existing);
      }
      assert.ok(input.now < input.expiresAt);
      const { quoteId, binding, authorizationKey, paymentDigest } = input;
      const r = { quoteId, binding, authorizationKey, paymentDigest, reservationId: `r-${++serial}`, state: "reserved" };
      reservations.set(authorizationKey, r); return clone(r);
    },
    async beginSettlement(input) {
      const r = reservations.get(input.authorizationKey);
      const granted = r.state === "reserved" && input.now < input.expiresAt;
      if (granted) r.state = "settling";
      return { granted, reservation: clone(r) };
    },
    async recordSettlement(input) {
      const r = reservations.get(input.authorizationKey);
      // Monotone: a late uncertain write cannot erase authoritative settlement.
      if (r.state !== "settled" && r.state !== "dispatched") {
        r.state = input.state;
        if (input.receipt) r.receipt = clone(input.receipt);
      }
      return clone(r);
    },
    async dispatchSettled(input) {
      const r = reservations.get(input.authorizationKey);
      assert.ok(["settled", "dispatched"].includes(r.state));
      assert.equal(digest(input.receipt), digest(r.receipt));
      if (!deliveries.has(r.reservationId)) {
        counts.dispatch++;
        deliveries.set(r.reservationId, { content: [{ type: "text", text: "offline protected output" }] });
      }
      r.state = "dispatched";
      return clone(deliveries.get(r.reservationId));
    },
  };
  const facilitator = {
    async getSupported() { counts.supported++; return clone(supported); },
    async verify(payload, requirements) { counts.verify++; return verifyOffline(payload, requirements); },
    async settle(payload, requirements) {
      counts.settle++;
      // Scripted authoritative RESPONSE, not a real settlement.
      return { success: true, network: requirements.network,
        transaction: requirements.network === BASE ? `0x${"ab".repeat(32)}` : "2".repeat(88),
        payer: requirements.network === BASE ? evmSigner.address : svmSigner.address };
    },
  };
  const registry = { listTools: () => [{ name: params.name }, { name: "run_noodle" }],
    async prepareCall(input) { counts.prepare++; assert.equal(input.name, params.name); assert.deepEqual(input.arguments, params.arguments); },
    callTool() { assert.fail("ingress must never invoke the unguarded registry executor"); } };
  const settings = { registry, resolveContext: () => clone(ctx), boundary, facilitator, facilitatorId: "offline-fixture-only",
    routes, clock: () => time, timeoutMs: options.timeoutMs ?? 1000, capabilityTtlMs: 1000 };
  function fresh() { return createX402ExactIngress(settings); }
  const app = fresh();
  return { app, fresh, settings, boundary, facilitator, registry, ctx, supported, counts, quotes, reservations,
    advance: ms => { time += ms; },
    quote: () => app.handle({ params }),
    async payment(network = BASE) {
      const quote = await app.handle({ params }); assert.equal(quote.status, 402); assert.ok(quote.headers, JSON.stringify(quote));
      const payload = await sdkPayload(quote.body.accepts.find(r => r.network === network), quote.body.resource);
      return { payload, paymentSignature: encodePaymentSignatureHeader(payload) };
    },
  };
}

for (const network of [BASE, SOLANA]) {
  test(`${network}: official SDK challenge, signed payment, settlement-before-dispatch and restart replay`, async () => {
    const h = harness(); const payment = await h.payment(network);
    assert.ok(PaymentRequiredV2Schema.safeParse((await h.quote()).body).success);
    assert.deepEqual(decodePaymentRequiredHeader((await h.quote()).headers["PAYMENT-REQUIRED"]), (await h.quote()).body);
    const request = { params, paymentSignature: payment.paymentSignature };
    const result = await h.app.handle(request);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.content[0].text, "offline protected output");
    assert.equal(result.receipt.amountAtomic, "10000");
    assert.equal(result.receipt.network, network);
    assert.equal(result.receipt.facilitatorId, "offline-fixture-only");
    assert.equal(decodePaymentResponseHeader(result.headers["PAYMENT-RESPONSE"]).success, true);
    h.advance(70_000); // an already settled quote remains replayable
    const replay = await h.fresh().handle(request);
    assert.equal(replay.status, 200); assert.deepEqual(replay.body, result.body);
    assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
  });
}
test("concurrent retries grant exactly one settlement and one dispatch", async () => {
  const h = harness(), { paymentSignature } = await h.payment();
  const results = await Promise.all(Array.from({ length: 12 }, () => h.fresh().handle({ params, paymentSignature })));
  assert.ok(results.some(r => r.status === 200));
  assert.ok(results.every(r => [200, 202].includes(r.status)), JSON.stringify(results));
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
});
test("Solana signature changes cannot disguise a previously reserved message", async () => {
  const h = harness(), { payload, paymentSignature } = await h.payment(SOLANA);
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 200);
  const original = [...h.reservations.values()][0].authorizationKey;
  // Flip one fee-payer signature byte; leave the message identical. The exact
  // payload digest changes, but global replay identity must stay the same.
  const bytes = Buffer.from(payload.payload.transaction, "base64"); bytes[1] ^= 1;
  payload.payload.transaction = bytes.toString("base64");
  assert.equal((await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) })).status, 402);
  assert.deepEqual([...h.reservations.keys()], [original]);
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
});
test("a malformed Solana transaction is rejected before verification", async () => {
  const h = harness(), { payload } = await h.payment(SOLANA);
  payload.payload.transaction = Buffer.from([1, 2, 3]).toString("base64");
  assert.equal((await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) })).status, 402);
  assert.equal(h.counts.verify, 0); assert.equal(h.counts.settle, 0);
});
test("the actual registry prepareCall and MCP dispatcher accept the opt-in seam without running a workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x402-ingress-"));
  try {
    const registry = await loadTools({ dirs: [new URL("./fixtures", import.meta.url).pathname], outDir: directory, log() {} });
    const h = harness(); h.settings.registry = registry;
    const app = h.fresh();
    const dispatch = createDispatcher({ name: "offline-x402", version: "0", commit: null, listTools: () => registry.listTools(),
      callTool: async params => { const response = await app.handle({ params }); return { content: [], structuredContent: response }; } });
    const tool = registry.listTools().find(t => t.name === "hello-noodle"); assert.ok(tool);
    const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello-noodle", arguments: { Idea: "Ada" } } });
    assert.equal(response.result.structuredContent.status, 402);
    assert.ok(response.result.structuredContent.headers?.["PAYMENT-REQUIRED"], JSON.stringify(response));
    assert.equal(h.counts.settle, 0); assert.equal(h.counts.dispatch, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("unknown networks, wildcard/v1 capabilities and revoked capabilities fail closed", async () => {
  assert.throws(() => harness({ routes: [{ network: "eip155:1", payTo: "0x1111111111111111111111111111111111111111" }] }), /UNSUPPORTED_NETWORK/);
  for (const kind of [{ x402Version: 1, scheme: "exact", network: BASE }, { x402Version: 2, scheme: "exact", network: "eip155:*" },
    { x402Version: 2, scheme: "upto", network: BASE }]) {
    const h = harness(); h.supported.kinds = [kind];
    assert.equal((await h.quote()).status, 402); assert.equal(h.counts.settle, 0);
  }
  const h = harness(), { paymentSignature } = await h.payment();
  h.supported.kinds = h.supported.kinds.filter(k => k.network !== BASE); h.advance(1001);
  assert.equal((await h.app.handle({ params, paymentSignature })).body.code, "NETWORK_UNAVAILABLE");
  assert.equal(h.counts.verify, 0); assert.equal(h.counts.settle, 0);
});
test("client alterations cannot redirect asset, network, amount, recipient, resource, timeout or mode", async t => {
  for (const mutate of [p => p.accepted.amount = "1", p => p.accepted.asset = "fake", p => p.accepted.network = "eip155:1",
    p => p.accepted.payTo = evmSigner.address, p => p.accepted.maxTimeoutSeconds++, p => p.resource.url += "/other",
    p => p.accepted.extra.paymentFlow = "upfront", p => p.accepted.extra.assetTransferMethod = "permit2",
    p => p.x402Version = 1, p => p.extensions = { unknown: {} }]) {
    await t.test(String(mutate), async () => {
      const h = harness(), { payload } = await h.payment(); mutate(payload);
      const r = await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) });
      assert.equal(r.status, 402); assert.equal(h.counts.verify, 0); assert.equal(h.counts.settle, 0);
    });
  }
});
test("altering the signed authorization or signature fails real offline signature verification", async () => {
  for (const mutate of [p => p.payload.authorization.validAfter = "1", p => p.payload.signature = `0x${"11".repeat(65)}`]) {
    const h = harness(), { payload } = await h.payment(); mutate(payload);
    const result = await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) });
    assert.equal(result.status, 402); assert.equal(h.counts.settle, 0); assert.equal(h.counts.dispatch, 0);
  }
});
test("invalid signatures cannot poison the legitimate payer's global replay reservation", async () => {
  const h = harness(), { payload, paymentSignature } = await h.payment();
  payload.payload.authorization.validAfter = "1";
  assert.equal((await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) })).status, 402);
  assert.equal(h.reservations.size, 0);
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 200);
  assert.equal(h.counts.settle, 1);
});
test("replay across a different request/quote is rejected by global authorization identity", async () => {
  const h = harness(), { payload, paymentSignature } = await h.payment();
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 200);
  h.ctx.requestId = "second-server-request";
  const next = await h.quote(); payload.accepted = next.body.accepts[0]; payload.resource = next.body.resource;
  const result = await h.app.handle({ params, paymentSignature: encodePaymentSignatureHeader(payload) });
  assert.equal(result.status, 402); assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
});
test("changing customer, workflow or arguments cannot reuse a canonical quote", async () => {
  for (const mutate of [h => h.ctx.customerScope = "other", h => h.ctx.workflowDigest = "b".repeat(64)]) {
    const h = harness(), { paymentSignature } = await h.payment(); mutate(h);
    assert.equal((await h.app.handle({ params, paymentSignature })).status, 402); assert.equal(h.counts.settle, 0);
  }
  const h = harness(), { paymentSignature } = await h.payment();
  assert.equal((await h.app.handle({ params: { ...params, arguments: { Name: "different" } }, paymentSignature })).status, 402);
});
test("expired unpaid quotes and forged server quotes never reach settlement", async () => {
  const h = harness(), { paymentSignature } = await h.payment(); h.advance(60_000);
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 402); assert.equal(h.counts.settle, 0);
  for (const mutate of [q => q.requirements[0].asset = "fake", q => q.requirements[0].extra.name = "wrong",
    q => q.expiresAt += 600_000, q => q.downstream.asset = "USDC"]) {
    const h = harness(), { paymentSignature } = await h.payment(); mutate(h.quotes.get(h.ctx.requestId));
    assert.equal((await h.app.handle({ params, paymentSignature })).status, 402); assert.equal(h.counts.settle, 0);
  }
});
test("verification is not settlement; invalid verification cannot dispatch", async () => {
  const h = harness(), { paymentSignature } = await h.payment();
  h.facilitator.verify = async () => ({ isValid: false, invalidMessage: secret });
  const result = await h.app.handle({ params, paymentSignature });
  assert.equal(result.status, 402); assert.equal(h.counts.settle, 0); assert.equal(h.counts.dispatch, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
});
test("caller payer binding cannot be replaced by facilitator's reported payer", async () => {
  const h = harness(); h.ctx.payer = "0x2222222222222222222222222222222222222222";
  const { paymentSignature } = await h.payment();
  assert.equal((await h.app.handle({ params, paymentSignature })).body.code, "PAYMENT_REJECTED");
  assert.equal(h.counts.settle, 0);
});
test("lost settlement response stays uncertain across new adapter instances; no automatic retry", async () => {
  const h = harness(), { paymentSignature } = await h.payment();
  h.facilitator.settle = async () => { h.counts.settle++; throw new Error(secret); };
  for (let i = 0; i < 3; i++) {
    const r = await h.fresh().handle({ params, paymentSignature });
    assert.equal(r.status, 202); assert.equal(r.body.code, "SETTLEMENT_UNCERTAIN"); assert.ok(!JSON.stringify(r).includes(secret));
  }
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 0);
});
test("a lost durable intent response blocks another attempt even though no settlement call was observed", async () => {
  const h = harness(), { paymentSignature } = await h.payment(), begin = h.boundary.beginSettlement;
  h.boundary.beginSettlement = async input => { await begin(input); throw new Error(secret); };
  const first = await h.app.handle({ params, paymentSignature });
  assert.equal(first.status, 202); assert.equal(first.body.code, "SETTLEMENT_UNCERTAIN"); assert.ok(!JSON.stringify(first).includes(secret));
  assert.equal((await h.fresh().handle({ params, paymentSignature })).body.code, "SETTLEMENT_UNCERTAIN");
  assert.equal(h.counts.settle, 0); assert.equal(h.counts.dispatch, 0);
});
test("a lost downstream response is uncertain and replay cannot spend or charge twice", async () => {
  const h = harness(), { paymentSignature } = await h.payment(), dispatch = h.boundary.dispatchSettled;
  h.boundary.dispatchSettled = async input => { await dispatch(input); throw new Error(secret); };
  const first = await h.app.handle({ params, paymentSignature });
  assert.equal(first.status, 202); assert.equal(first.body.code, "DISPATCH_UNCERTAIN");
  assert.ok(first.receipt.transaction); assert.ok(!JSON.stringify(first).includes(secret));
  h.boundary.dispatchSettled = dispatch;
  assert.equal((await h.fresh().handle({ params, paymentSignature })).status, 200);
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
});
test("reconciled settled state requires a bound receipt before protected dispatch", async () => {
  const h = harness(), { paymentSignature } = await h.payment();
  h.facilitator.settle = async () => { h.counts.settle++; throw new Error(secret); };
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 202);
  const r = [...h.reservations.values()][0]; r.state = "settled";
  r.receipt = { success: true, transaction: `0x${"ab".repeat(32)}` };
  assert.equal((await h.fresh().handle({ params, paymentSignature })).body.code, "INVALID_SETTLEMENT_RECEIPT");
  assert.equal(h.counts.dispatch, 0); assert.equal(h.counts.settle, 1);
});
test("authoritatively reconciled settlement can resume dispatch without another charge", async () => {
  const h = harness(), { payload, paymentSignature } = await h.payment();
  h.facilitator.settle = async () => { h.counts.settle++; throw new Error(secret); };
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 202);
  const r = [...h.reservations.values()][0], q = h.quotes.get(h.ctx.requestId), req = q.requirements[0];
  await h.boundary.recordSettlement({ ...r, state: "settled", receipt: {
    quoteId: r.quoteId, binding: r.binding, authorizationKey: r.authorizationKey, paymentDigest: r.paymentDigest,
    success: true, network: BASE, transaction: `0x${"ab".repeat(32)}`, payer: payload.payload.authorization.from,
    asset: req.asset, amountAtomic: req.amount, payTo: req.payTo, facilitatorId: "offline-fixture-only",
  } });
  h.advance(70_000);
  assert.equal((await h.fresh().handle({ params, paymentSignature })).status, 200);
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 1);
});
test("settlement failure, wrong network/amount/payer/transaction and non-durable recording cannot release output", async t => {
  for (const change of [{ success: false }, { network: SOLANA }, { amount: "9999" }, { transaction: "" },
    { payer: "0x2222222222222222222222222222222222222222" }]) {
    await t.test(JSON.stringify(change), async () => {
      const h = harness(), { paymentSignature } = await h.payment(), settle = h.facilitator.settle;
      h.facilitator.settle = async (...args) => ({ ...await settle(...args), ...change });
      assert.equal((await h.app.handle({ params, paymentSignature })).status, 202); assert.equal(h.counts.dispatch, 0);
    });
  }
  const h = harness(), { paymentSignature } = await h.payment(); h.boundary.recordSettlement = async () => { throw new Error(secret); };
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 202);
  assert.equal((await h.fresh().handle({ params, paymentSignature })).status, 202);
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 0);
});
test("timeout and cancellation during settlement preserve intent, ignoring late success", async () => {
  for (const cancel of [false, true]) {
    const h = harness({ timeoutMs: 50 }), { paymentSignature } = await h.payment();
    let finish, started;
    const start = new Promise(resolve => { started = resolve; });
    h.facilitator.settle = async () => { h.counts.settle++; started(); return new Promise(resolve => { finish = resolve; }); };
    const controller = new AbortController();
    const pending = h.app.handle({ params, paymentSignature, signal: controller.signal });
    await start; if (cancel) controller.abort();
    assert.equal((await pending).status, 202);
    finish({ success: true, network: BASE, transaction: `0x${"ab".repeat(32)}`, payer: evmSigner.address });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.fresh().handle({ params, paymentSignature })).body.code, "SETTLEMENT_UNCERTAIN");
    assert.equal(h.counts.settle, 1); assert.equal(h.counts.dispatch, 0);
  }
});
test("cancellation before intent and expiry during verification make no settlement attempt", async () => {
  const h = harness(), { paymentSignature } = await h.payment(), c = new AbortController(); c.abort();
  assert.equal((await h.app.handle({ params, paymentSignature, signal: c.signal })).status, 499);
  const verify = h.facilitator.verify;
  h.facilitator.verify = async (...args) => { const result = await verify(...args); h.advance(60_000); return result; };
  assert.equal((await h.app.handle({ params, paymentSignature })).body.code, "QUOTE_EXPIRED");
  assert.equal(h.counts.settle, 0);
});
test("safe registry/storage errors and mixed payment metadata fail without workflow execution", async () => {
  const h = harness(); h.registry.prepareCall = async () => { throw new Error(secret); };
  const result = await h.quote(); assert.equal(result.body.code, "INGRESS_REJECTED"); assert.ok(!JSON.stringify(result).includes(secret));
  for (const args of [{ ...params.arguments, _payment_id: "nano" }, { ...params.arguments, _near_payment: {} }]) {
    const h = harness(); assert.equal((await h.app.handle({ params: { ...params, arguments: args } })).body.code, "INVALID_ARGUMENTS");
    assert.equal(h.counts.quote, 0);
  }
  assert.equal((await harness().app.handle({ params: { name: "run_noodle" } })).body.code, "UNKNOWN_TOOL");
});
test("invalid or oversized payment headers fail closed", async () => {
  for (const value of [null, "garbage", "A".repeat(16_385)]) {
    const h = harness(); await h.quote();
    assert.equal((await h.app.handle({ params, paymentSignature: value })).status, 402); assert.equal(h.counts.settle, 0);
  }
});
