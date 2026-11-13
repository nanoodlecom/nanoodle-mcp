/** Circle-issued USDC on NEAR. Amounts are integer micro-USDC, never floats. */
import { randomInt } from "node:crypto";
import { NearError } from "./errors.mjs";
import { usdToYocto } from "./amount.mjs";
import { signFunctionCall } from "./tx.mjs";

// https://developers.circle.com/stablecoins/usdc-contract-addresses
export const USDC_CONTRACTS = Object.freeze({
  mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  testnet: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
});
export const USDC_SCALE = 1_000_000n;
export const USDC_RATE = Object.freeze({ usdNano: 1_000_000_000n, yocto: USDC_SCALE });

export function formatUsdc(amount) {
  if (!(typeof amount === "bigint" || typeof amount === "string" && /^\d+$/.test(amount))) throw new NearError("BAD_AMOUNT", "USDC amount must be integer units");
  const n = BigInt(amount);
  if (n < 0n) throw new NearError("BAD_AMOUNT", "USDC amount cannot be negative");
  const fraction = (n % USDC_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${n / USDC_SCALE}${fraction ? "." + fraction : ""}`;
}

export function usdcDeposit(usd, taken, rng = randomInt) {
  const base = usdToYocto(usd, USDC_RATE, "ceil");
  for (let i = 0; i < 200; i++) {
    const amount = base + BigInt(rng(1, 1000));
    if (!taken(amount)) return amount;
  }
  for (let dust = 1n; dust < 1000n; dust++) if (!taken(base + dust)) return base + dust;
  throw new NearError("NO_UNIQUE_AMOUNT", "every USDC deposit amount at this price is in use");
}

export async function ftView(rpc, tokenContract, method, args = {}) {
  const result = await rpc.call("query", { request_type: "call_function", finality: "final", account_id: tokenContract,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  try { return JSON.parse(Buffer.from(result.result).toString("utf8")); }
  catch { throw new NearError("RPC_BAD_RESPONSE", `Invalid ${method} result from token contract`); }
}

export async function checkUsdcMerchant({ rpc, network, merchantId }) {
  const tokenContract = USDC_CONTRACTS[network];
  if (!tokenContract) throw new NearError("BAD_TOKEN", "USDC network is not supported");
  const [metadata, storage] = await Promise.all([
    ftView(rpc, tokenContract, "ft_metadata"), ftView(rpc, tokenContract, "storage_balance_of", { account_id: merchantId }),
  ]);
  if (metadata?.symbol !== "USDC" || metadata.decimals !== 6 || metadata.spec !== "ft-1.0.0") throw new NearError("BAD_TOKEN", "USDC contract metadata does not match the expected asset");
  if (!storage || !/^\d+$/.test(storage.total) || BigInt(storage.total) <= 0n) throw new NearError("USDC_NOT_REGISTERED", "The merchant must register storage with the USDC contract before accepting USDC");
  return { tokenContract, symbol: "USDC", decimals: 6 };
}

/** Confirm the trusted token contract emitted the exact NEP-141 transfer. */
export function hasFtTransfer(result, { tokenContract, from, to, amount }) {
  let matches = 0;
  for (const receipt of result.receipts_outcome || []) {
    if (receipt.outcome?.executor_id !== tokenContract) continue;
    for (const line of receipt.outcome.logs || []) {
      if (typeof line !== "string" || !line.startsWith("EVENT_JSON:")) continue;
      let event;
      try { event = JSON.parse(line.slice(11)); } catch { continue; }
      if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) continue;
      for (const entry of event.data) {
        if (entry.old_owner_id === from && entry.new_owner_id === to && entry.amount === String(amount)) matches++;
      }
    }
  }
  return matches === 1;
}

export function signFtTransfer({ signer, signerId, tokenContract, to, amount, nonce, blockHash }) {
  if (typeof amount !== "bigint" || amount <= 0n || amount >= 1n << 128n) throw new NearError("BAD_AMOUNT", "USDC transfer amount must be a positive u128");
  return signFunctionCall({ signer, signerId, receiverId: tokenContract, nonce, blockHash,
    methodName: "ft_transfer", args: { receiver_id: to, amount: amount.toString() }, depositYocto: 1n });
}
