import { createHash } from "node:crypto";
import { x402ResourceServer } from "@x402/core/server";
import { PaymentPayloadV2Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { address, getTransactionDecoder } from "@solana/kit";

export const BASE = "eip155:8453";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const schemes = { [BASE]: new ExactEvmScheme(), [SOLANA]: new ExactSvmScheme() };
class IngressError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const check = (ok, code) => { if (!ok) throw new IngressError(code); };
const nonempty = x => typeof x === "string" && x.length > 0 && x.length <= 2048;
const uint = x => typeof x === "string" && /^[1-9]\d{0,77}$/.test(x);
const millis = x => Number.isSafeInteger(x) && x >= 0;
// Transport inputs are JSON, but do not execute toJSON/getters on injection inputs.
export function canonical(value, parents = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isFinite(value), "INVALID_JSON"); return JSON.stringify(value); }
  check(value && typeof value === "object" && !parents.has(value), "INVALID_JSON");
  const array = Array.isArray(value);
  check(array || [Object.prototype, null].includes(Object.getPrototypeOf(value)), "INVALID_JSON");
  const keys = Reflect.ownKeys(value).filter(k => !(array && k === "length"));
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(typeof key === "string" && d.enumerable && "value" in d, "INVALID_JSON");
  }
  if (array) check(keys.length === value.length && keys.every((k, i) => k === String(i)), "INVALID_JSON");
  parents.add(value);
  const result = array ? `[${keys.map(k => canonical(value[k], parents)).join(",")}]`
    : `{${keys.sort().map(k => `${JSON.stringify(k)}:${canonical(value[k], parents)}`).join(",")}}`;
  parents.delete(value);
  return result;
}
const copy = x => JSON.parse(canonical(x));
const hash = x => createHash("sha256").update(canonical(x)).digest("hex");
const bytesHash = x => createHash("sha256").update(x).digest("hex");
const normalizePayer = (p, network) => network === BASE ? p.toLowerCase() : p;
function validAddress(value, network) {
  if (network === BASE) return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
  try { address(value); return true; } catch { return false; }
}
function cancelled(signal) { check(!signal?.aborted, "CANCELLED"); }
// Timeouts stop waiting; they do not claim to reverse an external side effect.
async function bounded(fn, timeoutMs, signal) {
  cancelled(signal);
  let timer, onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new IngressError("TIMEOUT")), timeoutMs);
        if (signal) {
          onAbort = () => reject(new IngressError("CANCELLED"));
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Opt-in, transport-free ingress; NOT installed by the CLI or HTTP server.
 * boundary is the authoritative quote/reservation/Nano-dispatch service. It
 * must persist intent before granting settlement and atomically deduplicate
 * authorizationKey across ALL quotes/processes. See docs/x402-exact-ingress.md.
 * No ledger, wallet, FX operation, default facilitator or refund is created.
 */
export function createX402ExactIngress({ registry, resolveContext, boundary, facilitator,
  facilitatorId, routes, clock = Date.now, timeoutMs = 10_000, capabilityTtlMs = 30_000 }) {
  check(typeof registry?.prepareCall === "function" && typeof registry?.listTools === "function"
    && typeof resolveContext === "function", "MISSING_REGISTRY_CONTEXT");
  for (const name of ["issueQuote", "lookupQuote", "lookupReservation", "reserve", "beginSettlement", "recordSettlement", "dispatchSettled"])
    check(typeof boundary?.[name] === "function", "MISSING_CANONICAL_BOUNDARY");
  for (const name of ["getSupported", "verify", "settle"])
    check(typeof facilitator?.[name] === "function", "MISSING_FACILITATOR");
  check(nonempty(facilitatorId), "MISSING_FACILITATOR_ID");
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, "INVALID_TIMEOUT");
  check(Number.isSafeInteger(capabilityTtlMs) && capabilityTtlMs > 0 && capabilityTtlMs <= 60_000, "INVALID_CAPABILITY_TTL");
  const policy = copy(routes);
  check(Array.isArray(policy) && policy.length > 0 && policy.length <= 2, "INVALID_ROUTES");
  const byNetwork = new Map();
  for (const r of policy) {
    check(Object.hasOwn(schemes, r.network) && !byNetwork.has(r.network), "UNSUPPORTED_NETWORK");
    check(validAddress(r.payTo, r.network), "INVALID_RECIPIENT");
    byNetwork.set(r.network, r);
  }
  const now = () => { const t = clock(); check(millis(t), "INVALID_CLOCK"); return t; };
  let capabilities, capabilityAt;
  async function sdk(signal) {
    const t = now();
    if (!capabilities || t < capabilityAt || t - capabilityAt >= capabilityTtlMs) {
      const supported = copy(await bounded(() => facilitator.getSupported(), timeoutMs, signal));
      check(Array.isArray(supported.kinds), "INVALID_CAPABILITIES");
      capabilities = supported; capabilityAt = t;
    }
    // Only an explicit, current v2/exact pair is usable. Wildcards don't grant
    // support and unknown networks remain unavailable even if advertised.
    const supportedNetworks = new Set(capabilities.kinds.filter(k => k.x402Version === 2 && k.scheme === "exact")
      .map(k => k.network));
    const server = new x402ResourceServer({
      getSupported: async () => copy(capabilities),
      verify: (...args) => facilitator.verify(...args),
      settle: (...args) => facilitator.settle(...args),
    });
    for (const r of policy) if (supportedNetworks.has(r.network)) server.register(r.network, schemes[r.network]);
    check(policy.some(r => supportedNetworks.has(r.network)), "NETWORK_UNAVAILABLE");
    await bounded(() => server.initialize(), timeoutMs, signal);
    return { server, supportedNetworks };
  }
  async function buildRequirements({ network, amountAtomic, maxTimeoutSeconds }, signal) {
    check(byNetwork.has(network), "UNSUPPORTED_NETWORK");
    check(uint(amountAtomic) && Number.isSafeInteger(maxTimeoutSeconds) && maxTimeoutSeconds > 0
      && maxTimeoutSeconds <= 300, "INVALID_PRICE_OR_TIMEOUT");
    const { server, supportedNetworks } = await sdk(signal);
    check(supportedNetworks.has(network), "NETWORK_UNAVAILABLE");
    const asset = await schemes[network].parsePrice("1", network);
    const result = await bounded(() => server.buildPaymentRequirements({ scheme: "exact", network,
      payTo: byNetwork.get(network).payTo, price: { ...asset, amount: amountAtomic }, maxTimeoutSeconds }), timeoutMs, signal);
    check(result.length === 1, "AMBIGUOUS_REQUIREMENTS");
    return copy(result[0]);
  }
  async function quoteCheck(q, request, binding) {
    check(q && q.binding === binding && nonempty(q.quoteId) && millis(q.issuedAt) && millis(q.expiresAt)
      && q.issuedAt <= now() && q.expiresAt > q.issuedAt && q.expiresAt - q.issuedAt <= 300_000, "QUOTE_BINDING_MISMATCH");
    check(canonical(q.resource) === canonical(request.resource), "RESOURCE_MISMATCH");
    check(q.downstream?.asset === "XNO" && q.downstream.unit === "raw" && uint(q.downstream.amountAtomic), "MISSING_NANO_COST");
    check(Array.isArray(q.requirements) && q.requirements.length > 0 && q.requirements.length <= policy.length,
      "INVALID_REQUIREMENTS");
    const networks = new Set();
    for (const r of q.requirements) {
      check(byNetwork.has(r.network) && !networks.has(r.network), "UNSUPPORTED_NETWORK"); networks.add(r.network);
      const asset = await schemes[r.network].parsePrice("1", r.network);
      check(r.scheme === "exact" && r.asset === asset.asset && r.payTo === byNetwork.get(r.network).payTo
        && uint(r.amount) && Number.isSafeInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0
        && r.maxTimeoutSeconds * 1000 <= q.expiresAt - q.issuedAt, "REQUIREMENTS_POLICY_MISMATCH");
      // This bounded adapter intentionally excludes Permit2, upto, extensions
      // and alternate payment flows. Don't silently inherit future SDK modes.
      const allowedExtra = r.network === BASE ? ["name", "version"] : ["feePayer", "transactionVersions"];
      check(r.extra && Object.keys(r.extra).every(k => allowedExtra.includes(k)), "UNSUPPORTED_PAYMENT_MODE");
      if (r.network === BASE) check(canonical(r.extra) === canonical(asset.extra), "INVALID_EIP712_DOMAIN");
      else check(validAddress(r.extra.feePayer, SOLANA), "INVALID_FEE_PAYER");
    }
  }
  function required(q) {
    const body = copy({ x402Version: 2, resource: q.resource, accepts: q.requirements });
    check(PaymentRequiredV2Schema.safeParse(body).success, "INVALID_REQUIREMENTS");
    return { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) }, body };
  }
  function evidence(payload, r) {
    if (r.network === BASE) {
      const a = payload.payload.authorization;
      check(a && validAddress(a.from, BASE) && validAddress(a.to, BASE) && a.to.toLowerCase() === r.payTo.toLowerCase()
        && a.value === r.amount && /^0x[0-9a-fA-F]{64}$/.test(a.nonce), "INVALID_AUTHORIZATION");
      return { payer: a.from, authorizationKey: hash(["eip3009", r.network, r.asset.toLowerCase(), a.from.toLowerCase(), a.nonce.toLowerCase()]) };
    }
    const wire = payload.payload.transaction;
    check(typeof wire === "string" && wire.length <= 4096 && /^[A-Za-z0-9+/]+={0,2}$/.test(wire), "INVALID_TRANSACTION");
    const bytes = Buffer.from(wire, "base64");
    check(bytes.toString("base64") === wire, "INVALID_TRANSACTION");
    const transaction = getTransactionDecoder().decode(bytes);
    // Signatures can change; the signed message is the replay identity.
    return { authorizationKey: hash(["svm-message", r.network, bytesHash(transaction.messageBytes)]) };
  }
  function reservationCheck(record, expected) {
    check(record && nonempty(record.reservationId) && ["reserved", "settling", "uncertain", "settled", "dispatched"].includes(record.state),
      "INVALID_RESERVATION");
    for (const key of ["quoteId", "binding", "authorizationKey", "paymentDigest"])
      check(record[key] === expected[key], "RESERVATION_BINDING_MISMATCH");
    return record;
  }
  function receiptCheck(receipt, expected, r, payer) {
    check(receipt && receipt.success === true && receipt.network === r.network && receipt.asset === r.asset
      && receipt.amountAtomic === r.amount && receipt.payTo === r.payTo && receipt.facilitatorId === facilitatorId
      && receipt.authorizationKey === expected.authorizationKey && receipt.paymentDigest === expected.paymentDigest
      && receipt.quoteId === expected.quoteId && receipt.binding === expected.binding
      && typeof receipt.transaction === "string" && (r.network === BASE ? /^0x[0-9a-fA-F]{64}$/ : /^[1-9A-HJ-NP-Za-km-z]{64,88}$/).test(receipt.transaction)
      && typeof receipt.payer === "string" && (!payer || normalizePayer(receipt.payer, r.network) === normalizePayer(payer, r.network)),
    "INVALID_SETTLEMENT_RECEIPT");
  }
  async function handle({ params, paymentSignature, context, signal }) {
    try {
      cancelled(signal);
      const call = copy(params);
      check(call && nonempty(call.name) && call.name !== "run_noodle"
        && registry.listTools().some(t => t.name === call.name), "UNKNOWN_TOOL");
      const args = call.arguments ?? {};
      check(args && typeof args === "object" && !Array.isArray(args)
        && !["_payment_id", "_near_payment"].some(k => Object.hasOwn(args, k)), "INVALID_ARGUMENTS");
      const clean = copy({ name: call.name, arguments: args });
      await bounded(() => registry.prepareCall(clean), timeoutMs, signal);
      const ctx = copy(await bounded(() => resolveContext(clean, context), timeoutMs, signal));
      check(nonempty(ctx.requestId) && nonempty(ctx.customerScope) && /^[a-f0-9]{64}$/.test(ctx.workflowDigest)
        && nonempty(ctx.resource?.url), "MISSING_AUTHORITATIVE_CONTEXT");
      const request = { ...ctx, call: clean };
      const binding = hash(["nanoodle-x402-ingress/v1", request, policy, facilitatorId]);
      const q = copy(await bounded(() => paymentSignature === undefined
        ? boundary.issueQuote({ request, binding, buildRequirements: fields => buildRequirements(fields, signal), signal })
        : boundary.lookupQuote({ request, binding, signal }), timeoutMs, signal));
      await quoteCheck(q, request, binding);
      if (paymentSignature === undefined) {
        check(now() < q.expiresAt, "QUOTE_EXPIRED");
        const { supportedNetworks } = await sdk(signal);
        check(q.requirements.every(r => supportedNetworks.has(r.network)), "NETWORK_UNAVAILABLE");
        return required(q);
      }
      check(typeof paymentSignature === "string" && paymentSignature.length <= 16_384, "INVALID_PAYMENT_HEADER");
      const payload = copy(decodePaymentSignatureHeader(paymentSignature));
      check(PaymentPayloadV2Schema.safeParse(payload).success && !payload.extensions, "INVALID_PAYMENT_PAYLOAD");
      check(!payload.resource || canonical(payload.resource) === canonical(q.resource), "RESOURCE_MISMATCH");
      const r = q.requirements.find(r => canonical(r) === canonical(payload.accepted));
      check(r, "PAYMENT_REQUIREMENTS_MISMATCH");
      const auth = evidence(payload, r);
      const expected = { quoteId: q.quoteId, binding, authorizationKey: auth.authorizationKey,
        paymentDigest: hash(payload) };
      let reservation = await bounded(() => boundary.lookupReservation({ ...expected, signal }), timeoutMs, signal);
      if (reservation) reservation = reservationCheck(reservation, expected);
      if (reservation && ["settling", "uncertain"].includes(reservation.state))
        return { status: 202, body: { code: "SETTLEMENT_UNCERTAIN", reservationId: reservation.reservationId } };
      const payer = ctx.payer ?? auth.payer;
      if (!reservation || reservation.state === "reserved") {
        check(now() < q.expiresAt, "QUOTE_EXPIRED");
        const { server, supportedNetworks } = await sdk(signal);
        check(supportedNetworks.has(r.network), "NETWORK_UNAVAILABLE");
        const verified = await bounded(() => server.verifyPayment(payload, r), timeoutMs, signal);
        check(verified.isValid === true && validAddress(verified.payer, r.network)
          && (!auth.payer || normalizePayer(verified.payer, r.network) === normalizePayer(auth.payer, r.network))
          && (!payer || normalizePayer(verified.payer, r.network) === normalizePayer(payer, r.network)), "PAYMENT_REJECTED");
        check(now() < q.expiresAt, "QUOTE_EXPIRED"); cancelled(signal);
        // Never let an invalid signature consume a globally unique nonce or
        // transaction message before its legitimate payer can use it.
        reservation = reservationCheck(await bounded(() => boundary.reserve({ ...expected,
          expiresAt: q.expiresAt, now: now(), signal }), timeoutMs, signal), expected);
        if (["settling", "uncertain"].includes(reservation.state))
          return { status: 202, body: { code: "SETTLEMENT_UNCERTAIN", reservationId: reservation.reservationId } };
        let begun;
        try {
          begun = await bounded(() => boundary.beginSettlement({ ...expected,
            reservationId: reservation.reservationId, now: now(), expiresAt: q.expiresAt, signal }), timeoutMs, signal);
        } catch {
          // The storage transaction may have committed even if its reply was
          // lost. A retry must inspect canonical state, never recreate intent.
          return { status: 202, body: { code: "SETTLEMENT_UNCERTAIN", reservationId: reservation.reservationId } };
        }
        reservation = reservationCheck(begun.reservation, expected);
        if (begun.granted !== true) return { status: 202, body: { code: "SETTLEMENT_PENDING", reservationId: reservation.reservationId } };
        check(reservation.state === "settling", "INVALID_SETTLEMENT_INTENT");
        try {
          const settlement = await bounded(() => server.settlePayment(payload, r), timeoutMs, signal);
          const receipt = { ...expected, success: settlement.success, network: settlement.network,
            transaction: settlement.transaction, payer: settlement.payer ?? verified.payer,
            asset: r.asset, amountAtomic: r.amount, payTo: r.payTo, facilitatorId };
          check(settlement.amount === undefined || settlement.amount === r.amount, "SETTLEMENT_AMOUNT_MISMATCH");
          receiptCheck(receipt, expected, r, verified.payer);
          reservation = reservationCheck(await bounded(() => boundary.recordSettlement({ ...expected,
            reservationId: reservation.reservationId, state: "settled", receipt: copy(receipt) }), timeoutMs), expected);
          check(["settled", "dispatched"].includes(reservation.state), "SETTLEMENT_NOT_DURABLE");
        } catch {
          // Also covers cancellation, late responses, malformed receipts and
          // storage ambiguity. NEVER clear durable intent or retry settlement.
          try { await bounded(() => boundary.recordSettlement({ ...expected,
            reservationId: reservation.reservationId, state: "uncertain" }), timeoutMs); } catch { /* intent still blocks retry */ }
          return { status: 202, body: { code: "SETTLEMENT_UNCERTAIN", reservationId: reservation.reservationId } };
        }
      }
      receiptCheck(reservation.receipt, expected, r, payer);
      cancelled(signal);
      let result;
      try {
        result = await bounded(() => boundary.dispatchSettled({ ...expected,
          reservationId: reservation.reservationId, receipt: copy(reservation.receipt), request, signal }), timeoutMs, signal);
      } catch {
        // Dispatch may have consumed downstream Nano before losing its reply.
        // Only the canonical dispatcher may reconcile or replay that result.
        return { status: 202, body: { code: "DISPATCH_UNCERTAIN", reservationId: reservation.reservationId },
          receipt: copy(reservation.receipt) };
      }
      return { status: 200, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true,
        network: r.network, transaction: reservation.receipt.transaction, payer: reservation.receipt.payer }) },
      body: result, receipt: copy(reservation.receipt) };
    } catch (error) {
      // No raw SDK, registry, storage or upstream error strings reach clients.
      return { status: error?.code === "CANCELLED" ? 499 : 402,
        body: { code: error instanceof IngressError ? error.code : "INGRESS_REJECTED" } };
    }
  }
  return Object.freeze({ handle, buildRequirements });
}
