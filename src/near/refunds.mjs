/**
 * Refund sender: native NEAR transfers from the merchant account, one
 * broadcast at a time.
 *
 * Idempotency rules:
 *   - One refund per payment id, ever.
 *   - The owed refund is recorded ("queued") before anything touches the
 *     network, so an RPC outage while building it never loses the debt.
 *   - A transfer is signed and recorded ("signed", with its tx hash) BEFORE it is
 *     broadcast. Retries and restarts rebroadcast the same bytes, which is
 *     harmless: the same hash can land only once.
 *   - A new transaction is signed only when the old one is provably dead: the
 *     network rejected it as Expired or InvalidNonce AND the old hash is unknown
 *     AND the old transaction was signed recently enough (resignWindowMs) that
 *     a regular RPC node still keeps it. Past that window "unknown" may only
 *     mean garbage-collected, so the record goes to the operator instead of
 *     being paid twice.
 *   - A refund counts as sent only once its transfer receipt has executed at
 *     FINAL. A receipt that failed (for example: the payer deleted their
 *     account) is failed_permanent and logged for the operator.
 *
 * Record statuses: queued -> signed -> sent | failed_permanent.
 */
import { randomBytes } from "node:crypto";
import { assertNearAccountId } from "./account.mjs";
import { MIN_REFUND_YOCTO, formatYoctoAsNear } from "./amount.mjs";
import { signTransfer } from "./tx.mjs";

const REASONS = new Set(["change", "run_failed", "wrong_amount", "late_payment", "interrupted"]);

function invalidTxKind(err) {
  if (err?.code !== "INVALID_TRANSACTION") return null;
  const inv = err.data?.data?.TxExecutionError?.InvalidTxError ?? err.data?.cause?.info?.TxExecutionError?.InvalidTxError;
  if (inv === "Expired") return "Expired";
  if (inv && typeof inv === "object" && Object.hasOwn(inv, "InvalidNonce")) return "InvalidNonce";
  return "other";
}

function publicStatus(rec) {
  if (rec.status === "sent") return "sent";
  if (rec.status === "failed_permanent") return "failed_permanent";
  return "pending";
}

function view(rec) {
  return { refundId: rec.id, status: publicStatus(rec), txHash: rec.txHash ?? null };
}

export function createRefunder({
  rpc,
  signer,
  accountId,
  ledger,
  now = Date.now,
  log = () => {},
  minRefundYocto = MIN_REFUND_YOCTO,
  backoffMs = [30_000, 60_000, 120_000, 300_000, 600_000],
  maxAttempts = 100,
  resignWindowMs = 36 * 3_600_000,
  schedule = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
}) {
  assertNearAccountId(accountId);
  if (!signer || typeof signer.sign !== "function" || typeof signer.publicKey !== "string") throw new TypeError("createRefunder needs a signer");

  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  /** Sign a fresh transfer for `rec` and persist it before returning. */
  async function signFor(rec) {
    const key = await rpc.viewAccessKey({ accountId, publicKey: signer.publicKey });
    const chainNonce = BigInt(key.nonce);
    const lastNonce = BigInt(ledger.getMeta("lastNonce") ?? 0);
    const nonce = (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
    const signed = signTransfer({
      signer,
      signerId: accountId,
      receiverId: rec.to,
      nonce,
      blockHash: key.block_hash,
      amountYocto: BigInt(rec.amountYocto),
    });
    ledger.setMeta("lastNonce", signed.nonce);
    const patch = {
      status: "signed",
      signedAt: now(),
      txHash: signed.txHash,
      signedTxBase64: signed.signedTxBase64,
      nonce: signed.nonce,
      blockHash: signed.blockHash,
      nextAttemptAt: null,
    };
    if (rec.txHash) patch.supersededTxHashes = [...(rec.supersededTxHashes || []), rec.txHash];
    return ledger.updateRefund(rec.id, patch);
  }

  function retryLater(rec, err) {
    const attempts = (rec.attempts || 0) + 1;
    if (attempts >= maxAttempts) {
      const done = ledger.updateRefund(rec.id, { status: "failed_permanent", attempts, nextAttemptAt: null, lastError: String(err?.code || "error"), finishedAt: now() });
      log(`NEAR refund failed permanently after ${attempts} attempts: payment ${rec.paymentId}, ${formatYoctoAsNear(rec.amountYocto)} NEAR to ${rec.to}. The funds remain in ${accountId}; send them manually.`);
      return view(done);
    }
    const delay = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
    const next = ledger.updateRefund(rec.id, { attempts, nextAttemptAt: now() + delay, lastError: String(err?.code || "error") });
    schedule(() => { tick().catch(() => {}); }, delay);
    return view(next);
  }

  /** Has the transfer's outcome (incl. its receipt) executed? Only then is "sent" or "failed" known. */
  function executed(result) {
    return !!(result && typeof result === "object" && result.status && typeof result.status === "object"
      && (Object.hasOwn(result.status, "SuccessValue") || Object.hasOwn(result.status, "Failure"))
      && Array.isArray(result.receipts_outcome) && result.receipts_outcome.length > 0);
  }

  function failedOutcome(result) {
    if (Object.hasOwn(result.status, "Failure")) return true;
    return result.receipts_outcome.some((ro) => ro && ro.outcome && ro.outcome.status && typeof ro.outcome.status === "object" && Object.hasOwn(ro.outcome.status, "Failure"));
  }

  function markSent(rec, result) {
    const failed = failedOutcome(result);
    if (failed) {
      const done = ledger.updateRefund(rec.id, { status: "failed_permanent", nextAttemptAt: null, lastError: "TX_FAILED", finishedAt: now() });
      log(`NEAR refund transaction ${rec.txHash} failed on chain: payment ${rec.paymentId}, ${formatYoctoAsNear(rec.amountYocto)} NEAR to ${rec.to}. The funds remain in ${accountId}; send them manually.`);
      return view(done);
    }
    return view(ledger.updateRefund(rec.id, { status: "sent", nextAttemptAt: null, sentAt: now() }));
  }

  /** Read the transfer's outcome at FINAL (receipts executed). */
  async function confirm(rec) {
    try {
      const r = await rpc.txStatus({ txHash: rec.txHash, senderId: accountId, waitUntil: "FINAL" });
      if (executed(r)) return markSent(rec, r);
      return retryLater(rec, { code: "NOT_FINAL" });
    } catch (e) {
      return retryLater(rec, e);
    }
  }

  /** Drive one record forward: sign if needed, broadcast, classify the outcome. */
  async function drive(rec, { resigned = false } = {}) {
    if (rec.status === "queued") {
      try {
        rec = await signFor(rec);
      } catch (e) {
        return retryLater(rec, e);
      }
    }
    if (rec.status !== "signed") return view(rec);
    let result;
    try {
      result = await rpc.sendTx(rec.signedTxBase64, "FINAL");
    } catch (e) {
      const kind = invalidTxKind(e);
      if (kind === "Expired" || kind === "InvalidNonce") {
        let known;
        try {
          await rpc.txStatus({ txHash: rec.txHash, senderId: accountId, waitUntil: "NONE" });
          known = true;
        } catch (e2) {
          if (e2?.code !== "UNKNOWN_TRANSACTION") return retryLater(rec, e2);
          known = false;
        }
        if (known) return confirm(rec);
        if (resigned) return retryLater(rec, e);
        const signedAt = typeof rec.signedAt === "number" ? rec.signedAt : rec.createdAt;
        if (typeof signedAt !== "number" || now() - signedAt > resignWindowMs) {
          // A regular RPC node forgets transactions after a few epochs, so an old
          // hash being "unknown" proves nothing; re-signing could pay twice.
          const done = ledger.updateRefund(rec.id, { status: "failed_permanent", nextAttemptAt: null, lastError: "UNPROVABLE", finishedAt: now() });
          log(`NEAR refund ${rec.txHash} for payment ${rec.paymentId} could not be confirmed (signed too long ago for the RPC to remember). ` +
            `Check ${accountId}'s history on an explorer or an archival RPC; if no transfer of ${formatYoctoAsNear(rec.amountYocto)} NEAR to ${rec.to} landed, send it manually.`);
          return view(done);
        }
        let fresh;
        try {
          fresh = await signFor(rec);
        } catch (e3) {
          return retryLater(rec, e3);
        }
        return drive(fresh, { resigned: true });
      }
      // Transient transport errors, a FINAL wait that timed out (the same
      // bytes are rebroadcast later, harmlessly), and any other rejection (for
      // example NotEnoughBalance, which an operator top-up fixes) retry with backoff.
      return retryLater(rec, e);
    }
    if (!executed(result)) return confirm(rec);
    return markSent(rec, result);
  }

  async function refund({ paymentId, to, amountYocto, reason }) {
    if (typeof paymentId !== "string" || !paymentId) throw new TypeError("refund needs a paymentId");
    if (typeof amountYocto !== "bigint" || amountYocto < 0n) throw new TypeError("amountYocto must be a non-negative bigint");
    if (!REASONS.has(reason)) throw new TypeError(`unknown refund reason: ${String(reason)}`);
    assertNearAccountId(to);
    if (amountYocto < minRefundYocto) return { refundId: null, status: "none", txHash: null };
    return serialized(async () => {
      const existing = ledger.refundForPayment(paymentId);
      if (existing) return view(existing);
      const rec = {
        id: `rf_${randomBytes(9).toString("base64url")}`,
        paymentId,
        to,
        amountYocto: amountYocto.toString(),
        reason,
        status: "queued",
        txHash: null,
        signedTxBase64: null,
        nonce: null,
        blockHash: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: now(),
      };
      ledger.putRefund(rec);
      return drive(rec);
    });
  }

  function tick() {
    return serialized(async () => {
      const t = now();
      for (const rec of ledger.refunds()) {
        if (rec.status !== "queued" && rec.status !== "signed") continue;
        if (rec.nextAttemptAt != null && rec.nextAttemptAt > t) continue;
        await drive(rec);
      }
    });
  }

  function resume() {
    return serialized(async () => {
      for (const rec of ledger.refunds()) {
        if (rec.status === "queued" || rec.status === "signed") await drive(rec);
      }
    });
  }

  return {
    refund,
    resume,
    tick,
    get(refundId) {
      return ledger.getRefund(refundId);
    },
  };
}
