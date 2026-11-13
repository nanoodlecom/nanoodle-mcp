/** Durable Nano creator payments, funded by the provider wallet's shared queue. */
import { authorAddress } from "./wallet.mjs";

// Convert only the fee actually collected, after model costs and the deposit cap.
// usdNano and xnoUsdNano share the same scale, so it cancels without rounding USD.
export function authorPayoutRaw(settlement, rate, xnoUsdNano) {
  const remaining = BigInt(settlement.chargedYocto) - BigInt(settlement.costYocto);
  const fee = BigInt(settlement.feeYocto);
  const collected = remaining <= 0n ? 0n : remaining < fee ? remaining : fee;
  if (xnoUsdNano <= 0n) throw new RangeError("author payouts need a positive locked XNO/USD rate");
  return collected * BigInt(rate.usdNano) * 10n ** 30n / (BigInt(rate.yocto) * xnoUsdNano);
}

export function createAuthorPayouts({ ledger, ops, now = Date.now, log = () => {}, usage = () => {},
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  backoffMs = [30_000, 60_000, 120_000, 300_000, 600_000],
}) {
  if (typeof ops?.transferOnce !== "function") throw new TypeError("author payouts need the shared Nano wallet's durable transfer operation");
  let running = null;
  function enqueue({ paymentId, to, amountRaw }) {
    if (!authorAddress({ author: to }) || !/^\d+$/.test(String(amountRaw)) || BigInt(amountRaw) <= 0n) throw new TypeError("invalid author payout");
    const existing = ledger.getPayout(paymentId);
    if (existing) {
      if (existing.to !== to || existing.amountRaw !== String(amountRaw)) throw new Error("author payout does not match its recorded intent");
      return existing;
    }
    ledger.putPayout({ paymentId, to, amountRaw: String(amountRaw), status: "queued", prepared: null, attempts: 0, createdAt: now(), nextAttemptAt: now() });
    return ledger.getPayout(paymentId);
  }
  async function drive(rec) {
    try {
      const hash = await ops.transferOnce(rec.to, rec.amountRaw, {
        prepared: rec.prepared,
        onPrepared(prepared) { ledger.updatePayout(rec.paymentId, { status: "signed", prepared }); },
      });
      ledger.updatePayout(rec.paymentId, { status: "sent", txHash: hash, sentAt: now(), nextAttemptAt: null });
      try { usage("author_payout", { rail: "near", paymentId: rec.paymentId, to: rec.to, amountRaw: rec.amountRaw, hash, ok: true }); } catch { /* money is already journaled */ }
    } catch {
      // Keep signed bytes even when the publish response was lost. A retry can
      // only republish that block, or replace a provably confirmed losing fork.
      const attempts = (rec.attempts || 0) + 1;
      const delay = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
      ledger.updatePayout(rec.paymentId, { attempts, nextAttemptAt: now() + delay });
      log(`Nano creator payout pending for payment ${rec.paymentId}; retrying in ${delay / 1000}s`);
      schedule(() => { tick().catch(() => {}); }, delay);
    }
  }
  function tick({ force = false } = {}) {
    if (running) return running.then(() => tick({ force }));
    running = (async () => {
      for (const rec of ledger.payouts()) if (rec.status !== "sent" && (force || rec.nextAttemptAt <= now())) await drive(rec);
    })().finally(() => { running = null; });
    return running;
  }
  return { enqueue, tick, resume: () => tick({ force: true }) };
}
