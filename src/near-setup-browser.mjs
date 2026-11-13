import { NearConnector } from "@hot-labs/near-connect";

const config = JSON.parse(document.querySelector("#near-setup").dataset.setup);
const button = document.querySelector("#near-authorize");
const status = document.querySelector("#near-setup-status");
const error = document.querySelector("#near-setup-error");
let authorized = false, busy = false;
async function refresh() {
  const response = await fetch("/setup/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not check the refund key. Try again shortly.");
  const state = await response.json();
  authorized = state.authorized;
  button.disabled = authorized || busy;
  status.textContent = authorized
    ? state.active ? "Authorized. NEAR payments and automatic refunds are active." : "Authorized on chain. The server can now be activated. Return to your chat."
    : "Your wallet must approve adding this key. No seed phrase or private key is requested.";
}
button.addEventListener("click", async () => {
  if (busy || authorized) return;
  busy = true; button.disabled = true; error.textContent = "";
  try {
    await refresh();
    if (authorized) return;
    const connector = new NearConnector({ network: config.network, features: { signAndSendTransaction: true, signInWithoutAddKey: true } });
    let selectedAccount = null;
    connector.on("wallet:signIn", ({ accounts }) => { selectedAccount = accounts[0]?.accountId || null; });
    const wallet = await connector.connect({ walletId: "meteor-wallet" });
    if (selectedAccount !== config.merchant) {
      throw new Error(`Select ${config.merchant} in Meteor Wallet, then try again.`);
    }
    status.textContent = "Review and approve the Full Access key in Meteor Wallet.";
    const result = await wallet.signAndSendTransaction({
      network: config.network, signerId: config.merchant, receiverId: config.merchant,
      actions: [{ type: "AddKey", params: { publicKey: config.publicKey, accessKey: { nonce: 0, permission: "FullAccess" } } }],
    });
    if (result?.status?.Failure) throw new Error("The authorization transaction failed. Your wallet shows the reason.");
    await refresh();
    if (!authorized) status.textContent = "Submitted. Waiting for NEAR finality; this page will check automatically.";
  } catch (e) { error.textContent = e.message; }
  finally { busy = false; button.disabled = authorized; }
});
refresh().catch((e) => { error.textContent = e.message; });
setInterval(() => { if (!busy) refresh().catch(() => {}); }, 5000);
