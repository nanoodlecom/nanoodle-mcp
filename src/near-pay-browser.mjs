// Built into assets/near-wallet.js by npm run build:near-wallet. Wallet keys
// stay in the selected wallet; this page requests one NEAR or USDC transfer.
import { NearConnector } from "@hot-labs/near-connect";
import { createRunView } from "./run-view.mjs";
import { monitorPaymentRun } from "./payment-run.mjs";
import { isExpiredPayment } from "./near/payment-view.mjs";

const root = document.querySelector("#near-payment");
const quote = JSON.parse(root.dataset.payment);
const button = document.querySelector("#near-pay");
const status = document.querySelector("#near-status");
const error = document.querySelector("#near-error");
const form = document.querySelector("#near-confirm");
const key = `nanoodle-near:${quote.paymentId}`;
let current = quote;
let paidResult = null;
let paymentMonitor;
const runView = createRunView("pay");
let busy = false;
let saved = null;
try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* storage may be disabled */ }
const remember = (value) => {
  saved = value;
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch { /* confirmation still works without persistent storage */ }
};

function render(state) {
  current = state;
  const asset = quote.asset === "USDC" ? "USDC" : "NEAR";
  const canPay = state.status === "pending", checking = state.checkingPayment === true;
  const messages = {
    pending: `Ready to pay. Approve the ${asset} deposit in your wallet.`,
    paid: "Payment confirmed. Your agent is continuing — no further payment needed.",
    running: "Payment confirmed. Your workflow is running.",
    settled: `Complete. Unused ${asset} is returned to the wallet that paid.`,
    failed: "The run failed. Your deposit is being refunded to the wallet that paid.",
    rejected: `This payment could not buy the run. Received ${asset} is being refunded.`,
    expired: `This ${asset} quote expired. If you sent a transfer, confirm it below.`,
    unknown: `Unknown payment. Ask your agent for a fresh ${asset} quote.`,
  };
  status.textContent = checking ? state.next || "Checking for your original transfer…" : messages[state.status] || state.status;
  const final = ["settled", "failed", "rejected"].includes(state.status);
  document.querySelector("#near-title").textContent = canPay ? `Pay in ${asset}` : checking ? "Checking payment"
    : final ? (!quote.resultInClient && state.receipt?.outcome === "succeeded" ? "Your result" : "Run finished") : "Your workflow";
  document.querySelector("#near-deposit").open = canPay;
  document.querySelector("#near-manual").hidden = !canPay && state.status !== "expired";
  document.querySelector("#near-transfer-instructions").hidden = !canPay || !!saved;
  document.querySelector("#near-note").textContent = quote.resultInClient
    ? "Your workflow and result are in your Custom MCP client. This page shows payment and refund status."
    : checking
    ? "This page will show your workflow as soon as your original payment is confirmed."
    : canPay
    ? "Keep this page open for the live workflow, result and receipt. Your agent continues automatically after payment."
    : state.status === "paid" ? "Waiting for your agent to start this paid workflow. No further payment is needed."
    : state.status === "running" ? "Follow each step here. Your result appears on this page when it is ready."
    : "This page shows the result and receipt for your original payment. Refreshing never starts another run.";
  runView.render({ payment: quote, workflow: state.workflow, receipt: state.receipt, result: paidResult });
  if (state.receipt?.refund?.status === "pending") status.textContent += " The refund is pending; it will retry automatically.";
  if (state.receipt?.refund?.status === "failed_permanent") status.textContent += ` Contact the operator with payment id ${quote.paymentId} about the refund.`;
  button.hidden = !canPay;
  button.disabled = busy || !canPay || !!saved;
  button.textContent = saved ? "Payment submitted — confirm below if needed" : "Connect wallet & pay";
  if (saved && (canPay || isExpiredPayment(state))) status.textContent = "A wallet payment was already requested. Confirm the original transaction below.";
}

function track(state) {
  paymentMonitor?.stop();
  paymentMonitor = monitorPaymentRun({ initial: state, update(next, result) { paidResult = result; render(next); } });
}

async function confirm(txHash, senderId) {
  error.textContent = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    status.textContent = "Confirming your transfer…";
    const response = await fetch(`/near/pay/${encodeURIComponent(quote.paymentId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash, senderId }),
    });
    const state = await response.json();
    if (isExpiredPayment(current) && state.txHash) track(state);
    else if (state.status) render(state);
    if (response.ok) return;
    if (state.error && /not found as final|not final|could not be reached/.test(state.error) && attempt < 9) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }
    throw new Error(state.error || "Confirmation failed. Retry confirming the same transfer below.");
  }
}

button.addEventListener("click", async () => {
  if (busy || saved || current.status !== "pending") return;
  busy = true;
  error.textContent = "";
  render(current);
  try {
    // Fetch current state before opening the wallet, including after a tab was idle.
    const response = await fetch(`/near/status/${encodeURIComponent(quote.paymentId)}`, { cache: "no-store" });
    render(await response.json());
    if (!response.ok || current.status !== "pending") return;
    const connector = new NearConnector({ network: quote.network, features: { signAndSendTransaction: true, signInWithoutAddKey: true } });
    const wallet = await connector.connect();
    const accounts = await wallet.getAccounts({ network: quote.network });
    const senderId = accounts[0]?.accountId;
    if (!senderId) throw new Error("The wallet did not return an account.");
    // Persist before requesting a signature: a closed tab or uncertain wallet
    // result must not invite a second payment on reload.
    remember({ senderId });
    const outcome = await wallet.signAndSendTransaction({
      network: quote.network, signerId: senderId, receiverId: quote.asset === "USDC" ? quote.tokenContract : quote.payTo,
      actions: quote.asset === "USDC"
        ? [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: quote.payTo, amount: quote.amountAtomic }, gas: "30000000000000", deposit: "1" } }]
        : [{ type: "Transfer", params: { deposit: quote.amountYocto } }],
    });
    const txHash = outcome?.transaction?.hash;
    if (!txHash) throw new Error("Check your wallet history and confirm the transaction below. Do not send the deposit again.");
    remember({ senderId, txHash });
    form.elements.senderId.value = senderId;
    form.elements.txHash.value = txHash;
    await confirm(txHash, senderId);
  } catch (e) {
    if (/reject|cancel|denied/i.test(e.message) && !saved?.txHash) remember(null);
    error.textContent = e.message;
  } finally {
    busy = false;
    render(current);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !["pending", "expired"].includes(current.status)) return;
  busy = true;
  const senderId = form.elements.senderId.value.trim();
  const txHash = form.elements.txHash.value.trim();
  remember({ senderId, txHash });
  render(current);
  try { await confirm(txHash, senderId); }
  catch (e) { error.textContent = e.message; }
  finally { busy = false; render(current); }
});

render(current);
if (saved?.senderId) form.elements.senderId.value = saved.senderId;
if (saved?.txHash) {
  form.elements.txHash.value = saved.txHash;
  if (["pending", "expired"].includes(current.status)) confirm(saved.txHash, saved.senderId).catch((e) => { error.textContent = e.message; });
}
track(quote);
setInterval(() => { if (current.workflow && !current.workflow.finishedAt) runView.elapsed(current.workflow); }, 1000);
