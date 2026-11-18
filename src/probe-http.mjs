// A bounded transport for read-only probes, including catalogs and RPC bodies.
export function createProbeFetch({ fetch = globalThis.fetch, timeoutMs = 12_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return async (url, init = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const res = await fetch(url, { ...init, signal, redirect: "error" });
    if (!res.body) return res;
    const reader = res.body.getReader(), chunks = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw Error("probe-response-too-large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return new Response(new Blob(chunks), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
