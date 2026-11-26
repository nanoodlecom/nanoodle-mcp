/**
 * NanoUSD gate = the shared payment route (src/pay/route-core.mjs) with
 * the NanoUSD adapter (./adapter.mjs). Wiring only — the lifecycle,
 * settle formula, journal protocol and receipt assembly live in the
 * core, shared by design with the Nano and NEAR routes.
 *
 * The rail is inactive until an operator configures a NanUSD node RPC
 * and a merchant account (see docs/nanusd-payments.md); nothing in this
 * module is constructed by the CLI yet.
 */
import { createPaymentRoute } from "../pay/route-core.mjs";
import { createNanusdAdapter, NANUSD_TTL_MS } from "./adapter.mjs";

export const NANUSD_QUOTE_TTL_MS = NANUSD_TTL_MS;

export function createNanusdGate({ rpc, merchantAccount, broadcast, now = Date.now }) {
  const adapter = createNanusdAdapter({ rpc, merchantAccount, broadcast });
  return createPaymentRoute({ adapter, now });
}

/** Public status view for /nanusd/status/:id — money figures only, no user content. */
export function nanusdPaymentView(q) {
  if (!q) return null;
  return {
    status: q.status,
    paymentId: q.id,
    asset: q.asset,
    network: q.network,
    merchant: q.merchant,
    amountRaw: q.depositAtomic,
    amountUsd: q.depositUsd,
    expiresAt: q.expiresAt,
    ...(q.payment ? { payHash: q.payment.ref, payer: q.payment.payer } : {}),
    ...(q.receipt ? { receipt: q.receipt } : {}),
    done: ["settled", "refunded", "expired"].includes(q.status),
  };
}
