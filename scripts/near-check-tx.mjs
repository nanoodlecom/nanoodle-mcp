#!/usr/bin/env node
/**
 * Read-only: check a real NEAR transfer the way a NEAR-paid nanoodle-mcp
 * server does before it runs anything, and print PASS/FAIL per rule.
 *
 *   node scripts/near-check-tx.mjs --network testnet --merchant <account> --tx <hash> --sender <account>
 *        [--amount-yocto N | --amount-near X] [--rpc url]
 *        [--state <out>/near-state.json --payment-id nq_…]
 *
 * --merchant is the receiving account. To check a refund, pass the payer as
 * --merchant and the merchant as --sender. With --state and --payment-id the
 * amount, quote time and expiry come from the server's own quote record, and
 * the script also reports whether the server has consumed the hash.
 *
 * No keys, no transactions: it only calls the RPC's `tx` and `block` methods.
 * Exits 0 when every rule passes, 1 otherwise.
 */
import { readFile } from "node:fs/promises";
import {
  createNearRpc, readPaymentTransfer, formatYoctoAsNear, parseNearToYocto, isNearAccountId,
  NEAR_NETWORKS, explorerTxUrl,
} from "../src/near/index.mjs";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/near-check-tx.mjs --network testnet|mainnet --merchant <receiver> --tx <hash> --sender <signer>\n" +
    "         [--amount-yocto N | --amount-near X] [--rpc url] [--state near-state.json --payment-id nq_…]");
  process.exit(2);
}

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (!k.startsWith("--")) usage(`unexpected argument ${k}`);
  const v = argv[++i];
  if (v === undefined) usage(`${k} needs a value`);
  opts[k.slice(2)] = v;
}
const network = opts.network || "testnet";
if (!Object.hasOwn(NEAR_NETWORKS, network)) usage("--network must be testnet or mainnet");
const merchant = opts.merchant || opts.receiver;
if (!isNearAccountId(merchant)) usage("--merchant must be a NEAR account id");
if (!isNearAccountId(opts.sender)) usage("--sender must be a NEAR account id");
if (!opts.tx) usage("--tx is required");

let expected = opts["amount-yocto"] ? BigInt(opts["amount-yocto"]) : opts["amount-near"] ? parseNearToYocto(opts["amount-near"]) : null;
let quote = null, consumedBy = null;
if (opts.state) {
  if (!opts["payment-id"]) usage("--state needs --payment-id");
  const state = JSON.parse(await readFile(opts.state, "utf8"));
  quote = state.quotes && state.quotes[opts["payment-id"]];
  if (!quote) usage(`no quote ${opts["payment-id"]} in ${opts.state}`);
  if (expected == null) expected = BigInt(quote.amountYocto);
  consumedBy = (state.consumedTx || {})[opts.tx] || null;
}

const rpcUrl = opts.rpc || NEAR_NETWORKS[network].rpcUrl;
const rpc = createNearRpc({ url: rpcUrl, timeoutMs: 45_000 });
const results = [];
const rule = (ok, text) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${text}`); };
const has = (o, k) => o !== null && typeof o === "object" && Object.hasOwn(o, k);

console.log(`Checking ${opts.tx} on ${network} via ${rpcUrl}`);
console.log(`explorer: ${explorerTxUrl(network, opts.tx)}\n`);

let r;
try {
  r = await rpc.txStatus({ txHash: opts.tx, senderId: opts.sender, waitUntil: "FINAL", timeoutMs: 45_000 });
} catch (e) {
  rule(false, `the RPC knows the transaction as final (${e.code || "error"}: ${e.message})`);
  console.log("\nFAIL — not found as final. Check the network, the hash and the sender, or wait a few seconds.");
  process.exit(1);
}
rule(r.final_execution_status === "FINAL", `1. finality is FINAL (got ${r.final_execution_status})`);
const failedReceipt = (r.receipts_outcome || []).some((ro) => has(ro && ro.outcome && ro.outcome.status, "Failure"));
rule(has(r.status, "SuccessValue") && !failedReceipt, "2. the transaction and all its receipts succeeded");
const tx = r.transaction || {};
rule(tx.hash === opts.tx, "3. the RPC returned this exact transaction");
rule(tx.receiver_id === merchant, `4. receiver is ${merchant} (got ${tx.receiver_id})`);
const acts = tx.actions || [];
const single = acts.length === 1 && acts[0] && Object.keys(acts[0]).length === 1 && has(acts[0], "Transfer");
rule(single, `5. exactly one native Transfer action (got ${JSON.stringify(acts.map((a) => (a && typeof a === "object" ? Object.keys(a)[0] : a)))})`);
const deposit = single ? BigInt(acts[0].Transfer.deposit) : null;
if (deposit != null) console.log(`      amount: ${formatYoctoAsNear(deposit)} NEAR (${deposit} yocto), signer (refunds go here): ${tx.signer_id}`);
if (expected != null) rule(deposit === expected, `6. amount equals ${formatYoctoAsNear(expected)} NEAR (${expected} yocto)`);
else console.log("SKIP  6. amount (pass --amount-yocto, --amount-near or --state/--payment-id)");

let blockMs = null;
try {
  const b = await rpc.block({ blockId: r.transaction_outcome.block_hash });
  blockMs = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
  console.log(`      block time: ${new Date(blockMs).toISOString()}`);
} catch (e) {
  rule(false, `the transaction's block can be read (${e.code || "error"})`);
}
if (quote && blockMs != null) {
  rule(blockMs >= quote.createdAt - 120_000, `7. sent after the quote was created (${new Date(quote.createdAt).toISOString()}, 120 s skew allowed)`);
  rule(blockMs <= quote.expiresAt, `8. sent before the quote expired (${new Date(quote.expiresAt).toISOString()})`);
  console.log(`INFO  quote ${quote.id}: status ${quote.status}${quote.outcome ? `, outcome ${quote.outcome}` : ""}; hash consumed by ${consumedBy || "nothing yet"}`);
} else {
  console.log("SKIP  7-8. quote time window (pass --state <out>/near-state.json --payment-id nq_…)");
}

// The server's own verifier, end to end.
try {
  const t = await readPaymentTransfer({ rpc, txHash: opts.tx, senderId: opts.sender, merchantId: merchant, txTimeoutMs: 45_000 });
  rule(true, `server verifier accepts it: payer ${t.payer}, ${formatYoctoAsNear(t.amountYocto)} NEAR`);
} catch (e) {
  rule(false, `server verifier rejects it: ${e.code} — ${e.message}`);
}

const ok = results.every(Boolean);
console.log(`\n${ok ? "PASS" : "FAIL"} — ${results.filter(Boolean).length}/${results.length} rules passed`);
process.exit(ok ? 0 : 1);
