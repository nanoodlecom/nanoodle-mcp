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
 *   - Expiry can renew a recent transaction with the same access key and nonce.
 *     Every candidate hash is reconciled, and at most one can consume the nonce.
 *     An unknown outcome after InvalidNonce keeps the original refund pending.
 *   - A refund counts as sent only once its transfer receipt has executed at
 *     FINAL. A receipt that failed (for example: the payer deleted their
 *     account) is failed_permanent and logged for the operator.
 *
 * Record statuses: queued -> signed -> sent | failed_permanent.
 */
import { randomBytes } from "node:crypto";
import { assertNearAccountId } from "./account.mjs";
import { MIN_REFUND_YOCTO, formatYoctoAsNear } from "./amount.mjs";
import { matchesSignedNonce, signTransfer } from "./tx.mjs";
import { signFtTransfer, hasFtTransfer, formatUsdc } from "./ft.mjs";
import { NearError } from "./errors.mjs";
import { conflictingNearRefunds, nearRefundHashes, nearRefundTerms, sameNearRefund } from "./refund-terms.mjs";

const REASONS = new Set(["change", "run_failed", "wrong_amount", "late_payment", "interrupted"]);

function invalidTxKind(err) {
  if (err?.code !== "INVALID_TRANSACTION") return null;
  const inv = err.data?.data?.TxExecutionError?.InvalidTxError ?? err.data?.cause?.info?.TxExecutionError?.InvalidTxError;
  if (inv === "Expired") return "Expired";
  if (inv && typeof inv === "object" && Object.hasOwn(inv, "InvalidNonce")) return "InvalidNonce";
  return "other";
}

function publicStatus(rec) {
  if (rec.reconciliationRequired) return "failed_permanent";
  if (rec.status === "sent") return "sent";
  if (rec.status === "failed_permanent") return "failed_permanent";
  return "pending";
}

function view(rec) {
  return { refundId: rec.id, status: publicStatus(rec), txHash: rec.reconciliationRequired ? null : rec.txHash ?? null };
}
const amountLabel = (rec) => rec.asset === "usdc" ? `${formatUsdc(rec.amountYocto)} USDC` : `${formatYoctoAsNear(rec.amountYocto)} NEAR`;

export function createRefunder({
  rpc,
  signer,
  accountId,
  ledger,
  now = Date.now,
  log = () => {},
  minRefundYocto = MIN_REFUND_YOCTO,
  usdcToken = null,
  beforeSign = async () => {},
  beforeComplete = async () => {},
  maintenance = null,
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
  if (typeof beforeSign !== "function") throw new TypeError("beforeSign must be a function");
  if (typeof beforeComplete !== "function") throw new TypeError("beforeComplete must be a function");

  if (maintenance !== null && typeof maintenance.capture !== "function") throw new TypeError("maintenance must provide operation capture");

  let chain = Promise.resolve();
  function hold(rec) {
    if (rec.reconciliationRequired) return view(rec);
    const held = ledger.updateRefund(rec.id, { reconciliationRequired: true, nextAttemptAt: null });
    log("NEAR refund records need reconciliation before a retry");
    return view(held);
  }

  function serialized(task) {
    // Register before queueing: a nonce task waiting behind another refund
    // still prevents a drain. Accepted settlement retains its caller's scope.
    let scheduled;
    try { scheduled = maintenance ? maintenance.capture(task, "wallet") : task; }
    catch (error) { return Promise.reject(error); }
    const run = chain.then(scheduled);
    chain = run.catch(() => {});
    return run;
  }

  /** Sign a fresh transfer for `rec` and persist it before returning. */
  async function signFor(rec, { renew = false } = {}) {
    if (rec.asset != null && !["near", "usdc"].includes(rec.asset)) throw new Error("Unknown refund asset in ledger");
    if (rec.asset === "usdc" && (!usdcToken || rec.tokenContract !== usdcToken)) throw new Error("USDC refund contract does not match this server");
    // The debt is already durable. Refuse a fresh signature without consuming
    // nonce/state when gas, storage or another customer's principal is short.
    // Existing signed bytes still reconcile through drive/confirm unchanged.
    const admission = await beforeSign(rec);
    const key = admission?.accessKey ?? await rpc.viewAccessKey({ accountId, publicKey: signer.publicKey });
    ledger.assertDurable();
    const chainNonce = BigInt(key.nonce);
    const lastNonce = BigInt(ledger.getMeta("lastNonce") ?? 0);
    const nonce = renew ? BigInt(rec.nonce) : (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
    if (renew) {
      if (key.permission !== "FullAccess" || nonce <= chainNonce || !matchesSignedNonce({
        signedTxBase64: rec.signedTxBase64, txHash: rec.txHash, signerId: accountId, publicKeyBytes: signer.publicKeyBytes, nonce,
      })) throw new NearError("UNPROVABLE", "The original refund nonce could not be renewed");
      if (key.block_hash === rec.blockHash) throw new NearError("REFUND_BLOCK_UNCHANGED", "A newer block reference is required for renewal");
    }
    const signed = rec.asset === "usdc" ? signFtTransfer({ signer, signerId: accountId, tokenContract: usdcToken,
      to: rec.to, amount: BigInt(rec.amountYocto), nonce, blockHash: key.block_hash }) : signTransfer({
      signer,
      signerId: accountId,
      receiverId: rec.to,
      nonce,
      blockHash: key.block_hash,
      amountYocto: BigInt(rec.amountYocto),
    });
    if (nonce > lastNonce) ledger.setMeta("lastNonce", signed.nonce);
    const patch = {
      status: "signed",
      signedAt: now(),
      txHash: signed.txHash,
      signedTxBase64: signed.signedTxBase64,
      nonce: signed.nonce,
      blockHash: signed.blockHash,
      nextAttemptAt: null,
    };
    if (renew) {
      patch.replacementNonce = signed.nonce;
      patch.supersededTxHashes = [...new Set([...(rec.supersededTxHashes || []), rec.txHash])].filter(hash => hash !== signed.txHash);
    }
    return ledger.updateRefund(rec.id, patch);
  }

  function retryLater(rec, err) {
    const attempts = (rec.attempts || 0) + 1;
    const failure = { attempts, lastError: String(err?.code || "error"),
      ...(err?.code === "UNPROVABLE" && { outcomeUnverified: true }) };
    if (attempts >= maxAttempts) {
      const done = ledger.updateRefund(rec.id, { ...failure, status: "failed_permanent", nextAttemptAt: null, finishedAt: now() });
      log(`NEAR refund needs operator review after ${attempts} attempts: payment ${rec.paymentId}, ${amountLabel(rec)} to ${rec.to}. Verify the original transaction outcome before any replacement.`);
      return view(done);
    }
    const delay = backoffMs[Math.min(attempts - 1, backoffMs.length - 1)];
    const next = ledger.updateRefund(rec.id, { ...failure, nextAttemptAt: now() + delay });
    schedule(() => { retry({ force: false }).catch(() => {}); }, delay);
    return view(next);
  }

  /** Has the transfer's outcome (incl. its receipt) executed? Only then is "sent" or "failed" known. */
  function executed(result) {
    return !!(result && typeof result === "object" && result.final_execution_status === "FINAL" && result.status && typeof result.status === "object"
      && (Object.hasOwn(result.status, "SuccessValue") || Object.hasOwn(result.status, "Failure"))
      && Array.isArray(result.receipts_outcome) && result.receipts_outcome.length > 0);
  }

  function failedOutcome(result) {
    if (Object.hasOwn(result.status, "Failure")) return true;
    return result.receipts_outcome.some((ro) => ro && ro.outcome && ro.outcome.status && typeof ro.outcome.status === "object" && Object.hasOwn(ro.outcome.status, "Failure"));
  }

  function transferObserved(rec, result) {
    return rec.asset !== "usdc" || hasFtTransfer(result, {
      tokenContract: usdcToken, from: accountId, to: rec.to, amount: rec.amountYocto,
    });
  }

  function unprovable(rec) {
    const done = ledger.updateRefund(rec.id, { status: "failed_permanent", nextAttemptAt: null, lastError: "UNPROVABLE",
      outcomeUnverified: true, finishedAt: now() });
    log(`NEAR refund ${rec.txHash} for payment ${rec.paymentId} could not be confirmed. Verify the original transaction outcome before any replacement.`);
    return view(done);
  }

  async function markSent(rec, result, hash = rec.txHash) {
    // Keep the debt until the funding reader has checkpointed the finalized
    // outgoing effects. An older account view must not reuse the spent funds.
    try { await beforeComplete({ ...rec, txHash: hash }, result); }
    catch (e) { return retryLater(rec, e); }
    const resolved = hash === rec.txHash ? {} : { txHash: hash, signedTxBase64: null, nonce: null, blockHash: null,
      supersededTxHashes: nearRefundHashes(rec).filter(candidate => candidate !== hash) };
    if (failedOutcome(result)) {
      const done = ledger.updateRefund(rec.id, { ...resolved, status: "failed_permanent", nextAttemptAt: null,
        lastError: "TX_FAILED", outcomeUnverified: false, finishedAt: now() });
      log(`NEAR refund transaction ${hash} failed on chain: payment ${rec.paymentId}, ${amountLabel(rec)} to ${rec.to}. Verify the receipt before any manual replacement.`);
      return view(done);
    }
    if (!transferObserved(rec, result)) return unprovable(rec);
    return view(ledger.updateRefund(rec.id, { ...resolved, status: "sent", nextAttemptAt: null, lastError: null,
      outcomeUnverified: false, sentAt: now() }));
  }

  /** Search every candidate. Nonfinal or unavailable lookups keep renewal pending. */
  async function observe(rec, { successOnly = false } = {}) {
    let error;
    for (const hash of nearRefundHashes(rec)) {
      try {
        const result = await rpc.txStatus({ txHash: hash, senderId: accountId, waitUntil: "FINAL" });
        if (executed(result) && (!successOnly || !failedOutcome(result) && transferObserved(rec, result))) return { hash, result };
        error ??= { code: "NOT_FINAL" };
      } catch (e) {
        if (e?.code !== "UNKNOWN_TRANSACTION") error ??= e;
      }
    }
    return { error };
  }

  async function confirm(rec) {
    const check = await observe(rec);
    return check.result ? markSent(rec, check.result, check.hash) : retryLater(rec, check.error ?? { code: "UNKNOWN_TRANSACTION" });
  }

  /** Drive one record forward: sign if needed, broadcast, classify the outcome. */
  async function drive(rec, { renewed = false } = {}) {
    ledger.assertDurable();
    if (rec.reconciliationRequired) return view(rec);
    const quote = ledger.getQuote(rec.paymentId);
    const expected = nearRefundTerms(quote);
    if ((rec.asset != null && !["near", "usdc"].includes(rec.asset))
      || (rec.asset === "usdc" && (!usdcToken || rec.tokenContract !== usdcToken))
      || (expected && !sameNearRefund(expected, rec)) || (quote && !expected)) return hold(rec);
    if (rec.status === "queued") {
      try {
        rec = await signFor(rec);
      } catch (e) {
        return retryLater(rec, e);
      }
    }
    if (rec.status !== "signed") return view(rec);
    if (ledger.refundHashConflict(rec.id) || ledger.invalidRefundProof(rec.id)) return hold(rec);
    if (rec.supersededTxHashes?.length && rec.replacementNonce !== rec.nonce) {
      // Older replacements used a new nonce. Until their outcome is known,
      // even rebroadcasting the latest already-signed bytes may pay again.
      const check = await observe(rec, { successOnly: true });
      return check.result ? markSent(rec, check.result, check.hash) : retryLater(rec, { code: "UNPROVABLE" });
    }
    let result;
    try {
      result = await rpc.sendTx(rec.signedTxBase64, "FINAL");
    } catch (e) {
      const kind = invalidTxKind(e);
      if (kind === "Expired" || kind === "InvalidNonce") {
        const check = await observe(rec);
        if (check.result) return markSent(rec, check.result, check.hash);
        if (check.error) return retryLater(rec, check.error);
        const signedAt = typeof rec.signedAt === "number" ? rec.signedAt : rec.createdAt;
        if (!Number.isSafeInteger(signedAt) || signedAt > now() || now() - signedAt > resignWindowMs) return unprovable(rec);
        if (kind === "InvalidNonce") return retryLater(rec, { code: "UNPROVABLE" });
        if (renewed) return retryLater(rec, e);
        let fresh;
        try {
          fresh = await signFor(rec, { renew: true });
        } catch (e3) {
          return retryLater(rec, e3);
        }
        return drive(fresh, { renewed: true });
      }
      // Transient transport errors, a FINAL wait that timed out (the same
      // bytes are rebroadcast later, harmlessly), and any other rejection (for
      // example NotEnoughBalance, which an operator top-up fixes) retry with backoff.
      return retryLater(rec, e);
    }
    if (!executed(result)) return confirm(rec);
    return markSent(rec, result);
  }

  async function refund({ paymentId, to, amountYocto, reason, asset = "near", tokenContract = null }) {
    if (typeof paymentId !== "string" || !paymentId) throw new TypeError("refund needs a paymentId");
    if (typeof amountYocto !== "bigint" || amountYocto < 0n) throw new TypeError("amountYocto must be a non-negative bigint");
    if (!REASONS.has(reason)) throw new TypeError(`unknown refund reason: ${String(reason)}`);
    assertNearAccountId(to);
    if (asset !== "near" && asset !== "usdc") throw new TypeError("Unknown refund asset");
    if (asset === "usdc" && (!usdcToken || tokenContract !== usdcToken)) throw new TypeError("Unknown USDC contract");
    if (amountYocto < (asset === "usdc" ? 1n : minRefundYocto)) return { refundId: null, status: "none", txHash: null };
    return serialized(async () => {
      ledger.assertDurable();
      const existing = ledger.refundForPayment(paymentId);
      if (existing) {
        const duplicate = ledger.refunds().some(other => other.id !== existing.id && other.paymentId === paymentId);
        return !duplicate && !ledger.refundHashConflict(existing.id)
          && !ledger.invalidRefundProof(existing.id)
          && sameNearRefund({ paymentId, to, amountYocto: amountYocto.toString(), asset, tokenContract }, existing)
          ? view(existing) : hold(existing);
      }
      const rec = {
        id: `rf_${randomBytes(9).toString("base64url")}`,
        paymentId,
        to,
        amountYocto: amountYocto.toString(),
        ...(asset === "usdc" ? { asset, tokenContract } : {}),
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

  function retry({ force }) {
    return serialized(async () => {
      const t = now(), records = ledger.refunds(), seen = new Set(), duplicates = new Set();
      const conflictingHashes = conflictingNearRefunds(records);
      for (const rec of records) {
        if (seen.has(rec.paymentId)) duplicates.add(rec.paymentId);
        seen.add(rec.paymentId);
      }
      for (const rec of records) {
        if (rec.reconciliationRequired) continue;
        if (conflictingHashes.has(rec.id) || ledger.invalidRefundProof(rec.id)) { hold(rec); continue; }
        if (rec.status !== "queued" && rec.status !== "signed") continue;
        if (duplicates.has(rec.paymentId)) { hold(rec); continue; }
        if (!force && rec.nextAttemptAt != null && rec.nextAttemptAt > t) continue;
        await drive(rec);
      }
    });
  }

  return {
    refund,
    resume: () => retry({ force: true }),
    tick: () => retry({ force: false }),
    get(refundId) {
      return ledger.getRefund(refundId);
    },
  };
}
