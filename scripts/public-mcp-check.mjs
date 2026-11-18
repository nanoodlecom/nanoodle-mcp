#!/usr/bin/env node
import { runPublicMcpCheck } from "../src/public-mcp-check.mjs";

export { runPublicMcpCheck };

if (import.meta.main) {
  const report = await runPublicMcpCheck();
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
