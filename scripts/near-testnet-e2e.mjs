#!/usr/bin/env node
/**
 * One command that proves NEAR mode on REAL NEAR testnet.
 *
 *   node scripts/near-testnet-e2e.mjs --dry-run --mock-model   every step that moves no funds
 *   node scripts/near-testnet-e2e.mjs --mock-model             real chain, local NanoGPT stand-in (no model credit)
 *   node scripts/near-testnet-e2e.mjs                          real chain, one real NanoGPT text call
 *
 * Accounts come from <keys-dir>/accounts.json written by
 * scripts/near-testnet-accounts.mjs (default .near-testnet/accounts.json), or
 * from --merchant/--merchant-key-file/--payer/--payer-key-file.
 *
 * What it does, in order:
 *   preflight  key files, RPC is testnet, both accounts exist with full-access
 *              keys, balances, the live NEAR/USD rate, a NanoGPT source
 *   server     starts bin/nanoodle-mcp.mjs --serve in NEAR mode as a child
 *              process (merchant account + key file) and talks MCP over HTTP
 *   agent      noodle_guide -> price_noodle on a small text graph ->
 *              run_noodle without payment (the quote)
 *   ---------- --dry-run stops here; nothing below runs ----------
 *   pay        signs the payer's ONE native transfer of exactly the quoted
 *              amount with the repo's own signer (src/near/tx.mjs) and
 *              broadcasts it; then pays the call and prints result + receipt
 *   verify     re-reads the payment AND the refund from RPC (the rules of
 *              scripts/near-check-tx.mjs plus the server's own verifier) and
 *              checks both balances against the receipt to the yocto, gas aside
 *   charge     the charge is the model cost + 20% at the quote's locked rate
 *              (--mock-model: the stand-in's own reported cost), not just any
 *              amount the chain and the receipt agree on
 *   replay     the same paying call again: same receipt, and the merchant
 *              signs nothing new on chain (key nonce and balance unchanged)
 *   wrong      a second quote paid with 0.000001 NEAR too little: nothing
 *              runs and the full amount comes back on chain
 *   reuse      a third quote presented with the first, already used
 *              transaction: refused, nothing moves
 * Every transaction gets an explorer link; the run ends with a PASS/FAIL table
 * and exits 1 on any failure (2 on bad usage).
 *
 * Options: --accounts <path> | --keys-dir <dir>, --rpc <url>, --near-usd <n>
 * (pin the rate; default is the server's live CoinGecko rate), --env-file
 * <path> (default .env in the repo: NANOGPT_API_KEY for the real model run;
 * this script never reads it, the server does), --model <id>, --out <dir>
 * (server state; default nanoodle-out/near-testnet-e2e/<time>).
 *
 * Testnet only. The merchant key is used only by the server (refunds), the
 * payer key only by this script (payments); no key is printed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNearUsdRate, loadNearSigner } from "../src/near/index.mjs";
import { usdToYocto } from "../src/near/amount.mjs";
import { freePort, mcpClient } from "./near-simulate.mjs";
import {
  ACCOUNTS_FILE, DEFAULT_KEYS_DIR, GAS_CAP_YOCTO, MIN_MERCHANT_YOCTO, MIN_PAYER_YOCTO, NETWORK, ROOT,
  absPath, checkTransferOnChain, checkTxCommand, explorerAccountUrl, explorerTxUrl, formatYoctoAsNear,
  keyFileModeWarning, parseArgs, readAccountsConfig, rpcFor, sendTransfer, settledBalance, viewAccessKey, viewAccount,
} from "./near-testnet-lib.mjs";

const BIN = join(ROOT, "bin", "nanoodle-mcp.mjs");
export const MOCK_MODEL = "z-ai/glm-5.3-flash"; // priced by the local NanoGPT stand-in's catalog
/** A cheap, non-reasoning chat model in NanoGPT's public catalog ($0.05 / $0.23 per 1M tokens when this was written). */
export const DEFAULT_REAL_MODEL = "meta-llama/llama-3.3-70b-instruct";
// Half a dust step: every quote is a whole number of 0.000001 NEAR steps, so an amount
// short by this much can never be the exact amount of some other open quote.
const HALF_STEP_YOCTO = 5n * 10n ** 17n;
/** What the local NanoGPT stand-in (tests/fixtures/near-fake-chain.mjs) reports for one chat call. */
export const MOCK_CHAT_COST_USD = 0.00041;

/**
 * The charge for a model cost, worked out here from the settlement rule in
 * docs/near-payments.md (not by calling the server's settle function):
 * cost = ceil(costUsd at the locked rate), fee = floor(cost / 5), charged =
 * min(cost + fee, deposit).
 */
export function expectedChargeYocto(costUsd, rate, depositYocto) {
  const cost = usdToYocto(String(costUsd), rate, "ceil");
  const charged = cost + cost / 5n;
  return charged > depositYocto ? depositYocto : charged;
}

const USAGE = `usage: node scripts/near-testnet-e2e.mjs [--dry-run] [--mock-model] [--accounts path | --keys-dir dir]
         [--merchant id --merchant-key-file path --payer id --payer-key-file path]
         [--rpc url] [--near-usd n] [--env-file path] [--model id] [--out dir]`;

/** The small custom graph the run prices, pays for and runs: text -> llm, 48 output tokens at most. */
export function e2eGraph(model) {
  return {
    v: 1,
    nodes: [
      { id: "n1", type: "text", name: "Topic", fields: { text: "" } },
      { id: "n2", type: "llm", name: "Writer", fields: { model, system: "Reply with exactly one short, friendly sentence about the topic.", maxTokens: 48 } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  };
}

/** What to check when a step fails, keyed by step id. */
const HINTS = {
  keys: "The key files: each must be a near-cli credentials JSON whose account_id is the account and whose private_key is ed25519:… (re-run scripts/near-testnet-accounts.mjs, or --use-existing).",
  rpc: "The RPC: is the network reachable, and does --rpc point at testnet? Try again, or pass --rpc https://rpc.testnet.fastnear.com.",
  accounts: "The accounts: do both exist on testnet, and is each key file's public key a FullAccess key of its account? Run node scripts/near-testnet-accounts.mjs to see their state.",
  balances: "Funding: top up the account named in the failure from any funded testnet wallet, then re-run.",
  rate: "The live NEAR/USD rate (CoinGecko public API) could not be read: retry in a minute, or pin it with --near-usd <n>.",
  model: "The NanoGPT source: pass --env-file with NANOGPT_API_KEY, export NANOGPT_API_KEY, or use --mock-model.",
  server: "The server did not start: its stderr is printed above. Common causes: the merchant key is not on the account, the RPC is unreachable, or the env file has no NanoGPT key.",
  tools: "The server is not in NEAR mode or is an older build: run this script from the same checkout as bin/nanoodle-mcp.mjs.",
  price: "price_noodle refused the graph: its refusals are printed above (an unpriceable model? pass another --model from NanoGPT's catalog).",
  quote: "run_noodle did not return a quote: see the answer printed above.",
  pay: "The payer's transfer: if it says TRANSFER_UNCONFIRMED, open the printed explorer link before sending anything again; TRANSFER_REJECTED gives the network's reason (balance, nonce, key).",
  paid: "The paid call: the answer and receipt are printed above. outcome run_failed means the model call failed (the whole deposit is refunded); check NanoGPT credit and the model id. Run the printed near-check-tx commands to see what is on chain.",
  receipt: "Receipt arithmetic: deposit − refund must equal charged; a mismatch is a server bug — keep <out>/near-state.json and <out>/usage.jsonl.",
  charge: "The charge must be the model cost + 20% at the quote's locked rate (docs/near-payments.md, settlement). A mismatch is a server pricing bug, even though the chain matches the receipt — keep <out>/near-state.json and <out>/usage.jsonl.",
  onchain: "On-chain re-verification: open the explorer links; run the printed near-check-tx command for the failing transaction; a refund that is not on chain shows as status pending/failed_permanent in <out>/near-state.json.",
  state: "The server's state file <out>/near-state.json should map the payment hash to the payment id in consumedTx.",
  balance: "Balance deltas: the account may have been used by something else during the run (use dedicated accounts), or the RPC answered from a lagging node — re-run the check commands.",
  replay: "Replay must never refund twice: compare the merchant's transactions in the explorer; a second refund is a server bug — keep <out>/near-state.json.",
  wrong: "Wrong-amount handling: the server must consume the hash, run nothing and refund everything; see the receipt above and the explorer link of its refund.",
  reuse: "Reuse of a consumed transaction must be refused without moving funds; see the answer above.",
};

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start bin/nanoodle-mcp.mjs in NEAR mode; resolves once it serves. Never passes a key in argv or env. */
async function startServer({ port, outDir, graphsDir, merchant, keyFile, rpcUrl, nearUsd, envFile, childEnv, startTimeoutMs = 90_000 }) {
  const args = [
    BIN, "--graphs", graphsDir, "--out", outDir, "--serve", `127.0.0.1:${port}`, "--public-url", `http://127.0.0.1:${port}`,
    "--near-merchant", merchant, "--near-network", NETWORK, "--near-rpc", rpcUrl, "--near-key-file", keyFile,
    ...(nearUsd ? ["--near-usd", nearUsd] : []),
    ...(envFile ? ["--env-file", envFile] : []),
  ];
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const t0 = Date.now();
  while (!/MCP over HTTP on/.test(stderr)) {
    if (child.exitCode !== null) throw Object.assign(new Error("the server exited during startup"), { stderr });
    if (Date.now() - t0 > startTimeoutMs) { child.kill("SIGKILL"); throw Object.assign(new Error("the server did not start in time"), { stderr }); }
    await defaultSleep(50);
  }
  return {
    child,
    get stderr() { return stderr; },
    stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once("exit", r); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5_000).unref(); }),
  };
}

const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/**
 * The whole run. Returns { exitCode, rows, txs, outDir }. Tests inject
 * `rpcFetch` (NEAR RPC), `sleep`, `nano` (a NanoGPT stand-in with url/runs) and `env`.
 */
export async function runTestnetE2E(argv, { print = console.log, rpcFetch, sleep = defaultSleep, nano: injectedNano, env = process.env } = {}) {
  let opts;
  try {
    opts = parseArgs(argv, ["dry-run", "mock-model", "help"]);
  } catch (e) {
    print(e.message); print(USAGE); return { exitCode: 2, rows: [] };
  }
  if (opts.help) { print(USAGE); return { exitCode: 0, rows: [] }; }
  if (opts.network && opts.network !== NETWORK) { print("this script is testnet-only"); return { exitCode: 2, rows: [] }; }
  const dryRun = !!opts["dry-run"];
  const mockModel = !!opts["mock-model"];
  const model = mockModel ? MOCK_MODEL : (opts.model || DEFAULT_REAL_MODEL);
  if (mockModel && opts.model) { print("--model applies to the real NanoGPT run only; --mock-model uses the stand-in's catalog"); return { exitCode: 2, rows: [] }; }
  const nearUsd = opts["near-usd"] || null;
  const rpc = rpcFor(opts.rpc || env.NEAR_RPC_URL || undefined, rpcFetch);
  const rpcUrl = rpc.url;

  const rows = [];   // { id, name, status: PASS|FAIL|SKIP|INFO, detail }
  const txs = [];    // { label, hash }
  const checkCmds = [];
  let aborted = false;
  const step = (title) => print(`\n=== ${title} ===`);
  const check = (id, ok, name, detail = "") => {
    rows.push({ id, name, status: ok ? "PASS" : "FAIL", detail });
    print(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };
  const info = (line) => print(`  info  ${line}`);
  const fail = (id, name, detail) => { check(id, false, name, detail); aborted = true; };
  const near = (y) => `${formatYoctoAsNear(y)} NEAR`;
  const addTx = (label, hash) => { txs.push({ label, hash }); print(`  ${label}: ${hash}\n        ${explorerTxUrl(NETWORK, hash)}`); };

  print(`nanoodle-mcp NEAR testnet end-to-end — ${dryRun ? "DRY RUN (no funds move)" : "LIVE on testnet"}, ` +
    `${mockModel ? "model: local NanoGPT stand-in (no model credit)" : `model: real NanoGPT ${model}`}`);

  let server = null, nano = null, startedNano = false;
  const outDir = absPath(opts.out) || join(ROOT, "nanoodle-out", "near-testnet-e2e", new Date().toISOString().replace(/[:.]/g, "-"));
  try {
    /* ------------------------------ preflight ------------------------------ */
    step("Preflight");
    let acc;
    if (opts.merchant || opts.payer) {
      for (const k of ["merchant", "merchant-key-file", "payer", "payer-key-file"]) {
        if (!opts[k]) { print(`--${k} is required when accounts are given on the command line`); return { exitCode: 2, rows }; }
      }
      acc = { merchant: { accountId: opts.merchant, keyFile: absPath(opts["merchant-key-file"]) }, payer: { accountId: opts.payer, keyFile: absPath(opts["payer-key-file"]) } };
    } else {
      const path = absPath(opts.accounts) || join(absPath(opts["keys-dir"]) || DEFAULT_KEYS_DIR, ACCOUNTS_FILE);
      try { acc = await readAccountsConfig(path); } catch (e) { fail("keys", "accounts file", e.message); return finish(); }
      info(`accounts from ${path}`);
    }
    const M = acc.merchant.accountId, P = acc.payer.accountId;
    if (M === P) { fail("keys", "two different accounts", "the merchant and the payer are the same account"); return finish(); }
    let merchantSigner, payerSigner;
    try {
      merchantSigner = await loadNearSigner({ accountId: M, keyFile: acc.merchant.keyFile, env: {} });
      payerSigner = await loadNearSigner({ accountId: P, keyFile: acc.payer.keyFile, env: {} });
    } catch (e) { fail("keys", "key files load", `${e.code}: ${e.message}`); return finish(); }
    check("keys", true, "key files load and name their accounts", `merchant ${M} ${merchantSigner.publicKey}; payer ${P} ${payerSigner.publicKey}`);
    for (const f of [acc.merchant.keyFile, acc.payer.keyFile]) { const w = keyFileModeWarning(f); if (w) print(`  WARN  ${w}`); }

    let st;
    try { st = await rpc.status(); } catch (e) { fail("rpc", "RPC reachable", `${rpcUrl}: ${e.code}: ${e.message}`); return finish(); }
    if (!check("rpc", st.chain_id === NETWORK, "RPC is on testnet", `${rpcUrl} chain_id ${st.chain_id}, head ${st.sync_info?.latest_block_height}`)) { aborted = true; return finish(); }

    const mAcct = await viewAccount(rpc, M), pAcct = await viewAccount(rpc, P);
    if (!check("accounts", !!mAcct && !!pAcct, "both accounts exist on testnet", `${mAcct ? "" : `${M} missing `}${pAcct ? "" : `${P} missing`}`.trim())) { aborted = true; return finish(); }
    const mKey = await viewAccessKey(rpc, M, merchantSigner.publicKey), pKey = await viewAccessKey(rpc, P, payerSigner.publicKey);
    if (!check("accounts", mKey?.permission === "FullAccess" && pKey?.permission === "FullAccess", "both keys are full-access keys of their accounts",
      `${M}: ${mKey ? JSON.stringify(mKey.permission) : "not a key of this account"}; ${P}: ${pKey ? JSON.stringify(pKey.permission) : "not a key of this account"}`)) { aborted = true; return finish(); }
    info(`${M}: ${near(mAcct.amount)} (spendable ≈${near(mAcct.available)})  ${explorerAccountUrl(NETWORK, M)}`);
    info(`${P}: ${near(pAcct.amount)} (spendable ≈${near(pAcct.available)})  ${explorerAccountUrl(NETWORK, P)}`);
    const fundedOk = check("balances", mAcct.available >= MIN_MERCHANT_YOCTO && pAcct.available >= MIN_PAYER_YOCTO, "balances are enough for the run",
      `need merchant ≥ ${near(MIN_MERCHANT_YOCTO)}, payer ≥ ${near(MIN_PAYER_YOCTO)} spendable`);
    if (!fundedOk && !dryRun) { aborted = true; return finish(); }

    let rate;
    try {
      rate = await createNearUsdRate(nearUsd ? { staticUsd: nearUsd } : {}).current();
      check("rate", true, "NEAR/USD rate available", `1 NEAR = $${rate.nearUsd} (${rate.source}, ${rate.at})`);
    } catch (e) { fail("rate", "NEAR/USD rate available", `${e.code}: ${e.message}`); return finish(); }

    const childEnv = { PATH: env.PATH, HOME: outDir };
    let envFile = null;
    if (mockModel) {
      nano = injectedNano;
      if (!nano) {
        const { nanoGptMock } = await import("../tests/fixtures/near-fake-chain.mjs");
        nano = nanoGptMock();
        await nano.listen();
        startedNano = true;
      }
      childEnv.NANOGPT_API_KEY = "local-stand-in";
      childEnv.NANOGPT_BASE_URL = nano.url;
      check("model", true, "model source: local NanoGPT stand-in", nano.url);
    } else {
      envFile = absPath(opts["env-file"]) || (existsSync(join(ROOT, ".env")) ? join(ROOT, ".env") : null);
      if (envFile && !existsSync(envFile)) { fail("model", "model source", `--env-file ${envFile} does not exist`); return finish(); }
      if (env.NANOGPT_API_KEY) childEnv.NANOGPT_API_KEY = env.NANOGPT_API_KEY;
      if (env.NANOGPT_BASE_URL) childEnv.NANOGPT_BASE_URL = env.NANOGPT_BASE_URL;
      if (!envFile && !childEnv.NANOGPT_API_KEY) { fail("model", "model source", "no --env-file, no .env in the repo and no NANOGPT_API_KEY in the environment"); return finish(); }
      check("model", true, "model source: real NanoGPT", envFile ? `key from ${envFile} (read by the server only)` : "NANOGPT_API_KEY from the environment");
    }

    /* ------------------------------- server -------------------------------- */
    step("Start the server in NEAR mode");
    await mkdir(join(outDir, "graphs"), { recursive: true });
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    try {
      server = await startServer({ port, outDir, graphsDir: join(outDir, "graphs"), merchant: M, keyFile: acc.merchant.keyFile, rpcUrl, nearUsd, envFile, childEnv });
    } catch (e) {
      print((e.stderr || "").split("\n").map((l) => "  [server] " + l).join("\n"));
      fail("server", "server starts in NEAR mode", e.message); return finish();
    }
    check("server", true, "server starts in NEAR mode", `${base}, state in ${outDir}`);
    for (const l of server.stderr.split("\n").filter((x) => /NEAR mode on|NEAR RPC/.test(x))) print("  [server] " + l.replace(/^nanoodle-mcp:\s*/, ""));
    const mcp = mcpClient(base);

    step("Agent: discover tools and learn the graph format");
    const init = await mcp.initialize();
    check("tools", /native NEAR on testnet/.test(init?.result?.instructions || ""), "server says it is paid in native NEAR on testnet");
    const names = (await mcp.list()).map((t) => t.name);
    if (!check("tools", ["run_noodle", "price_noodle", "noodle_guide"].every((n) => names.includes(n)), "run_noodle, price_noodle and noodle_guide are offered", names.join(", "))) { aborted = true; return finish(); }
    const guide = await mcp.call("noodle_guide", { kind: "chat", search: model, limit: 3 });
    const listed = (guide?.structuredContent?.models || []).map((m) => m.id || m.model);
    check("tools", !guide?.isError && listed.includes(model), "noodle_guide lists the model this run uses", `${model}: ${listed.includes(model) ? "listed and priced" : `not listed (got ${listed.join(", ") || "none"})`}`);

    const graph = e2eGraph(model);
    const args1 = { graph, inputs: { Topic: "a lighthouse at dawn" } };
    step("Agent: price the custom graph (free)");
    const price = await mcp.call("price_noodle", args1);
    print(text(price).split("\n").map((l) => "  | " + l).join("\n"));
    const pricing = price?.structuredContent?.pricing;
    const safety = pricing?.safety || price?.structuredContent?.safety;
    if (!check("price", !price?.isError && safety?.ok === true, "price_noodle: the graph is safe and priceable",
      safety?.ok ? `estimated cost $${pricing.estimatedCost.usd}, likely charge $${pricing.likelyCharge.usd}, deposit $${pricing.deposit.usd}` : JSON.stringify(safety?.refusals || price?.rpcError || null))) { aborted = true; return finish(); }
    if (!mockModel) {
      info(`this run makes ONE real NanoGPT call to ${model}: estimated model cost $${pricing.estimatedCost.usd} at most ` +
        `(48 output tokens); the operator's NanoGPT key pays it, the payer is charged it + 20%. The wrong-amount and reuse steps run no model.`);
    }

    step("Agent: ask to run it without paying → quote");
    const q1r = await mcp.call("run_noodle", args1);
    print(text(q1r).split("\n").map((l) => "  | " + l).join("\n"));
    const q1 = q1r?.structuredContent?.payment;
    if (!check("quote", !q1r?.isError && q1?.status === "payment_required" && q1.payTo === M && q1.network === NETWORK && /^\d+$/.test(q1.amountYocto || ""),
      "run_noodle returns a quote for the merchant on testnet", q1 ? `${q1.amountNear} NEAR (${q1.amountYocto} yocto) to ${q1.payTo}, expires ${q1.expiresAt}` : JSON.stringify(q1r?.rpcError || null))) { aborted = true; return finish(); }
    const D1 = BigInt(q1.amountYocto);
    check("balances", pAcct.available >= 2n * D1 + 2n * GAS_CAP_YOCTO, "the payer can afford this quote twice (main + wrong-amount step)", `payer spendable ≈${near(pAcct.available)}`);

    if (dryRun) {
      print("\nDRY RUN: stopping before the first transfer. No funds moved; the quote above expires unused.");
      return finish();
    }
    if (!fundedOk || rows.some((r) => r.status === "FAIL")) { aborted = true; return finish(); }

    /* --------------------------------- pay --------------------------------- */
    const nonceState = {};
    step("Payer: ONE native transfer of exactly the quoted amount");
    const P0 = await settledBalance(rpc, P, { sleep }), M0 = await settledBalance(rpc, M, { sleep });
    let pay1;
    try {
      pay1 = await sendTransfer({ rpc, signer: payerSigner, signerId: P, receiverId: M, amountYocto: D1, nonceState, sleep });
    } catch (e) {
      if (e?.data?.txHash) addTx("payment (unconfirmed)", e.data.txHash);
      fail("pay", "payment transfer is FINAL", `${e.code}: ${e.message}`); return finish();
    }
    addTx("payment", pay1.txHash);
    check("pay", true, "payment transfer is FINAL and succeeded", `${near(D1)}, nonce ${pay1.nonce}, gas burnt ${near(pay1.burnt)}`);

    step("Agent: call again with the payment → result + receipt");
    const paidArgs1 = { ...args1, _payment_id: q1.paymentId, _payment_tx: pay1.txHash, _payment_sender: P };
    const runsBefore = nano?.runs ? nano.runs() : null;
    let paid = await mcp.call("run_noodle", paidArgs1);
    print(text(paid).split("\n").map((l) => "  | " + l).join("\n"));
    let rc = paid?.structuredContent?.receipt;
    if (!check("paid", !paid?.isError && rc?.outcome === "succeeded", "the paid run succeeded with a receipt", rc ? `outcome ${rc.outcome}` : JSON.stringify(paid?.rpcError || paid?.structuredContent || null))) {
      if (rc?.refund?.txHash) addTx("refund", rc.refund.txHash);
      aborted = true; return finish();
    }
    if (runsBefore != null) check("paid", nano.runs() === runsBefore + 1, "the model ran exactly once");
    for (let i = 0; rc.refund.status === "pending" && i < 24; i++) {
      info(`refund pending (${rc.refund.txHash || "no hash yet"}); asking again in 5 s`);
      await sleep(5_000);
      paid = await mcp.call("run_noodle", paidArgs1);
      rc = paid?.structuredContent?.receipt || rc;
    }
    print("  receipt: " + JSON.stringify(rc, null, 2).split("\n").join("\n  "));
    if (!check("paid", rc.refund.status === "sent" && !!rc.refund.txHash, "the refund was sent", `status ${rc.refund.status}`)) {
      if (rc.refund.txHash) addTx("refund", rc.refund.txHash);
      aborted = true; return finish();
    }
    addTx("refund", rc.refund.txHash);
    const R1 = BigInt(rc.refund.yocto), C1 = BigInt(rc.charged.yocto);

    step("Verify the receipt and both transfers independently");
    check("receipt", BigInt(rc.deposit.yocto) === D1 && rc.deposit.txHash === pay1.txHash, "receipt deposit = the quoted amount and our transaction");
    check("receipt", D1 - R1 === C1, "receipt: deposit − refund = charged, to the yocto", `${D1} − ${R1} = ${C1}`);
    check("receipt", rc.refund.to === P, "the refund goes to the account that paid (read from chain)", rc.refund.to);
    const stateFile = join(outDir, "near-state.json");
    const state1 = JSON.parse(await readFile(stateFile, "utf8"));
    const qrec = state1.quotes?.[q1.paymentId];
    check("state", state1.consumedTx?.[pay1.txHash] === q1.paymentId, "the server recorded the payment hash as consumed by this quote");
    const payChk = await checkTransferOnChain({ rpc, txHash: pay1.txHash, sender: P, receiver: M, amountYocto: D1, notBeforeMs: qrec?.createdAt ?? null, notAfterMs: Date.parse(q1.expiresAt) });
    for (const r of payChk.rules) print(`    ${r.ok ? "ok " : "BAD"} ${r.text}`);
    check("onchain", payChk.ok, "payment re-verified on chain (near-check-tx rules + the server's verifier)");
    const refChk = await checkTransferOnChain({ rpc, txHash: rc.refund.txHash, sender: M, receiver: P, amountYocto: R1 });
    for (const r of refChk.rules) print(`    ${r.ok ? "ok " : "BAD"} ${r.text}`);
    check("onchain", refChk.ok, "refund re-verified on chain: merchant → payer, exactly the receipt's refund");
    checkCmds.push(checkTxCommand({ txHash: pay1.txHash, sender: P, receiver: M, amountYocto: D1, rpcUrl }));
    checkCmds.push(checkTxCommand({ txHash: rc.refund.txHash, sender: M, receiver: P, amountYocto: R1, rpcUrl }));

    // The charge itself: the checks above pass for any charge between 0 and the deposit.
    step("Check the charge against the model cost");
    const lockedRate = qrec?.rate ? { usdNano: BigInt(qrec.rate.usdNano), yocto: BigInt(qrec.rate.yocto) } : null;
    if (check("charge", !!lockedRate, "the quote's locked rate is in the server's state")) {
      const costUsd = mockModel ? String(MOCK_CHAT_COST_USD) : rc.actualCost?.usd;
      const expected = costUsd == null ? null : expectedChargeYocto(costUsd, lockedRate, D1);
      check("charge", C1 > 0n && C1 < D1 && rc.charged.capped === false, "the charge is above zero, below the deposit and not capped", `${near(C1)} of ${near(D1)}`);
      // The receipt shows the cost to 9 decimals (rounded); the server settles on the provider's full figure
      // truncated to 1e-9 USD. So a real run may differ by one nano-USD; the stand-in's $0.00041 is exact.
      const tol = mockModel ? 0n : expectedChargeYocto("0.000000001", lockedRate, D1) + 2n;
      const diff = expected === null ? null : (C1 > expected ? C1 - expected : expected - C1);
      check("charge", diff !== null && diff <= tol,
        mockModel
          ? `charged = the stand-in's own reported model cost ($${MOCK_CHAT_COST_USD}) + 20%, at the quote's locked rate`
          : `charged = the model cost the server settled on ($${costUsd}, ${rc.actualCost?.billedAs || "unknown"}) + 20%, at the quote's locked rate`,
        `${C1} yocto, expected ${expected}${tol ? ` (± ${tol}: one nano-USD of rounding)` : ""}`);
      if (mockModel) check("charge", rc.actualCost?.usd != null && Number(rc.actualCost.usd) === MOCK_CHAT_COST_USD, "the receipt's actual cost is what the stand-in reported", `receipt $${rc.actualCost?.usd}`);
      const likelyYocto = usdToYocto(String(pricing.likelyCharge.usd), lockedRate, "ceil");
      if (!mockModel) {
        info(`charged ${C1 <= likelyYocto ? "is within" : "EXCEEDS"} the quote's likely charge ($${pricing.likelyCharge.usd} = ${near(likelyYocto)}): ` +
          `${C1 <= likelyYocto ? "as estimated" : "NanoGPT reported more than the catalog estimate (the deposit covers it); compare <out>/usage.jsonl"}`);
      }
    }

    const P1 = await settledBalance(rpc, P, { sleep }), M1 = await settledBalance(rpc, M, { sleep });
    const payerGas = (P0 - P1) - C1;
    const merchantGas = C1 - (M1 - M0);
    print(`  payer    ${near(P0)} → ${near(P1)}  (−${near(P0 - P1)} = charged ${near(C1)} + gas ${near(payerGas)})`);
    print(`  merchant ${near(M0)} → ${near(M1)}  (+${near(M1 - M0)} = charged ${near(C1)} − refund gas ${near(merchantGas)})`);
    check("balance", payerGas >= 0n && payerGas <= GAS_CAP_YOCTO, "payer lost exactly the charge, plus its own gas", `gas ${payerGas} yocto (cap ${GAS_CAP_YOCTO})`);
    check("balance", merchantGas >= 0n && merchantGas <= GAS_CAP_YOCTO, "merchant gained exactly the charge, minus its refund gas", `gas ${merchantGas} yocto (cap ${GAS_CAP_YOCTO})`);
    info(`payer gas vs tokens_burnt of the payment tx: ${payerGas === pay1.burnt ? "exact match" : `differs by ${payerGas - pay1.burnt} yocto`}`);
    if (refChk.burnt != null) info(`merchant gas vs tokens_burnt of the refund tx: ${merchantGas === refChk.burnt ? "exact match" : `differs by ${merchantGas - refChk.burnt} yocto`}`);

    /* -------------------------------- replay -------------------------------- */
    step("Replay the same paying call");
    const mNonce0 = (await viewAccessKey(rpc, M, merchantSigner.publicKey)).nonce;
    const runsR = nano?.runs ? nano.runs() : null;
    const replay = await mcp.call("run_noodle", paidArgs1);
    check("replay", JSON.stringify(replay?.structuredContent?.receipt) === JSON.stringify(rc), "replay returns the same receipt");
    await sleep(3_000);
    const mNonce1 = (await viewAccessKey(rpc, M, merchantSigner.publicKey)).nonce;
    const M2 = await settledBalance(rpc, M, { sleep });
    check("replay", mNonce1 === mNonce0 && M2 === M1, "no second refund on chain (merchant key nonce and balance unchanged)", `nonce ${mNonce0} → ${mNonce1}`);
    if (runsR != null) check("replay", nano.runs() === runsR, "replay ran nothing");

    /* ------------------------------ wrong amount ---------------------------- */
    step("A second quote, paid with 0.000001 NEAR too little");
    const args2 = { graph, inputs: { Topic: "wrong amount test" } };
    const q2r = await mcp.call("run_noodle", args2);
    const q2 = q2r?.structuredContent?.payment;
    if (!check("wrong", q2?.status === "payment_required", "second quote issued", q2 ? `${q2.amountNear} NEAR` : JSON.stringify(q2r?.rpcError || null))) { aborted = true; return finish(); }
    const sent2 = BigInt(q2.amountYocto) - HALF_STEP_YOCTO;
    const P2 = await settledBalance(rpc, P, { sleep });
    let pay2;
    try {
      pay2 = await sendTransfer({ rpc, signer: payerSigner, signerId: P, receiverId: M, amountYocto: sent2, nonceState, sleep });
    } catch (e) {
      if (e?.data?.txHash) addTx("wrong-amount payment (unconfirmed)", e.data.txHash);
      fail("pay", "wrong-amount transfer is FINAL", `${e.code}: ${e.message}`); return finish();
    }
    addTx("wrong-amount payment", pay2.txHash);
    const runsW = nano?.runs ? nano.runs() : null;
    const wr = await mcp.call("run_noodle", { ...args2, _payment_id: q2.paymentId, _payment_tx: pay2.txHash, _payment_sender: P });
    print(text(wr).split("\n").map((l) => "  | " + l).join("\n"));
    let rc2 = wr?.structuredContent?.receipt;
    for (let i = 0; rc2?.refund?.status === "pending" && i < 24; i++) {
      await sleep(5_000);
      rc2 = (await mcp.call("run_noodle", { ...args2, _payment_id: q2.paymentId, _payment_tx: pay2.txHash, _payment_sender: P }))?.structuredContent?.receipt || rc2;
    }
    check("wrong", wr?.isError === true && rc2?.outcome === "wrong_amount", "wrong amount: refused, nothing runs", rc2 ? `outcome ${rc2.outcome}` : JSON.stringify(wr?.rpcError || null));
    if (runsW != null) check("wrong", nano.runs() === runsW, "wrong amount: the model was not called");
    if (check("wrong", rc2?.refund?.status === "sent" && BigInt(rc2.refund.yocto) === sent2, "wrong amount: everything sent is refunded", rc2 ? `${rc2.refund.yocto} of ${sent2}, status ${rc2.refund.status}` : "")) {
      addTx("wrong-amount refund", rc2.refund.txHash);
      const c2 = await checkTransferOnChain({ rpc, txHash: rc2.refund.txHash, sender: M, receiver: P, amountYocto: sent2 });
      for (const r of c2.rules) print(`    ${r.ok ? "ok " : "BAD"} ${r.text}`);
      check("onchain", c2.ok, "wrong-amount refund re-verified on chain: the full amount came back");
      checkCmds.push(checkTxCommand({ txHash: pay2.txHash, sender: P, receiver: M, amountYocto: sent2, rpcUrl }));
      checkCmds.push(checkTxCommand({ txHash: rc2.refund.txHash, sender: M, receiver: P, amountYocto: sent2, rpcUrl }));
      const P3 = await settledBalance(rpc, P, { sleep }), M3 = await settledBalance(rpc, M, { sleep });
      const g = P2 - P3, gm = M2 - M3;
      check("balance", g >= 0n && g <= GAS_CAP_YOCTO, "payer is down only its gas after the full refund", `−${g} yocto`);
      check("balance", gm >= 0n && gm <= GAS_CAP_YOCTO, "merchant is down only its refund gas", `−${gm} yocto`);
    }

    /* ---------------------------------- reuse -------------------------------- */
    step("Reuse the first, already consumed transaction for a third quote");
    const args3 = { graph, inputs: { Topic: "reuse test" } };
    const q3 = (await mcp.call("run_noodle", args3))?.structuredContent?.payment;
    const mNonce2 = (await viewAccessKey(rpc, M, merchantSigner.publicKey)).nonce;
    const runsU = nano?.runs ? nano.runs() : null;
    const ru = q3 ? await mcp.call("run_noodle", { ...args3, _payment_id: q3.paymentId, _payment_tx: pay1.txHash, _payment_sender: P }) : null;
    print(text(ru).split("\n").map((l) => "  | " + l).join("\n"));
    check("reuse", !!q3 && ru?.isError === true && /already used/.test(text(ru)), "a consumed transaction is refused");
    await sleep(3_000);
    const mNonce3 = (await viewAccessKey(rpc, M, merchantSigner.publicKey)).nonce;
    check("reuse", mNonce3 === mNonce2, "nothing was refunded for it (merchant key nonce unchanged)", `nonce ${mNonce2} → ${mNonce3}`);
    if (runsU != null) check("reuse", nano.runs() === runsU, "reuse ran nothing");
  } catch (e) {
    fail("unexpected", "unexpected error", e?.stack || String(e));
    if (server) print(server.stderr.split("\n").slice(-40).map((l) => "  [server] " + l).join("\n"));
  } finally {
    if (server) await server.stop();
    if (startedNano && nano?.close) await nano.close();
  }
  return finish();

  function finish() {
    print("\n=== Transactions ===");
    if (!txs.length) print("  (none: no funds moved)");
    for (const t of txs) print(`  ${t.label.padEnd(36)} ${explorerTxUrl(NETWORK, t.hash)}`);
    if (checkCmds.length) {
      print("\nRe-check any of them later, read-only:");
      for (const c of checkCmds) print("  " + c);
    }
    print("\n=== Result ===");
    for (const r of rows) print(`  ${r.status.padEnd(4)}  ${r.name}`);
    const failed = rows.filter((r) => r.status === "FAIL");
    if (failed.length) {
      print("\nWhat to check:");
      for (const id of [...new Set(failed.map((r) => r.id))]) print(`  - ${id}: ${HINTS[id] || "see the step output above."}`);
      if (txs.length) print(`  Server state and money log: ${join(outDir, "near-state.json")}, ${join(outDir, "usage.jsonl")}`);
    }
    const ok = failed.length === 0 && !aborted;
    print(`\n${ok ? "PASS" : "FAIL"}: ${rows.filter((r) => r.status === "PASS").length}/${rows.length} checks passed` +
      `${dryRun ? " (dry run: no funds moved)" : ""}${txs.length ? `; server state in ${outDir}` : ""}`);
    return { exitCode: ok ? 0 : 1, rows, txs, outDir };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runTestnetE2E(process.argv.slice(2)).then(
    ({ exitCode }) => process.exit(exitCode),
    (e) => { console.error(`FAIL: ${e?.stack || e}`); process.exit(1); },
  );
}
