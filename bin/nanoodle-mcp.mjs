#!/usr/bin/env node
/**
 * nanoodle-mcp — MCP server that exposes saved nanoodle workflow graphs as tools.
 *
 *   nanoodle-mcp --graphs <dir> [--graphs <dir> …] [--out dir] [--out-ttl h] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
 *   nanoodle-mcp --graphs <dir> --serve [host:]port [--charge-usd n] [--public-url u] [--nano-ws url]
 *
 * Default transport is MCP over stdio. --serve speaks MCP over streamable HTTP
 * instead — host a directory of noodles as a service — and --charge-usd puts an
 * x402 payment gate in front of every call: callers pay in Nano (XNO), no
 * accounts anywhere, refunds on failed runs, optional per-graph author payouts.
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
import { loadTools, attachEstimates } from "../src/tools.mjs";
import { serveMcp } from "../src/server.mjs";
import { serveHttp } from "../src/http.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { createNanoWallet, resolveWalletKey, DEFAULT_NANO_RPC } from "../src/wallet.mjs";
import { startSweeper } from "../src/sweep.mjs";

function usage(code = 1) {
  console.error(`usage:
  nanoodle-mcp --graphs <dir> [--graphs <dir> …] [--out dir] [--out-ttl h] [--key K] [--env-file path] [--nano-rpc url] [--max-usd n]
  nanoodle-mcp --graphs <dir> --serve [host:]port [--charge-usd n] [--public-url u] [--nano-ws url]
  nanoodle-mcp --version

  --graphs dir   directory of noodle-graph.json saves — each becomes an MCP tool (required;
                 repeat to serve several dirs — scanned in order, so an earlier dir wins name clashes)
  --out dir      where media outputs are saved (default ./nanoodle-out)
  --out-ttl h    privacy: auto-delete generated media older than h hours (fractions ok;
                 0 disables). Default 24 in --serve mode (a hosted server must not hoard
                 customers' generations), off in stdio mode (local files are yours to keep).
                 Only media artifacts are ever deleted — never costs.json/gate-state.json/usage.jsonl
  --key K        NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p   read NANOGPT_API_KEY / NANO_SEED / NANO_PRIVATE_KEY from a .env-style file
                 (--key wins over its NANOGPT_API_KEY if both given)
  --nano-rpc u   Nano RPC node for wallet operations (default ${DEFAULT_NANO_RPC}; NANO_RPC_URL)
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
                   are the rate oracle — the rate we pay is the rate we charge; cached 60s)

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
    maxUsd = Number(maxUsdFlag);
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) { console.error("--max-usd expects a positive number"); usage(); }
  }
  const positive = (flag, v) => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) { console.error(`${flag} expects a positive number`); usage(); }
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
    workKey = entry("NANO_WORK_KEY") ?? workKey;
    if (!nanoWsFlag) nanoWs = entry("NANO_WS_URL") ?? nanoWs;
    if (!fileKey && entry("NANO_SEED") === undefined && entry("NANO_PRIVATE_KEY") === undefined) {
      console.error(`--env-file: no NANOGPT_API_KEY, NANO_SEED, or NANO_PRIVATE_KEY entry in ${envFile}`);
      process.exit(1);
    }
  }

  // The wallet exists for two independent jobs: paying NanoGPT x402 invoices when
  // there's no API key (a key always wins for runs, matching the library), and — in
  // --charge-usd mode — receiving callers' payments and sending refunds/payouts,
  // which is needed even when an API key funds the runs themselves.
  let wallet = null;
  if ((nanoKey || nanoSeed) && (!apiKey || chargeUsd != null)) {
    try {
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
  });

  // With several dirs in play, a bare filename is ambiguous — qualify it with its dir.
  const multiDir = graphDirs.length > 1;
  const label = (rec) => (multiDir ? join(rec.dir, rec.file) : rec.file);
  const dirList = graphDirs.map((d) => resolve(d)).join(", ");
  for (const f of registry.failures) {
    console.error(`nanoodle-mcp: skipping ${label(f)}: ${f.reason}`);
  }
  if (!registry.tools.length) {
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
  if (wallet) {
    console.error(`nanoodle-mcp: wallet mode (accountless x402) — paying from ${wallet.address}` +
      (maxUsd != null ? `, capped at $${maxUsd}/call` : ", no per-call cap (--max-usd)") +
      (workUrl ? `, work via ${workUrl}${workKey ? " (keyed)" : ""}` : ""));
  }

  console.error(`nanoodle-mcp ${pkg.version}: serving ${registry.tools.length} tool(s) from ${dirList}`);
  for (const t of registry.tools) console.error(`  - ${t.name} (${label(t)}): ${t.description}`);
  if (serveSpec === null || chargeUsd == null) {
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
      // strip the gate-facing sidecars (costUsd, textOutput) — stdio clients get pure MCP content
      callTool: (params) => registry.callTool(params).then(({ costUsd, textOutput, ...r }) => r),
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
    ({ listTools, callTool } = gate.wrapRegistry(registry));
    instructions =
      "Every tool on this server is paid per call in Nano (XNO) — no account or API key needed. " +
      "The first call to a tool returns PAYMENT REQUIRED with a payUrl: show ONLY that link to your user " +
      "(it renders a QR code and confirms on-screen when the payment lands, usually within a second) — do " +
      "not show them any other URL or the wallet address. Then " +
      "call the same tool again with identical arguments plus the given _payment_id — you can call right " +
      "away, right after showing the link: that call waits for the payment to land, then runs (streaming " +
      "progress with the tool's typical runtime), so you never have to call a third time after paying. " +
      "That _payment_id call is how YOU watch for the payment — the user never tells you they paid. (If you " +
      "run your own event loop, the server also exposes a payment-status SSE stream at /x402/watch/<paymentId>; " +
      "that is for you, never show it to the user.) " +
      "The amount paid is a " +
      "DEPOSIT: the real price is the run's actual metered model cost + 20% (the markup is the workflow " +
      "author's cut), and the difference is sent back " +
      "to the paying wallet as change after the run. Quotes expire after 15 minutes. If a run fails after " +
      "payment, the whole payment is refunded automatically.";
  } else {
    // Free serve mode writes NO usage.jsonl — no money moves, so there is no
    // payments ledger, and we deliberately don't log run telemetry either
    // (which tool ran, or upstream error text that can quote user content).
    // Strip the gate-facing sidecars (costUsd, textOutput) so HTTP clients get pure MCP.
    callTool = (params) => registry.callTool(params).then(({ costUsd, textOutput, ...r }) => r);
  }

  await serveHttp({
    host: serveHost,
    port: servePort,
    name: "nanoodle-mcp",
    version: pkg.version,
    listTools,
    callTool,
    instructions,
    gate,
    toolInfo: registry.tools,
    costs: registry.costs,
    outDir: resolvedOut,
    publicBase,
    log: (...a) => console.error(...a),
  });
  console.error(`nanoodle-mcp: MCP over HTTP on http://${serveHost}:${servePort}/mcp` +
    (chargeUsd != null
      ? ` — charging $${chargeUsd}/call in XNO to ${wallet.address}`
      : " — free (runs spend from this server's balance)"));
  console.error(`nanoodle-mcp: connect with: claude mcp add --transport http noodles ${publicBase}/mcp`);
  // The ledger records money only, and only exists in charge mode.
  if (usagePath) console.error(`nanoodle-mcp: payments ledger: ${usagePath}`);
}

main().catch((e) => { console.error("nanoodle-mcp: " + ((e && e.message) || e)); process.exit(1); });
