/** Durable Nano creator payments, funded by the provider wallet's shared queue. */
import { authorAddress } from "./wallet.mjs";
import { nanoCreatorTransferId } from "./nano-transfer-journal.mjs";
import { sameCreatorPayout } from "./creator-payout-evidence.mjs";
import { NANO_STANDBY_BUDGET_MS } from "./nano-read-pool.mjs";

// Convert only the fee actually collected, after model costs and the deposit cap.
// usdNano and xnoUsdNano share the same scale, so it cancels without rounding USD.
export function authorPayoutRaw(settlement, rate, xnoUsdNano) {
  const remaining = BigInt(settlement.chargedYocto) - BigInt(settlement.costYocto);
  const fee = BigInt(settlement.feeYocto);
  const collected = remaining <= 0n ? 0n : remaining < fee ? remaining : fee;
  if (xnoUsdNano <= 0n) throw new RangeError("author payouts need a positive locked XNO/USD rate");
  return collected * BigInt(rate.usdNano) * 10n ** 30n / (BigInt(rate.yocto) * xnoUsdNano);
}

export function createAuthorPayouts({ ledger, ops, maintenance = null, now = Date.now, log = () => {}, usage = () => {},
  marketPayoutMatches = () => true,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  backoffMs = [30_000, 60_000, 120_000, 300_000, 600_000],
}) {
  if (typeof ops?.transferOnce !== "function") throw new TypeError("author payouts need the shared Nano wallet's durable transfer operation");
  if (maintenance !== null && (typeof maintenance.capture !== "function" || typeof maintenance.assertAdmitted !== "function")) throw new TypeError("maintenance must provide operation capture");
  let chain = Promise.resolve();
  function enqueue({ paymentId, to, amountRaw }) {
    if (!authorAddress({ author: to }) || !/^\d+$/.test(String(amountRaw)) || BigInt(amountRaw) <= 0n) throw new TypeError("invalid author payout");
    maintenance?.assertAdmitted();
    const existing = ledger.getPayout(paymentId);
    if (existing) {
      if (!sameCreatorPayout({ to, amountRaw: String(amountRaw) }, existing)) throw new Error("author payout does not match its recorded intent");
      return existing;
    }
    ledger.putPayout({ paymentId, to, amountRaw: String(amountRaw), status: "queued", prepared: null, attempts: 0, createdAt: now(), nextAttemptAt: now() });
    return ledger.getPayout(paymentId);
  }
  async function drive(rec) {
    ledger.assertDurable();
    try {
      const quote = ledger.getQuote(rec.paymentId);
      const expected = quote?.settlement?.authorPayout;
      const matches = rec.paymentId.startsWith("market_") ? marketPayoutMatches(rec)
        : !quote || (expected && sameCreatorPayout(expected, rec));
      if (!matches) {
        ledger.updatePayout(rec.paymentId, { reconciliationRequired: true, nextAttemptAt: null });
        log("Nano creator payout records need reconciliation before a retry");
        return;
      }
      const hash = await ops.transferOnce(rec.to, rec.amountRaw, {
        liabilityRaw: rec.amountRaw,
        transferId: nanoCreatorTransferId(rec.paymentId),
        fundingRunId: rec.paymentId.startsWith("market_") ? `market:${rec.paymentId.slice(7)}` : `near:${rec.paymentId}`,
        prepared: rec.prepared,
        onPrepared(prepared) { ledger.updatePayout(rec.paymentId, { status: "signed", prepared }); },
      });
      ledger.updatePayout(rec.paymentId, { status: "sent", txHash: hash, sentAt: now(), nextAttemptAt: null });
      try { usage("author_payout", { rail: "near", paymentId: rec.paymentId, to: rec.to, amountRaw: rec.amountRaw, hash, ok: true }); } catch { /* money is already journaled */ }
    } catch (error) {
      // Keep signed bytes even when the publish response was lost. A retry can
      // only republish that block, or replace a provably confirmed losing fork.
      const deferred = error?.code === "NANO_RPC_STANDBY_BUDGET";
      const attempts = (rec.attempts || 0) + Number(!deferred);
      const delay = deferred ? NANO_STANDBY_BUDGET_MS : backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
      ledger.updatePayout(rec.paymentId, { attempts, nextAttemptAt: now() + delay });
      log(`Nano creator payout pending for payment ${rec.paymentId}; retrying in ${delay / 1000}s`);
      schedule(() => { tick().catch(() => {}); }, delay);
    }
  }
  function tick({ force = false } = {}) {
    const pass = async () => {
      for (const rec of ledger.payouts()) {
        if (rec.status !== "sent" && !rec.reconciliationRequired && (force || rec.nextAttemptAt <= now())) await drive(rec);
      }
    };
    let scheduled;
    try { scheduled = maintenance ? maintenance.capture(pass, "wallet") : pass; }
    catch (error) { return Promise.reject(error); }
    const run = chain.then(scheduled);
    chain = run.catch(() => {});
    return run;
  }
  return { enqueue, tick, resume: () => tick({ force: true }), records: () => ledger.payouts() };
}
