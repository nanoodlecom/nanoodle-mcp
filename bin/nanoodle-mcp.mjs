#!/usr/bin/env node
/**
 * nanoodle-mcp — MCP stdio server that exposes saved nanoodle workflow graphs as tools.
 *
 *   nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
 *
 * Every *.json noodle-graph save in --graphs becomes one MCP tool. Each tools/call
 * runs the workflow on the NanoGPT API and SPENDS from your key's balance — or, in
 * wallet mode, pays each call's x402 invoice in Nano from your own wallet.
 *
 * API key: NANOGPT_API_KEY env var, --key <key>, or --env-file <path> (.env-style file).
 * Precedence: --key > --env-file > NANOGPT_API_KEY (same as the nanoodle CLI).
 * NANOGPT_BASE_URL overrides the API host.
 *
 * Wallet mode (accountless x402, used only when no API key is set):
 * NANO_PRIVATE_KEY (64-hex secret key) or NANO_SEED (64-hex seed, account 0), from the
 * environment or --env-file (env-file wins, mirroring the key). Never a CLI flag — argv
 * leaks via `ps`. NANO_RPC_URL / --nano-rpc picks the Nano node (default rpc.nano.to);
 * --max-usd refuses any single invoice above $n.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { loadTools } from "../src/tools.mjs";
import { serveMcp } from "../src/server.mjs";
import { createNanoWallet, resolveWalletKey, DEFAULT_NANO_RPC } from "../src/wallet.mjs";

function usage(code = 1) {
  console.error(`usage:
  nanoodle-mcp --graphs <dir> [--out dir] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY from a .env-style file
                 (--key wins over its NANOGPT_API_KEY if both given)
  --nano-rpc u   Nano RPC node for wallet mode (default ${DEFAULT_NANO_RPC}; NANO_RPC_URL)
  --work-rpc u   dedicated work_generate endpoint, e.g. a local nano-work-server
                 (NANO_WORK_URL; falls back to --nano-rpc, then local CPU work)
  --max-usd n    wallet mode: refuse any single x402 invoice above $n

No API key? Set NANO_SEED or NANO_PRIVATE_KEY (env or --env-file) to run accountless:
each call's HTTP 402 invoice is paid in Nano (XNO) from that wallet via x402.
Use a dedicated wallet with a small balance — it doubles as your spend cap.

The server speaks MCP over stdio — wire it into an MCP client, don't run it by hand.
Every tools/call spends real money (your NanoGPT balance, or your Nano wallet).`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  let graphsDir = null, outDir = null, keyFlag = null, envFile = null, nanoRpcFlag = null, workRpcFlag = null, maxUsdFlag = null;
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
    else if (a === "--nano-rpc") nanoRpcFlag = val("--nano-rpc");
    else if (a === "--work-rpc") workRpcFlag = val("--work-rpc");
    else if (a === "--max-usd") maxUsdFlag = val("--max-usd");
    else if (a === "--help" || a === "-h") usage(0);
    else if (a === "--version") {
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(`nanoodle-mcp ${pkg.version}`);
      process.exit(0);
    } else { console.error("unknown argument: " + a); usage(); }
  }
  if (!graphsDir) { console.error("--graphs <dir> is required"); usage(); }
  let maxUsd = null;
  if (maxUsdFlag != null) {
    maxUsd = Number(maxUsdFlag);
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) { console.error("--max-usd expects a positive number"); usage(); }
  }

  // key precedence: --key > --env-file > NANOGPT_API_KEY (mirrors the nanoodle CLI)
  let apiKey = keyFlag ?? process.env.NANOGPT_API_KEY;
  // wallet material: --env-file > environment; never argv (it leaks via `ps`)
  let nanoSeed = process.env.NANO_SEED, nanoKey = process.env.NANO_PRIVATE_KEY;
  let workUrl = workRpcFlag || process.env.NANO_WORK_URL || null;
  if (envFile) {
    let envText;
    try { envText = await readFile(envFile, "utf8"); }
    catch (e) { console.error(`--env-file: cannot read ${envFile}: ${e.message}`); process.exit(1); }
    const entry = (name) => {
      const m = envText.match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, "m"));
      return m ? m[1].trim() : undefined;
    };
    const fileKey = entry("NANOGPT_API_KEY");
    if (fileKey && keyFlag == null) apiKey = fileKey;
    nanoSeed = entry("NANO_SEED") ?? nanoSeed;
    nanoKey = entry("NANO_PRIVATE_KEY") ?? nanoKey;
    if (!workRpcFlag) workUrl = entry("NANO_WORK_URL") ?? workUrl;
    if (!fileKey && entry("NANO_SEED") === undefined && entry("NANO_PRIVATE_KEY") === undefined) {
      console.error(`--env-file: no NANOGPT_API_KEY, NANO_SEED, or NANO_PRIVATE_KEY entry in ${envFile}`);
      process.exit(1);
    }
  }

  // wallet mode: accountless x402, only when there's no API key (a key always wins,
  // matching the nanoodle library's own precedence)
  let wallet = null;
  if (!apiKey && (nanoKey || nanoSeed)) {
    try {
      wallet = createNanoWallet({
        secretKey: resolveWalletKey({ privateKey: nanoKey, seed: nanoSeed }),
        rpcUrl: nanoRpcFlag || process.env.NANO_RPC_URL || undefined,
        workUrl,
        maxUsd,
        log: (line) => console.error("nanoodle-mcp: " + line),
      });
    } catch (e) { console.error("nanoodle-mcp: " + e.message); process.exit(1); }
  } else if (apiKey && (nanoKey || nanoSeed)) {
    console.error("nanoodle-mcp: both an API key and a Nano wallet are configured — using the key (wallet ignored)");
  }

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const registry = await loadTools({
    dir: graphsDir,
    apiKey,
    payment: wallet ? wallet.payment : undefined,
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
  if (!apiKey && !wallet) {
    console.error("nanoodle-mcp: warning — no NanoGPT API key (NANOGPT_API_KEY / --key / --env-file) " +
      "and no x402 wallet (NANO_SEED / NANO_PRIVATE_KEY); tool calls that hit the API will fail");
  }
  if (wallet) {
    console.error(`nanoodle-mcp: wallet mode (accountless x402) — paying from ${wallet.address}` +
      (maxUsd != null ? `, capped at $${maxUsd}/call` : ", no per-call cap (--max-usd)") +
      (workUrl ? `, work via ${workUrl}` : ""));
  }

  console.error(`nanoodle-mcp ${pkg.version}: serving ${registry.tools.length} tool(s) from ${resolve(graphsDir)}`);
  for (const t of registry.tools) console.error(`  - ${t.name} (${t.file}): ${t.description}`);
  console.error("  - run_noodle: runs any nanoodle share link on the fly (always available)");

  serveMcp({
    name: "nanoodle-mcp",
    version: pkg.version,
    listTools: () => registry.listTools(),
    callTool: (params) => registry.callTool(params),
  });
}

main().catch((e) => { console.error("nanoodle-mcp: " + ((e && e.message) || e)); process.exit(1); });
