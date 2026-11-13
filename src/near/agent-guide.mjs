/** One actionable payment guide for discovery and MCP initialize. The quote,
 * rather than this prose, is authoritative for asset, recipient and amount.
 */
export function nearAgentGuide({ publicBase, usdc = false, network = "mainnet" }) {
  return [
    `## Agent quickstart: ${usdc ? "NEAR and USDC on NEAR" : "native NEAR"}`,
    ``,
    `Use ${publicBase}/mcp on NEAR ${network}. No Nanoodle account, subscription, provider key, or Nano wallet is required.`,
    `1. Discover tools with tools/list. For a custom graph, use noodle_guide and price_noodle (both free), then run_noodle. Saved workflows can be quoted directly.`,
    `2. Call the desired tool with its original inputs${usdc ? ' and _pay_with: "near" or "usdc"' : ''}. Native NEAR is the default${usdc ? '; respect a request to pay USDC by setting _pay_with: "usdc"' : ''}. An unpaid call only returns a quote; it never runs or charges a model.`,
    `3. Read structuredContent.payment. Preserve the original tool name and arguments, paymentId, asset, network, payTo and exact amount. The amount includes a small unique matching component: never round it or reuse an old quote.`,
    `4. If you have an authorized funded NEAR wallet, pay the quote directly within the user's spending authorization. For native NEAR: one Transfer to payment.payTo with deposit payment.amountYocto (integer string).`,
    ...(usdc ? [`   For USDC: one FunctionCall to payment.tokenContract, method ft_transfer, JSON args {"receiver_id":payment.payTo,"amount":payment.amountAtomic}, with exactly "1" yoctoNEAR attached and sufficient gas. Use the token contract and six-decimal integer amount from the quote. USDC is on NEAR, not another chain. Keep NEAR for gas; do not send the USDC amount as native NEAR or use ft_transfer_call.`] : []),
    `   If the wallet requires human approval, show ONLY payment.payUrl and immediately open payment.watchUrl (Accept: text/event-stream), or GET payment.statusUrl?wait=1. The pay page prepares the correct asset transfer. No transaction hash needs to be copied from the user.`,
    `5. On status "paid", immediately continue with tools/call: the same tool and identical original inputs plus _payment_id: payment.paymentId. Confirmed payment authorizes this quoted run; do not wait for a follow-up "paid" or "go" message. Direct-wallet agents can skip discovery delay by also passing _payment_tx and _payment_sender from the submitted transaction.`,
    `6. Request Accept: text/event-stream and params._meta.progressToken for the result call. Progress notifications include real node states; wait for the final JSON-RPC result. A multi-model run can take minutes. Do not start another paid run because generation is slow.`,
    `7. Read structuredContent.receipt. Cost is model spend + 20%, capped by the deposit. Change returns to the transaction signer in the SAME asset. Poll the same statusUrl if refund.status is "pending". A failed run refunds the full deposit.`,
    `Recovery: status "running" means an existing execution is active; keep monitoring its status. For "settled", replay the same call with the same paymentId to retrieve the existing outcome. After payment, never create/pay a replacement quote as a retry. If the result connection drops, reconnect using that same paymentId. An unpaid expired quote can be replaced with a fresh quote before paying.`,
    `Discovery: GET ${publicBase}/llms.txt; initialize on ${publicBase}/mcp returns these same payment instructions.`,
    ``,
  ].join("\n");
}
