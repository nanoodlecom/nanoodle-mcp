/** Offline payment-recovery regression checks using synthetic wallet fixtures. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checks = [
  "Nano payment stays pending until its original transfer is durable",
  "Nano history resumes beyond the page cap",
  "Nano history screens unconfirmed and pre-quote deposits",
  "a restart reconciles signed Nano transfers",
  "Nano payment recovery retains a signed send if the completion write fails",
  "a Nano workflow killed after provider dispatch",
  "a failed Nano execution-claim write buys no inference",
  "Nano startup records an interrupted refund while admission is paused",
  "a pre-claim Nano deposit is reserved for reconciliation",
  "the scheduled check detects overdue Nano execution",
  "modern Nano settlement evidence reserves",
  "a marked Nano refund requires proof",
  "earlier Nano outcomes preserve the receipt formats",
  "Nano restore retains aged settlement gaps",
  "the scheduled check reserves incomplete Nano settlements",
  "a durable Nano send preserves new liabilities",
  "two identical obligations cannot claim the same signed Nano transfer",
  "the scheduled check detects legacy send debt",
];
const suites = ["serve-gate", "x402-wallet", "operational-check", "state-audit", "funding-liabilities"].map(name =>
  fileURLToPath(new URL(`../tests/${name}.test.mjs`, import.meta.url)));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec",
  "--test-name-pattern", checks.join("|"), ...suites], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
