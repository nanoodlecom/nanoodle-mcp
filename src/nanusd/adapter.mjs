/**
 * The NanoUSD adapter — a third payment route, instantiated on the shared
 * route core (src/pay/route-core.mjs) and deliberately NOT a variant of
 * the NEAR gate: NanoUSD is its own asset on its own network.
 *
 * What this adapter owns (the core must not know):
 *   - Addresses are `usd_` on the NanUSD network — a Nano-protocol fork
 *     (yxse/nan-node, custom genesis) run by Nanswap. It is NOT Nano
 *     (XNO): a `nano_` address here would strand every payment, so the
 *     core's construction check runs this adapter's validator.
 *   - Detection is watch-mode (like the Nano gate): payers are wallets
 *     and NanChat, so the gate finds the money itself on its own NanUSD
 *     node — receivable scan here; the production watcher adds the Nano
 *     gate's history-walk race cover behind the same primitive.
 *   - The rate is the degenerate pair: a 1:1 peg assertion against
 *     Nanswap's USDC reserve, source "peg". Its honesty requirement is
 *     disclosure (docs/nanusd-payments.md), not freshness.
 *   - Sending back is a Nano-family state block (work, signing,
 *     pocketing in production wallet ops) via the injected broadcast.
 */
import { parseNanusdAddress } from "./address.mjs";
import { rawToUsd, RAW_PER_NANUSD } from "./units.mjs";

export const NANUSD_TTL_MS = 30 * 60 * 1000; // in-band family value (NEAR parity)

export function createNanusdAdapter({ rpc, merchantAccount, broadcast }) {
  let tagCounter = 0;
  return {
    rail: "nanusd",
    assets: ["nanusd"],
    idPrefix: "uq_",
    asset: "NANUSD",
    network: "NanUSD",
    ttlMs: NANUSD_TTL_MS,
    merchant: merchantAccount,
    detection: "watch",

    validateAddress: (a) => parseNanusdAddress(a),
    formatAtomic: (raw) => `${rawToUsd(raw)} NANUSD`,

    rate: {
      current: async () => Object.freeze({
        usdNano: 1_000_000_000n, atomic: RAW_PER_NANUSD, source: "peg (1 NANUSD = 1 USD, issuer-asserted)", at: null,
      }),
    },

    // Amount-as-memo, the mechanism both production gates use: a unique
    // micro-unit tag (1e-6 NANUSD steps) inside the deposit amount.
    tagging: {
      tag(baseAtomic, taken) {
        for (let i = 0; i < 1_000_000; i++) {
          const tag = BigInt(++tagCounter % 1_000_000 || 1);
          const depositAtomic = baseAtomic + tag * (RAW_PER_NANUSD / 1_000_000n);
          if (!taken.has(depositAtomic.toString())) return { depositAtomic, tag: tag.toString() };
        }
        throw new Error("deposit tag space exhausted for this amount");
      },
    },

    async observe() {
      const rec = await rpc.receivable(merchantAccount).catch(() => ({ blocks: {} }));
      return Object.entries(rec.blocks || {}).map(([hash, info]) => ({
        ref: hash, payer: info.source, amountAtomic: BigInt(info.amount),
      }));
    },

    sendBack: (entry) => broadcast(entry),
  };
}
