#!/usr/bin/env node
// A paid production canary. Run under flock; see docs/near-monitoring.md.
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createNearRpcPool, loadNearSigner, NEAR_NETWORKS, signTransfer, parseNearToYocto, formatYoctoAsNear } from "../src/near/index.mjs";
import { readNearTransferFunding } from "../src/near/funding.mjs";
import { checkTransferOnChain, parseArgs, tokensBurnt } from "./near-testnet-lib.mjs";
import { callMcp, resultText } from "../src/near-site-browser.mjs";
import { atomicJson } from "./atomic-json.mjs";

export { atomicJson } from "./atomic-json.mjs";
export const DEFAULT_CHECK_MAX_NEAR = "0.01";

export function checkGraph(marker, twoSteps = false) {
  // This checks the payment/runtime path, not reasoning. A thinking model can
  // spend this small output budget before emitting the marker, producing a
  // billed empty answer. Keep strict output validation and a bounded budget.
  const fields = { model: "openai/gpt-4.1-nano", temperature: 0, maxTokens: 256 };
  const nodes = [
    { id: "input", type: "text", name: "Marker", fields: { text: "" } },
    { id: "extract", type: "llm", name: "Read marker", fields: { ...fields,
      system: "Return only the 16 lowercase hexadecimal characters after Marker: in the user's message. Copy them exactly. No prefix, punctuation, spaces or explanation." } },
  ];
  const links = [{ id: "read", from: { node: "input", port: "text" }, to: { node: "extract", port: "prompt" } }];
  if (twoSteps) {
    nodes.push({ id: "format", type: "llm", name: "Copy marker", fields: { ...fields, system: "Return the user's 16 lowercase hexadecimal characters exactly. No prefix, punctuation, spaces or explanation." } });
    links.push({ id: "handoff", from: { node: "extract", port: "text" }, to: { node: "format", port: "prompt" } });
  }
  return { graph: { v: 1, nodes, links }, inputs: { Marker: `Marker: ${marker}` }, _pay_with: "near" };
}

function correctOutput(result, state) {
  if (state.v < 2) return resultText(result).includes(`NANOODLE_OK:${state.marker}`);
  // Validate the model output itself, not marker text in billing or metadata.
  const text = result?.content?.find(c => c.type === "text")?.text;
  return /^[a-f0-9]{16}$/.test(state.marker) && typeof text === "string" && text.trim() === state.marker;
}

/** Dependencies are injectable so crash recovery and payment limits run offline. */
export async function runCheck(config, deps = {}) {
  const { stateDir, payer, keyFile, merchant = "nanoodle.near", network = "mainnet", twoSteps = false,
    maxNear = DEFAULT_CHECK_MAX_NEAR, maxUsd = 0.001, url = "https://near.nanoodle.com" } = config;
  const base = url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const request = deps.fetch || ((input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(240_000) }));
  const rpc = deps.rpc || createNearRpcPool({ urls: config.rpc || NEAR_NETWORKS[network].rpcUrls, chainId: network, timeoutMs: 20_000 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "state.json"), latest = join(stateDir, "latest.json");
  let state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, stage = "preflight";
  const save = () => atomicJson(file, state);
  const require = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { checkFailure: true }); };
  let id = 0;
  const json = async path => {
    const response = await request(base + path, { cache: "no-store" });
    require(response.status === 200, "HTTP status check failed"); return response.json();
  };
  const mcp = async (method, params) => {
    const response = await request(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    require(response.ok, "MCP HTTP check failed"); const body = await response.json();
    require(!body.error && body.result, "MCP returned an error"); return body.result;
  };
  const call = (name, args) => mcp("tools/call", { name, arguments: args });
  async function verifyPaymentPage(receipt) {
    stage = "payment_page";
    const paymentId = state.quote?.paymentId;
    require(/^nq_[A-Za-z0-9_-]+$/.test(paymentId) && receipt?.outcome === "succeeded" && receipt.refund?.status === "sent",
      "Verified payment or refund is missing from retained state");
    const [view, cached] = await Promise.all([json(`/near/status/${paymentId}`), json(`/near/result/${paymentId}`)]);
    require(view?.paymentId === paymentId && view.status === "settled" && isDeepStrictEqual(view.receipt, receipt),
      "Payment page status or refund differs from the verified receipt");
    require(cached && !cached.isError && correctOutput(cached, state) && isDeepStrictEqual(cached.structuredContent?.receipt, receipt),
      "Payment page result or receipt differs from the verified run");
  }
  try {
    const day = new Date(now()).toISOString().slice(0, 10);
    require(payer && payer !== merchant && keyFile, "A separate payer and key file are required");
    require(Number.isFinite(Number(maxUsd)) && Number(maxUsd) > 0 && parseNearToYocto(maxNear) > 0n, "Invalid spending cap");
    // Check configuration even on a cached day; never resume against another host/account.
    if (state) require(state.base === base && state.payer === payer && state.merchant === merchant && state.network === network, "Stored run belongs to another configuration");
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nanoodle-daily-check", version: "1" } });
    const tools = (await mcp("tools/list", {})).tools;
    require(["run_noodle", "price_noodle", "noodle_guide"].every(name => tools?.some(t => t.name === name)), "Required MCP tools are missing");
    require(!(await call("noodle_guide", {})).isError, "Agent guide failed");
    if (state?.done && state.day === day) {
      await verifyPaymentPage(state.receipt);
      const report = { ...state.report, checkedAt: new Date(now()).toISOString(), reused: true };
      atomicJson(latest, report); return report;
    }
    if (!state || state.done) {
      const marker = randomBytes(8).toString("hex");
      state = { v: 2, day, base, payer, merchant, network, marker, args: checkGraph(marker, twoSteps), progress: [], createdAt: new Date(now()).toISOString() };
      save();
    }
    stage = "quote";
    let q = state.quote;
    if (!q) {
      const priced = await call("price_noodle", { graph: state.args.graph, inputs: state.args.inputs });
      const pricing = priced.structuredContent?.pricing;
      require(!priced.isError && pricing?.safety?.ok && Number.isFinite(Number(pricing.estimatedCost?.usd)) && Number(pricing.estimatedCost.usd) <= Number(maxUsd), "Price exceeds the model-cost cap or cannot be estimated");
      const quoted = await call("run_noodle", state.args);
      require(!quoted.isError, "Workflow quote failed");
      q = quoted.structuredContent?.payment;
    }
    require(q?.status === "payment_required" && /^nq_[A-Za-z0-9_-]+$/.test(q.paymentId) && /^\d+$/.test(q.amountYocto), "Invalid NEAR quote");
    require(q.network === network && q.payTo === merchant && (!q.asset || q.asset === "NEAR"), "Unexpected network, asset or payment destination");
    const deposit = BigInt(q.amountYocto);
    require(deposit > 0n && deposit <= parseNearToYocto(maxNear) && Number(q.depositUsd) <= Number(maxUsd) * 10, "Deposit exceeds the spending cap");
    let newlySigned = false;
    if (!state.signed) {
      require(Date.parse(q.expiresAt) > now() + 60_000, "Unpaid quote expired; operator must archive this state before trying a new run");
      stage = "payer_funding";
      const signer = await (deps.loadSigner || loadNearSigner)({ accountId: payer, keyFile, env: {} });
      const { accessKey: key, sufficient } = await readNearTransferFunding({ rpc, network, accountId: payer,
        publicKey: signer.publicKey, amountYocto: deposit, now });
      require(sufficient, "Canary payer cannot cover this deposit, storage and gas");
      stage = "payment";
      require(Date.parse(q.expiresAt) > now() + 60_000, "Unpaid quote expired while checking payer funding");
      state.day = new Date(now()).toISOString().slice(0, 10);
      state.quote = q;
      state.signed = signTransfer({ signer, signerId: payer, receiverId: merchant, nonce: BigInt(key.nonce) + 1n, blockHash: key.block_hash, amountYocto: deposit });
      save(); newlySigned = true;
    }
    stage = "payment";
    if (!state.paymentFinal) {
      // On recovery, query first; if unknown, only re-broadcast these SAME bytes.
      let tx;
      try { if (!newlySigned) tx = await rpc.txStatus({ txHash: state.signed.txHash, senderId: payer, waitUntil: "FINAL", timeoutMs: 15_000 }); } catch (e) {
        if (!["UNKNOWN_TRANSACTION", "TIMEOUT_ERROR", "RPC_TIMEOUT", "RPC_HTTP", "RPC_BAD_RESPONSE"].includes(e.code)) throw e;
      }
      if (!tx || tx.final_execution_status !== "FINAL") tx = await rpc.sendTx(state.signed.signedTxBase64, "FINAL", { timeoutMs: 60_000 });
      require(tx?.final_execution_status === "FINAL" && Object.hasOwn(tx.status || {}, "SuccessValue") && !(tx.receipts_outcome || []).some(r => r.outcome?.status?.Failure), "Payment did not succeed at FINAL");
      state.paymentFinal = true; state.gasYocto = tokensBurnt(tx).toString(); save();
    }
    stage = "payment_detection";
    // Deliberately no _payment_tx/_payment_sender hints: exercise the watcher.
    let view;
    for (let i = 0; i < 90; i++) {
      view = await json(`/near/status/${q.paymentId}`);
      if (["paid", "running", "settled"].includes(view.status)) break;
      await sleep(1000);
    }
    require(["paid", "running", "settled"].includes(view?.status), "Payment watcher did not recognize the deposit");
    stage = "execution";
    const paidArgs = { ...state.args, _payment_id: q.paymentId };
    if (!state.result) {
      const result = await callMcp("run_noodle", paidArgs, { fetch: request, endpoint: base + "/mcp", onWorkflow: workflow => {
        state.progress.push({ status: workflow.status, nodes: workflow.nodes.map(n => ({ id: n.id, status: n.status })) }); save();
      } });
      const pause = result.structuredContent?.payment;
      require(!(result.isError && pause?.retryable === true && pause.status === "paid" && pause.paymentId === q.paymentId),
        "Payment verified but execution is temporarily paused; resume this retained payment after funding recovers");
      state.result = result; save();
    }
    const expected = state.v < 2 ? `NANOODLE_OK:${state.marker}` : state.marker;
    require(!state.result.isError && correctOutput(state.result, state), "Custom workflow returned an incorrect result");
    require(state.progress.some(w => w.nodes.some(n => n.status === "running")), "No live running-node progress received");
    stage = "refund";
    let receipt = state.result.structuredContent?.receipt;
    for (let i = 0; receipt?.refund?.status === "pending" && i < 90; i++) {
      await sleep(1000); receipt = (await call("run_noodle", paidArgs)).structuredContent?.receipt || receipt;
    }
    require(receipt?.outcome === "succeeded", "Workflow receipt did not succeed");
    const refunded = BigInt(receipt.refund?.yocto ?? -1), charged = BigInt(receipt.charged?.yocto ?? -1);
    require(BigInt(receipt.deposit?.yocto ?? -1) === deposit && receipt.deposit.txHash === state.signed.txHash && deposit - refunded === charged && charged >= 0n, "Receipt arithmetic or deposit does not match");
    require(Number.isFinite(Number(receipt.charged.usd)) && Number(receipt.charged.usd) <= Number(maxUsd) * 1.2, "Actual charge exceeds the cost cap");
    require(refunded > 0n && receipt.refund.status === "sent" && receipt.refund.to === payer, "Refund was not sent to the payer");
    require((await checkTransferOnChain({ rpc, txHash: receipt.refund.txHash, sender: merchant, receiver: payer, amountYocto: refunded })).ok, "Refund does not match the finalized on-chain transfer");
    stage = "replay_and_result";
    const replay = await call("run_noodle", paidArgs);
    require(isDeepStrictEqual(replay.structuredContent?.receipt, receipt), "Replay changed the receipt");
    require(correctOutput(replay, state), "Paid output is unavailable on replay; text results are not retained across server restarts");
    await verifyPaymentPage(receipt);
    const report = { ok: true, checkedAt: new Date(now()).toISOString(), runDay: state.day, model: state.args.graph.nodes.find(n => n.type === "llm").fields.model, modelSteps: state.args.graph.nodes.filter(n => n.type === "llm").length,
      output: expected, progressFrames: state.progress.length, chargedUsd: receipt.charged.usd, chargedNear: formatYoctoAsNear(charged), refundedNear: formatYoctoAsNear(refunded), payerGasNear: formatYoctoAsNear(BigInt(state.gasYocto)),
      paymentTx: state.signed.txHash, refundTx: receipt.refund.txHash, watcher: true, replay: true, paymentPageResult: true };
    state.done = true; state.receipt = receipt; state.report = report; save(); atomicJson(latest, report); return report;
  } catch (error) {
    // Raw RPC/MCP errors can include signed payloads and private checkout URLs.
    const report = { ok: false, checkedAt: new Date(now()).toISOString(), stage, error: error.checkFailure ? error.message : "Check interrupted or dependency failed; resume the retained state. Inspect locally before replacing it." };
    atomicJson(latest, report); throw Object.assign(new Error(report.error), { report });
  }
}

if (import.meta.main) {
  try {
    const o = parseArgs(process.argv.slice(2), ["two-steps"]);
    const report = await runCheck({ stateDir: o["state-dir"] || "/var/lib/nanoodle-near-check", payer: o.payer || process.env.CHECK_PAYER,
      keyFile: o["key-file"] || process.env.CHECK_KEY_FILE, url: o.url || process.env.CHECK_URL, network: o.network || "mainnet", rpc: o.rpc,
      merchant: o.merchant || "nanoodle.near", maxNear: o["max-near"] || process.env.CHECK_MAX_NEAR || DEFAULT_CHECK_MAX_NEAR,
      maxUsd: Number(o["max-usd"] || "0.001"), twoSteps: !!o["two-steps"] });
    console.log(JSON.stringify(report));
  } catch (error) { console.error(JSON.stringify(error.report || { ok: false, error: "Invalid configuration or unreadable state" })); process.exitCode = 1; }
}
