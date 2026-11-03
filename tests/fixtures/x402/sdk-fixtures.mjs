// Public deterministic test-only signers. No wallet, credential, network or funds.
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromPrivateKeyBytes, getTransactionDecoder, getPublicKeyFromAddress, verifySignature } from "@solana/kit";
import { BASE } from "../../../src/integrations/x402-exact-ingress.mjs";

export const evmSigner = privateKeyToAccount(`0x${"01".repeat(32)}`);
export const svmSigner = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));
export const svmSeller = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(8));
export const svmFeePayer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(9));
export const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
export async function sdkPayload(requirements, resource) {
  let result;
  if (requirements.network === BASE) result = await new ExactEvmScheme(evmSigner).createPaymentPayload(2, requirements);
  else {
    // The actual SDK fetches mint metadata and a blockhash. Substitute the RPC
    // transport completely; any unrecognized operation fails, with no sockets.
    const oldFetch = globalThis.fetch;
    const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://rpc.invalid/");
      const req = JSON.parse(init.body);
      assert.ok(["getAccountInfo", "getLatestBlockhash"].includes(req.method));
      const value = req.method === "getAccountInfo" ? {
        data: [mint.toString("base64"), "base64"], executable: false, lamports: 1461600,
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", space: 82,
      } : { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 12345 };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { context: { slot: 1 }, value } }),
        { headers: { "content-type": "application/json" } });
    };
    try { result = await new ExactSvmScheme(svmSigner, { rpcUrl: "https://rpc.invalid/" }).createPaymentPayload(2, requirements); }
    finally { globalThis.fetch = oldFetch; }
  }
  return { ...result, accepted: requirements, resource };
}
export async function verifyOffline(payload, requirements) {
  if (requirements.network === BASE) {
    const a = payload.payload.authorization;
    const isValid = await verifyTypedData({ address: a.from,
      domain: { name: requirements.extra.name, version: requirements.extra.version, chainId: 8453, verifyingContract: requirements.asset },
      types, primaryType: "TransferWithAuthorization", message: a, signature: payload.payload.signature });
    return { isValid, payer: a.from };
  }
  const transaction = getTransactionDecoder().decode(Buffer.from(payload.payload.transaction, "base64"));
  const signature = transaction.signatures[svmSigner.address];
  return { isValid: !!signature && await verifySignature(await getPublicKeyFromAddress(svmSigner.address), signature, transaction.messageBytes),
    payer: svmSigner.address };
}
