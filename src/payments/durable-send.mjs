/** Fenced account-block coordinator. Retry only reconciles an existing signed block. */
import { performance } from "node:perf_hooks";
const sameAddress = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.replace(/^xrb_/, "nano_") === b.replace(/^xrb_/, "nano_");
function error(code) {
  const e = new Error(code);
  e.code = code;
  e.reconciliationRequired = true;
  e.paymentAmbiguous = true;
  return e;
}
const check = (ok, code) => {
  if (!ok) throw error(code);
};
export function assertRecoveryObservation({ signal, deadlineAt } = {}) {
  check(!signal?.aborted && (deadlineAt === undefined || Number.isFinite(deadlineAt) && performance.now() < deadlineAt), "SEND_RECONCILIATION_ABORTED");
}
function createDurableWriter(
  { store, account, publicKey, prepare, publish, lookup, crypto, requireHeight = false, onConfirmed = () => {} },
  direction,
) {
  const { checkAddress, hashBlock, verifyBlock, deriveAddress } = crypto;
  const validTarget = (target) =>
    direction === "send"
      ? checkAddress(target)
      : typeof target === "string" && /^[A-F0-9]{64}$/i.test(target);
  check(
    checkAddress(account) &&
      sameAddress(deriveAddress(publicKey, { useNanoPrefix: true }), account),
    "SEND_ACCOUNT_INVALID",
  );
  store.bindAccount(account, { requireHeight });
  const active = new Map();
  function signed(r) {
    const b = r.block;
    check(
      b &&
        b.type === "state" &&
        sameAddress(b.account, r.account) &&
        validTarget(r.to) &&
        /^\d+$/.test(r.previousBalance),
      "SIGNED_SEND_INVALID",
    );
    const h = hashBlock(b).toUpperCase();
    check(
      h === r.hash &&
        hashBlock({ ...b, account: r.account, link: r.to }).toUpperCase() === h,
      "SIGNED_SEND_BINDING_INVALID",
    );
    check(
      direction === "send"
        ? BigInt(b.balance) + BigInt(r.amountRaw) === BigInt(r.previousBalance)
        : BigInt(r.previousBalance) + BigInt(r.amountRaw) === BigInt(b.balance),
      "SIGNED_SEND_AMOUNT_INVALID",
    );
    check(
      verifyBlock({ hash: h, signature: b.signature, publicKey }),
      "SIGNED_SEND_SIGNATURE_INVALID",
    );
    return r;
  }
  async function reconcile(r, options = {}) {
    assertRecoveryObservation(options);
    signed(r);
    let info;
    try {
      info = await lookup(r.hash);
    } catch {
      throw error("SEND_RECONCILIATION_UNAVAILABLE");
    }
    // A timed-out observer cannot later release the account slot. A later
    // attempt may re-read this same hash; it never constructs a replacement.
    assertRecoveryObservation(options);
    check(
      info &&
        (info.confirmed === true || info.confirmed === "true") &&
        info.contents &&
        typeof info.contents === "object",
      "SEND_CONFIRMATION_REQUIRED",
    );
    check(
      hashBlock(info.contents).toUpperCase() === r.hash &&
        String(info.amount) === r.amountRaw,
      "SEND_CONFIRMATION_MISMATCH",
    );
    const height = typeof info.height === "string" && /^[1-9]\d{0,38}$/.test(info.height) ? info.height : null;
    check(!requireHeight || height !== null, "SEND_CONFIRMATION_HEIGHT_REQUIRED");
    assertRecoveryObservation(options);
    store.complete(r.id, r.hash, { height });
    onConfirmed();
    return r.hash;
  }
  async function perform(id, to, amountRaw) {
    const binding = { account, to, amountRaw: String(amountRaw) };
    check(
      validTarget(to) && /^[1-9]\d*$/.test(binding.amountRaw),
      "SEND_BINDING_INVALID",
    );
    let r = store.beginSend(id, binding);
    if (r.state === "completed") {
      signed(r);
      return r.hash;
    }
    if (r.state !== "intent") return reconcile(r);
    const epoch = r.epoch;
    try {
      const candidate = await prepare(to, binding.amountRaw, id);
      signed({
        ...binding,
        id,
        block: candidate.block,
        previousBalance: candidate.previousBalance,
        hash: candidate.hash.toUpperCase(),
      });
      // The winning signed block is durable before publish. Competing callers
      // must use the winner returned here, never their own stale preparation.
      r = store.submitted(id, { ...candidate, epoch });
    } catch (e) {
      store.releaseUnsigned(id, epoch);
      if (store.getSend(id)?.state === "intent") e.paymentNotSent = true;
      throw e;
    }
    signed(r);
    if (!r.granted) return r.state === "completed" ? r.hash : reconcile(r);
    try {
      await publish(r.block);
    } catch {
      store.uncertain(id);
    }
    try {
      return await reconcile(r);
    } catch (e) {
      store.uncertain(id);
      throw e;
    }
  }
  return Object.freeze({
    matchesPayout(id, { to, amountRaw, prepared = null, txHash = null }) {
      const r = store.getSend(id);
      if (!r || r.state === "intent" || r.account !== account || r.to !== to || r.amountRaw !== String(amountRaw)) return false;
      try {
        signed(r);
        if (!prepared) return r.state === "completed" && typeof txHash === "string" && r.hash === txHash.toUpperCase();
        signed({ ...r, hash: typeof prepared.hash === "string" ? prepared.hash.toUpperCase() : null,
          block: prepared.block, previousBalance: prepared.previousBalance ?? r.previousBalance });
        return r.hash === prepared.hash.toUpperCase();
      } catch { return false; }
    },
    transfer(id, to, amountRaw) {
      // Binding is still checked by beginSend for sequential/restart calls;
      // concurrent local calls must not hide a rebound operation identity.
      const key = JSON.stringify({ to, amountRaw: String(amountRaw) });
      if (active.has(id)) {
        const running = active.get(id);
        if (running.key !== key)
          return Promise.reject(error("SEND_BINDING_CONFLICT"));
        return running.promise;
      }
      const promise = perform(id, to, amountRaw).finally(() =>
        active.delete(id),
      );
      active.set(id, { key, promise });
      return promise;
    },
    async reconcile(id, options = {}) {
      assertRecoveryObservation(options);
      const r = store.getSend(id);
      check(r && r.state !== "intent", "SEND_NOT_SUBMITTED");
      signed(r);
      return r.state === "completed" ? r.hash : reconcile(r, options);
    },
  });
}

export const createDurableSender = (options) =>
  createDurableWriter(options, "send");
export function createDurableReceiver(options) {
  const writer = createDurableWriter(options, "receive");
  return Object.freeze({
    receive: (id, sourceHash, amountRaw) =>
      writer.transfer(
        id,
        typeof sourceHash === "string" ? sourceHash.toUpperCase() : sourceHash,
        amountRaw,
      ),
    reconcile: writer.reconcile,
  });
}
