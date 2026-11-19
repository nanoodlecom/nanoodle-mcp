/** Money already received, or the exact change after a completed run. */
export function nearRefundTerms(q) {
  if (!q) return null;
  let amountYocto;
  if (q.settlement) amountYocto = q.settlement.refundYocto;
  else if (["paid", "running"].includes(q.status)
    || (["failed", "rejected"].includes(q.status) && q.paidYocto != null && !q.refundWaived)) amountYocto = q.paidYocto;
  else return null;
  return { paymentId: q.id, refundId: q.refundId, to: q.payer, asset: q.asset ?? "near",
    tokenContract: q.tokenContract, amountYocto };
}

export function sameNearRefundDestination(expected, record) {
  return expected.paymentId === record.paymentId
    && (expected.refundId == null || expected.refundId === record.id)
    && (expected.asset ?? "near") === (record.asset ?? "near")
    && (expected.to === undefined || expected.to === record.to)
    && (expected.asset !== "usdc" || expected.tokenContract === undefined || expected.tokenContract === record.tokenContract);
}

export function sameNearRefund(expected, record) {
  return sameNearRefundDestination(expected, record) && expected.amountYocto === record.amountYocto;
}

export function nearRefundHashes(record) {
  return [...new Set([record.txHash, ...(record.supersededTxHashes ?? [])])]
    .filter(hash => typeof hash === "string" && hash.length > 0);
}

/** A finalized transfer or any candidate from a renewal belongs to one refund. */
export function conflictingNearRefunds(refunds) {
  const owners = new Map(), conflicts = new Set();
  for (const refund of refunds) {
    for (const hash of nearRefundHashes(refund)) {
      if (!owners.has(hash)) owners.set(hash, refund.id);
      else {
        conflicts.add(owners.get(hash));
        conflicts.add(refund.id);
      }
    }
  }
  return conflicts;
}
