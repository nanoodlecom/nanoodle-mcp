import { base58Decode } from "./base58.mjs";
import { ftTransferCall } from "./ft.mjs";
import { matchesSignedTransaction, serializeFunctionCallTx, serializeTransferTx } from "./tx.mjs";

export function hasInvalidNearRefundProof(record, merchant) {
  // Recovered older candidates may be confirmed after their signed bytes were
  // superseded. A pending signed refund must always have its original proof.
  if (record.status !== "signed" && record.signedTxBase64 == null) return false;
  try {
    if (typeof record.nonce !== "string" || !/^\d{1,20}$/.test(record.nonce)
      || typeof record.amountYocto !== "string" || !/^\d{1,39}$/.test(record.amountYocto)
      || typeof record.blockHash !== "string" || record.blockHash.length > 44) return true;
    const base = { signerId: merchant, nonce: BigInt(record.nonce) };
    const amount = BigInt(record.amountYocto), { asset, blockHash, to, tokenContract } = record;
    const evidence = { signedTxBase64: record.signedTxBase64, txHash: record.txHash, signerId: merchant };
    if (asset === "usdc") {
      const call = ftTransferCall({ tokenContract, to, amount });
      return !matchesSignedTransaction(evidence, publicKeyBytes => serializeFunctionCallTx({ ...base, ...call, blockHash, publicKeyBytes }));
    }
    if (asset != null && asset !== "near") return true;
    return !matchesSignedTransaction(evidence, publicKeyBytes => serializeTransferTx({ ...base, publicKeyBytes,
      blockHash: base58Decode(blockHash, 32), receiverId: to, amountYocto: amount }));
  } catch {
    return true;
  }
}
