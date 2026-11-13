/** Loaded only with the hosted service's Nano payout wallet configured. */
import { authorAddress } from "../wallet.mjs";
import { parseUsdNano } from "../gate.mjs";
import { knownUsd } from "../usd.mjs";
import { authorPayoutRaw } from "../author-payouts.mjs";

export function createMarketCreatorPayments({ rates, payouts, log = () => {} }) {
  return {
    async prepare(metadata) {
      const author = authorAddress(metadata);
      if (!author) return null;
      const rate = await rates.currentUsdc();
      if (rate.xnoUsd == null || parseUsdNano(rate.xnoUsd) <= 0n) throw new Error("A current Nano exchange rate is required for creator earnings");
      return { author, xnoUsd: rate.xnoUsd, status: "awaiting_acceptance" };
    },
    amount(terms, { costUsd, proceedsUsd }) {
      const cost = knownUsd(costUsd), proceeds = knownUsd(proceedsUsd);
      if (cost == null || proceeds == null) return "0";
      const costNano = parseUsdNano(cost), proceedsNano = parseUsdNano(proceeds);
      return authorPayoutRaw({ costYocto: costNano, feeYocto: costNano / 5n, chargedYocto: proceedsNano },
        { usdNano: 1_000_000_000n, yocto: 1_000_000_000n }, parseUsdNano(terms.xnoUsd)).toString();
    },
    enqueue(assignmentId, { author, amountRaw }) {
      payouts.enqueue({ paymentId: `market_${assignmentId}`, to: author, amountRaw });
      payouts.tick().catch(() => log("A market creator payout is queued for retry"));
    },
  };
}
