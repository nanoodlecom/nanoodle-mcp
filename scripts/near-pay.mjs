#!/usr/bin/env node
/**
 * Pay ONE call on a running nanoodle-mcp server with native NEAR, the way an
 * agent would, and check every step against the chain.
 *
 *   node scripts/near-pay.mjs --url https://mcp.example.com --network mainnet \
 *        --payer you.near --payer-key-file ~/.near-credentials/mainnet/you.near.json
 *
 * By default it runs a tiny custom workflow (text -> llm, 48 output tokens at
 * most) through `run_noodle`. Pick something else with:
 *   --tool <name> --args '<json>'     a saved tool; "_pay_with": "near" is added
 *   --graph-file <path> [--inputs '<json>']   your own graph through run_noodle
 *
 * Steps:
 *   quote     call without paying -> payment id, pay-to account, exact amount
 *   guard     stop unless the network matches and the amount is <= --max-near
 *   ---------- --quote-only stops here; nothing below runs, no funds move ----------
 *   pay       ONE native transfer of exactly the quoted amount, wait for FINAL
 *   run       same call + _payment_id, _payment_tx, _payment_sender -> result + receipt
 *   refund    ask again until the refund is sent, then read it from the chain
 *   verify    deposit - refund = charged; both transfers pass the server's own rules
 *
 * Paying from a wallet app instead of a key file: run with --quote-only, send
 * exactly the quoted amount to the pay-to account from the wallet, then run again
 * with the SAME call options plus --payment-id <nq_…> --payment-tx <hash>. That
 * skips the transfer and does the run, refund and verify steps.
 *
 * The payer key signs one transfer and is never printed. Nothing here touches
 * the server's keys. Exit 0 = every check passed, 1 = a check failed, 2 = usage.
 *
 * Options: --rpc <url[,url]> (default: the network's public RPCs), --max-near <n>
 * (default 1; the most this script will ever send), --model <id> (the default
 * graph's chat model), --quote-only.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createNearRpcPool, loadNearSigner, NEAR_NETWORKS } from "../src/near/index.mjs";
import {
  parseArgs, absPath, sendTransfer, checkTransferOnChain, settledBalance,
  explorerTxUrl, formatYoctoAsNear, isNearAccountId, parseNearToYocto,
} from "./near-testnet-lib.mjs";
import { mcpClient } from "./near-simulate.mjs";
import { e2eGraph, DEFAULT_REAL_MODEL } from "./near-testnet-e2e.mjs";

const USAGE = `usage: node scripts/near-pay.mjs --url <server> --network testnet|mainnet --payer <account> --payer-key-file <path>
         [--tool <name> --args '<json>' | --graph-file <path> [--inputs '<json>']]
         [--rpc url[,url]] [--max-near n] [--model id] [--quote-only]
         [--payment-id nq_… --payment-tx <hash>]   (already paid from a wallet: skip the transfer)`;

const near = (y) => `${formatYoctoAsNear(BigInt(y))} NEAR`;
const text = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The payer's signer from a key file. Legacy near-cli files carry `account_id`
 * and must match --payer; near-cli-rs files have none, so --payer names the account.
 */
async function payerSigner(accountId, keyFile) {
  let json = null;
  try { json = JSON.parse(await readFile(keyFile, "utf8")); } catch { /* loadNearSigner reports it */ }
  if (json && typeof json === "object" && json.account_id === undefined && typeof json.private_key === "string") {
    return loadNearSigner({ accountId, env: { NEAR_PRIVATE_KEY: json.private_key } });
  }
  return loadNearSigner({ accountId, keyFile, env: {} });
}

export async function runNearPay(argv, { print = console.log, fetch: fetchImpl, sleep = defaultSleep, mcp: injectedMcp } = {}) {
  let opts;
  try { opts = parseArgs(argv, ["quote-only", "help"]); } catch (e) { print(e.message + "\n" + USAGE); return 2; }
  if (opts.help) { print(USAGE); return 0; }
  const usage = (msg) => { print(msg + "\n" + USAGE); return 2; };
  const network = opts.network;
  if (!Object.hasOwn(NEAR_NETWORKS, network || "")) return usage("--network must be testnet or mainnet (say which chain you mean to pay on)");
  if (!opts.url || !/^https?:\/\//.test(opts.url)) return usage("--url must be the server's http(s) address");
  const P = opts.payer;
  if (!isNearAccountId(P)) return usage("--payer must be a NEAR account id");
  const quoteOnly = !!opts["quote-only"];
  const resume = opts["payment-id"] || opts["payment-tx"] ? { paymentId: opts["payment-id"], txHash: opts["payment-tx"] } : null;
  if (resume && !(/^nq_/.test(resume.paymentId || "") && resume.txHash)) return usage("--payment-id nq_… and --payment-tx <hash> go together");
  if (!quoteOnly && !resume && !opts["payer-key-file"]) return usage("--payer-key-file is required (or pass --quote-only, or --payment-id with --payment-tx)");
  let maxYocto;
  try { maxYocto = parseNearToYocto(String(opts["max-near"] ?? "1")); } catch { return usage("--max-near must be a NEAR amount"); }

  let name = "run_noodle", args;
  try {
    if (opts.tool) {
      name = opts.tool;
      args = { ...(opts.args ? JSON.parse(opts.args) : {}), _pay_with: "near" };
    } else if (opts["graph-file"]) {
      args = { graph: JSON.parse(await readFile(absPath(opts["graph-file"]), "utf8")), inputs: opts.inputs ? JSON.parse(opts.inputs) : {} };
    } else {
      args = { graph: e2eGraph(opts.model || DEFAULT_REAL_MODEL), inputs: { Topic: "a lighthouse at dawn" } };
    }
  } catch (e) { return usage(`could not read the call's arguments: ${e.message}`); }

  const rows = [];
  const check = (ok, what, detail = "") => { rows.push(!!ok); print(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`); return !!ok; };
  const finish = (note) => {
    const failed = rows.filter((r) => !r).length;
    print(`\n${failed ? "FAIL" : "PASS"} — ${rows.length - failed}/${rows.length} checks passed${note ? ` (${note})` : ""}`);
    return failed ? 1 : 0;
  };
  const base = opts.url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const mcp = injectedMcp || mcpClient(base);
  const rpc = createNearRpcPool({
    urls: opts.rpc || NEAR_NETWORKS[network].rpcUrls, chainId: network, timeoutMs: 20_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  print(`Server ${base}, paying on ${network} from ${P}\n`);
  /* -------------------------------- quote -------------------------------- */
  let q, D, M, pay = null, P0 = null;
  if (!resume) {
  try {
    await mcp.initialize();
    const qr = await mcp.call(name, args);
    print(text(qr).split("\n").map((l) => "  | " + l).join("\n"));
    q = qr?.structuredContent?.payment;
    if (!check(!qr?.isError && q?.status === "payment_required" && /^nq_/.test(q.paymentId || "") && /^\d+$/.test(q.amountYocto || ""),
      `${name} answers with a NEAR quote`, q ? `${q.amountNear} NEAR to ${q.payTo}, id ${q.paymentId}, expires ${q.expiresAt}` : JSON.stringify(qr?.rpcError || qr?.structuredContent || null))) return finish();
  } catch (e) { check(false, "the server answers", e.message); return finish(); }
  D = BigInt(q.amountYocto);
  if (!check(q.network === network, `the quote is for ${network}`, `server says ${q.network}`)) return finish("nothing was sent");
  if (!check(isNearAccountId(q.payTo) && q.payTo !== P, "the pay-to account is a NEAR account other than the payer", q.payTo)) return finish("nothing was sent");
  if (!check(D <= maxYocto, `the amount is within --max-near ${formatYoctoAsNear(maxYocto)}`, near(D))) return finish("nothing was sent; raise --max-near to allow it");
  M = q.payTo;
  if (quoteOnly) return finish("quote only: no funds moved, the quote expires unused");

  /* --------------------------------- pay --------------------------------- */
  let signer;
  try { signer = await payerSigner(P, absPath(opts["payer-key-file"])); } catch (e) {
    check(false, "the payer key file is usable", e.message); return finish("nothing was sent");
  }
  try { P0 = await settledBalance(rpc, P, { sleep }); } catch (e) { check(false, `the payer account exists on ${network}`, `${e.code || ""} ${e.message}`); return finish("nothing was sent"); }
  try {
    pay = await sendTransfer({ rpc, signer, signerId: P, receiverId: M, amountYocto: D, sleep });
  } catch (e) {
    if (e?.data?.txHash) print(`  payment (unconfirmed): ${explorerTxUrl(network, e.data.txHash)}`);
    check(false, "the payment transfer is FINAL", `${e.code}: ${e.message}`);
    return finish(e?.data?.txHash ? `if that transfer did land, finish by hand: call ${name} again with _payment_id ${q.paymentId}, _payment_tx ${e.data.txHash}, _payment_sender ${P}` : "nothing was sent");
  }
  check(true, "the payment transfer is FINAL", `${near(D)}, gas ${near(pay.burnt)}`);
  print(`  payment: ${explorerTxUrl(network, pay.txHash)}`);

  } else {
    await mcp.initialize();
    q = { paymentId: resume.paymentId };
    print(`Resuming ${resume.paymentId}: the transfer ${resume.txHash} was sent from a wallet.`);
    print(`  payment: ${explorerTxUrl(network, resume.txHash)}`);
    // What was paid, and to whom, comes from the chain, not from anything typed here.
    try {
      const st = await rpc.txStatus({ txHash: resume.txHash, senderId: P, waitUntil: "FINAL", timeoutMs: 30_000 });
      M = st?.transaction?.receiver_id;
      D = BigInt(st?.transaction?.actions?.[0]?.Transfer?.deposit ?? -1);
    } catch (e) { M = null; D = -1n; print(`  (${e.code || "error"}: ${e.message})`); }
    if (!check(isNearAccountId(M) && D > 0n, `the wallet transfer is FINAL on ${network}, signed by ${P}`, M ? `${near(D)} to ${M}` : "not found: check the hash, --payer and --network")) return finish();
  }
  const txHash = pay ? pay.txHash : resume.txHash;

  /* --------------------------------- run --------------------------------- */
  const paidArgs = { ...args, _payment_id: q.paymentId, _payment_tx: txHash, _payment_sender: P };
  let paid, rc;
  for (let i = 0; i < 8; i++) {
    paid = await mcp.call(name, paidArgs);
    rc = paid?.structuredContent?.receipt;
    if (rc || !/not found as final|could not be reached/i.test(text(paid))) break;
    print("  the server does not see the payment as final yet; asking again in 4 s");
    await sleep(4_000);
  }
  print(text(paid).split("\n").map((l) => "  | " + l).join("\n"));
  if (!check(!!rc, "the paid call returns a receipt", rc ? `outcome ${rc.outcome}` : JSON.stringify(paid?.rpcError || paid?.structuredContent || null))) {
    return finish(`if the payment is on chain, call again later with _payment_id ${q.paymentId}, _payment_tx ${txHash}, _payment_sender ${P}`);
  }
  check(rc.outcome === "succeeded", "the run succeeded", rc.outcome === "succeeded" ? "" : `outcome ${rc.outcome}: a failed run refunds the whole deposit`);

  /* -------------------------------- refund ------------------------------- */
  for (let i = 0; rc.refund?.status === "pending" && i < 36; i++) {
    print(`  refund pending (${rc.refund.txHash || "no hash yet"}); asking again in 5 s`);
    await sleep(5_000);
    rc = (await mcp.call(name, paidArgs))?.structuredContent?.receipt || rc;
  }
  const R = BigInt(rc.refund?.yocto ?? 0), C = BigInt(rc.charged?.yocto ?? 0);
  check(BigInt(rc.deposit?.yocto ?? -1) === D && rc.deposit?.txHash === txHash, "receipt: the deposit is our transfer and its exact amount");
  check(D - R === C, "receipt: deposit − refund = charged, to the yocto", `${near(D)} − ${near(R)} = ${near(C)}`);
  if (R > 0n) {
    if (check(rc.refund.status === "sent" && !!rc.refund.txHash, "the refund was sent", `status ${rc.refund.status}`)) {
      print(`  refund:  ${explorerTxUrl(network, rc.refund.txHash)}`);
      check(rc.refund.to === P, "the refund goes to the account that paid", rc.refund.to);
      if (M) {
        const onChain = await checkTransferOnChain({ rpc, txHash: rc.refund.txHash, sender: M, receiver: P, amountYocto: R });
        for (const r of onChain.rules) if (!r.ok) print(`    ${r.text}`);
        check(onChain.ok, "the refund is FINAL on chain: merchant → payer, exactly the receipt's amount");
      }
      if (pay) {
        const P1 = await settledBalance(rpc, P, { sleep });
        const spent = P0 - P1, want = C + pay.burnt;
        check(spent === want, "the payer's balance fell by exactly charged + its own gas (assumes no other activity on the account)", `${near(spent)} (charged ${near(C)} + gas ${near(pay.burnt)})`);
      }
    }
  } else {
    check(rc.refund?.status !== "pending", "nothing to refund (the charge used the whole deposit)");
  }
  print(`\nPaid ${near(D)}, charged ${near(C)}${rc.charged?.usd != null ? ` ($${rc.charged.usd})` : ""}, refunded ${near(R)}.`);
  return finish();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runNearPay(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
