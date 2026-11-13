/** Read-only browser subscription: payment → graph → result → refund.
 * Never calls a tool, requests a signature, or starts another paid execution.
 */
export function monitorPaymentRun({ initial, update, fetch: request = globalThis.fetch,
  EventSource: Events = globalThis.EventSource, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const id = encodeURIComponent(initial.paymentId);
  let current = initial, result = null, reading = null, polling = false, stopped = false, watch;
  const final = state => ["settled", "failed", "rejected"].includes(state?.status);
  const finished = () => ["unknown", "expired"].includes(current?.status) || final(current) && current.receipt?.refund?.status !== "pending" && result;
  const stop = () => { stopped = true; watch?.close(); };
  async function apply(state) {
    if (stopped) return;
    current = state; update(current, result);
    if (final(current) && !result) {
      if (!reading) reading = (async () => {
        const response = await request(`/near/result/${id}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error("The result is not available yet. Reconnecting to the same paid run…");
        if (response.status === 202) return;
        result = await response.json(); update(current, result);
      })().finally(() => { reading = null; });
      await reading;
    }
    if (finished()) stop();
  }
  async function poll() {
    if (polling || stopped) return;
    polling = true; watch?.close();
    try {
      while (!stopped) {
        try {
          const response = await request(`/near/status/${id}?wait=1`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
          if (!response.ok && response.status !== 404) throw new Error("Run monitor is reconnecting");
          await apply(response.status === 404 ? { paymentId: initial.paymentId, status: "unknown" } : await response.json());
        } catch { /* Keep the same capability through temporary network outages. */ }
        if (!stopped) await pause(1000);
      }
    } finally { polling = false; }
  }
  void apply(initial).catch(() => { void poll(); });
  if (!finished() && Events) {
    watch = new Events(`/near/watch/${id}?run=1`);
    watch.addEventListener("status", event => {
      try { void apply(JSON.parse(event.data)).then(() => { if (current.done && !stopped) void poll(); }).catch(() => { void poll(); }); }
      catch { void poll(); }
    });
    watch.onerror = () => { void poll(); };
  } else if (!Events && !stopped) void poll();
  return { stop, apply };
}
