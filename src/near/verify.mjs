/**
 * Read a payment transaction from RPC and check its shape: final, successful,
 * exactly one native Transfer to the merchant. Amount, expiry and age policy
 * belong to the caller (the gate), not here.
 *
 * The payer is the transaction's signer_id read from the chain. The caller's
 * claimed sender only routes the lookup: public RPCs answer `tx` even when the
 * sender is wrong, so the claim proves nothing.
 */
import { assertNearAccountId } from "./account.mjs";
import { base58Decode } from "./base58.mjs";
import { NearError } from "./errors.mjs";
import { hasFtTransfer } from "./ft.mjs";

const TRANSPORT = new Set(["RPC_HTTP", "RPC_TIMEOUT", "RPC_BAD_RESPONSE"]);
const NOT_FOUND = new Set(["UNKNOWN_TRANSACTION", "TIMEOUT_ERROR"]);

function hasKey(obj, key) {
  return obj !== null && typeof obj === "object" && Object.hasOwn(obj, key);
}

/**
 * `txTimeoutMs` bounds the `tx` call. A `FINAL` wait for a hash the network has
 * never seen is held by the RPC node (about 30 s on public testnet RPC) before it
 * answers TIMEOUT_ERROR, so the default leaves room for that answer.
 */
export async function readPaymentTransfer({ rpc, txHash, senderId, merchantId, tokenContract = null, txTimeoutMs = 40_000 }) {
  base58Decode(txHash, 32);
  assertNearAccountId(senderId);
  assertNearAccountId(merchantId);

  let r;
  try {
    r = await rpc.txStatus({ txHash, senderId, waitUntil: "FINAL", timeoutMs: txTimeoutMs });
  } catch (e) {
    if (NOT_FOUND.has(e?.code)) throw new NearError("TX_NOT_FOUND", `transaction ${txHash} was not found as final on this network`, { cause: e });
    if (TRANSPORT.has(e?.code)) throw new NearError("RPC_UNAVAILABLE", "the NEAR RPC could not be reached; try again", { cause: e });
    throw e;
  }
  if (!r || typeof r !== "object") throw new NearError("RPC_UNAVAILABLE", "the NEAR RPC returned no transaction");
  if (r.final_execution_status !== "FINAL") {
    throw new NearError("TX_NOT_FINAL", `transaction ${txHash} is not final yet (${String(r.final_execution_status)})`);
  }
  if (!hasKey(r.status, "SuccessValue")) throw new NearError("TX_FAILED", `transaction ${txHash} did not succeed`);
  const receipts = Array.isArray(r.receipts_outcome) ? r.receipts_outcome : [];
  if (receipts.some((ro) => hasKey(ro?.outcome?.status, "Failure"))) {
    throw new NearError("TX_FAILED", `transaction ${txHash} has a failed receipt`);
  }
  const tx = r.transaction;
  if (!tx || tx.hash !== txHash) throw new NearError("TX_MISMATCH", "the RPC returned a different transaction than the one asked for");
  const actions = tx.actions;
  let deposit = Array.isArray(actions) && actions.length === 1 && actions[0] && typeof actions[0] === "object"
    && Object.keys(actions[0]).length === 1 && hasKey(actions[0], "Transfer")
    ? actions[0].Transfer?.deposit
    : undefined;
  const payer = assertNearAccountId(tx.signer_id);
  if (tokenContract) {
    const call = Array.isArray(actions) && actions.length === 1 && Object.keys(actions[0] || {}).join(",") === "FunctionCall" ? actions[0].FunctionCall : null;
    if (tx.receiver_id !== tokenContract) throw new NearError("WRONG_RECEIVER", "The payment was not sent to the quoted USDC contract");
    let args;
    try {
      if (typeof call?.args !== "string" || call.args.length > 8192 || Buffer.from(call.args, "base64").toString("base64") !== call.args) throw new Error();
      args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
    } catch { throw new NearError("NOT_A_SINGLE_TRANSFER", "The payment must be one USDC ft_transfer call"); }
    if (call.method_name !== "ft_transfer" || call.deposit !== "1" || typeof args?.amount !== "string"
      || !/^[1-9]\d{0,38}$/.test(args.amount) || BigInt(args.amount) >= 1n << 128n) {
      throw new NearError("NOT_A_SINGLE_TRANSFER", "The payment must be one USDC ft_transfer with exactly 1 yoctoNEAR attached");
    }
    if (args.receiver_id !== merchantId) throw new NearError("WRONG_RECEIVER", "The USDC transfer pays a different account");
    if (!hasFtTransfer(r, { tokenContract, from: payer, to: merchantId, amount: args.amount })) {
      throw new NearError("TX_FAILED", "The USDC contract did not emit the exact quoted transfer");
    }
    deposit = args.amount;
  } else if (typeof deposit !== "string" || !/^\d+$/.test(deposit)) {
    throw new NearError("NOT_A_SINGLE_TRANSFER", `transaction ${txHash} is not exactly one native NEAR transfer`);
  }
  if (!tokenContract && tx.receiver_id !== merchantId) {
    throw new NearError("WRONG_RECEIVER", `transaction ${txHash} pays ${String(tx.receiver_id)}, not ${merchantId}`);
  }

  const blockHash = r.transaction_outcome?.block_hash;
  if (typeof blockHash !== "string") throw new NearError("RPC_UNAVAILABLE", "the RPC returned no block for the transaction");
  let block;
  try {
    block = await rpc.block({ blockId: blockHash });
  } catch (e) {
    throw new NearError("RPC_UNAVAILABLE", "could not read the transaction's block; try again", { cause: e });
  }
  const ns = block?.header?.timestamp_nanosec;
  if (typeof ns !== "string" || !/^\d+$/.test(ns)) throw new NearError("RPC_UNAVAILABLE", "the transaction's block has no timestamp");

  return {
    txHash,
    payer,
    receiver: tokenContract ? merchantId : tx.receiver_id,
    amountYocto: BigInt(deposit),
    ...(tokenContract ? { asset: "usdc", tokenContract } : {}),
    blockHash,
    blockTimeMs: Number(BigInt(ns) / 1_000_000n),
  };
}
