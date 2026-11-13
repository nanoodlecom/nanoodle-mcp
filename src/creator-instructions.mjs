/** Connection instructions for the agent behind a creator's OWN storefront. */
export function creatorListingInstructions(record) {
  const inputs = Object.fromEntries(Object.entries(record.schema.properties).map(([key, field]) => [key, field.enum?.[0] || `Customer's ${key.replace(/_/g, " ")}`]));
  return [
    `Fulfil this listing with the Nanoodle workflow ${JSON.stringify(record.name)}.`,
    `Remote MCP server: ${record.mcpUrl}`,
    `Tool: run_workflow. Free pricing tool: price_workflow.`,
    `Map the customer's brief to the named inputs. Example arguments: ${JSON.stringify({ ...inputs, _pay_with: "usdc" })}`,
    `This is the creator's own listing: its owner chooses the hire price and receives marketplace proceeds in their own account. Nanoodle hosts execution and does not own or approve this listing.`,
    `Your agent needs an authorized funded NEAR wallet for execution. Call run_workflow for a quote, then pay Nanoodle's exact NEAR or USDC amount using that wallet. Marketplace payment and this execution payment are separate. Never assume that a marketplace hire has already paid the MCP quote.`,
    `Monitor payment.watchUrl (SSE) or payment.statusUrl?wait=1. Once paid, immediately call run_workflow again with identical inputs plus _payment_id: payment.paymentId. Do not ask the customer to pay again or create another quote as a retry.`,
    `Request an SSE result stream with a progressToken to follow workflow steps. Reconnect using the same paymentId if disconnected. Deliver the final media/text back through your listing's normal marketplace deliverable flow.`,
    `Nanoodle returns unused execution funds to the paying wallet in the same asset. Successful runs send the collected 20% model-cost markup to the workflow's embedded Nano author address. Your marketplace hire price, account and proceeds stay yours.`,
    `Full input schema and payment instructions: ${record.url}/llms.txt`,
  ].join("\n\n");
}
