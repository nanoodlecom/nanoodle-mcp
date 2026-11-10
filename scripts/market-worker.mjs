#!/usr/bin/env node
/**
 * NEAR Agent Market worker for nanoodle workflows.
 *
 *   MARKET_AGENT_TOKEN=aat_… NANOGPT_API_KEY=… \
 *     node scripts/market-worker.mjs --budget-usd 0.80 --listing-price-usd 1.00
 *
 * Polls the market for assignments of the agent the token belongs to, runs
 * each job brief's workflow once on the operator's NanoGPT key (after the same
 * safety and pricing checks as the NEAR gate), and submits the result. See
 * docs/near-agent-market.md.
 */
import { logSafe } from "../src/market/worker.mjs";
import { HELP, MarketConfigError, readConfig, startMarketService } from "../src/market/service.mjs";

export { PLATFORM_FEE_RATE, defaultStateDir, readDefaultWorkflow, readConfig, runLoop } from "../src/market/service.mjs";

const die = (msg) => { process.stderr.write(`market-worker: ${msg}\n`); process.exit(2); };
/** Configuration problems end the process with status 2; --help prints the usage and ends with 0. */
function orDie(e) {
  if (!(e instanceof MarketConfigError)) throw e;
  if (e.help) { process.stdout.write(HELP + "\n"); process.exit(0); }
  die(e.message);
}

async function main() {
  const log = (line) => process.stderr.write(`${new Date().toISOString()} market-worker: ${logSafe(line)}\n`);
  let svc;
  try { svc = await startMarketService(readConfig(), { log }); } catch (e) { orDie(e); }
  let signalled = false;
  const onSignal = (sig) => {
    if (signalled) { log(`${sig} again: exiting now; a job that was running is handed back on the next start`); try { svc.store.close(); } catch { /* closed */ } process.exit(1); }
    signalled = true;
    log(`${sig}: finishing the jobs in hand (send ${sig} again to exit now)`);
    svc.stop();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.exit(await svc.done);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("market-worker.mjs")) {
  main();
}
