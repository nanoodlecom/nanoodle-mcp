/** Payment and execution instructions for any agent using a hosted workflow. */
export function creatorAgentInstructions(record) {
  const inputs = Object.fromEntries(Object.entries(record.schema.properties).map(([key, field]) => [key, field.enum?.[0] || `User's ${key.replace(/_/g, " ")}`]));
  return [
    `Run the Nanoodle workflow ${JSON.stringify(record.name)}.`,
    `Remote MCP server: ${record.mcpUrl}`,
    `Tool: run_workflow. Free pricing tool: price_workflow.`,
    `Map the user's request to the named inputs. Example arguments: ${JSON.stringify({ ...inputs, _pay_with: "near" })}`,
    `Call run_workflow for a quote. Pay its exact NEAR or USDC amount from an authorized funded wallet, or show the wallet payment link for the user to approve. Never execute a second payment as a retry.`,
    `Monitor payment.watchUrl (SSE) or payment.statusUrl?wait=1. Once paid, immediately call run_workflow again with identical inputs plus _payment_id: payment.paymentId. Do not ask the user to pay again or create another quote as a retry.`,
    `Request an SSE result stream with a progressToken to follow workflow steps. Reconnect using the same paymentId if disconnected. Show the final media or text to the user.`,
    `Nanoodle returns unused execution funds to the paying wallet in the same asset. Successful runs send the collected 20% fee on actual model cost to the workflow's embedded Nano author address.`,
    `Full input schema and payment instructions: ${record.url}/llms.txt`,
  ].join("\n\n");
}
