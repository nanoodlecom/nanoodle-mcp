#!/usr/bin/env node
/**
 * nanoodle-mcp — MCP stdio server that exposes saved nanoodle workflow graphs as tools.
 *
 *   nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path]
 *
 * Every *.json noodle-graph save in --graphs becomes one MCP tool. Each tools/call
 * runs the workflow on the NanoGPT API and SPENDS from your key's balance.
 *
 * API key: NANOGPT_API_KEY env var, --key <key>, or --env-file <path> (.env-style file).
 * Precedence: --key > --env-file > NANOGPT_API_KEY (same as the nanoodle CLI).
 * NANOGPT_BASE_URL overrides the API host.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { loadTools } from "../src/tools.mjs";
import { serveMcp } from "../src/server.mjs";

function usage(code = 1) {
  console.error(`usage:
  nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY from a .env-style file (--key wins if both given)

The server speaks MCP over stdio — wire it into an MCP client, don't run it by hand.
Every tools/call spends real money from your NanoGPT balance.`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  let graphsDir = null, outDir = null, keyFlag = null, envFile = null;
  let i = 0;
  const val = (flag) => {
    const v = argv[++i];
    if (v === undefined) { console.error(`${flag} expects a value`); usage(); }
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--graphs") graphsDir = val("--graphs");
    else if (a === "--out") outDir = val("--out");
    else if (a === "--key") keyFlag = val("--key");
    else if (a === "--env-file") envFile = val("--env-file");
    else if (a === "--help" || a === "-h") usage(0);
    else if (a === "--version") {
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(`nanoodle-mcp ${pkg.version}`);
      process.exit(0);
    } else { console.error("unknown argument: " + a); usage(); }
  }
  if (!graphsDir) { console.error("--graphs <dir> is required"); usage(); }

  // key precedence: --key > --env-file > NANOGPT_API_KEY (mirrors the nanoodle CLI)
  let apiKey = keyFlag ?? process.env.NANOGPT_API_KEY;
  if (envFile && keyFlag == null) {
    let envText;
    try { envText = await readFile(envFile, "utf8"); }
    catch (e) { console.error(`--env-file: cannot read ${envFile}: ${e.message}`); process.exit(1); }
    const m = envText.match(/^NANOGPT_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!m) { console.error(`--env-file: no NANOGPT_API_KEY entry in ${envFile}`); process.exit(1); }
    apiKey = m[1].trim();
  }

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const registry = await loadTools({
    dir: graphsDir,
    apiKey,
    baseUrl: process.env.NANOGPT_BASE_URL || undefined,
    outDir: resolve(outDir || "./nanoodle-out"),
  });

  for (const f of registry.failures) {
    console.error(`nanoodle-mcp: skipping ${f.file}: ${f.reason}`);
  }
  if (!registry.tools.length) {
    console.error(`nanoodle-mcp: no runnable graphs in ${resolve(graphsDir)} — ` +
      (registry.failures.length
        ? "every .json file was skipped (reasons above)."
        : "no .json files found. Save workflows from the nanoodle editor (💾 → noodle-graph.json) into that directory."));
    process.exit(1);
  }
  if (!apiKey) {
    console.error("nanoodle-mcp: warning — no NanoGPT API key (NANOGPT_API_KEY / --key / --env-file); tool calls that hit the API will fail");
  }

  console.error(`nanoodle-mcp ${pkg.version}: serving ${registry.tools.length} tool(s) from ${resolve(graphsDir)}`);
  for (const t of registry.tools) console.error(`  - ${t.name} (${t.file}): ${t.description}`);

  serveMcp({
    name: "nanoodle-mcp",
    version: pkg.version,
    listTools: () => registry.listTools(),
    callTool: (params) => registry.callTool(params),
  });
}

main().catch((e) => { console.error("nanoodle-mcp: " + ((e && e.message) || e)); process.exit(1); });
