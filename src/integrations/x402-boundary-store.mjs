// Durable implementation of the nanoodle-x402-boundary/v2 contract consumed
// by src/integrations/x402-exact-ingress.mjs. The #91 draft shipped the
// adapter against an in-memory test fixture and named this service as the
// missing prerequisite; this module is that service.
//
// Design constraints, in order:
//  1. NEVER lose replay protection. State lives in one private JSON file
//     replaced through writePrivateStateSync (staging file, fsync, atomic
//     rename, directory fsync) — the same primitive the Nano checkpoint
//     store uses. A mutation returns only after its state is durable.
//  2. Fail closed. A corrupt/short state file throws at load instead of
//     resetting (a reset would silently re-enable every spent nonce). A
//     durability-uncertain write poisons the instance: every later
//     operation throws rather than trusting possibly-unpersisted state.
//  3. One transaction per grant. beginSettlement claims the request's
//     funding AND flips its authorization reserved->settling in a single
//     synchronous critical section that persists before returning, so two
//     processes/retries/networks can never both win one request.
//  4. Monotone settlement. settled/dispatched are terminal for settlement
//     writes; a late "uncertain" can never erase an authoritative receipt.
//     (network, transaction) is globally unique across all quotes.
//  5. Dispatch exactly once or never silently twice. The dispatch intent
//     is persisted BEFORE the injected executor runs; a crash or lost reply
//     leaves an intent with no outcome, and redispatch throws
//     DISPATCH_INFLIGHT (the adapter maps that to 202 DISPATCH_UNCERTAIN)
//     until an operator reconciles. The executor is never re-run blind.
//
// Single-writer: operations are serialized on an internal promise chain and
// every critical section is synchronous, so one process instance is safe
// under arbitrary concurrency. Cross-process writers must hold the repo's
// writer lock (src/process-lock.mjs) for the state file — the store does
// not silently share a file between live instances.
//
// This module performs no network, wallet, FX or refund TRANSFER work. The
// operator injects `priceQuote` (authoritative USDC pricing + downstream
// XNO budget) and `execute` (the established Nano-funded workflow executor
// returning the v2 typed outcome envelope). Refund STATE is recorded here;
// moving refund money is a separate, operator-owned policy.

import { existsSync, readFileSync } from "node:fs";
const sha256 = text => createHash("sha256").update(text).digest("hex");
import { createHash } from "node:crypto";
import { writePrivateStateSync } from "../private-state.mjs";
import { BOUNDARY_CONTRACT, canonical } from "./x402-exact-ingress.mjs";

const STATE_VERSION = 1;
const SETTLEMENT_RANK = { reserved: 0, settling: 1, uncertain: 2, settled: 3, dispatched: 4 };
const REFUND_FLOW = {
  not_requested: ["pending", "uncertain"],
  pending: ["refunded", "uncertain"],
  uncertain: ["pending", "refunded"],
  refunded: [],
  not_required: [],
};
const REFUND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class BoundaryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new BoundaryError(code); };
const clone = x => x === null || x === undefined ? x : JSON.parse(canonical(x));
const digest = x => createHash("sha256").update(canonical(x)).digest("hex");
const isHex64 = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);

function emptyState() {
  return {
    version: STATE_VERSION, serial: 0,
    quotesByBinding: {}, reservationsByAuth: {}, fundingByKey: {},
    txIndex: {}, outcomesByFunding: {}, dispatchIntents: {},
  };
}

function loadState(file) {
  if (!existsSync(file)) return { state: emptyState(), fingerprint: null };
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { fail("BOUNDARY_STATE_CORRUPT"); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { fail("BOUNDARY_STATE_CORRUPT"); }
  const ok = parsed && parsed.version === STATE_VERSION && Number.isSafeInteger(parsed.serial)
    && ["quotesByBinding", "reservationsByAuth", "fundingByKey", "txIndex", "outcomesByFunding", "dispatchIntents"]
      .every(k => parsed[k] && typeof parsed[k] === "object" && !Array.isArray(parsed[k]));
  if (!ok) fail("BOUNDARY_STATE_CORRUPT");
  return { state: parsed, fingerprint: sha256(raw) };
}

const IDENTITY_KEYS = ["fundingKey", "quoteId", "binding", "authorizationKey", "paymentDigest"];
function assertIdentity(record, input) {
  for (const k of IDENTITY_KEYS) if (record[k] !== input[k]) fail("BOUNDARY_IDENTITY_MISMATCH");
}

export function createDurableX402Boundary({ file, priceQuote, execute, now = Date.now }) {
  if (typeof file !== "string" || !file) fail("BOUNDARY_FILE_REQUIRED");
  if (typeof priceQuote !== "function") fail("BOUNDARY_PRICE_QUOTE_REQUIRED");
  if (typeof execute !== "function") fail("BOUNDARY_EXECUTOR_REQUIRED");
  const loaded = loadState(file);
  let state = loaded.state;
  // Fingerprint of the exact bytes this instance loaded or last wrote. If
  // the file changes underneath us (a second live writer, a restore, a
  // manual edit), the next persist fails closed instead of overwriting
  // the other writer's grants with our stale whole-file snapshot.
  let fingerprint = loaded.fingerprint;
  let poisoned = null;
  let chain = Promise.resolve();
  // Serialize every operation; critical sections below never await between
  // check and persist, so a grant is atomic w.r.t. all other operations.
  const run = fn => {
    const result = chain.then(() => {
      if (poisoned) throw poisoned;
      return fn();
    });
    chain = result.then(() => {}, () => {});
    return result;
  };
  function persist(mutate) {
    const backup = clone(state);
    try {
      if (fingerprint === null ? existsSync(file) : (!existsSync(file) || sha256(readFileSync(file, "utf8")) !== fingerprint)) {
        poisoned = new BoundaryError("BOUNDARY_STATE_CHANGED");
        throw poisoned;
      }
      mutate(state);
      const text = JSON.stringify(state) + "\n";
      writePrivateStateSync(file, text);
      fingerprint = sha256(text);
    } catch (error) {
      if (error?.code === "BOUNDARY_STATE_CHANGED") throw error;
      if (error?.code === "STATE_DURABILITY_UNCERTAIN") {
        // The replacement may be visible but unconfirmed: trust nothing.
        poisoned = error;
        throw new BoundaryError("BOUNDARY_DURABILITY_UNCERTAIN");
      }
      state = backup; // staging failed before the rename: nothing changed
      throw error;
    }
  }
  const reservationOf = input => {
    const r = state.reservationsByAuth[input.authorizationKey];
    if (!r) fail("BOUNDARY_RESERVATION_MISSING");
    assertIdentity(r, input);
    return r;
  };
  const claimOf = input => {
    const c = state.fundingByKey[input.fundingKey];
    if (!c) fail("BOUNDARY_FUNDING_CLAIM_MISSING");
    assertIdentity(c, input);
    return c;
  };

  return {
    contractVersion: BOUNDARY_CONTRACT,

    async issueQuote({ request, binding, buildRequirements }) {
      return run(async () => {
        const existing = state.quotesByBinding[binding];
        if (existing) return clone(existing);
        const priced = await priceQuote({ request: clone(request), binding });
        if (!priced || !Array.isArray(priced.prices) || priced.prices.length === 0
          || priced.downstream?.asset !== "XNO" || priced.downstream?.unit !== "raw"
          || typeof priced.downstream?.amountAtomic !== "string") fail("BOUNDARY_PRICING_INVALID");
        const issuedAt = now();
        const ttlSeconds = priced.ttlSeconds ?? 60;
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 300) fail("BOUNDARY_PRICING_INVALID");
        if (new Set(priced.prices.map(p => p?.network)).size !== priced.prices.length) fail("BOUNDARY_PRICING_INVALID");
        const requirements = [];
        for (const p of priced.prices) {
          const built = await buildRequirements({
            network: p.network, amountAtomic: p.amountAtomic, maxTimeoutSeconds: ttlSeconds,
          });
          if (!built || built.network !== p.network) fail("BOUNDARY_PRICING_INVALID");
          requirements.push(built);
        }
        let quote;
        persist(s => {
          quote = {
            quoteId: priced.quoteId ?? `quote-${++s.serial}`, binding,
            resource: clone(request.resource), issuedAt, expiresAt: issuedAt + ttlSeconds * 1000,
            downstream: clone(priced.downstream), requirements: clone(requirements),
          };
          s.quotesByBinding[binding] = quote;
        });
        return clone(quote);
      });
    },

    async lookupQuote({ binding }) {
      return run(() => clone(state.quotesByBinding[binding] ?? null));
    },

    async lookupReservation({ authorizationKey }) {
      return run(() => clone(state.reservationsByAuth[authorizationKey] ?? null));
    },

    async lookupFundingClaim({ fundingKey }) {
      return run(() => clone(state.fundingByKey[fundingKey] ?? null));
    },

    async reserve(input) {
      return run(() => {
        const quote = state.quotesByBinding[input.binding];
        if (!quote || quote.quoteId !== input.quoteId) fail("BOUNDARY_QUOTE_MISMATCH");
        const existing = state.reservationsByAuth[input.authorizationKey];
        if (existing) { assertIdentity(existing, input); return clone(existing); }
        if (!(input.now < input.expiresAt) || input.expiresAt - input.now > 300_000) fail("BOUNDARY_RESERVATION_EXPIRED");
        let record;
        persist(s => {
          record = {
            fundingKey: input.fundingKey, quoteId: input.quoteId, binding: input.binding,
            authorizationKey: input.authorizationKey, paymentDigest: input.paymentDigest,
            reservationId: `reservation-${++s.serial}`, state: "reserved", expiresAt: input.expiresAt,
          };
          s.reservationsByAuth[input.authorizationKey] = record;
        });
        return clone(record);
      });
    },

    async beginSettlement(input) {
      return run(() => {
        const r = reservationOf(input);
        if (r.reservationId !== input.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        const claim = state.fundingByKey[input.fundingKey];
        if (claim) {
          // Funding is already claimed — by this authorization (lost reply /
          // retry: verify the full identity) or by a different one (fresh
          // nonce, other network: return the winning claim untouched).
          // Either way no second grant exists.
          if (claim.authorizationKey === input.authorizationKey) assertIdentity(claim, input);
          return { granted: false, reservation: clone(r), fundingClaim: clone(claim) };
        }
        if (r.state !== "reserved" || !(input.now < input.expiresAt)) {
          // No grant and no claim to report: the adapter treats a throw here
          // as SETTLEMENT_UNCERTAIN, which is the honest fail-closed answer.
          fail("BOUNDARY_NO_GRANT");
        }
        let granted;
        persist(s => {
          const rr = s.reservationsByAuth[input.authorizationKey];
          rr.state = "settling";
          const c = {
            fundingKey: rr.fundingKey, quoteId: rr.quoteId, binding: rr.binding,
            authorizationKey: rr.authorizationKey, paymentDigest: rr.paymentDigest,
            reservationId: rr.reservationId, claimId: `claim-${++s.serial}`, state: "settling",
          };
          s.fundingByKey[rr.fundingKey] = c;
          granted = { reservation: clone(rr), fundingClaim: clone(c) };
        });
        return { granted: true, ...granted };
      });
    },

    async recordSettlement(input) {
      return run(() => {
        const r = reservationOf(input);
        if (r.reservationId !== input.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        const claim = claimOf(input);
        if (claim.reservationId !== r.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        if (input.state === "uncertain") {
          if (SETTLEMENT_RANK[r.state] >= SETTLEMENT_RANK.settled) return clone(r); // never erase settlement
          persist(s => {
            s.reservationsByAuth[input.authorizationKey].state = "uncertain";
            s.fundingByKey[input.fundingKey].state = "uncertain";
          });
          return clone(state.reservationsByAuth[input.authorizationKey]);
        }
        if (input.state !== "settled" || !input.receipt) fail("BOUNDARY_SETTLEMENT_INVALID");
        const receipt = clone(input.receipt);
        const txKey = `${receipt.network}:${receipt.transaction}`;
        const txOwner = state.txIndex[txKey];
        if (txOwner && txOwner !== input.authorizationKey) fail("BOUNDARY_TX_CONFLICT");
        if (SETTLEMENT_RANK[r.state] >= SETTLEMENT_RANK.settled) {
          if (!r.receipt || r.receipt.transaction !== receipt.transaction || r.receipt.network !== receipt.network)
            fail("BOUNDARY_TX_CONFLICT");
          return clone(r); // idempotent re-record of the same settlement
        }
        persist(s => {
          const rr = s.reservationsByAuth[input.authorizationKey];
          rr.state = "settled"; rr.receipt = receipt;
          s.fundingByKey[input.fundingKey].state = "settled";
          s.txIndex[txKey] = input.authorizationKey;
        });
        return clone(state.reservationsByAuth[input.authorizationKey]);
      });
    },

    async dispatchSettled(input) {
      // Phase 1 (serialized): validate + persist intent before any spend.
      const prepared = await run(() => {
        const r = reservationOf(input);
        if (r.reservationId !== input.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        const claim = claimOf(input);
        if (claim.reservationId !== r.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        if (!["settled", "dispatched"].includes(r.state) || !r.receipt) fail("BOUNDARY_NOT_SETTLED");
        if (digest(input.receipt) !== digest(r.receipt)) fail("BOUNDARY_RECEIPT_MISMATCH");
        const cached = state.outcomesByFunding[input.fundingKey];
        if (cached) return { cached: clone(cached) };
        if (state.dispatchIntents[input.fundingKey]) fail("BOUNDARY_DISPATCH_INFLIGHT");
        persist(s => {
          s.dispatchIntents[input.fundingKey] = { reservationId: r.reservationId, startedAt: now() };
        });
        return { receipt: clone(r.receipt) };
      });
      if (prepared.cached) return prepared.cached;
      // Phase 2: the executor runs exactly once per fundingKey. If it throws
      // or the process dies, the persisted intent blocks any blind re-run.
      const outcome = await execute({ request: clone(input.request), receipt: prepared.receipt });
      let valid = outcome && ["completed", "failed"].includes(outcome.status)
        && outcome.refund && ["not_required", "not_requested", "pending", "refunded", "uncertain"].includes(outcome.refund.state)
        && (outcome.status !== "completed" || outcome.refund.state === "not_required");
      if (valid) { try { clone(outcome); } catch { valid = false; } } // must survive canonical JSON round-trip
      if (!valid) fail("BOUNDARY_DISPATCH_OUTCOME_INVALID");
      // Phase 3 (serialized): persist the typed outcome + dispatched state.
      return run(() => {
        persist(s => {
          s.outcomesByFunding[input.fundingKey] = clone(outcome);
          s.reservationsByAuth[input.authorizationKey].state = "dispatched";
          s.fundingByKey[input.fundingKey].state = "dispatched";
          delete s.dispatchIntents[input.fundingKey];
        });
        return clone(outcome);
      });
    },

    // Operator-only authoritative reconciliation. NOT one of the adapter's
    // eight operations: the reconciler acts on provider/chain evidence the
    // adapter never sees. It can move settling/uncertain -> settled with a
    // bound receipt. It deliberately offers no "release the claim" shortcut:
    // the v2 adapter has no released state, so clearing a claim safely
    // requires proving the attempt cannot have charged AND a contract
    // extension — see docs/x402-exact-ingress.md.
    async reconcileSettlement(input) {
      return run(() => {
        const r = reservationOf(input);
        if (r.reservationId !== input.reservationId) fail("BOUNDARY_IDENTITY_MISMATCH");
        if (!["settling", "uncertain"].includes(r.state)) fail("BOUNDARY_NOT_RECONCILABLE");
        if (!input.receipt) fail("BOUNDARY_SETTLEMENT_INVALID");
        const receipt = clone(input.receipt);
        const txKey = `${receipt.network}:${receipt.transaction}`;
        const txOwner = state.txIndex[txKey];
        if (txOwner && txOwner !== input.authorizationKey) fail("BOUNDARY_TX_CONFLICT");
        persist(s => {
          const rr = s.reservationsByAuth[input.authorizationKey];
          rr.state = "settled"; rr.receipt = receipt;
          s.fundingByKey[input.fundingKey].state = "settled";
          s.txIndex[txKey] = input.authorizationKey;
        });
        return clone(state.reservationsByAuth[input.authorizationKey]);
      });
    },

    // Operator-only dispatch reconciliation: the ONLY way to clear a
    // persisted dispatch intent that has no outcome (executor crashed or
    // its reply was lost). The operator must state, from evidence outside
    // this store, either the authoritative outcome the executor produced
    // or that the executor provably never ran. Anything else keeps the
    // intent — and the adapter's DISPATCH_UNCERTAIN — in force.
    async reconcileDispatch({ fundingKey, resolution }) {
      return run(() => {
        if (state.outcomesByFunding[fundingKey]) return clone(state.outcomesByFunding[fundingKey]);
        if (!state.dispatchIntents[fundingKey]) fail("BOUNDARY_NO_DISPATCH_INTENT");
        if (!resolution || !["completed", "not_executed"].includes(resolution.kind)) fail("BOUNDARY_RECONCILE_INVALID");
        if (resolution.kind === "not_executed") {
          persist(s => { delete s.dispatchIntents[fundingKey]; });
          return null;
        }
        const outcome = resolution.outcome;
        let valid = outcome && ["completed", "failed"].includes(outcome.status)
          && outcome.refund && ["not_required", "not_requested", "pending", "refunded", "uncertain"].includes(outcome.refund.state)
          && (outcome.status !== "completed" || outcome.refund.state === "not_required");
        if (valid) { try { clone(outcome); } catch { valid = false; } }
        if (!valid) fail("BOUNDARY_DISPATCH_OUTCOME_INVALID");
        persist(s => {
          s.outcomesByFunding[fundingKey] = clone(outcome);
          const claim = s.fundingByKey[fundingKey];
          const r = s.reservationsByAuth[claim.authorizationKey];
          if (r) r.state = "dispatched";
          claim.state = "dispatched";
          delete s.dispatchIntents[fundingKey];
        });
        return clone(outcome);
      });
    },

    // Operator-only: advance the authoritative refund state of a dispatched
    // outcome. Monotone per REFUND_FLOW; "refunded" requires the canonical
    // refundId of an already-executed refund transfer (executed elsewhere).
    async recordRefundState({ fundingKey, refund }) {
      return run(() => {
        const outcome = state.outcomesByFunding[fundingKey];
        if (!outcome) fail("BOUNDARY_OUTCOME_MISSING");
        const from = outcome.refund?.state;
        if (!refund || !(REFUND_FLOW[from] ?? []).includes(refund.state)) fail("BOUNDARY_REFUND_TRANSITION");
        if (refund.state === "refunded" && !REFUND_ID.test(refund.refundId ?? "")) fail("BOUNDARY_REFUND_INVALID");
        persist(s => {
          const o = s.outcomesByFunding[fundingKey];
          o.refund = refund.state === "refunded" ? { state: "refunded", refundId: refund.refundId } : { state: refund.state };
        });
        return clone(state.outcomesByFunding[fundingKey]);
      });
    },
  };
}

export { BoundaryError };
