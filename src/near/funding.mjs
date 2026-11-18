import { NearError } from "./errors.mjs";
import { assertFreshBlock } from "./freshness.mjs";
import { DEFAULT_FUNCTION_CALL_GAS } from "./tx.mjs";
import { holdsNearQuoteAmount, RETAIN_NEAR_QUOTE_MS } from "./quote-capacity.mjs";

const U128 = (1n << 128n) - 1n;
export const NEAR_OPERATING_RESERVE = 50_000_000_000_000_000_000_000n;
export const FT_REFUND_GAS = DEFAULT_FUNCTION_CALL_GAS;
const bad = () => new NearError("NEAR_FUNDING_INVALID", "NEAR refund funding cannot be verified");
const unavailable = () => new NearError("NEAR_FUNDING_UNAVAILABLE", "NEAR refund funding cannot be verified right now");
function raw(value) {
  if (typeof value !== "string" || !/^\d{1,39}$/.test(value) || BigInt(value) > U128) throw bad();
  return BigInt(value);
}
function integer(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return raw(value);
}
const ceil = (a, b) => (a + b - 1n) / b;
const rows = value => {
  if (!value || typeof value !== "object") throw bad();
  return Array.isArray(value) ? value : Object.values(value);
};

/** One future refund per obligation, including the gap before its outbox entry.
 * Unpaid quotes are counted separately and cannot tie up gas with free requests. */
export function nearRefundClaims({ quotes, refunds }, { now = Date.now(), unpaidRetainMs = RETAIN_NEAR_QUOTE_MS } = {}) {
  let nearYocto = 0n, usdcAtomic = 0n, nativeRefunds = 0, tokenRefunds = 0, pendingNativeRefunds = 0, pendingTokenRefunds = 0;
  const issues = new Set(), paid = new Set(rows(refunds).map(r => r.paymentId).filter(Boolean));
  const add = (asset, value) => {
    const n = raw(value);
    if (asset != null && !["near", "usdc"].includes(asset)) throw bad();
    if (!n) return;
    if (asset === "usdc") { usdcAtomic += n; tokenRefunds++; }
    else { nearYocto += n; nativeRefunds++; }
  };
  for (const r of rows(refunds)) {
    if (!["queued", "signed", "sent", "failed_permanent"].includes(r.status)) throw bad();
    if (r.status !== "sent") add(r.asset, r.amountYocto);
  }
  for (const q of rows(quotes)) {
    if (!["pending", "paid", "running", "settled", "failed", "rejected", "expired"].includes(q.status)) throw bad();
    if (paid.has(q.id)) continue; // outbox is authoritative, even during handoff
    if (["paid", "running"].includes(q.status)) add(q.asset, q.settlement?.refundYocto ?? q.paidYocto);
    else if (q.settlement) {
      add(q.asset, q.settlement.refundYocto);
      if (raw(q.settlement.refundYocto) > 0n) issues.add("near-refund-intent-missing");
    } else if (["failed", "rejected"].includes(q.status) && q.paidYocto != null) {
      add(q.asset, q.paidYocto);
      if (raw(q.paidYocto) > 0n) issues.add("near-refund-intent-missing");
    } else if (["pending", "expired"].includes(q.status)) {
      if (!Number.isSafeInteger(q.expiresAt)) throw bad();
      if (holdsNearQuoteAmount(q, now, unpaidRetainMs)) {
        if (q.asset === "usdc") pendingTokenRefunds++;
        else if (q.asset == null || q.asset === "near") pendingNativeRefunds++;
        else throw bad();
      }
    }
  }
  return { nearYocto, usdcAtomic, nativeRefunds, tokenRefunds, pendingNativeRefunds, pendingTokenRefunds, issues: [...issues] };
}

/** Conservative prepayment, rather than observed net gas after gas refunds.
 * Includes implicit-account creation, FT action/argument fees and the protocol's
 * minimum gas purchase price. A 2x allowance covers movement before signing. */
export function nearRefundCosts(protocol, gasPriceYocto) {
  const runtime = protocol?.runtime_config, tx = runtime?.transaction_costs, actions = tx?.action_creation_config;
  if (!Number.isSafeInteger(protocol?.protocol_version) || protocol.protocol_version < 1) throw bad();
  const gas = integer(gasPriceYocto), floor = protocol.protocol_version >= 85 ? integer(runtime?.min_gas_purchase_price) : gas;
  const price = gas > floor ? gas : floor;
  const storagePriceYocto = integer(runtime?.storage_amount_per_byte);
  if (price <= 0n || storagePriceYocto <= 0n) throw bad();
  const fee = value => {
    const a = integer(value?.send_sir), b = integer(value?.send_not_sir);
    return (a > b ? a : b) + integer(value?.execution);
  };
  const ratio = tx?.pessimistic_gas_price_inflation_ratio;
  if (!Array.isArray(ratio) || ratio.length !== 2) throw bad();
  const num = integer(ratio[0]), den = integer(ratio[1]);
  if (den <= 0n || num < den) throw bad();
  const receipt = fee(tx?.action_receipt_creation_config);
  const nativeGas = receipt + fee(actions?.transfer_cost) + fee(actions?.create_account_cost) + fee(actions?.add_key_cost?.full_access_cost);
  const bytes = Buffer.byteLength("ft_transfer" + JSON.stringify({ receiver_id: "a".repeat(64), amount: U128.toString() }));
  const tokenGas = receipt + fee(actions?.function_call_cost) + fee(actions?.function_call_cost_per_byte) * BigInt(bytes) + FT_REFUND_GAS;
  const padded = value => 2n * ceil(value * price * num, den);
  return { storagePriceYocto, nativeRefundFeeYocto: padded(nativeGas), tokenRefundFeeYocto: padded(tokenGas) + 1n };
}

export function nearFundingNeed({ claims, costs, storageUsage, reserveYocto = NEAR_OPERATING_RESERVE, pending = false, extraAsset = null }) {
  if (!Number.isSafeInteger(storageUsage) || storageUsage < 0 || typeof reserveYocto !== "bigint" || reserveYocto < 0n) throw bad();
  if (![costs.storagePriceYocto, costs.nativeRefundFeeYocto, costs.tokenRefundFeeYocto].every(n => typeof n === "bigint" && n > 0n)) throw bad();
  const native = claims.nativeRefunds + (pending ? claims.pendingNativeRefunds : 0) + (extraAsset === "near" ? 1 : 0);
  const token = claims.tokenRefunds + (pending ? claims.pendingTokenRefunds : 0) + (extraAsset === "usdc" ? 1 : 0);
  if (![native, token].every(n => Number.isSafeInteger(n) && n >= 0)) throw bad();
  return claims.nearYocto + BigInt(storageUsage) * costs.storagePriceYocto + reserveYocto
    + BigInt(native) * costs.nativeRefundFeeYocto + BigInt(token) * costs.tokenRefundFeeYocto;
}

/** All account/key/token views are pinned to the same finalized block. */
export async function readNearFunding({ rpc, network, accountId, publicKey, tokenContract = null, optionalTokenBalance = false, now = Date.now }) {
  const block = await rpc.block({ finality: "final" }), head = block?.header;
  assertFreshBlock(block, { now: now(), maxHeadAgeMs: 90_000, maxClockSkewMs: 30_000 });
  if (typeof head?.hash !== "string" || !Number.isSafeInteger(Number(head.height))) throw bad();
  const query = async params => {
    const value = await rpc.call("query", { ...params, block_id: head.hash });
    if (value.block_hash !== head.hash || Number(value.block_height) !== Number(head.height)) throw bad();
    return value;
  };
  const tokenView = async method => {
    const token = await query({ request_type: "call_function", account_id: tokenContract, method_name: method,
      args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64") });
    if (!Array.isArray(token.result) || token.result.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw bad();
    return JSON.parse(Buffer.from(token.result).toString("utf8"));
  };
  const tokenBalance = tokenContract ? tokenView("ft_balance_of").then(raw) : null;
  // Registration gates new quotes. A verified balance may still cover an
  // existing refund when the separate registration query is unavailable.
  const registration = tokenContract
    ? tokenView("storage_balance_of").then(storage => storage != null && raw(storage.total) > 0n).catch(() => false)
    : false;
  const [account, key, protocol, gas, usdcAtomic, usdcRegistered] = await Promise.all([
    query({ request_type: "view_account", account_id: accountId }),
    query({ request_type: "view_access_key", account_id: accountId, public_key: publicKey }),
    rpc.call("EXPERIMENTAL_protocol_config", { block_id: head.hash }),
    rpc.call("gas_price", [head.hash]),
    optionalTokenBalance ? tokenBalance?.catch(() => null) ?? null : tokenBalance,
    registration,
  ]);
  if (protocol.chain_id !== network || key.permission !== "FullAccess") throw bad();
  if (integer(key.nonce) >= (1n << 64n) - 1n) throw bad();
  return { balanceYocto: raw(account.amount), storageUsage: account.storage_usage, usdcAtomic, usdcRegistered,
    costs: nearRefundCosts(protocol, gas.gas_price), blockHeight: Number(head.height), accessKey: key };
}

/** A native transfer needs spendable principal, storage, and fee prepayment. */
export async function readNearTransferFunding({ amountYocto, ...options }) {
  const frame = await readNearFunding(options);
  const required = nearFundingNeed({ ...frame, reserveYocto: 0n,
    claims: { nearYocto: amountYocto, nativeRefunds: 1, tokenRefunds: 0 } });
  return { accessKey: frame.accessKey, sufficient: frame.balanceYocto >= required };
}

/** Serial admission/quote commit; financial debts remain in the existing ledger.
 * No model work, signing, publication or refund retry is performed here. */
export function createNearFunding({ rpc, ledger, network, accountId, publicKey, usdcToken = null, usdcQuotesEnabled = usdcToken != null,
  now = Date.now, unpaidRetainMs = 3_600_000 }) {
  let latest = { enforced: true, ok: false, checkedAt: null, canQuoteNear: false, canQuoteUsdc: false, code: "NEAR_FUNDING_UNAVAILABLE" };
  let usdcProvenAt = null;
  const queue = []; let draining = false, refreshing = null;
  function serial(execute, priority = 2) {
    if (priority === 3 && queue.filter(t => t.priority === 3).length >= 16) return Promise.reject(new NearError("NEAR_FUNDING_BUSY", "Quote admission is busy"));
    return new Promise((resolve, reject) => {
      const task = { execute, priority, resolve, reject }, at = queue.findIndex(t => t.priority > priority);
      if (at < 0) queue.push(task); else queue.splice(at, 0, task);
      if (!draining) drain();
    });
  }
  async function drain() {
    draining = true;
    while (queue.length) {
      const task = queue.shift();
      try { task.resolve(await task.execute()); } catch (e) { task.reject(e); }
    }
    draining = false;
  }
  const claims = () => nearRefundClaims({ quotes: ledger.quotes(), refunds: ledger.refunds() }, { now: now(), unpaidRetainMs });
  const sufficient = (frame, value, options = {}) => frame.balanceYocto >= nearFundingNeed({ claims: value, costs: frame.costs, storageUsage: frame.storageUsage, ...options })
    && (value.usdcAtomic === 0n || frame.usdcAtomic != null && frame.usdcAtomic >= value.usdcAtomic);
  async function checkpoint(rec, result) {
    if (result?.final_execution_status !== "FINAL") throw bad();
    const tx = result?.transaction, actions = tx?.actions, token = rec.asset === "usdc";
    if (tx?.hash !== rec.txHash || tx?.signer_id !== accountId || tx?.receiver_id !== (token ? usdcToken : rec.to)
        || !Array.isArray(actions) || actions.length !== 1) throw bad();
    if (token) {
      const call = actions[0]?.FunctionCall;
      if (call?.method_name !== "ft_transfer" || String(call.deposit) !== "1" || integer(call.gas) !== FT_REFUND_GAS) throw bad();
      const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
      if (args.receiver_id !== rec.to || args.amount !== rec.amountYocto) throw bad();
    } else if (actions[0]?.Transfer?.deposit !== rec.amountYocto) throw bad();
    if (!Array.isArray(result.receipts_outcome) || !result.receipts_outcome.length) throw bad();
    const hashes = [result.transaction_outcome?.block_hash, ...result.receipts_outcome.map(r => r.block_hash)];
    if (hashes.some(h => typeof h !== "string" || !h)) throw bad();
    let height = ledger.getMeta("refundFinalHeight") ?? 0;
    if (!Number.isSafeInteger(height) || height < 0) throw bad();
    for (const hash of new Set(hashes)) {
      const block = await rpc.block({ blockId: hash });
      const n = Number(block?.header?.height);
      if (block?.header?.hash !== hash || !Number.isSafeInteger(n) || n < 1) throw bad();
      height = Math.max(height, n);
    }
    // Persist before the refunder removes this debt. This also serializes
    // completion against an admission read that was already in progress.
    ledger.setMeta("refundFinalHeight", height);
  }
  async function bootstrap() {
    const version = ledger.getMeta("refundFundingV");
    if (version === 1) return;
    if (version != null) throw bad();
    // Old finalized records have no height checkpoint. Resolve recent ones
    // before their spent principal can be mistaken for cash on a lagging node.
    for (const rec of ledger.refunds()) {
      if (rec.status !== "sent" && !(rec.status === "failed_permanent" && rec.lastError === "TX_FAILED")) continue;
      const at = rec.status === "sent" ? rec.sentAt : rec.finishedAt;
      if (Number.isSafeInteger(at) && now() - at > 300_000) continue;
      const result = await rpc.txStatus({ txHash: rec.txHash, senderId: accountId, waitUntil: "FINAL" });
      if (result.final_execution_status !== "FINAL") throw bad();
      await checkpoint(rec, result);
    }
    ledger.setMeta("refundFundingV", 1);
  }
  async function inspect(asset, { refreshUsdc = false } = {}) {
    let frame, value, checkedToken = false;
    try {
      if (!["near", "usdc"].includes(asset) || asset === "usdc" && !usdcToken) throw bad();
      await bootstrap();
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = claims();
        checkedToken = asset === "usdc" || before.usdcAtomic > 0n || refreshUsdc;
        frame = await readNearFunding({ rpc, network, accountId, publicKey, now,
          tokenContract: checkedToken ? usdcToken : null, optionalTokenBalance: true });
        if (integer(ledger.getMeta("lastNonce") ?? "0") >= (1n << 64n) - 1n) throw bad();
        const floor = ledger.getMeta("refundFinalHeight") ?? 0;
        if (!Number.isSafeInteger(floor) || floor < 0) throw bad();
        value = claims(); // include deposits discovered during RPC awaits
        if (frame.blockHeight < floor || value.usdcAtomic > 0n && frame.usdcAtomic == null) {
          if (attempt < 2) continue;
          throw bad();
        }
        if (!sufficient(frame, value) && attempt < 2) {
          const head = await rpc.block({ finality: "final" });
          if (Number(head.header.height) > frame.blockHeight) continue;
        }
        break;
      }
      latest = { enforced: true, checkedAt: now(), ok: sufficient(frame, value),
        canQuoteNear: sufficient(frame, value, { extraAsset: "near" }),
        canQuoteUsdc: usdcQuotesEnabled && sufficient(frame, value, { extraAsset: "usdc" }) };
      if (checkedToken) usdcProvenAt = frame.usdcAtomic != null && frame.usdcRegistered ? latest.checkedAt : null;
      if (!latest.ok) latest.code = "NEAR_FUNDING_INSUFFICIENT";
    } catch {
      if (checkedToken) usdcProvenAt = null;
      latest = { enforced: true, checkedAt: now(), ok: false, canQuoteNear: false, canQuoteUsdc: false, code: "NEAR_FUNDING_UNAVAILABLE" };
      throw unavailable();
    }
    if (asset === "usdc" && frame.usdcAtomic == null) throw unavailable();
    return { frame, value };
  }
  function assert(frame, value, options) {
    if (!sufficient(frame, value, options)) throw new NearError("NEAR_FUNDING_INSUFFICIENT", "NEAR funds are reserved for storage and customer refunds");
  }
  function status() {
    const at = now(), fresh = stamp => stamp != null && at >= stamp && at - stamp <= 60_000;
    if (!fresh(latest.checkedAt)) {
      return { ...latest, ok: false, canQuoteNear: false, canQuoteUsdc: false, code: "NEAR_FUNDING_STALE" };
    }
    if (latest.ok && usdcQuotesEnabled && !fresh(usdcProvenAt)) {
      return { ...latest, canQuoteUsdc: false, usdcCode: "USDC_FUNDING_UNAVAILABLE" };
    }
    return { ...latest };
  }
  return {
    quote: (asset, commit, prepare = () => {}) => serial(async () => {
      // Recheck caller-owned rates/watcher readiness after queueing, then make
      // the final financial read before the synchronous quote commit.
      if (asset === "usdc" && !usdcQuotesEnabled) throw unavailable();
      await prepare();
      const { frame, value } = await inspect(asset);
      if (asset === "usdc" && !frame.usdcRegistered) throw unavailable();
      assert(frame, value, { extraAsset: asset });
      return commit();
    }, 3),
    run: asset => serial(async () => { const { frame, value } = await inspect(asset); assert(frame, value); }, 1),
    beforeSign: rec => serial(async () => {
      const { frame, value } = await inspect(rec.asset || "near");
      const held = ledger.getRefund(rec.id);
      if (!held || !["queued", "signed"].includes(held.status)
          || ["paymentId", "to", "asset", "amountYocto", "tokenContract"].some(k => held[k] !== rec[k])) throw bad();
      // Actual refunds take priority over unpaid quotes and the operating float.
      assert(frame, value, { pending: false, reserveYocto: 0n });
      return { accessKey: frame.accessKey }; // sign immediately from this same verified frame
    }, 0),
    beforeComplete: (rec, result) => serial(() => checkpoint(rec, result), 0),
    refresh: () => refreshing ||= serial(async () => {
      try { await inspect("near", { refreshUsdc: usdcQuotesEnabled }); } catch {}
      return status();
    }).finally(() => { refreshing = null; }),
    status,
  };
}
