const config = JSON.parse(document.querySelector("#near-setup").dataset.setup);
const button = document.querySelector("#near-copy-key");
const status = document.querySelector("#near-setup-status");
const error = document.querySelector("#near-setup-error");
async function refresh() {
  const response = await fetch("/setup/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not check the refund key. Try again shortly.");
  const state = await response.json();
  status.textContent = state.authorized
    ? state.active ? "Authorized. NEAR payments and automatic refunds are active." : "Authorized on chain. The server can now be activated. Return to your chat."
    : "Awaiting owner authorization in the wallet's key-management settings. NEAR payments are inactive.";
}
button.addEventListener("click", async () => {
  error.textContent = "";
  try {
    await navigator.clipboard.writeText(config.publicKey);
    button.textContent = "Public key copied";
  } catch { error.textContent = "Could not copy automatically. Select and copy the public key shown above."; }
});
refresh().catch((e) => { error.textContent = e.message; });
setInterval(() => { refresh().catch(() => {}); }, 5000);
