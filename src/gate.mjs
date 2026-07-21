/**
 * x402 charge gate — sell tool calls for Nano (XNO), no accounts anywhere.
 *
 * Flow (mirrors NanoGPT's own x402 shape, adapted to MCP's in-band tool results):
 *   1. tools/call without `_payment_id` → a payment-required result: price, a
 *      pay-page link (QR), the exact raw amount, and agent-directed instructions.
 *   2. The caller pays the EXACT amount to the gate's wallet address. Nano has
 *      no payment memo, so each quote's amount carries a random sub-cent "dust
 *      tag" that makes it unique among live quotes — the amount IS the memo.
 *   3. tools/call again with `_payment_id` → the gate long-polls its watcher
 *      (RPC polling, plus node websocket push when configured), then runs the
 *      tool exactly once. Re-calls replay the cached result; run failures are
 *      refunded to the payer's account automatically.
 *
 * Detection watches `receivable` on the gate address and, as a race-cover,
 * `account_history` — a concurrently running wallet may pocket the customer's
 * send between polls, at which point it only shows up as a received entry.
 * Payments that arrive after their quote expired are refunded automatically.
 */
import { randomBytes, createHash } from "node:crypto";
import { checkAddress } from "nanocurrency";
import { rawToXno } from "./wallet.mjs";

const QUOTE_TTL_MS = 15 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000; // keep dead quotes around to auto-refund late payments
const HISTORY_EVERY = 5; // check account_history every Nth poll tick
/** Share of each successful paid call forwarded, uncut, to the graph's x402.author address. */
const AUTHOR_SHARE_PCT = 20n;

/** Deterministic hash of (tool, arguments) — a payment id is bound to exactly this call. */
export function hashArgs(name, args) {
  const stable = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  };
  return createHash("sha256").update(name + "\n" + stable(args)).digest("hex").slice(0, 16);
}

const fmtUsd = (n) => "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2)).replace(/(\.\d\d\d*?)0+$/, "$1");

/**
 * @param {object} opts
 * @param {string} opts.address           Nano address payments arrive at (the wallet account)
 * @param {object} opts.ops               wallet ops ({ rpc, transfer, pocket }) — refunds + chain RPC
 * @param {number} opts.usd               default price per call
 * @param {(params) => Promise<void>} [opts.validate]  registry arg validation — quotes are only
 *                                        issued for calls that would actually run (never charge for a typo)
 * @param {number|null} [opts.xnoUsd]     static XNO/USD rate; null → live CoinGecko, 60s cache
 * @param {string|null} [opts.wsUrl]      Nano node websocket (wss://…) for push confirmations
 * @param {string} opts.publicBase        absolute base URL for pay links (no trailing slash)
 * @param {number} [opts.pollMs]          receivable poll interval while quotes are pending
 * @param {number} [opts.waitMs]          how long a _payment_id call blocks waiting for settlement
 * @param {(event: string, fields: object) => void} [opts.usage]  usage-log sink
 */
export function createChargeGate({
  address,
  ops,
  usd,
  validate = null,
  xnoUsd = null,
  wsUrl = null,
  publicBase,
  pollMs = 1000,
  waitMs = 75_000,
  fetch = globalThis.fetch,
  log = () => {},
  usage = () => {},
  now = () => Date.now(),
}) {
  if (!address || !ops) throw new Error("charge gate needs a funded Nano wallet (address + ops)");
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("charge gate needs a positive default price");

  /** @type {Map<string, object>} paymentId → quote */
  const quotes = new Map();

  /* ---------------- pricing ---------------- */

  let rate = Number.isFinite(xnoUsd) && xnoUsd > 0 ? { usdPerXno: xnoUsd, at: Infinity } : null;
  async function usdPerXno() {
    if (rate && (rate.at === Infinity || now() - rate.at < 60_000)) return rate.usdPerXno;
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=nano&vs_currencies=usd");
      const j = await r.json();
      const v = j && j.nano && Number(j.nano.usd);
      if (!Number.isFinite(v) || v <= 0) throw new Error("no usable price in response");
      rate = { usdPerXno: v, at: now() };
      return v;
    } catch (e) {
      if (rate) {
        log(`XNO/USD refresh failed (${e.message}) — using cached rate $${rate.usdPerXno}`);
        return rate.usdPerXno;
      }
      throw new Error("cannot price this call: XNO/USD rate unavailable " +
        "(CoinGecko unreachable and no --xno-usd override): " + e.message);
    }
  }

  /** Price → raw amount with a dust tag unique among live quotes (the amount is the memo). */
  function tagAmount(usdPrice, usdRate) {
    // 8 decimal places of XNO precision for the price itself…
    const base = BigInt(Math.max(1, Math.round((usdPrice / usdRate) * 1e8))) * 10n ** 22n;
    for (;;) {
      // …plus < 10^-10 XNO of random dust: invisible in any display, unmistakable on-chain
      const dust = BigInt("0x" + randomBytes(8).toString("hex")) % 10n ** 20n;
      const amountRaw = (base + dust).toString();
      let clash = false;
      for (const q of quotes.values()) if (q.status === "pending" && q.amountRaw === amountRaw) { clash = true; break; }
      if (!clash) return amountRaw;
    }
  }

  /* ---------------- quote lifecycle ---------------- */

  function resolveWaiters(q) {
    for (const w of q.waiters.splice(0)) w();
  }

  async function markPaid(q, { source, hash, via }) {
    q.status = "paid";
    q.paidAt = now();
    q.source = source || null;
    q.payHash = hash || null;
    log(`payment ${q.id}: ${rawToXno(q.amountRaw)} XNO received via ${via}` +
      (source ? ` from ${source}` : "") + ` (${q.tool})`);
    usage("paid", { paymentId: q.id, tool: q.tool, amountRaw: q.amountRaw, usd: q.usd, source: q.source, via, settleMs: q.paidAt - q.createdAt });
    resolveWaiters(q);
  }

  async function refund(q, reason) {
    if (q.refunding) return q.refunding;
    if (!q.source) {
      log(`cannot refund ${q.id}: payer account unknown — ${rawToXno(q.amountRaw)} XNO stays in the wallet`);
      usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: "payer account unknown", reason });
      return false;
    }
    q.refunding = (async () => {
      try {
        const hash = await ops.transfer(q.source, q.amountRaw, "refunded");
        q.status = "refunded";
        usage("refund", { paymentId: q.id, tool: q.tool, ok: true, amountRaw: q.amountRaw, to: q.source, hash, reason });
        return true;
      } catch (e) {
        log(`refund of ${q.id} to ${q.source} failed: ${e.message}`);
        usage("refund", { paymentId: q.id, tool: q.tool, ok: false, error: e.message, reason });
        return false;
      }
    })();
    return q.refunding;
  }

  function prune() {
    const t = now();
    for (const q of quotes.values()) {
      if (q.status === "pending" && t > q.expiresAt) {
        q.status = "expired";
        resolveWaiters(q);
      }
      if (t - q.createdAt > RETAIN_MS) quotes.delete(q.id);
    }
  }

  /** An incoming amount either settles a pending quote or, on a dead quote, bounces back. */
  function matchAmount(amountRaw, meta) {
    const amt = String(amountRaw);
    if (!/^\d+$/.test(amt)) return;
    for (const q of quotes.values()) {
      if (q.amountRaw !== amt) continue;
      if (q.status === "pending") return void markPaid(q, meta);
      if (q.status === "expired" && !q.refunding) {
        log(`late payment for expired quote ${q.id} — refunding`);
        q.source = q.source || meta.source || null;
        return void refund(q, "quote expired before payment arrived");
      }
      return; // paid/consumed already — a re-scan of the same block, not a new payment
    }
  }

  /* ---------------- payment watcher: RPC polling + optional websocket ---------------- */

  let timer = null;
  let tickCount = 0;
  let wsConnected = false;

  const anyPending = () => [...quotes.values()].some((q) => q.status === "pending");
  // Recently expired quotes stay watched so a payment that arrives too late is
  // noticed and bounced straight back instead of silently kept.
  const LATE_WATCH_MS = 60 * 60 * 1000;
  const anyWatchable = () => {
    const t = now();
    return [...quotes.values()].some((q) =>
      q.status === "pending" || (q.status === "expired" && t - q.expiresAt < LATE_WATCH_MS));
  };

  async function scan() {
    prune();
    if (!anyWatchable()) return;
    tickCount++;
    const r = await ops.rpc({ action: "receivable", account: address, count: "50", threshold: "1", source: "true" });
    const blocks = r && r.blocks && typeof r.blocks === "object" ? Object.entries(r.blocks) : [];
    for (const [hash, v] of blocks) {
      const amount = typeof v === "object" && v !== null ? v.amount : v; // nodes return "raw" or {amount, source}
      const source = typeof v === "object" && v !== null ? v.source : null;
      matchAmount(amount, { source, hash, via: "receivable poll" });
    }
    // Race cover: a concurrently running wallet may have pocketed the customer's send
    // between polls — then it only exists as a received history entry.
    if (tickCount % HISTORY_EVERY === 0 && anyWatchable()) {
      const h = await ops.rpc({ action: "account_history", account: address, count: "25" });
      for (const entry of Array.isArray(h && h.history) ? h.history : []) {
        if (entry && entry.type === "receive") {
          matchAmount(entry.amount, { source: entry.account, hash: entry.hash, via: "history poll" });
        }
      }
    }
  }

  function tick() {
    timer = null;
    scan().catch((e) => log(`payment scan failed (${e.message}) — will retry`)).then(() => {
      if (!anyWatchable()) return;
      // With a live websocket the poll is only a safety net — relax it.
      timer = setTimeout(tick, wsConnected ? Math.max(pollMs, 5000) : pollMs);
      if (timer.unref) timer.unref();
    });
  }

  function ensureWatching() {
    connectWs();
    if (!timer) tick();
  }

  let ws = null;
  let wsEverFailed = false;
  function connectWs() {
    if (!wsUrl || ws) return;
    if (typeof WebSocket === "undefined") {
      if (!wsEverFailed) { wsEverFailed = true; log("--nano-ws ignored: no global WebSocket (needs Node ≥ 21)"); }
      return;
    }
    try { ws = new WebSocket(wsUrl); } catch (e) { log(`websocket ${wsUrl} failed to open: ${e.message}`); return; }
    ws.onopen = () => {
      wsConnected = true;
      log(`websocket connected: ${wsUrl} — payment detection is push-based`);
      ws.send(JSON.stringify({ action: "subscribe", topic: "confirmation", options: { accounts: [address] } }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.topic === "confirmation" && m.message) {
        const blk = m.message.block || {};
        if (blk.subtype === "send" && blk.link_as_account === address) {
          matchAmount(m.message.amount, { source: blk.account, hash: m.message.hash, via: "websocket" });
        }
      }
    };
    ws.onclose = ws.onerror = () => {
      if (wsConnected) log(`websocket ${wsUrl} disconnected — falling back to polling`);
      wsConnected = false;
      ws = null;
      // reconnect lazily next time something needs watching
      if (anyPending()) setTimeout(connectWs, 10_000).unref?.();
    };
  }

  /* ---------------- MCP-facing results ---------------- */

  const payUrl = (q) => `${publicBase}/pay/${q.id}`;
  const nanoUri = (q) => `nano:${address}?amount=${q.amountRaw}`;

  function paymentRequiredResult(q) {
    const x402 = {
      paymentId: q.id,
      payUrl: payUrl(q),
      uri: nanoUri(q),
      address,
      amountRaw: q.amountRaw,
      amountXno: rawToXno(q.amountRaw),
      amountUsd: q.usd,
      expiresAt: new Date(q.expiresAt).toISOString(),
    };
    const text =
      `PAYMENT REQUIRED — this tool costs ${fmtUsd(q.usd)} (≈${rawToXno(q.amountRaw)} XNO), paid per call in Nano. No account needed.\n\n` +
      `To proceed:\n` +
      `1. Show your user this payment link (it renders a QR code to scan with any Nano wallet, and turns into a green check the moment the payment lands):\n` +
      `   ${payUrl(q)}\n` +
      `2. Once they say they've paid (settlement takes about a second), call this tool again with the SAME arguments plus "_payment_id": "${q.id}".\n\n` +
      `Paying without the page: send EXACTLY ${q.amountRaw} raw to ${address} (URI: ${nanoUri(q)}).\n` +
      `This quote expires ${x402.expiresAt}. If the run fails after payment, the payment is refunded automatically.`;
    return { content: [{ type: "text", text }], structuredContent: { x402 } };
  }

  const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

  /* ---------------- public surface ---------------- */

  const gate = {
    address,

    /** Quote/pay state for the HTTP pay page + status endpoint. */
    quote(id) {
      const q = quotes.get(String(id));
      if (!q) return null;
      prune();
      return {
        id: q.id, tool: q.tool, status: q.status, usd: q.usd,
        amountRaw: q.amountRaw, amountXno: rawToXno(q.amountRaw),
        address, uri: nanoUri(q), expiresAt: new Date(q.expiresAt).toISOString(),
      };
    },

    /** Resolve when the quote leaves `pending` (paid/expired), or after ms. Returns the status. */
    waitForPayment(id, ms) {
      const q = quotes.get(String(id));
      if (!q) return Promise.resolve("unknown");
      if (q.status !== "pending") return Promise.resolve(q.status);
      ensureWatching();
      return new Promise((res) => {
        const t = setTimeout(() => res(q.status), ms);
        if (t.unref) t.unref();
        q.waiters.push(() => { clearTimeout(t); res(q.status); });
      });
    },

    /**
     * Decorate a tool registry: descriptions gain prices, schemas gain _payment_id,
     * run_noodle is withdrawn (arbitrary share links can't be priced up front),
     * and callTool enforces quote → pay → run-once → replay.
     */
    wrapRegistry(registry, { runNoodleName = "run_noodle" } = {}) {
      const priceFor = (tool) => {
        const v = tool.x402 && Number(tool.x402.usd);
        return Number.isFinite(v) && v > 0 ? v : usd;
      };
      const prices = new Map(registry.tools.map((t) => [t.name, priceFor(t)]));
      // Hand-added `"x402": {"author": "nano_…"}` on a graph routes 20% of every
      // successful call to its author, uncut. No field → the gate wallet keeps it.
      const authorFor = (tool) => {
        const a = tool.x402 && typeof tool.x402.author === "string" ? tool.x402.author.trim() : "";
        if (!a) return null;
        if (!checkAddress(a)) { log(`ignoring x402.author on ${tool.name}: not a valid Nano address`); return null; }
        return a;
      };
      const authors = new Map(registry.tools.map((t) => [t.name, authorFor(t)]));

      /** Forward the author's share of a settled payment; queued, never blocks the caller's result. */
      function payAuthor(q, name) {
        const author = authors.get(name);
        if (!author) return;
        const share = (BigInt(q.amountRaw) * AUTHOR_SHARE_PCT) / 100n;
        if (share <= 0n) return;
        ops.transfer(author, share.toString(), "author payout:")
          .then((hash) => usage("author_payout", { paymentId: q.id, tool: name, ok: true, to: author, amountRaw: share.toString(), hash }))
          .catch((e) => {
            log(`author payout for ${q.id} (${name} → ${author}) failed: ${e.message}`);
            usage("author_payout", { paymentId: q.id, tool: name, ok: false, to: author, amountRaw: share.toString(), error: e.message });
          });
      }

      const listTools = () =>
        registry.listTools()
          .filter((t) => t.name !== runNoodleName)
          .map((t) => {
            const price = prices.get(t.name) ?? usd;
            const description = t.description.replace(
              /every call spends real credit from [^;.]+/,
              `${fmtUsd(price)} per call, paid in Nano (XNO) at call time — no account needed`) +
              (authors.get(t.name) ? " The graph's author earns 20% of every call." : "");
            const inputSchema = {
              ...t.inputSchema,
              properties: {
                ...(t.inputSchema.properties || {}),
                _payment_id: {
                  type: "string",
                  description: "Payment id from this tool's previous payment-required response. " +
                    "First call the tool without it to get a payment link; after the user pays, " +
                    "call again with the same arguments plus this id.",
                },
              },
            };
            return { ...t, description, inputSchema };
          });

      async function callTool(params) {
        // Malformed shells fall through to the registry for its usual ParamsError texts.
        if (params == null || typeof params !== "object" || Array.isArray(params)) return registry.callTool(params);
        if (params.name === runNoodleName) {
          return errResult("run_noodle is not available on this paid server — arbitrary share links can't be " +
            "priced up front. Use the listed tools, or run your own nanoodle-mcp (npx nanoodle-mcp) to run any link.");
        }
        const rawArgs = params.arguments == null ? {} : params.arguments;
        if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return registry.callTool(params);
        const { _payment_id, ...args } = rawArgs;
        const name = params.name;
        const argsHash = hashArgs(name, args);
        const price = prices.get(name);

        if (_payment_id == null) {
          // Never charge for a call that couldn't run: unknown tool / bad args throw here, pre-quote.
          if (validate) await validate({ name, arguments: args });
          const usdRate = await usdPerXno();
          const q = {
            id: "pay_" + randomBytes(9).toString("base64url"),
            tool: name, argsHash, usd: price ?? usd,
            amountRaw: tagAmount(price ?? usd, usdRate),
            createdAt: now(), expiresAt: now() + QUOTE_TTL_MS,
            status: "pending", waiters: [],
          };
          quotes.set(q.id, q);
          ensureWatching();
          usage("quote", { paymentId: q.id, tool: name, usd: q.usd, amountRaw: q.amountRaw });
          return paymentRequiredResult(q);
        }

        const q = quotes.get(String(_payment_id));
        if (!q) {
          return errResult(`unknown or expired payment id "${_payment_id}" — call the tool again without _payment_id for a fresh quote.`);
        }
        if (q.tool !== name || q.argsHash !== argsHash) {
          return errResult(`payment ${q.id} was issued for a different call (tool/arguments changed) — ` +
            `call again without _payment_id to get a quote for these arguments.`);
        }
        if (q.status === "refunded") {
          return errResult(`payment ${q.id} was refunded${q.source ? ` to ${q.source}` : ""} — call again without _payment_id to retry.`);
        }
        if (q.status === "expired") {
          return errResult(`payment ${q.id} expired unpaid — call again without _payment_id for a fresh quote.`);
        }
        if (q.status === "pending") {
          const st = await gate.waitForPayment(q.id, waitMs);
          if (st === "pending") {
            return errResult(`payment ${q.id} hasn't arrived yet. If your user has the page open at ${payUrl(q)} ` +
              `it will show a green check when it lands — then call this tool again with the same _payment_id.`);
          }
          if (st === "expired") {
            return errResult(`payment ${q.id} expired unpaid — call again without _payment_id for a fresh quote.`);
          }
        }
        // paid (or consumed): run exactly once, replay the cached outcome afterwards
        if (!q.running) {
          q.status = "consumed";
          const t0 = now();
          q.running = (async () => {
            try {
              const result = await registry.callTool({ name, arguments: args });
              const receipt = `paid ${rawToXno(q.amountRaw)} XNO (${fmtUsd(q.usd)})` +
                (q.payHash ? ` — block ${q.payHash}` : "") +
                (authors.get(name) ? " — 20% goes to this noodle's author" : "");
              q.result = { ...result, content: [...result.content, { type: "text", text: receipt }] };
              usage("run", { paymentId: q.id, tool: name, ok: true, ms: now() - t0, usd: q.usd, paid: true });
              payAuthor(q, name);
            } catch (e) {
              const msg = String((e && e.message) || e);
              usage("run", { paymentId: q.id, tool: name, ok: false, ms: now() - t0, usd: q.usd, paid: true, error: msg });
              const refunded = await refund(q, `run failed: ${msg}`);
              q.error = `run failed: ${msg}` + (refunded
                ? ` — your payment of ${rawToXno(q.amountRaw)} XNO was refunded to ${q.source}.`
                : " — the run was paid for; contact the operator about a refund.");
            }
          })();
        }
        await q.running;
        return q.error ? errResult(q.error) : q.result;
      }

      return { listTools, callTool };
    },
  };
  return gate;
}
