#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runPublicMcpCheck } from "../src/public-mcp-check.mjs";

export { runPublicMcpCheck };

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const report = await runPublicMcpCheck();
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
}
