import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableX402Boundary } from "../src/integrations/x402-boundary-store.mjs";
import { BOUNDARY_CONTRACT } from "../src/integrations/x402-exact-ingress.mjs";

const hex = c => c.repeat(64);
const RECEIPT = {
  success: true, network: "eip155:8453", transaction: `0x${"ab".repeat(32)}`,
  payer: "0x2222222222222222222222222222222222222222", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountAtomic: "10000", payTo: "0x1111111111111111111111111111111111111111",
  facilitatorId: "offline-fixture-only",
};

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "x402-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "boundary.json");
  const counts = { price: 0, execute: 0 };
  let time = 1_000_000;
  const make = () => createDurableX402Boundary({
    file, now: () => time,
    priceQuote: async () => {
      counts.price++;
      return {
        downstream: { asset: "XNO", unit: "raw", amountAtomic: "1000" }, ttlMs: 60_000,
        prices: [{ network: "eip155:8453", amountAtomic: "10000" }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amountAtomic: "10000" }],
      };
    },
    execute: options.execute ?? (async () => {
      counts.execute++;
      return { status: "completed", refund: { state: "not_required" },
        result: { isError: false, content: [{ type: "text", text: "protected output" }] } };
    }),
  });
  const boundary = make();
  assert.equal(boundary.contractVersion, BOUNDARY_CONTRACT);
  const identity = (over = {}) => ({
    fundingKey: hex("f"), quoteId: "quote-1", binding: hex("b"),
    authorizationKey: hex("a"), paymentDigest: hex("d"), ...over,
  });
  const quote = async (b = boundary) => b.issueQuote({
    request: { requestId: "req-1", customerScope: "cust", resource: { url: "https://offline.invalid/t", mimeType: "application/json" } },
    binding: hex("b"),
    buildRequirements: async ({ network, amountAtomic, maxTimeoutSeconds }) => ({
      scheme: "exact", network, asset: "USDC", payTo: "0x1111", amount: amountAtomic, maxTimeoutSeconds, extra: {},
    }),
  });
  // The real flow always issues (or re-reads) the quote before reserving:
  // prepare() binds the identity to the actually-issued quoteId.
  const prepare = async (b, id) => { const q = await quote(b); id.quoteId = q.quoteId; return id; };
  const reserve = async (b, id) => { await prepare(b, id); return b.reserve({ ...id, now: time, expiresAt: time + 60_000 }); };
  const begin = (b, id, reservationId) => b.beginSettlement({ ...id, reservationId, now: time, expiresAt: time + 60_000 });
  const settle = async (b, id, reservationId, receipt = RECEIPT) => {
    const r = await reserve(b, id); const g = await begin(b, id, r.reservationId ?? reservationId);
    return b.recordSettlement({ ...id, reservationId: g.reservation.reservationId, state: "settled", receipt });
  };
  return { boundary, make, counts, file, identity, quote, reserve, begin, settle, now: () => time };
}

test("quotes are priced once, persisted, and returned identically after restart", async t => {
  const s = await setup(t);
  const q1 = await s.quote();
  const q2 = await s.quote();
  assert.equal(q1.quoteId, q2.quoteId); assert.equal(s.counts.price, 1);
  const restarted = s.make();
  const q3 = await s.quote(restarted);
  assert.equal(q3.quoteId, q1.quoteId); assert.equal(s.counts.price, 1);
  assert.deepEqual(await restarted.lookupQuote({ binding: hex("b") }), q1);
  assert.equal(await restarted.lookupQuote({ binding: hex("e") }), null);
});

test("reserve is idempotent for identical identity and rejects identity drift", async t => {
  const s = await setup(t); const id = s.identity();
  const r1 = await s.reserve(s.boundary, id);
  const r2 = await s.reserve(s.boundary, id);
  assert.equal(r1.reservationId, r2.reservationId); assert.equal(r1.state, "reserved");
  await assert.rejects(s.reserve(s.boundary, s.identity({ paymentDigest: hex("9") })), /BOUNDARY_IDENTITY_MISMATCH/);
  await assert.rejects(s.boundary.reserve({ ...id, authorizationKey: hex("c"), now: s.now() + 120_000, expiresAt: s.now() + 60_000 }),
    /BOUNDARY_RESERVATION_EXPIRED/);
});

test("concurrent beginSettlement grants exactly one winner", async t => {
  const s = await setup(t); const id = s.identity();
  const r = await s.reserve(s.boundary, id);
  const results = await Promise.all(Array.from({ length: 20 }, () => s.begin(s.boundary, id, r.reservationId)));
  assert.equal(results.filter(x => x.granted).length, 1);
  const claim = await s.boundary.lookupFundingClaim({ fundingKey: id.fundingKey });
  assert.equal(claim.state, "settling"); assert.equal(claim.reservationId, r.reservationId);
});

test("a second authorization (fresh nonce / other network) cannot claim the same request funding", async t => {
  const s = await setup(t);
  const a = s.identity(), b = s.identity({ authorizationKey: hex("c"), paymentDigest: hex("e") });
  const ra = await s.reserve(s.boundary, a), rb = await s.reserve(s.boundary, b);
  const ga = await s.begin(s.boundary, a, ra.reservationId);
  assert.equal(ga.granted, true);
  const gb = await s.begin(s.boundary, b, rb.reservationId);
  assert.equal(gb.granted, false);
  assert.equal(gb.fundingClaim.authorizationKey, a.authorizationKey);
  // and the block survives a restart
  const restarted = s.make();
  const gb2 = await s.begin(restarted, b, rb.reservationId);
  assert.equal(gb2.granted, false); assert.equal(gb2.fundingClaim.claimId, ga.fundingClaim.claimId);
});

test("settlement is monotone: a late uncertain write never erases a settled receipt", async t => {
  const s = await setup(t); const id = s.identity();
  const r = await s.settle(s.boundary, id);
  assert.equal(r.state, "settled"); assert.equal(r.receipt.transaction, RECEIPT.transaction);
  const after = await s.boundary.recordSettlement({ ...id, reservationId: r.reservationId, state: "uncertain" });
  assert.equal(after.state, "settled"); assert.equal(after.receipt.transaction, RECEIPT.transaction);
  const claim = await s.boundary.lookupFundingClaim({ fundingKey: id.fundingKey });
  assert.equal(claim.state, "settled");
  // idempotent re-record of the same receipt is fine; a different tx is not
  const again = await s.boundary.recordSettlement({ ...id, reservationId: r.reservationId, state: "settled", receipt: RECEIPT });
  assert.equal(again.state, "settled");
  await assert.rejects(
    s.boundary.recordSettlement({ ...id, reservationId: r.reservationId, state: "settled", receipt: { ...RECEIPT, transaction: `0x${"cd".repeat(32)}` } }),
    /BOUNDARY_TX_CONFLICT/);
});

test("(network, transaction) is globally unique across quotes and authorizations", async t => {
  const s = await setup(t);
  await s.settle(s.boundary, s.identity());
  const other = s.identity({ fundingKey: hex("1"), quoteId: "quote-2", authorizationKey: hex("c"), paymentDigest: hex("e") });
  const r = await s.reserve(s.boundary, other);
  await s.begin(s.boundary, other, r.reservationId);
  await assert.rejects(
    s.boundary.recordSettlement({ ...other, reservationId: r.reservationId, state: "settled", receipt: RECEIPT }),
    /BOUNDARY_TX_CONFLICT/);
});

test("dispatch executes exactly once, caches the outcome, and replays it after restart", async t => {
  const s = await setup(t); const id = s.identity();
  const r = await s.settle(s.boundary, id);
  const input = { ...id, reservationId: r.reservationId, receipt: RECEIPT, request: { call: "x" } };
  const out1 = await s.boundary.dispatchSettled(input);
  assert.equal(out1.status, "completed"); assert.equal(s.counts.execute, 1);
  const out2 = await s.boundary.dispatchSettled(input);
  assert.deepEqual(out2, out1); assert.equal(s.counts.execute, 1);
  const restarted = s.make();
  const out3 = await restarted.dispatchSettled(input);
  assert.deepEqual(out3, out1); assert.equal(s.counts.execute, 1);
  const claim = await restarted.lookupFundingClaim({ fundingKey: id.fundingKey });
  assert.equal(claim.state, "dispatched");
  await assert.rejects(restarted.dispatchSettled({ ...input, receipt: { ...RECEIPT, amountAtomic: "999" } }),
    /BOUNDARY_RECEIPT_MISMATCH/);
});

test("a crashed/failed dispatch leaves a persisted intent and is never blindly re-run", async t => {
  let calls = 0;
  const s = await setup(t, { execute: async () => { calls++; throw new Error("executor died"); } });
  const id = s.identity();
  const r = await s.settle(s.boundary, id);
  const input = { ...id, reservationId: r.reservationId, receipt: RECEIPT, request: {} };
  await assert.rejects(s.boundary.dispatchSettled(input), /executor died/);
  assert.equal(calls, 1);
  await assert.rejects(s.boundary.dispatchSettled(input), /BOUNDARY_DISPATCH_INFLIGHT/);
  const restarted = s.make();
  await assert.rejects(restarted.dispatchSettled(input), /BOUNDARY_DISPATCH_INFLIGHT/);
  assert.equal(calls, 1);
});

test("corrupt, truncated or foreign-version state files fail closed at load", async t => {
  const s = await setup(t);
  await writeFile(s.file, "{not json");
  assert.throws(() => s.make(), /BOUNDARY_STATE_CORRUPT/);
  await writeFile(s.file, JSON.stringify({ version: 99, serial: 0, quotesByBinding: {}, reservationsByAuth: {}, fundingByKey: {}, txIndex: {}, outcomesByFunding: {}, dispatchIntents: {} }));
  assert.throws(() => s.make(), /BOUNDARY_STATE_CORRUPT/);
  await writeFile(s.file, "");
  assert.throws(() => s.make(), /BOUNDARY_STATE_CORRUPT/);
});

test("reconcileSettlement settles an uncertain reservation authoritatively, and only then", async t => {
  const s = await setup(t); const id = s.identity();
  const r = await s.reserve(s.boundary, id);
  await s.begin(s.boundary, id, r.reservationId);
  await s.boundary.recordSettlement({ ...id, reservationId: r.reservationId, state: "uncertain" });
  const settled = await s.boundary.reconcileSettlement({ ...id, reservationId: r.reservationId, receipt: RECEIPT });
  assert.equal(settled.state, "settled");
  await assert.rejects(s.boundary.reconcileSettlement({ ...id, reservationId: r.reservationId, receipt: RECEIPT }),
    /BOUNDARY_NOT_RECONCILABLE/);
});

test("refund state advances monotonically and refunded requires a canonical refundId", async t => {
  const s = await setup(t, { execute: async () => ({ status: "failed", refund: { state: "not_requested" } }) });
  const id = s.identity();
  const r = await s.settle(s.boundary, id);
  await s.boundary.dispatchSettled({ ...id, reservationId: r.reservationId, receipt: RECEIPT, request: {} });
  await assert.rejects(s.boundary.recordRefundState({ fundingKey: id.fundingKey, refund: { state: "refunded", refundId: "rf-1" } }),
    /BOUNDARY_REFUND_TRANSITION/); // cannot skip pending
  await s.boundary.recordRefundState({ fundingKey: id.fundingKey, refund: { state: "pending" } });
  await assert.rejects(s.boundary.recordRefundState({ fundingKey: id.fundingKey, refund: { state: "refunded" } }),
    /BOUNDARY_REFUND_INVALID/);
  const done = await s.boundary.recordRefundState({ fundingKey: id.fundingKey, refund: { state: "refunded", refundId: "rf-1" } });
  assert.equal(done.refund.state, "refunded"); assert.equal(done.refund.refundId, "rf-1");
  await assert.rejects(s.boundary.recordRefundState({ fundingKey: id.fundingKey, refund: { state: "pending" } }),
    /BOUNDARY_REFUND_TRANSITION/);
  const restarted = s.make();
  await assert.rejects(restarted.recordRefundState({ fundingKey: hex("7"), refund: { state: "pending" } }),
    /BOUNDARY_OUTCOME_MISSING/);
});
