import { knownUsd } from "./usd.mjs";

// These requests carry replayable bodies and return their result directly.
// Payment completion, paid replay, polling and downloaded URLs stay outside
// the backup path.
const supported = new Set([
  "/api/v1/chat/completions",
  "/api/v1/decisions",
  "/api/v1/responses",
  "/api/v1/images/generations",
  "/api/v1/images/edits",
  "/v1/images/generations",
  "/api/v1/audio/speech",
]);
const proofHeaders = ["authorization", "x-api-key", "x-x402-payment-id", "x-payment", "payment-signature"];

function pricedQuote(body) {
  const quote = body?.payment;
  if (!Array.isArray(quote?.accepted) || !quote.accepted.length
    || typeof quote.paymentId !== "string" || !quote.paymentId || quote.paymentId.length > 256) return null;
  const offers = [...quote.accepted, ...(Array.isArray(body.accepts) ? body.accepts : [])];
  // Preserve the existing wallet path when the provider offers direct Nano,
  // including malformed or expired Nano quotes that it needs to diagnose.
  if (offers.some(offer => offer?.scheme === "nano" || offer?.protocolScheme === "nano")) return null;
  if (!quote.accepted.some(offer => offer?.scheme === "lightning-l402" || offer?.scheme === "nano-exact")) return null;
  const price = knownUsd(quote.amountUsd);
  if (!(price > 0)) return null;
  const amountUsd = quote.accepted.reduce((cost, offer) => Math.max(cost, knownUsd(offer?.undiscountedAmountUsd) ?? 0), price);
  return { paymentId: quote.paymentId, amountUsd };
}

function backupError(message, { possibleCharge = false, status } = {}) {
  return Object.assign(new Error(message), { code: "x402-backup", status, backupChargePossible: possibleCharge });
}

export function nanoGptBackupFetch({ baseUrl, key, authorize, fetch = globalThis.fetch }) {
  const base = new URL(baseUrl);
  const loopback = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (typeof key !== "string" || !/^[!-~]+$/.test(key) || typeof authorize !== "function"
    || base.username || base.password || (base.protocol !== "https:" && !loopback)) {
    throw new TypeError("NanoGPT backup requires a key, provider origin and wallet run budget");
  }
  return async (input, init = {}) => {
    const url = typeof input === "string" || input instanceof URL ? URL.parse(input) : null;
    if (url?.origin !== base.origin || url.username || url.password || !supported.has(url.pathname)
      || init.method !== "POST" || typeof init.body !== "string") return fetch(input, init);
    const headers = new Headers(init.headers);
    if (headers.get("x-x402") !== "true" || proofHeaders.some(header => headers.has(header))) return fetch(input, init);
    const response = await fetch(input, { ...init, redirect: "error" });
    if (response.status !== 402 || response.redirected) return response;
    const invoice = pricedQuote(await response.clone().json().catch(() => null));
    if (!invoice) return response;
    // This 402 is the original, unsigned challenge. No wallet callback can
    // have run yet. Debit the quote before posting the same body with the key.
    response.body?.cancel().catch(() => {});
    try {
      await authorize(invoice, init.signal);
      init.signal?.throwIfAborted();
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      throw backupError(error?.code === "FUNDING_OVER_BUDGET"
        ? "NanoGPT backup quote exceeds the approved run budget."
        : "NanoGPT backup could not reserve the quoted cost.");
    }
    headers.delete("x-x402");
    headers.set("Authorization", "Bearer " + key);
    headers.set("x-api-key", key);
    let retry;
    try {
      retry = await fetch(input, { ...init, headers, redirect: "error" });
    } catch {
      throw backupError("NanoGPT backup request did not return a result. Its charge could be pending.", { possibleCharge: true });
    }
    if (retry.ok) return retry;
    retry.body?.cancel().catch(() => {});
    const { status } = retry;
    const detail = status === 402 ? "the backup account has insufficient credit"
      : status === 401 || status === 403 ? "the backup API key was rejected"
      : "the provider returned HTTP " + status;
    throw backupError("NanoGPT backup failed because " + detail + ".", {
      possibleCharge: ![401, 402, 403, 429].includes(status), status,
    });
  };
}
