/** Stable-operation send coordinator. Retry means read-only reconciliation, never a new transfer. */
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
export function createDurableSender({
  store,
  account,
  publicKey,
  prepare,
  publish,
  lookup,
  crypto,
}) {
  const { checkAddress, hashBlock, verifyBlock, deriveAddress } = crypto;
  check(
    checkAddress(account) &&
      sameAddress(deriveAddress(publicKey, { useNanoPrefix: true }), account),
    "SEND_ACCOUNT_INVALID",
  );
  const active = new Map();
  function signed(r) {
    const b = r.block;
    check(
      b &&
        b.type === "state" &&
        sameAddress(b.account, r.account) &&
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
      BigInt(b.balance) + BigInt(r.amountRaw) === BigInt(r.previousBalance),
      "SIGNED_SEND_AMOUNT_INVALID",
    );
    check(
      verifyBlock({ hash: h, signature: b.signature, publicKey }),
      "SIGNED_SEND_SIGNATURE_INVALID",
    );
    return r;
  }
  async function reconcile(r) {
    signed(r);
    let info;
    try {
      info = await lookup(r.hash);
    } catch {
      throw error("SEND_RECONCILIATION_UNAVAILABLE");
    }
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
    store.complete(r.id, r.hash);
    return r.hash;
  }
  async function perform(id, to, amountRaw) {
    const binding = { account, to, amountRaw: String(amountRaw) };
    check(
      checkAddress(to) && /^[1-9]\d*$/.test(binding.amountRaw),
      "SEND_BINDING_INVALID",
    );
    let r = store.beginSend(id, binding);
    if (r.state === "completed") {
      signed(r);
      return r.hash;
    }
    if (r.state !== "intent") return reconcile(r);
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
      r = store.submitted(id, candidate);
    } catch (e) {
      store.releaseUnsigned(id);
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
    async reconcile(id) {
      const r = store.getSend(id);
      check(r && r.state !== "intent", "SEND_NOT_SUBMITTED");
      signed(r);
      return r.state === "completed" ? r.hash : reconcile(r);
    },
  });
}
