#!/usr/bin/env node
/**
 * nanoodle-mcp — MCP server that exposes saved nanoodle workflow graphs as tools.
 *
 *   nanoodle-mcp --graphs <dir> [--graphs <dir> …] [--out dir] [--out-ttl h] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
 *   nanoodle-mcp --graphs <dir> --serve [host:]port [--charge-usd n] [--public-url u] [--nano-ws url]
 *   nanoodle-mcp --graphs <dir> --serve [host:]port --near-merchant <account> [--near-network testnet|mainnet]
 *                [--near-rpc url] [--near-key-file path] [--near-usd n] [--near-max-deposit-usd n]
 *                [--near-swap-spread-bps n] [--near-quote-ttl-min n] [--near-rates-refresh-s n]
 *   --charge-usd and --near-merchant together: one server, callers pay each call in Nano or NEAR.
 *
 * Default transport is MCP over stdio. --serve speaks MCP over streamable HTTP
 * instead — host a directory of noodles as a service — and --charge-usd puts an
 * x402 payment gate in front of every call: callers pay in Nano (XNO), no
 * accounts anywhere, refunds on failed runs, optional per-graph author payouts.
 * --near-merchant instead sells runs for native NEAR, custom workflows included:
 * a quote, one transfer of the exact deposit, one run, an automatic refund of
 * whatever the run did not use (docs/near-payments.md). The refund key comes from
 * --near-key-file or NEAR_PRIVATE_KEY (env or --env-file) — never from argv.
 *
 * Every *.json noodle-graph save in a --graphs dir becomes one MCP tool. --graphs
 * may be repeated to serve several dirs (e.g. a per-project ./noodles plus a shared
 * ~/noodles); dirs are scanned in order, so on a name clash the earlier one wins.
 * Each tools/call
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
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import process from "node:process";
import { loadTools, attachEstimates, attachCatalogs } from "../src/tools.mjs";
import { knownUsd } from "../src/usd.mjs";
import { warnIfFfmpegMissing } from "../src/ffmpeg-check.mjs";
import { serveMcp } from "../src/server.mjs";
import { serveHttp } from "../src/http.mjs";
import { redactUrl } from "../src/redact.mjs";
import { startSweeper } from "../src/sweep.mjs";
/*
 * src/wallet.mjs and src/gate.mjs are the ONLY modules that reach `nanocurrency`,
 * and they load on demand (see loadWalletMod / loadGateMod below). `nanocurrency`
 * is GPL-3.0 while the rest of this stack is MIT, so a BYOK run must not even
 * execute it — and it is the heaviest import in the tree (a WASM proof-of-work
 * module plus bignumber.js and blakejs), which a key-only run never needs.
 * Keep every nanocurrency-touching import behind these two loaders.
 */
const loadWalletMod = () => import("../src/wallet.mjs");
const loadGateMod = () => import("../src/gate.mjs");
// The NEAR rail shares pure helpers with the Nano gate module, so it loads on demand too.
const loadNearMods = () => Promise.all([import("../src/near/index.mjs"), import("../src/near-gate.mjs")]);

function usage(code = 1) {
  console.error(`usage:
  nanoodle-mcp --graphs <dir> [--graphs <dir> …] [--out dir] [--out-ttl h] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
  nanoodle-mcp --graphs <dir> --serve [host:]port [--charge-usd n] [--public-url u] [--nano-ws url]
  nanoodle-mcp --graphs <dir> --serve [host:]port --near-merchant acct [--near-network n] [--near-rpc u]
               [--near-key-file p] [--near-usd n] [--near-max-deposit-usd n] [--public-url u]
               [--near-swap-spread-bps n] [--near-quote-ttl-min n] [--near-rates-refresh-s n]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required;
                 repeat to serve several dirs — scanned in order, so an earlier dir wins name clashes)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --out-ttl h    privacy: auto-delete generated media older than h hours (fractions ok;
                 0 disables). Default 24 in --serve mode (a hosted server must not hoard
                 customers' generations), off in stdio mode (local files are yours to keep).
                 Only media artifacts are ever deleted — never costs.json/gate-state.json/usage.jsonl
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY / NEAR_PRIVATE_KEY from a .env-style file
                 (--key wins over its NANOGPT_API_KEY if both given)
  --nano-rpc u   Nano RPC node(s) for wallet reads/publishes, comma-separated,
                 tried in order with failover so one throttling node can't end a
                 settlement (default: a resilient public chain; NANO_RPC_URL)
  --work-rpc u   dedicated work_generate endpoint(s), comma-separated, tried in order —
                 nano-work-server boxes and/or hosted GPU work APIs like rpc.nano.to
                 (NANO_WORK_URL; falls back to --nano-rpc, then local CPU work.
                 NANO_WORK_KEY — env or --env-file, never a flag — adds the API key as
                 both a \`key\` body field and a \`nodes-api-key\` header)
  --max-usd n    wallet mode: refuse any single x402 invoice above $n
  --no-local-work  never compute proof-of-work on this machine's CPU — if every
                 remote work source fails, the send fails cleanly instead. Local
                 CPU work blocks the whole process for minutes; recommended off
                 in --serve mode when --work-rpc points somewhere dependable

Serve mode (host your noodles over HTTP instead of stdio):
  --serve [h:]p    speak MCP over streamable HTTP on [host:]port (default 127.0.0.1:8402);
                   also serves a landing page, /pay pages, and generated media under /out/
  --charge-usd n   charge for tool calls, paid in Nano via x402: a deposit up front, settled
                   at the run's ACTUAL metered cost + 20% with the rest returned to the payer
                   as change; the 20% goes to the graph's x402.author address if set, else stays.
                   $n is the COLD-START deposit (used before a tool can be priced), not a cap:
                   each tool's per-run cost is forecast up front from the public catalog and
                   its quote tracks that (and its real observed cost once it runs), so expensive
                   graphs deposit what they actually cost. Change still returns any slack.
                   Per-graph deposit override: "x402": {"usd": 0.10} in the graph JSON.
                   Requires the wallet (NANO_SEED / NANO_PRIVATE_KEY) — it receives payments
                   and sends refunds/change/payouts. Payments (not runs) are logged to a
                   ledger at <out>/usage.jsonl — money events only, no run telemetry.
  --public-url u   absolute base URL callers see in pay links / media links
                   (required in practice behind a reverse proxy or tunnel)
  --nano-ws u      Nano node websocket (wss://…) for push payment detection;
                   polling via --nano-rpc is the always-on fallback (NANO_WS_URL —
                   env or --env-file — keeps a key-bearing ws URL off the command line)
  --xno-usd n      static XNO/USD rate override (default: NanoGPT's own x402 invoices
                   are the rate oracle — the rate we pay is the rate we charge; cached 60s).
                   The NEAR rail uses it too, for its XNO/USD and NEAR→XNO swap rate

Paid in NEAR (custom workflows too; see docs/near-payments.md):
  --near-merchant a  sell tool calls for native NEAR, paid to account a (NEAR_MERCHANT).
                     Callers get a quote, send ONE transfer of the exact deposit, and call
                     again with _payment_id/_payment_tx/_payment_sender; the run settles at
                     actual model cost + 20% service fee and the rest is refunded in NEAR.
                     run_noodle runs callers' own graphs (allowlisted node types only);
                     price_noodle and noodle_guide stay free. Requires --serve. With
                     --charge-usd as well, one server accepts both: Nano by default, NEAR
                     with "_pay_with": "near". NanoGPT is still paid by your API key or Nano wallet.
  --near-network n   testnet (default) or mainnet (NEAR_NETWORK)
  --near-serve [h:]p second HTTP listener, NEAR by default (NEAR_SERVE); shares the
                     existing Nano funding wallet and NEAR ledger in this process
  --near-public-url u public origin for that listener (NEAR_PUBLIC_URL), e.g.
                     https://mcp-near.nanoodle.com; requires --near-serve
  --near-rpc u       NEAR JSON-RPC endpoint(s) you trust for finality, comma-separated,
                     tried in order with failover (NEAR_RPC_URL; default fastnear's
                     public RPC, then near.org's). No node of your own is needed.
  --near-key-file p  near-cli credentials JSON for the merchant's full-access key, used
                     to sign refunds; or NEAR_PRIVATE_KEY=ed25519:… in the env / --env-file.
                     Never accepted on the command line, never logged
  --near-usd n       static NEAR/USD rate (NEAR_USD) for tests and demos; default is
                     CoinGecko's public price, cached 60s, quoting stops when it is stale
  --near-max-deposit-usd n  refuse any call whose deposit would exceed $n (default 2)
  --near-swap-spread-bps n  swap margin, 0-2000 basis points (NEAR_SWAP_SPREAD_BPS; default 0):
                     NEAR amounts are computed at a NEAR/USD rate n bps worse for the caller,
                     to cover swapping received NEAR to XNO (a manual operator task)
  --near-quote-ttl-min n    NEAR quote lifetime in minutes, 1-120 (NEAR_QUOTE_TTL_MIN; default 30);
                     a quote's rates stay locked for all of it
  --near-rates-refresh-s n  background refresh of live rates every n seconds (NEAR_RATES_REFRESH_S;
                     default 60, 0 disables). GET /rates shows them; /rates?refresh=1 refetches
                     (at most once per 15s); SIGHUP re-reads NEAR_USD / NEAR_SWAP_SPREAD_BPS
                     from --env-file and refetches

No API key? Set NANO_SEED or NANO_PRIVATE_KEY (env or --env-file) to run accountless:
each call's HTTP 402 invoice is paid in Nano (XNO) from that wallet via x402.
Use a dedicated wallet with a small balance — it doubles as your spend cap.

Without --serve the server speaks MCP over stdio — wire it into an MCP client.
Every tools/call spends real money (your NanoGPT balance, or your Nano wallet).`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const graphDirs = []; // --graphs is repeatable; order = precedence on name clashes
  let outDir = null, keyFlag = null, envFile = null, nanoRpcFlag = null, workRpcFlag = null, maxUsdFlag = null, outTtlFlag = null;
  let serveSpec = null, chargeUsdFlag = null, publicUrlFlag = null, nanoWsFlag = null, xnoUsdFlag = null, noLocalWork = false;
  let nearMerchantFlag = null, nearNetworkFlag = null, nearRpcFlag = null, nearKeyFile = null, nearUsdFlag = null, nearMaxDepositFlag = null;
  let nearSpreadFlag = null, nearQuoteTtlFlag = null, nearRefreshFlag = null;
  let nearServeFlag = null, nearPublicFlag = null;
  let i = 0;
  const val = (flag) => {
    const v = argv[++i];
    if (v === undefined) { console.error(`${flag} expects a value`); usage(); }
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--graphs") graphDirs.push(val("--graphs"));
    else if (a === "--out") outDir = val("--out");
    else if (a === "--out-ttl") outTtlFlag = val("--out-ttl");
    else if (a === "--key") keyFlag = val("--key");
    else if (a === "--env-file") envFile = val("--env-file");
    else if (a === "--nano-rpc") nanoRpcFlag = val("--nano-rpc");
    else if (a === "--work-rpc") workRpcFlag = val("--work-rpc");
    else if (a === "--max-usd") maxUsdFlag = val("--max-usd");
    else if (a === "--serve") {
      // the value is optional: `--serve` alone binds 127.0.0.1:8402
      serveSpec = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    }
    else if (a === "--charge-usd") chargeUsdFlag = val("--charge-usd");
    else if (a === "--public-url") publicUrlFlag = val("--public-url");
    else if (a === "--nano-ws") nanoWsFlag = val("--nano-ws");
    else if (a === "--xno-usd") xnoUsdFlag = val("--xno-usd");
    else if (a === "--no-local-work") noLocalWork = true;
    else if (a === "--near-merchant") nearMerchantFlag = val("--near-merchant");
    else if (a === "--near-serve") nearServeFlag = val("--near-serve");
    else if (a === "--near-public-url") nearPublicFlag = val("--near-public-url");
    else if (a === "--near-network") nearNetworkFlag = val("--near-network");
    else if (a === "--near-rpc") nearRpcFlag = val("--near-rpc");
    else if (a === "--near-key-file") nearKeyFile = val("--near-key-file");
    else if (a === "--near-usd") nearUsdFlag = val("--near-usd");
    else if (a === "--near-max-deposit-usd") nearMaxDepositFlag = val("--near-max-deposit-usd");
    else if (a === "--near-swap-spread-bps") nearSpreadFlag = val("--near-swap-spread-bps");
    else if (a === "--near-quote-ttl-min") nearQuoteTtlFlag = val("--near-quote-ttl-min");
    else if (a === "--near-rates-refresh-s") nearRefreshFlag = val("--near-rates-refresh-s");
    else if (a === "--near-key" || a === "--near-private-key") {
      console.error(`${a} is not accepted: a key on the command line leaks via ps and shell history. ` +
        "Use --near-key-file <near-cli credentials JSON> or NEAR_PRIVATE_KEY in the environment or --env-file.");
      usage();
    }
    else if (a === "--help" || a === "-h") usage(0);
    else if (a === "--version") {
      const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
      console.log(`nanoodle-mcp ${pkg.version}`);
      process.exit(0);
    } else { console.error("unknown argument: " + a); usage(); }
  }
  if (!graphDirs.length) { console.error("--graphs <dir> is required"); usage(); }
  let maxUsd = null;
  if (maxUsdFlag != null) {
    maxUsd = knownUsd(maxUsdFlag);
    if (maxUsd == null || maxUsd <= 0) { console.error("--max-usd expects a positive number"); usage(); }
  }
  const positive = (flag, v) => {
    if (v == null) return null;
    const n = knownUsd(v);
    if (n == null || n <= 0) { console.error(`${flag} expects a positive number`); usage(); }
    return n;
  };
  const chargeUsd = positive("--charge-usd", chargeUsdFlag);
  const xnoUsd = positive("--xno-usd", xnoUsdFlag);
  let serveHost = "127.0.0.1", servePort = 8402;
  if (serveSpec !== null && serveSpec !== "") {
    const m = serveSpec.match(/^(?:([^:]+):)?(\d+)$/);
    if (!m) { console.error(`--serve expects [host:]port, got "${serveSpec}"`); usage(); }
    if (m[1]) serveHost = m[1];
    servePort = Number(m[2]);
  }
  if (chargeUsd != null && serveSpec === null) { console.error("--charge-usd only makes sense with --serve"); usage(); }

  // NEAR mode: explicit operator config only (flags, or the NEAR_* environment).
  const nearMerchant = nearMerchantFlag || process.env.NEAR_MERCHANT || null;
  const nearMode = !!nearMerchant;
  const nearNetwork = nearNetworkFlag || process.env.NEAR_NETWORK || "testnet";
  let nearUsdText = nearUsdFlag ?? process.env.NEAR_USD ?? null;
  let nearSpreadText = nearSpreadFlag ?? process.env.NEAR_SWAP_SPREAD_BPS ?? null;
  const nearMaxDeposit = positive("--near-max-deposit-usd", nearMaxDepositFlag);
  if (!nearMode && (nearNetworkFlag || nearRpcFlag || nearKeyFile || nearUsdFlag || nearMaxDepositFlag || nearSpreadFlag || nearQuoteTtlFlag || nearRefreshFlag || nearServeFlag || nearPublicFlag)) {
    console.error("the --near-* options need --near-merchant <account> (or NEAR_MERCHANT)"); usage();
  }
  // Two listeners, one wallet queue and one NEAR ledger. A separate wallet
  // process for the NEAR hostname would race the existing Nano account.
  const nearServeSpec = nearServeFlag ?? process.env.NEAR_SERVE ?? null;
  const nearPublicUrl = nearPublicFlag ?? process.env.NEAR_PUBLIC_URL ?? null;
  let nearServeHost = "127.0.0.1", nearServePort = null;
  if (nearServeSpec !== null) {
    const m = nearServeSpec.match(/^(?:([^:]+):)?(\d+)$/);
    if (!nearMode || !m || Number(m[2]) < 1 || Number(m[2]) > 65535 || !nearPublicUrl) {
      console.error("--near-serve (NEAR_SERVE) needs --near-merchant, [host:]port (1-65535), and --near-public-url (NEAR_PUBLIC_URL)"); usage();
    }
    nearServeHost = m[1] || nearServeHost;
    nearServePort = Number(m[2]);
    if (nearServePort === servePort && nearServeHost === serveHost) { console.error("--near-serve must use a different listener from --serve"); usage(); }
  }
  if (nearPublicUrl != null) {
    let u;
    try { u = new URL(nearPublicUrl); } catch { /* rejected below */ }
    if (!nearMode || !nearServePort || !u || !["https:", "http:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
      console.error("--near-public-url (NEAR_PUBLIC_URL) must be an HTTP(S) origin and needs --near-serve"); usage();
    }
  }
  let nearQuoteTtlMin = 30, nearRefreshS = 60;
  if (nearMode) {
    if (serveSpec === null) { console.error("--near-merchant only makes sense with --serve (NEAR payments are for a hosted server)"); usage(); }
    if (nearNetwork !== "testnet" && nearNetwork !== "mainnet") { console.error(`--near-network must be testnet or mainnet, got "${nearNetwork}"`); usage(); }
    if (nearUsdText != null) positive("--near-usd", nearUsdText);
    const ttl = nearQuoteTtlFlag ?? process.env.NEAR_QUOTE_TTL_MIN ?? null;
    if (ttl != null) {
      nearQuoteTtlMin = Number(ttl);
      if (!Number.isInteger(nearQuoteTtlMin) || nearQuoteTtlMin < 1 || nearQuoteTtlMin > 120) { console.error("--near-quote-ttl-min expects a whole number of minutes from 1 to 120"); usage(); }
    }
    const rs = nearRefreshFlag ?? process.env.NEAR_RATES_REFRESH_S ?? null;
    if (rs != null) {
      nearRefreshS = Number(rs);
      if (!Number.isInteger(nearRefreshS) || nearRefreshS < 0 || nearRefreshS > 86_400) { console.error("--near-rates-refresh-s expects a whole number of seconds from 0 to 86400 (0 disables)"); usage(); }
    }
  }

  // --out-ttl: auto-delete generated media older than N hours (fractions allowed; 0 disables).
  // Default differs by mode: a hosted --serve server must not hoard customers' generations, so
  // it defaults to 24h; a local stdio user saved those files to their own disk on purpose, so
  // it defaults OFF (but honors the flag if they pass it). 24h is deliberately the same window
  // as the charge gate's RETAIN_MS: a paid quote's cached result references /out/ URLs and is
  // replayable for 24h, so keeping media 24h keeps replay links alive exactly that long.
  // Lowering --out-ttl below 24h in charge mode means replayed results may point at deleted files.
  const serveMode = serveSpec !== null;
  let outTtlHours;
  if (outTtlFlag != null) {
    outTtlHours = Number(outTtlFlag);
    if (!Number.isFinite(outTtlHours) || outTtlHours < 0) { console.error("--out-ttl expects a non-negative number of hours (0 disables)"); usage(); }
  } else {
    outTtlHours = serveMode ? 24 : 0;
  }
  const outTtlMs = outTtlHours > 0 ? outTtlHours * 60 * 60 * 1000 : 0;

  // key precedence: --key > --env-file > NANOGPT_API_KEY (mirrors the nanoodle CLI)
  let apiKey = keyFlag ?? process.env.NANOGPT_API_KEY;
  // wallet material: --env-file > environment; never argv (it leaks via `ps`)
  let nanoSeed = process.env.NANO_SEED, nanoKey = process.env.NANO_PRIVATE_KEY;
  let workUrl = workRpcFlag || process.env.NANO_WORK_URL || null;
  let workKey = process.env.NANO_WORK_KEY || null;
  let nanoWs = nanoWsFlag || process.env.NANO_WS_URL || null;
  let envText = null;
  if (envFile) {
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
    workKey = entry("NANO_WORK_KEY") ?? workKey;
    if (!nanoWsFlag) nanoWs = entry("NANO_WS_URL") ?? nanoWs;
    // Pinned NEAR-rail values: a flag wins, then the env file, then the environment (SIGHUP re-reads the file).
    if (nearUsdFlag == null) nearUsdText = entry("NEAR_USD") ?? nearUsdText;
    if (nearSpreadFlag == null) nearSpreadText = entry("NEAR_SWAP_SPREAD_BPS") ?? nearSpreadText;
    if (nearMode && nearUsdText != null) positive("--near-usd (NEAR_USD)", nearUsdText);
    if (!fileKey && entry("NANO_SEED") === undefined && entry("NANO_PRIVATE_KEY") === undefined && !(nearMode && /^\s*(?:export\s+)?NEAR_PRIVATE_KEY\s*=/m.test(envText))) {
      console.error(`--env-file: no NANOGPT_API_KEY, NANO_SEED, or NANO_PRIVATE_KEY entry in ${envFile}`);
      process.exit(1);
    }
  }
  if (nearMode && nearSpreadText != null && !(/^\d{1,4}$/.test(String(nearSpreadText).trim()) && Number(String(nearSpreadText).trim()) <= 2000)) {
    console.error("--near-swap-spread-bps (NEAR_SWAP_SPREAD_BPS): the swap spread must be a whole number of basis points from 0 to 2000"); usage();
  }

  // The wallet exists for two independent jobs: paying NanoGPT x402 invoices when
  // there's no API key (a key always wins for runs, matching the library), and — in
  // --charge-usd mode — receiving callers' payments and sending refunds/payouts,
  // which is needed even when an API key funds the runs themselves.
  let wallet = null;
  if ((nanoKey || nanoSeed) && (!apiKey || chargeUsd != null)) {
    try {
      const { createNanoWallet, resolveWalletKey } = await loadWalletMod();
      wallet = createNanoWallet({
        secretKey: resolveWalletKey({ privateKey: nanoKey, seed: nanoSeed }),
        rpcUrl: nanoRpcFlag || process.env.NANO_RPC_URL || undefined,
        workUrl,
        workKey,
        localWork: !noLocalWork,
        maxUsd,
        log: (line) => console.error("nanoodle-mcp: " + line),
      });
    } catch (e) { console.error("nanoodle-mcp: " + e.message); process.exit(1); }
  }
  if (apiKey && (nanoKey || nanoSeed) && chargeUsd == null) {
    console.error("nanoodle-mcp: both an API key and a Nano wallet are configured — using the key (wallet ignored)");
  }
  if (chargeUsd != null && !wallet) {
    console.error("nanoodle-mcp: --charge-usd needs a Nano wallet (NANO_SEED or NANO_PRIVATE_KEY, env or --env-file) " +
      "to receive payments and send refunds");
    process.exit(1);
  }

  if (nearMode && !apiKey && !wallet) {
    console.error("nanoodle-mcp: --near-merchant needs a NanoGPT funding source to run the workflows it sells — " +
      "NANOGPT_API_KEY (env, --key or --env-file) or a Nano wallet (NANO_SEED / NANO_PRIVATE_KEY)");
    process.exit(1);
  }

  const resolvedOut = resolve(outDir || "./nanoodle-out");
  const publicBase = (publicUrlFlag || `http://${serveHost === "0.0.0.0" ? "127.0.0.1" : serveHost}:${servePort}`).replace(/\/+$/, "");
  if (chargeUsd != null && serveHost === "0.0.0.0" && !publicUrlFlag) {
    console.error("nanoodle-mcp: warning — charging on 0.0.0.0 without --public-url: pay links will point at 127.0.0.1");
  }

  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const registry = await loadTools({
    dirs: graphDirs,
    apiKey,
    payment: wallet && !apiKey ? wallet.payment : undefined,
    baseUrl: process.env.NANOGPT_BASE_URL || undefined,
    outDir: resolvedOut,
    publicBase: serveSpec !== null ? publicBase : null,
    // hosted is billing (--charge-usd). remote is the HTTP transport: every
    // --serve listener refuses local paths, whether or not it charges.
    // Only stdio reads files on this machine.
    hosted: chargeUsd != null,
    remote: serveSpec !== null,
  });

  // With several dirs in play, a bare filename is ambiguous — qualify it with its dir.
  const multiDir = graphDirs.length > 1;
  const label = (rec) => (multiDir ? join(rec.dir, rec.file) : rec.file);
  const dirList = graphDirs.map((d) => resolve(d)).join(", ");
  for (const f of registry.failures) {
    console.error(`nanoodle-mcp: skipping ${label(f)}: ${f.reason}`);
  }
  // A NEAR-paid server sells run_noodle (custom workflows), so it may start with no saved graphs.
  if (!registry.tools.length && !nearMode) {
    console.error(`nanoodle-mcp: no runnable graphs in ${dirList} — ` +
      (registry.failures.length
        ? "every .json file was skipped (reasons above)."
        : "no .json files found. Save workflows from the nanoodle editor (💾 → noodle-graph.json) into that directory."));
    process.exit(1);
  }
  if (!apiKey && !wallet) {
    console.error("nanoodle-mcp: warning — no NanoGPT API key (NANOGPT_API_KEY / --key / --env-file) " +
      "and no x402 wallet (NANO_SEED / NANO_PRIVATE_KEY); tool calls that hit the API will fail");
  }
  // Local-media tools (resize/vframes/combine/audio) fall back to ffmpeg for formats
  // the pure-JS path can't handle. Missing on a server = mid-run failures (auto-refunded
  // in charge mode). Warn once at boot, naming the at-risk tools, instead of per call.
  await warnIfFfmpegMissing(registry.tools);
  // Hand the public model catalog to every graph's Workflow so the library's
  // catalog-driven payload limits apply — variations clamped to the model's real
  // max_output_images, refs to max_input_images — instead of the MCP paying for
  // whatever the graph asked for. Charge mode gets this from its own hourly
  // estimate refresh below (same fetch, also priced), so only do it here.
  // Best-effort: no catalog just means no clamp, exactly as before.
  if (chargeUsd == null && !nearMode) {
    const catalogOpts = {
      baseUrl: process.env.NANOGPT_BASE_URL || undefined,
      log: (line) => console.error("nanoodle-mcp: " + line),
    };
    // Fire-and-forget: the catalog is an optimization, and Workflow reads
    // `catalog` at run time, so it can land after the server is already
    // answering. Awaiting it would put a slow endpoint between the client and
    // server startup — MCP clients time out a launch long before a fetch does.
    attachCatalogs(registry, catalogOpts).then(
      (c) => { if (Object.keys(c).length) console.error(`nanoodle-mcp: model catalog loaded (${Object.keys(c).sort().join(", ")}) — payload limits apply`); },
      () => {});
    // Long-lived stdio servers shouldn't run all week on boot-time limits.
    const catTimer = setInterval(
      () => attachCatalogs(registry, { ...catalogOpts, maxAgeMs: 0 }).catch(() => {}),
      60 * 60 * 1000);
    if (catTimer.unref) catTimer.unref();
  }
  if (wallet) {
    console.error(`nanoodle-mcp: wallet mode (accountless x402) — paying from ${wallet.address}` +
      (maxUsd != null ? `, capped at $${maxUsd}/call` : ", no per-call cap (--max-usd)") +
      (workUrl ? `, work via ${redactUrl(workUrl)}${workKey ? " (keyed)" : ""}` : ""));
  }

  console.error(`nanoodle-mcp ${pkg.version}: serving ${registry.tools.length} tool(s) from ${dirList}`);
  for (const t of registry.tools) console.error(`  - ${t.name} (${label(t)}): ${t.description}`);
  if (nearMode) {
    console.error("  - run_noodle: custom workflows enabled (NEAR-paid, allowlisted nodes); price_noodle and noodle_guide are free");
  } else if (serveSpec === null || chargeUsd == null) {
    console.error("  - run_noodle: runs any nanoodle share link on the fly (always available)");
  } else {
    console.error("  - run_noodle: disabled in charge mode (arbitrary share links can't be priced up front)");
  }

  // Privacy backstop: delete generated media once it's older than the TTL, so a hosted
  // server stops hoarding customers' artifacts. Runs in both transports (off by default in
  // stdio unless --out-ttl was passed); the interval is unref()'d, so it never holds the
  // process open on its own.
  if (outTtlMs > 0) {
    startSweeper({ dir: resolvedOut, ttlMs: outTtlMs, log: (line) => console.error("nanoodle-mcp: " + line) });
    console.error(`nanoodle-mcp: --out-ttl ${outTtlHours}h — generated media in ${resolvedOut} is deleted after ${outTtlHours}h`);
  }

  if (serveSpec === null) {
    const srv = serveMcp({
      name: "nanoodle-mcp",
      version: pkg.version,
      listTools: () => registry.listTools(),
      // strip the gate-facing sidecars (costUsd, costExact, textOutput) — stdio clients get pure MCP content
      callTool: (params) => registry.callTool(params).then(({ costUsd, costExact, textOutput, ...r }) => r),
    });
    // A run's observed cost lands in the tool's description — tell the client to re-list.
    registry.onToolsChanged = () => srv.notify("notifications/tools/list_changed");
    return;
  }

  /* ---- --serve: MCP over streamable HTTP, optionally charging per call ---- */

  // Long-lived server: have send work ready before the first payment arrives.
  // (Not done in stdio mode — a session that never pays would waste one work per boot.)
  if (wallet) wallet.ops.prewarm();

  // Append-only PAYMENTS LEDGER — the operator's own record of money moving,
  // nothing client-side. It exists only in charge mode: money lifecycle events
  // (quote, paid, refund, change, author_payout) and nothing else. Free serve
  // mode writes NO ledger at all — it moves no money, and run telemetry (which
  // tool ran, timing, and upstream error strings that can quote user content)
  // is deliberately not recorded anywhere on the server.
  let usagePath = null;
  let usageLog = () => {};

  let listTools = () => registry.listTools();
  let callTool;
  let gate = null;
  let instructions;
  let paymentNote = null;
  let nearInfo = null;
  let near = null;
  const nearHealth = nearMode ? { merchant: nearMerchant, network: nearNetwork } : null;
  if (nearMode) {
    try {
      near = await startNearMode({
        registry, merchant: nearMerchant, network: nearNetwork, rpcFlag: nearRpcFlag, keyFile: nearKeyFile,
        envText, envFile, usdText: nearUsdText, usdFlag: nearUsdFlag != null, spreadText: nearSpreadText, spreadFlag: nearSpreadFlag != null,
        xnoUsdText: xnoUsdFlag, quoteTtlMin: nearQuoteTtlMin, refreshS: nearRefreshS,
        modelPayment: apiKey ? "api_key" : wallet ? "wallet" : null,
        maxDepositUsd: nearMaxDeposit, outDir: resolvedOut, publicBase: nearPublicUrl?.replace(/\/+$/, "") || publicBase, dual: chargeUsd != null,
      });
      ({ listTools, callTool, instructions, paymentNote, nearInfo, usagePath } = near);
    } catch (e) {
      // Only reachable with both rails configured (NEAR alone exits inside startNearMode).
      // The Nano rail is the production default; it keeps serving and NEAR stays off until a restart.
      if (chargeUsd == null) throw e;
      near = null;
      console.error(`nanoodle-mcp: NEAR PAYMENTS ARE OFF — ${(e && e.message) || e}`);
      console.error("nanoodle-mcp: the Nano rail is serving normally. Fix the NEAR setting above and restart to turn NEAR on.");
    }
  }
  if (chargeUsd != null) {
    usagePath = join(resolvedOut, "usage.jsonl");
    let usageChain = Promise.resolve();
    usageLog = (event, fields) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n";
      usageChain = usageChain
        .then(() => mkdir(resolvedOut, { recursive: true }))
        .then(() => appendFile(usagePath, line))
        .catch((e) => console.error(`nanoodle-mcp: cannot write ${usagePath}: ${e.message}`));
    };
    // Forecast each graph's per-run cost from the public catalog so the FIRST quote
    // for a never-run tool already deposits enough to cover it (change returns the
    // slack). Best-effort — a catalog that won't load just leaves the flat opening
    // deposit in place. Refreshed hourly so estimates track catalog/price changes;
    // the timer is unref()'d so it never holds the process open.
    const catalogBase = process.env.NANOGPT_BASE_URL || "https://nano-gpt.com";
    const refreshEstimates = () => attachEstimates(registry, {
      baseUrl: catalogBase,
      log: (line) => console.error("nanoodle-mcp: " + line),
    }).then((est) => {
      const n = est ? Object.keys(est).length : 0;
      if (n) console.error(`nanoodle-mcp: cost forecast ready for ${n}/${registry.tools.length} tool(s) — deposits track estimated model cost`);
    }).catch(() => {});
    await refreshEstimates();
    const estTimer = setInterval(refreshEstimates, 60 * 60 * 1000);
    if (estTimer.unref) estTimer.unref();

    const { createChargeGate } = await loadGateMod();
    gate = createChargeGate({
      address: wallet.address,
      ops: wallet.ops,
      usd: chargeUsd,
      validate: (p) => registry.prepareCall(p),
      xnoUsd,
      oracleBase: process.env.NANOGPT_BASE_URL || undefined,
      wsUrl: nanoWs,
      publicBase,
      // In-flight money (pending quotes, queued refunds) survives restarts here.
      stateFile: join(resolvedOut, "gate-state.json"),
      log: (line) => console.error("nanoodle-mcp: " + line),
      usage: usageLog,
    });
    const nanoWrapped = gate.wrapRegistry(registry);
    ({ listTools, callTool } = nanoWrapped);
    const nanoInstructions =
      "Every tool on this server is paid per call in Nano (XNO) — no account or API key needed. " +
      "When a tools/call returns PAYMENT REQUIRED it HANGS UP with a payUrl and a watchUrl. " +
      "On that payment link: show your user ONLY the payUrl (QR; confirms on-screen when paid) — never the watch URL or wallet address — " +
      "and IMMEDIATELY open structuredContent.x402.watchUrl yourself (GET /x402/watch/<paymentId>, Accept: text/event-stream; agent-only). " +
      "Wait until that watch stream CLOSES with status paid, done:true, and a next field. " +
      "ONLY THEN call the same tool again with identical arguments plus _payment_id — that tools/call is the RESULTS stream " +
      "(progress heartbeats, then the result). Do not open results while still watching for payment, and do not hold a tools/call open to wait for payment. " +
      "Paying is the consent — nothing to ask the user. " +
      "The amount paid is a DEPOSIT: the real price is the run's actual metered model cost + 20% (the markup goes to the " +
      "workflow's author when its graph names a payout address, and to the operator when it does not), and the difference " +
      "is sent back to the paying wallet as change after the run. " +
      "Quotes expire after 15 minutes. If a run fails after payment, the whole payment is refunded automatically.";
    instructions = nanoInstructions;
    if (near) {
      // Both rails on one server: a small router sends each call to the gate that issued (or will issue) its quote.
      const { createRailRouter } = await import("../src/rail-router.mjs");
      const router = createRailRouter({ nano: nanoWrapped, near: near.wrapped });
      ({ listTools, callTool } = router);
      instructions =
        "This server accepts two payment rails per call: Nano (XNO) over x402, the default, and native NEAR. " +
        "NANO (default): " + nanoInstructions.replace(/^Every tool on this server is paid per call in Nano \(XNO\) — no account or API key needed\. /, "") +
        " NEAR: " + near.instructions +
        ` A saved tool whose description says it can be paid in NEAR takes "_pay_with": "near" for a NEAR quote; ` +
        "run_noodle (custom workflows), price_noodle and noodle_guide are NEAR-side tools. " +
        "A Nano payment id starts with pay_, a NEAR one with nq_; pass the id back unchanged.";
      paymentNote = near.paymentNote;
      usagePath = join(resolvedOut, "usage.jsonl");
    }
  } else if (!near) {
    // Free serve mode writes NO usage.jsonl — no money moves, so there is no
    // payments ledger, and we deliberately don't log run telemetry either
    // (which tool ran, or upstream error text that can quote user content).
    // Strip the gate-facing sidecars (costUsd, costExact, textOutput) so HTTP clients get pure MCP.
    callTool = (params) => registry.callTool(params).then(({ costUsd, costExact, textOutput, ...r }) => r);
  }

  // Filled in when the Agent Market worker has started (below); until then the route answers 503.
  const marketWebhook = { handle: null };
  await serveHttp({
    host: serveHost,
    port: servePort,
    name: "nanoodle-mcp",
    version: pkg.version,
    listTools,
    callTool,
    instructions,
    gate,
    nearGate: near?.gate || null,
    nearHealth, nearWatcher: near?.watcher || null,
    paymentNote,
    rates: near ? near.rates : null,
    toolInfo: registry.tools,
    costs: registry.costs,
    outDir: resolvedOut,
    publicBase,
    marketWebhook,
    log: (...a) => console.error(...a),
  });
  if (nearServePort) {
    // Advertise no runnable tools if merchant verification fails; the Nano
    // endpoint continues serving while the NEAR account awaits funding.
    const unavailable = () => ({ content: [{ type: "text", text: "NEAR payments are unavailable. The merchant account must be funded and its refund key verified before any workflows can run." }], isError: true });
    try {
      await serveHttp({
        host: nearServeHost, port: nearServePort, name: "nanoodle-mcp", version: pkg.version,
        listTools: near ? near.wrapped.listTools : () => [],
        callTool: near ? near.wrapped.callTool : unavailable,
        instructions: near ? near.nearInstructions : unavailable().content[0].text,
        paymentNote: near ? near.nearPaymentNote : unavailable().content[0].text,
        nearGate: near?.gate || null, rates: near?.rates || null,
        nearHealth, nearWatcher: near?.watcher || null,
        toolInfo: registry.tools, costs: registry.costs, outDir: resolvedOut,
        publicBase: nearPublicUrl.replace(/\/+$/, ""),
        log: (...a) => console.error(...a),
      });
      console.error(`nanoodle-mcp: NEAR endpoint ${nearPublicUrl}/mcp on ${nearServeHost}:${nearServePort} — shared Nano funding pool${near ? "" : "; NEAR payments unavailable"}`);
    } catch (e) {
      console.error(`nanoodle-mcp: NEAR endpoint ${nearPublicUrl} could not listen on ${nearServeHost}:${nearServePort}: ${e.message}`);
      console.error("nanoodle-mcp: the primary MCP listener remains available; fix --near-serve and restart to enable the second endpoint.");
    }
  }
  console.error(`nanoodle-mcp: MCP over HTTP on http://${serveHost}:${servePort}/mcp` +
    (nearInfo && chargeUsd != null
      ? ` — paid in Nano (XNO to ${wallet.address}) or in NEAR on ${nearInfo.network} to ${nearInfo.merchant}`
      : nearInfo
      ? ` — paid in NEAR on ${nearInfo.network} to ${nearInfo.merchant}`
      : chargeUsd != null
      ? ` — charging $${chargeUsd}/call in XNO to ${wallet.address}`
      : " — free (runs spend from this server's balance)"));
  console.error(`nanoodle-mcp: connect with: claude mcp add --transport http noodles ${publicBase}/mcp`);
  console.error(`nanoodle-mcp:             or: grok mcp add --transport http noodles ${publicBase}/mcp`);
  // The ledger records money only, and only exists in charge mode.
  if (usagePath) console.error(`nanoodle-mcp: payments ledger: ${usagePath}`);
  if (near && near.usagePath !== usagePath) console.error(`nanoodle-mcp: NEAR payments ledger: ${near.usagePath}`);
  if (near) console.error(`nanoodle-mcp: rates: ${publicBase}/rates`);

  // NEAR Agent Market worker, inside this server: it pays NanoGPT exactly as the server
  // does (API key, or the Nano wallet through x402) and shares the wallet's one send queue.
  if (process.env.MARKET_AGENTS_FILE || process.env.MARKET_AGENT_TOKEN_FILE || process.env.MARKET_AGENT_TOKEN) {
    await startMarketWorkerInServer({ apiKey, wallet, marketWebhook });
  }
}

/**
 * Start the Agent Market worker in this process. A problem here never stops the
 * MCP server: it is logged as "market worker: OFF" and the server carries on.
 * Settings come from the environment only: one listing (MARKET_AGENT_TOKEN_FILE, MARKET_JOB_BUDGET_USD,
 * MARKET_LISTING_PRICE_USD, MARKET_DEFAULT_GRAPH, MARKET_DEFAULT_INPUT), or several from a catalog
 * (MARKET_AGENTS_FILE, MARKET_PRICE_REFRESH_SECONDS, MARKET_AUTO_PRICE); and MARKET_STATE_DIR.
 * With a catalog, log lines name the listing ("[handle] …") and SIGTERM drains every listing.
 */
async function startMarketWorkerInServer({ apiKey, wallet, marketWebhook }) {
  const say = (line) => console.error("nanoodle-mcp: market worker: " + line);
  try {
    const [{ readConfig, startMarketService }, { logSafe }] = await Promise.all([
      import("../src/market/service.mjs"), import("../src/market/worker.mjs"),
    ]);
    const env = apiKey ? { ...process.env, NANOGPT_API_KEY: apiKey } : { ...process.env, NANOGPT_API_KEY: "" };
    const cfg = readConfig([], env, { needKey: !wallet });
    const svc = await startMarketService(cfg, { payment: !cfg.apiKey && wallet ? wallet.payment : null, log: (l) => say(logSafe(l)) });
    // The HTTP server is already listening; from here it passes the market's events on.
    if (svc.webhook) marketWebhook.handle = svc.webhook;
    let stopping = false;
    const onSignal = (sig) => {
      if (stopping) process.exit(1);
      stopping = true;
      say(`${sig}: no new jobs; waiting up to 20 s for the job in hand (one still running then is handed back, refunded, on the next start)`);
      svc.stop();
      const t = setTimeout(() => process.exit(0), 20_000);
      svc.done.then(() => { clearTimeout(t); process.exit(0); });
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
    svc.done.then((code) => { if (!stopping) say(`stopped (status ${code}); the MCP server keeps serving. Restart the server to resume taking market jobs.`); });
  } catch (e) {
    say(`OFF — ${(e && e.message) || e}`);
    say("the MCP server is serving normally. Fix the setting above and restart to take market jobs.");
  }
}

/**
 * NEAR mode: check the RPC is on the configured network and holds the
 * merchant's full-access key, load the refund signer (never logged), open the
 * durable state, finish anything a previous run left in flight, and wrap the
 * registry in the NEAR gate. Exits with a clear error on any misconfiguration.
 */
async function startNearMode({
  registry, merchant, network, rpcFlag, keyFile, envText, envFile, usdText, usdFlag, spreadText, spreadFlag, xnoUsdText,
  quoteTtlMin, refreshS, modelPayment, maxDepositUsd, outDir, publicBase, dual,
}) {
  // With both rails on one server a NEAR problem must never stop the Nano rail:
  // there this throws, and main() carries on in Nano only. NEAR on its own exits.
  const fail = (msg) => {
    if (dual) throw Object.assign(new Error(msg), { nearStartup: true });
    console.error("nanoodle-mcp: " + msg);
    process.exit(1);
  };
  const [near, { createNearGate }] = await loadNearMods();
  if (!near.isNearAccountId(merchant)) fail(`--near-merchant: "${merchant}" is not a NEAR account id`);
  // One or more endpoints, comma-separated, tried in order with failover.
  const rpcUrls = near.parseRpcUrls(rpcFlag || process.env.NEAR_RPC_URL || near.NEAR_NETWORKS[network].rpcUrls);
  const rpcUrl = rpcUrls.map(redactUrl).join(", ");
  let signer;
  try {
    signer = await near.loadNearSigner({ accountId: merchant, keyFile, envFileText: envText, env: process.env });
  } catch (e) { fail(`NEAR refund key: ${e.message}`); }
  let rpc;
  try {
    rpc = near.createNearRpcPool({ urls: rpcUrls, chainId: network, log: (line) => console.error("nanoodle-mcp: " + line) });
  } catch (e) { fail(`--near-rpc: ${e.message}`); }
  // A public RPC can be briefly unreachable or rate limiting at boot; give it a few tries.
  const transient = (e) => ["RPC_HTTP", "RPC_TIMEOUT", "RPC_BAD_RESPONSE"].includes(e?.code);
  const patiently = async (fn) => {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (!transient(e) || i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
      }
    }
  };
  try { await patiently(() => rpc.status()); } catch (e) {
    fail(e?.code === "RPC_WRONG_NETWORK"
      ? `--near-rpc ${rpcUrl}: ${e.message}; point it at a ${network} RPC`
      : `cannot reach the NEAR RPC at ${rpcUrl}: ${e.message}`);
  }
  let key;
  try { key = await patiently(() => rpc.viewAccessKey({ accountId: merchant, publicKey: signer.publicKey })); } catch (e) {
    fail(transient(e)
      ? `cannot reach the NEAR RPC at ${rpcUrl}: ${e.message}`
      : `the refund key ${signer.publicKey} is not an access key of ${merchant} on ${network} (${e.message})`);
  }
  if (key.permission !== "FullAccess") fail(`the refund key ${signer.publicKey} on ${merchant} is not a full-access key; refunds need one`);

  // With both rails on one server, each gate keeps its own payments ledger.
  const usagePath = join(outDir, dual ? "near-usage.jsonl" : "usage.jsonl");
  let usageChain = Promise.resolve();
  const usage = (event, fields) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n";
    usageChain = usageChain
      .then(() => mkdir(outDir, { recursive: true }))
      .then(() => appendFile(usagePath, line))
      .catch((e) => console.error(`nanoodle-mcp: cannot write ${usagePath}: ${e.message}`));
  };
  const log = (line) => console.error("nanoodle-mcp: " + line);

  // Catalogs clamp payloads and price every quote; refreshed hourly as in charge mode
  // (which does the same refresh itself when both rails run).
  const catalogBase = process.env.NANOGPT_BASE_URL || "https://nano-gpt.com";
  if (!dual) {
    const refresh = () => attachEstimates(registry, { baseUrl: catalogBase, log }).catch(() => {});
    await refresh();
    const timer = setInterval(refresh, 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  let ledger;
  try {
    ledger = near.openNearLedger({ file: join(outDir, "near-state.json"), network, merchant });
  } catch (e) { fail(e.message); }
  // NEAR/USD, XNO/USD and the swap rate derived from them. When runs are paid
  // from the Nano wallet, XNO/USD is required to quote; with an API key it is informational.
  let rates;
  try {
    rates = near.createNearRates({
      nearUsd: usdText, xnoUsd: xnoUsdText, spreadBps: spreadText, xnoRequired: modelPayment === "wallet",
      refreshMs: refreshS * 1000, nanoGptBase: process.env.NANOGPT_BASE_URL || undefined, log,
    });
  } catch (e) { fail(e.message); }
  await rates.start(); // first fetch before serving, so the first quote is warm (bounded by the fetch timeouts)
  // SIGHUP: re-read pinned values from --env-file (a flag still wins) and refetch the live ones.
  process.on("SIGHUP", async () => {
    let values = rates.config;
    if (envFile) {
      try {
        const text = await readFile(envFile, "utf8");
        const entry = (name) => {
          const m = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*"?([^"\\n]*)"?`, "m"));
          return m && m[1].trim() !== "" ? m[1].trim() : null;
        };
        values = {
          ...values,
          nearUsd: usdFlag ? values.nearUsd : entry("NEAR_USD") ?? process.env.NEAR_USD ?? null,
          spreadBps: spreadFlag ? values.spreadBps : entry("NEAR_SWAP_SPREAD_BPS") ?? process.env.NEAR_SWAP_SPREAD_BPS ?? 0,
        };
      } catch (e) { log(`SIGHUP: cannot read ${envFile} (${e.message}); keeping the current rate settings`); }
    }
    try {
      const applied = await rates.reload(values);
      const v = await rates.view();
      log(`SIGHUP: rates reloaded — NEAR/USD ${applied.nearUsd != null ? `static ${applied.nearUsd}` : `live ${v.nearUsd ?? "unavailable"}`}, ` +
        `XNO/USD ${applied.xnoUsd != null ? `static ${applied.xnoUsd}` : `live ${v.xnoUsd ?? "unavailable"}`}, swap margin ${applied.spreadBps} bps`);
    } catch (e) { log(`SIGHUP: rate settings not changed: ${e.message}`); }
  });
  const refunder = near.createRefunder({ rpc, signer, accountId: merchant, ledger, log });
  const gate = createNearGate({
    merchantId: merchant, network, rpc, ledger, rate: rates, refunder,
    limits: maxDepositUsd != null ? { maxDepositUsd } : undefined,
    baseUrl: catalogBase, log, usage, quoteTtlMs: quoteTtlMin * 60_000, modelPayment, publicBase,
  });
  const wrapped = gate.wrapRegistry(registry);
  const { listTools, callTool } = wrapped;
  await gate.resume(); // before serving: a run a previous process left in flight is refunded, never re-run
  const watcher = near.createNearWatcher({
    rpc, ledger, merchantId: merchant, pendingQuotes: gate.pendingQuotes,
    observeTransfer: gate.observeTransfer, log,
  });
  await watcher.start();

  log(`NEAR mode on ${network}: merchant ${merchant} (${near.explorerAccountUrl(network, merchant)})`);
  const rc = rates.config;
  log(`NEAR RPC ${rpcUrl}; NEAR/USD rate ${rc.nearUsd != null ? `static ${rc.nearUsd}` : "CoinGecko (60s cache, fails closed)"}; ` +
    `XNO/USD ${rc.xnoUsd != null ? `static ${rc.xnoUsd}` : "NanoGPT x402 invoices, else CoinGecko"}${rc.xnoRequired ? " (required: runs are paid from the Nano wallet)" : " (informational)"}; ` +
    `swap margin ${rc.spreadBps} bps; quotes live ${quoteTtlMin} min; refund key ${signer.publicKey}`);

  const ratesLine = ` Current NEAR/USD, XNO/USD and swap rates: ${publicBase}/rates.`;
  const instructions =
    (dual
      ? `Paying in native NEAR on ${network}: no account or API key is needed. `
      : `Tools on this server are paid per call in native NEAR on ${network}; no account or API key is needed. `) +
    "price_noodle (free) returns the itemized estimated cost, the 20% service fee, the deposit and the likely refund of any workflow; " +
    "noodle_guide (free) explains how to compose a custom workflow graph for run_noodle. " +
    "For a human payer, show payment.payUrl and immediately open payment.watchUrl to monitor payment. " +
    "The user connects a wallet and approves the deposit there. When the monitor closes with status paid and done:true, " +
    "repeat the original tool call with identical arguments plus _payment_id; continue automatically without another confirmation. " +
    "Alternatively, an agent paying directly can send ONE native NEAR transfer of exactly payment.amountYocto to payment.payTo " +
    "(one Transfer action, nothing else), then call the same tool again with identical arguments plus _payment_id, _payment_tx " +
    "(the transaction hash) and _payment_sender (the account you paid from). " +
    "The amount you send is a deposit, the most you can be charged; you will most likely pay the estimated cost plus the 20% service fee, " +
    "and the rest is refunded to the paying account automatically after the run. If the run fails, the whole deposit is refunded. " +
    `Repeating the paying call returns the stored result and never charges again. Quotes expire after ${quoteTtlMin} minutes.` + ratesLine;
  const paymentNote =
    (dual
      ? `Calls can also be paid in native NEAR on ${network}: add "_pay_with": "near" to a saved tool's arguments (run_noodle is NEAR-paid). A call without payment returns a quote with an exact deposit; `
      : `Every call is paid in native NEAR on ${network}. A call without payment returns a quote with an exact deposit; `) +
    `send one transfer of that amount to ${merchant} and call again with the transaction hash. You are charged the ` +
    "actual model cost plus a 20% service fee, and the rest of the deposit is refunded automatically. price_noodle " +
    "(free) shows the itemized estimate first; run_noodle also runs workflow graphs you compose yourself. " +
    "The quote also includes a wallet payment link and monitor, so human payers can connect a wallet and the agent resumes automatically." + ratesLine;
  const nearInstructions = instructions.replace(`Paying in native NEAR on ${network}:`, `Tools on this server are paid per call in native NEAR on ${network};`);
  const nearPaymentNote = `Every call is paid in native NEAR on ${network}. Your agent shows a payment link: connect your wallet, approve the deposit, ` +
    "and the result streams back automatically. You pay actual model cost plus a 20% service fee; unused NEAR returns to the paying wallet on chain. " +
    "Failed runs refund the whole deposit. price_noodle and noodle_guide are free; run_noodle runs workflows you compose yourself." + ratesLine;
  return { listTools, callTool, wrapped, gate, watcher, rates, instructions, paymentNote, nearInstructions, nearPaymentNote, nearInfo: { network, merchant }, usagePath };
}

main().catch((e) => { console.error("nanoodle-mcp: " + ((e && e.message) || e)); process.exit(1); });

