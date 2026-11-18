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
