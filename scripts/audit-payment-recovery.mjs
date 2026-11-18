/** Offline payment-recovery regression checks using synthetic wallet fixtures. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checks = [
  "Nano payment stays pending until its original transfer is durable",
  "Nano history resumes beyond the page cap",
  "Nano history screens unconfirmed and pre-quote deposits",
  "a restart reconciles signed Nano transfers",
  "Nano payment recovery retains a signed send if the completion write fails",
  "a durable Nano send preserves new liabilities",
  "two identical obligations cannot claim the same signed Nano transfer",
  "the scheduled check detects legacy send debt",
];
const suites = ["serve-gate", "x402-wallet", "operational-check"].map(name =>
  fileURLToPath(new URL(`../tests/${name}.test.mjs`, import.meta.url)));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec",
  "--test-name-pattern", checks.join("|"), ...suites], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
