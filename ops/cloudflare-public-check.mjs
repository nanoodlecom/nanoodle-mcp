import { runPublicMcpCheck } from "../src/public-mcp-check.mjs";
import { checkMarketAvailability } from "../src/market/public-availability.mjs";

async function edgeFetch(url, options) {
  // Workers implements manual redirects. Keep the probes on their pinned origins.
  const response = await fetch(url, { ...options, redirect: "manual", cache: "no-store" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("availability-probe-redirect");
  }
  return response;
}

export default {
  async scheduled(controller) {
    // Finish the MCP requests before opening the Market connections.
    const mcp = await runPublicMcpCheck({ fetch: edgeFetch });
    const market = await checkMarketAvailability({}, { fetch: edgeFetch });
    const failures = [...mcp.checks, ...market.checks].filter(check => !check.ok)
      .map(({ stage, code, error }) => ({ stage, code: code ?? error }));
    console.log(JSON.stringify({ service: "nanoodle-public-availability", scheduledAt: new Date(controller.scheduledTime).toISOString(),
      checkedAt: mcp.checkedAt, ok: !failures.length, checks: mcp.checks.length + market.checks.length, failures }));
    if (failures.length) throw new Error("Nanoodle public availability check failed");
  },
};
