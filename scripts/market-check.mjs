#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson } from "./near-check.mjs";
import { checkMarketAvailability } from "../src/market/public-availability.mjs";

export { MARKET_HANDLES } from "../src/market/public-availability.mjs";

export async function runMarketCheck({ stateDir, ...options }, deps = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const report = await checkMarketAvailability(options, deps);
  atomicJson(join(stateDir, "market-latest.json"), report);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const report = await runMarketCheck({ stateDir: process.env.CHECK_STATE_DIR || "/var/lib/nanoodle-near-check" });
    console.log(JSON.stringify(report)); if (!report.ok) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ ok: false, stage: "service", error: "Market check could not finish; inspect the service journal" })); process.exitCode = 1; }
}
