#!/usr/bin/env node
/**
 * Check the prices of the listings in an Agent Market catalog against what
 * their own workflows can cost. Needs no credentials and spends nothing: it
 * prices each graph from NanoGPT's public catalog and reads each listing's
 * price from the market's public API.
 *
 *   node scripts/market-catalog.mjs plan  [--agents-file f]   print the table; always exits 0
 *   node scripts/market-catalog.mjs check [--agents-file f]   the same; exits 1 if a listing is priced too low
 *
 * See docs/near-agent-market.md#several-listings.
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { MarketConfigError } from "../src/market/service.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import { readCatalog, fetchListingPrice, priceVerdict, recommendPrice, budgetFromPrice, fmtUsd, REPO_ROOT, PROBE_BRIEF } from "../src/market/catalog.mjs";

const USAGE = `Usage: node scripts/market-catalog.mjs plan|check [--agents-file <file>] [--base-url <url>] [--nanogpt-base <url>]

  plan    for each listing with a workflow: estimated cost, deposit (the most a run can cost),
          the recommended price (smallest multiple of $0.05 whose 95% covers the deposit),
          the market's current price when it can be read, and a verdict. Exits 0.
  check   the same, and exits 1 if any listing's price is too low for its own workflow.

  --agents-file   the catalog (env MARKET_AGENTS_FILE; default scripts/market-catalog.json)
  --base-url      market API (env MARKET_BASE_URL; default https://market.near.ai)
  --nanogpt-base  NanoGPT API (env NANOGPT_BASE_URL; default https://nano-gpt.com)`;

export async function plan({ file, baseUrl, nanogptBase, out = (l) => process.stdout.write(l + "\n"), fetch = globalThis.fetch }) {
  const catalog = readCatalog(file);
  // Pricing only: this runner never runs anything, and its key is never sent anywhere by price().
  const runner = createWorkflowRunner({ apiKey: "pricing-only", budgetUsd: 1e6, baseUrl: nanogptBase, fetch });
  const rows = [];
  out(`Listings in ${catalog.file} (priced ${new Date().toISOString().slice(0, 10)}; market ${baseUrl})`);
  for (const a of catalog.agents) {
    const market = await fetchListingPrice({ baseUrl, handle: a.handle, fetch });
    const priceUsd = market.ok ? market.priceUsd : a.priceUsd;
    const priceFrom = market.ok ? `market, ${market.listingStatus || "listed"}` : a.priceUsd != null ? "catalog priceUsd; not read on the market" : null;
    out("");
    out(`${a.handle}${a.defaultWorkflow ? `  ${a.defaultWorkflow.label}` : ""}${a.custom ? (a.defaultWorkflow ? "  (also runs buyers' own workflows)" : "  (buyers' own workflows only)") : ""}`);
    const priceLine = priceUsd != null ? `$${fmtUsd(priceUsd)} (${priceFrom}); per-job budget $${fmtUsd(budgetFromPrice(priceUsd))}` : `not known (${market.reason})`;
    if (!a.defaultWorkflow) {
      out(`  price           ${priceLine}`);
      rows.push({ handle: a.handle, priceUsd, verdict: "n/a" });
      continue;
    }
    const wf = a.defaultWorkflow;
    const r = await runner.price({ graph: wf.graph, inputs: { [wf.inputName]: PROBE_BRIEF } });
    if (!r.ok) {
      out(`  REFUSED: this workflow cannot run on a paid worker:`);
      for (const x of r.refusals) out(`    - ${x.message}`);
      rows.push({ handle: a.handle, priceUsd, verdict: "refused" });
      continue;
    }
    const v = priceVerdict({ priceUsd: priceUsd ?? null, depositUsd: r.pricing.depositUsd });
    out(`  estimated cost  $${r.pricing.estimatedCostUsd.toFixed(6)}`);
    out(`  deposit         $${fmtUsd(r.pricing.depositUsd)} (the most a run can cost)`);
    out(`  recommended     $${fmtUsd(recommendPrice({ depositUsd: r.pricing.depositUsd }))}`);
    out(`  price           ${priceLine}`);
    out(`  verdict         ${v.text}`);
    rows.push({ handle: a.handle, priceUsd, estimatedCostUsd: r.pricing.estimatedCostUsd, depositUsd: r.pricing.depositUsd, recommendedUsd: v.recommendedUsd, verdict: v.verdict });
  }
  return rows;
}

async function main() {
  let a;
  try {
    a = parseArgs({
      args: process.argv.slice(2), allowPositionals: true, strict: true,
      options: { "agents-file": { type: "string" }, "base-url": { type: "string" }, "nanogpt-base": { type: "string" }, help: { type: "boolean" } },
    });
  } catch (e) { process.stderr.write(`market-catalog: ${e.message}\n\n${USAGE}\n`); process.exit(2); }
  const cmd = a.positionals[0];
  if (a.values.help || !cmd) { process.stdout.write(USAGE + "\n"); process.exit(a.values.help ? 0 : 2); }
  if (cmd !== "plan" && cmd !== "check") { process.stderr.write(`market-catalog: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}\n`); process.exit(2); }
  const file = a.values["agents-file"] ?? process.env.MARKET_AGENTS_FILE ?? join(REPO_ROOT, "scripts", "market-catalog.json");
  const baseUrl = a.values["base-url"] ?? process.env.MARKET_BASE_URL ?? "https://market.near.ai";
  const nanogptBase = a.values["nanogpt-base"] ?? process.env.NANOGPT_BASE_URL ?? undefined;
  let rows;
  try { rows = await plan({ file, baseUrl, nanogptBase }); } catch (e) {
    if (!(e instanceof MarketConfigError)) throw e;
    process.stderr.write(`market-catalog: ${e.message}\n`);
    process.exit(2);
  }
  // A workflow the paid rules refuse can never run on its listing: that fails the check too.
  const low = rows.filter((r) => r.verdict === "too-low" || r.verdict === "refused").map((r) => r.handle);
  if (cmd === "check" && low.length) {
    process.stdout.write(`\npriced too low for their own workflow, or the workflow cannot run: ${low.join(", ")}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("market-catalog.mjs")) {
  main();
}
