export const nanoGateTransferId = (paymentId, event) => `nano:${paymentId}:${event}`;
export const nanoCreatorTransferId = paymentId => `creator:${paymentId}`;

export function* gateNanoTransferClaims({ quotes, owed }) {
  for (const debt of owed) {
    if (debt.prepared?.hash) yield { id: nanoGateTransferId(debt.fields?.paymentId, debt.event), hash: debt.prepared.hash };
  }
  for (const quote of quotes) {
    for (const [event, receipt] of Object.entries(quote.transferReceipts ?? {})) {
      yield { id: nanoGateTransferId(quote.id, event), hash: receipt.hash };
    }
  }
}

export function* creatorNanoTransferClaims(payouts) {
  for (const payout of payouts) {
    const hash = payout.txHash ?? payout.prepared?.hash;
    if (hash) yield { id: nanoCreatorTransferId(payout.paymentId), hash };
  }
}

export function hasOtherNanoTransferClaim(claims, hash, id) {
  const key = hash.toUpperCase();
  for (const claim of claims) if (claim.id !== id && claim.hash.toUpperCase() === key) return true;
  return false;
}

export function hasConflictingNanoTransferClaims(...sources) {
  const owners = new Map();
  for (const claims of sources) {
    for (const { hash, id } of claims) {
      const key = hash.toUpperCase();
      if (owners.has(key) && owners.get(key) !== id) return true;
      owners.set(key, id);
    }
  }
  return false;
}
