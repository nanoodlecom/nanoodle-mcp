// NanUSD node RPC client.
//
// The NanUSD network runs a Nano-node fork (yxse/nan-node), so it speaks the
// standard Nano JSON-RPC dialect: HTTP POST of {action, ...} JSON. Example
// ports from the published docker config: RPC 9999, websocket 9998, peering
// 7090 (peering.nanusd.com). NO public hosted RPC is published by the
// operator today — production use means running our own node or obtaining
// an endpoint from Nanswap (DESIGN E-N3/M-N3).
//
// The transport is pluggable so tests can substitute an in-process mock
// node without changing gate code.

export function createHttpTransport(rpcUrl) {
  return async (payload) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`NanUSD RPC HTTP ${res.status}`);
    return res.json();
  };
}

export function createNanusdRpc({ rpcUrl, transport } = {}) {
  const send = transport || createHttpTransport(rpcUrl || "http://127.0.0.1:9999");
  const call = async (action, params = {}) => {
    const out = await send({ action, ...params });
    if (out && out.error) throw new Error(`NanUSD RPC ${action}: ${out.error}`);
    return out;
  };
  return {
    call,
    /** Confirmed + receivable balances for an account, in raw strings. */
    accountBalance: (account) => call("account_balance", { account }),
    /** Recent blocks for an account, newest first (head block in each entry). */
    accountHistory: (account, count = 25) => call("account_history", { account, count: String(count) }),
    /** Receivable (not yet received) source blocks for an account. */
    receivable: (account) => call("receivable", { account }),
    blockInfo: (hash) => call("block_info", { json_block: "true", hash }),
    version: () => call("version"),
  };
}

/**
 * In-process mock NanUSD node for offline proofs. Implements just the RPC
 * actions the gate consumes, backed by a plain ledger of confirmed sends.
 * A "send" here models a payer's state block already confirmed/cemented on
 * the NanUSD chain: { hash, from, to, amountRaw, timestamp }.
 */
export function createMockNanusdNode() {
  const sends = [];
  const received = new Set(); // hashes the merchant account has published receives for
  const outbound = [];        // sends the gate itself broadcast (change/refunds)
  const transport = async (payload) => {
    switch (payload.action) {
      case "version":
        return { node_vendor: "Mock NanUSD node", network: "NanUSD" };
      case "account_balance": {
        let balance = 0n, pending = 0n;
        for (const s of sends) if (s.to === payload.account) {
          if (received.has(s.hash)) balance += BigInt(s.amountRaw); else pending += BigInt(s.amountRaw);
        }
        for (const s of outbound) if (s.from === payload.account) balance -= BigInt(s.amountRaw);
        return { balance: balance.toString(), receivable: pending.toString(), pending: pending.toString() };
      }
      case "account_history": {
        const mine = sends.filter((s) => s.to === payload.account || s.from === payload.account)
          .slice(-Number(payload.count || 25)).reverse();
        return { history: mine.map((s) => ({
          type: s.to === payload.account ? "receive" : "send",
          account: s.to === payload.account ? s.from : s.to,
          amount: s.amountRaw, hash: s.hash, timestamp: String(s.timestamp || 0),
        })) };
      }
      case "receivable": {
        const blocks = {};
        for (const s of sends) if (s.to === payload.account && !received.has(s.hash)) {
          blocks[s.hash] = { amount: s.amountRaw, source: s.from };
        }
        return { blocks };
      }
      default:
        throw new Error(`mock node: unsupported action ${payload.action}`);
    }
  };
  return {
    transport,
    outbound,
    /** Test helper: a payer's confirmed send lands on the chain. */
    injectSend(send) { sends.push({ timestamp: Math.floor(Date.now() / 1000), ...send }); },
    markReceived(hash) { received.add(hash); },
    /** The gate's own broadcasts land here via gate's sendRaw callback. */
    recordOutbound(send) { outbound.push(send); },
  };
}
