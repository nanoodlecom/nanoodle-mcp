/**
 * A tiny in-memory NEAR chain that speaks the JSON-RPC methods nanoodle-mcp
 * uses, in the wire shapes public testnet RPC returns (checked against
 * test.rpc.fastnear.com): `status`, `block`, `tx`, `query` (view_access_key,
 * view_account) and `send_tx`.
 *
 * - `transfer(from, to, yocto, opts)` stands in for a wallet: it records a FINAL
 *   transfer and returns its base58 hash. `opts.blockTimeMs` stamps the block
 *   (to simulate late or old payments); `opts.actions` overrides the actions.
 * - `send_tx` decodes the Borsh SignedTransaction, checks the ed25519 signature
 *   over sha256(transaction) against the access key and the nonce, then
 *   applies it. A repeated broadcast of the same bytes returns the same outcome.
 * - Every transaction burns GAS_YOCTO from its signer, so balances reconcile
 *   the way they do on chain ("deposit − refund = charged, gas aside").
 *
 * Use `chain.fetch` as an injected fetch, or `await chain.listen()` for an
 * HTTP endpoint a child process can reach. No network, no real keys.
 */
import http from "node:http";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { base58Encode, base58Decode } from "../../src/near/base58.mjs";

export const GAS_YOCTO = 44_627_500_000_000_000_000n; // ~0.0000446 NEAR, a plain transfer's burn
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const rid = () => base58Encode(randomBytes(32));

function readBorshTransfer(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(); const s = buf.subarray(o, o + n).toString("utf8"); o += n; return s; };
  const u128 = () => { const n = buf.readBigUInt64LE(o) + (buf.readBigUInt64LE(o + 8) << 64n); o += 16; return n; };
  const bytes = (n) => { const b = buf.subarray(o, o + n); o += n; return b; };
  const signerId = str();
  const keyType = buf[o++];
  const publicKey = bytes(32);
  const nonce = buf.readBigUInt64LE(o); o += 8;
  const receiverId = str();
  const blockHash = bytes(32);
  const nActions = u32();
  const actions = [];
  for (let i = 0; i < nActions; i++) {
    const tag = buf[o++];
    if (tag === 3) actions.push({ Transfer: { deposit: u128().toString() } });
    else if (tag === 2) {
      const method_name = str(), args = Buffer.from(bytes(u32())).toString("base64");
      const gas = buf.readBigUInt64LE(o); o += 8;
      actions.push({ FunctionCall: { method_name, args, gas: Number(gas), deposit: u128().toString() } });
    } else throw new Error(`fake chain: unsupported action ${tag}`);
  }
  const txEnd = o;
  const sigType = buf[o++];
  const signature = bytes(64);
  if (o !== buf.length || keyType !== 0 || sigType !== 0) throw new Error("fake chain: malformed SignedTransaction");
  return { signerId, publicKey, nonce, receiverId, blockHash, actions, signature, txBytes: buf.subarray(0, txEnd) };
}

export function createFakeChain({ chainId = "testnet", now = Date.now } = {}) {
  const accounts = new Map(); // id -> { balance: bigint, keys: Map<publicKey, { nonce: bigint }> }
  const blocks = new Map();   // hash -> block
  const txs = new Map();      // hash -> FINAL tx result
  const tokens = new Map();
  let height = 230_000_000;
  const log = [];             // every RPC call: { method, params }
  const chain = {
    chainId,
    accounts,
    txs,
    log,
    /** send_tx answers HTTP 503 this many more times (an RPC outage). */
    failSendTx: 0,
    /** tx lookups answer "unknown" this many more times (not final yet). */
    hideTx: 0,
    sendTxCount: 0,
  };

  let lastBlockHash = rid();
  function newBlock(timeMs) {
    const hash = rid();
    const ns = BigInt(Math.round(timeMs)) * 1_000_000n;
    const block = {
      author: "node0.testnet",
      header: {
        height: ++height,
        hash,
        prev_hash: lastBlockHash,
        timestamp: Number(ns), // the RPC sends this as an unsafe JSON number; clients must use timestamp_nanosec
        timestamp_nanosec: ns.toString(),
        chunks_included: 1,
      },
      chunks: [],
    };
    blocks.set(hash, block);
    blocks.set(block.header.height, block);
    lastBlockHash = hash;
    return block;
  }
  let head = newBlock(now());

  chain.addAccount = (id, balanceYocto = 0n, publicKey = null, nonce = 275_735_371_000_000n) => {
    const a = { balance: BigInt(balanceYocto), keys: new Map() };
    if (publicKey) a.keys.set(publicKey, { nonce: BigInt(nonce) });
    accounts.set(id, a);
    return a;
  };
  chain.balance = (id) => (accounts.get(id) ? accounts.get(id).balance : 0n);
  chain.addFt = (contract, balances) => {
    if (!accounts.has(contract)) chain.addAccount(contract);
    tokens.set(contract, new Map(Object.entries(balances).map(([id, amount]) => [id, BigInt(amount)])));
  };
  chain.ftBalance = (contract, id) => tokens.get(contract)?.get(id) ?? 0n;
  const ftLog = (from, to, amount) => 'EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
    data: [{ old_owner_id: from, new_owner_id: to, amount: String(amount) }] });
  function moveFt(contract, from, to, amount) {
    const balances = tokens.get(contract), n = BigInt(amount);
    if (!balances?.has(to) || (balances.get(from) ?? 0n) < n) throw new Error("fake chain: FT balance/storage");
    balances.set(from, balances.get(from) - n); balances.set(to, balances.get(to) + n);
    return ftLog(from, to, amount);
  }

  function record({ hash, signerId, publicKey, nonce, receiverId, actions, signature, blockTimeMs, success = true, logs = [] }) {
    const block = newBlock(blockTimeMs ?? now());
    head = block;
    const receiptId = rid();
    const meta = { version: 1, gas_profile: null };
    const result = {
      final_execution_status: "FINAL",
      status: success ? { SuccessValue: "" } : { Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { account_id: receiverId } } } } },
      transaction: {
        signer_id: signerId, public_key: publicKey, nonce: Number(nonce), receiver_id: receiverId,
        actions, signature, hash, priority_fee: 0,
      },
      transaction_outcome: {
        id: hash,
        outcome: {
          logs: [], receipt_ids: [receiptId], gas_burnt: 223_182_562_500, tokens_burnt: GAS_YOCTO.toString(),
          executor_id: signerId, status: { SuccessReceiptId: receiptId }, metadata: meta,
        },
        block_hash: block.header.hash,
        proof: [{ hash: rid(), direction: "Right" }],
      },
      receipts_outcome: [{
        id: receiptId,
        outcome: {
          logs, receipt_ids: [], gas_burnt: 223_182_562_500, tokens_burnt: "0",
          executor_id: receiverId, status: success ? { SuccessValue: "" } : { Failure: {} }, metadata: meta,
        },
        block_hash: block.header.hash,
        proof: [{ hash: rid(), direction: "Left" }],
      }],
    };
    txs.set(hash, result);
    return result;
  }

  function move(from, to, yocto) {
    const a = accounts.get(from);
    if (!a) throw new Error(`fake chain: no account ${from}`);
    const amt = BigInt(yocto);
    if (a.balance < amt + GAS_YOCTO) throw new Error(`fake chain: ${from} cannot afford ${amt}`);
    a.balance -= amt + GAS_YOCTO;
    if (!accounts.has(to)) chain.addAccount(to);
    accounts.get(to).balance += amt;
  }

  /** A wallet-side transfer: records a FINAL tx and returns its hash. */
  chain.transfer = (from, to, yocto, { blockTimeMs, actions } = {}) => {
    const acts = actions || [{ Transfer: { deposit: BigInt(yocto).toString() } }];
    const total = acts.reduce((s, x) => s + BigInt((x.Transfer && x.Transfer.deposit) || 0), 0n);
    move(from, to, total);
    const hash = rid();
    record({ hash, signerId: from, publicKey: "ed25519:" + rid(), nonce: 1n, receiverId: to, actions: acts, signature: "ed25519:" + rid(), blockTimeMs });
    return hash;
  };
  chain.ftTransfer = (contract, from, to, amount, { blockTimeMs } = {}) => {
    const event = moveFt(contract, from, to, amount);
    move(from, contract, 1n);
    const hash = rid();
    record({ hash, signerId: from, publicKey: "ed25519:" + rid(), nonce: 1n, receiverId: contract, signature: "ed25519:" + rid(), blockTimeMs,
      actions: [{ FunctionCall: { method_name: "ft_transfer", args: Buffer.from(JSON.stringify({ receiver_id: to, amount: String(amount) })).toString("base64"), gas: 30000000000000, deposit: "1" } }], logs: [event] });
    return hash;
  };

  const rpcError = (id, cause, data, httpStatus = 200) => ({
    httpStatus,
    body: { jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000, message: "Server error", data } },
  });
  const ok = (id, result) => ({ httpStatus: 200, body: { jsonrpc: "2.0", id, result } });

  /** One JSON-RPC request object → { httpStatus, body }. */
  chain.handle = (req) => {
    const { id, method, params } = req || {};
    log.push({ method, params });
    if (method === "status") {
      return ok(id, { chain_id: chainId, sync_info: { latest_block_hash: head.header.hash, latest_block_height: head.header.height, syncing: false }, version: { version: "fake" } });
    }
    if (method === "block") {
      if (params && params.finality) return ok(id, head);
      const b = blocks.get(params && params.block_id);
      return b ? ok(id, b) : rpcError(id, "UNKNOWN_BLOCK", "DB Not Found Error: BLOCK HEIGHT");
    }
    if (method === "tx") {
      // Like public testnet RPC (checked on rpc.testnet.near.org and rpc.testnet.fastnear.com,
      // 2026-11), the lookup finds the transaction even when sender_account_id is wrong.
      const r = txs.get(params && params.tx_hash);
      if (!r || chain.hideTx > 0) {
        if (r) chain.hideTx--;
        return rpcError(id, "UNKNOWN_TRANSACTION", `Transaction ${params && params.tx_hash} doesn't exist`);
      }
      return ok(id, r);
    }
    if (method === "EXPERIMENTAL_changes") {
      const block = blocks.get(params.block_id);
      if (!block) return rpcError(id, "UNKNOWN_BLOCK", "unknown block");
      const changes = [...txs.values()].filter((tx) => tx.transaction_outcome.block_hash === block.header.hash
        && params.account_ids.includes(tx.transaction.receiver_id)).map((tx) => ({
        cause: { type: "receipt_processing", receipt_hash: tx.receipts_outcome[0].id },
        type: "account_update", change: { account_id: tx.transaction.receiver_id },
      }));
      return ok(id, { block_hash: block.header.hash, changes });
    }
    if (method === "EXPERIMENTAL_receipt_to_tx") {
      const tx = [...txs.values()].find((tx) => tx.receipts_outcome.some((r) => r.id === params.receipt_id));
      return tx ? ok(id, { transaction_hash: tx.transaction.hash, sender_account_id: tx.transaction.signer_id })
        : rpcError(id, "UNKNOWN_RECEIPT", "unknown receipt");
    }
    if (method === "query") {
      const acct = accounts.get(params.account_id);
      if (params.request_type === "call_function") {
        const balances = tokens.get(params.account_id);
        if (!balances) return rpcError(id, "UNKNOWN_ACCOUNT", "unknown token");
        const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
        let value;
        if (params.method_name === "ft_metadata") value = { spec: "ft-1.0.0", symbol: "USDC", decimals: 6 };
        else if (params.method_name === "ft_balance_of") value = String(balances.get(args.account_id) ?? 0n);
        else if (params.method_name === "storage_balance_of") value = balances.has(args.account_id) ? { total: "1250000000000000000000", available: "0" } : null;
        else return rpcError(id, "UNSUPPORTED", "unknown FT view");
        return ok(id, { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_hash: head.header.hash, block_height: head.header.height });
      }
      if (params.request_type === "view_account") {
        if (!acct) return rpcError(id, "UNKNOWN_ACCOUNT", `account ${params.account_id} does not exist while viewing`);
        return ok(id, { amount: acct.balance.toString(), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: head.header.height, block_hash: head.header.hash });
      }
      if (params.request_type === "view_access_key") {
        const k = acct && acct.keys.get(params.public_key);
        if (!k) {
          return ok(id, { error: `access key ${params.public_key} does not exist while viewing`, logs: [], block_height: head.header.height, block_hash: head.header.hash });
        }
        return ok(id, { nonce: Number(k.nonce), permission: "FullAccess", block_height: head.header.height, block_hash: head.header.hash });
      }
      return rpcError(id, "UNSUPPORTED", "fake chain: unsupported query");
    }
    if (method === "send_tx") {
      chain.sendTxCount++;
      if (chain.failSendTx > 0) {
        chain.failSendTx--;
        return { httpStatus: 503, body: "Service Unavailable" };
      }
      let t;
      try { t = readBorshTransfer(Buffer.from(params.signed_tx_base64, "base64")); } catch (e) {
        return rpcError(id, "PARSE_ERROR", String(e.message), 400);
      }
      const digest = createHash("sha256").update(t.txBytes).digest();
      const hash = base58Encode(digest);
      if (txs.has(hash)) return ok(id, txs.get(hash)); // the same bytes again: same outcome
      const pk = "ed25519:" + base58Encode(t.publicKey);
      const acct = accounts.get(t.signerId);
      const key = acct && acct.keys.get(pk);
      const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, t.publicKey]), format: "der", type: "spki" });
      if (!key || !verify(null, digest, pub, t.signature)) {
        return rpcError(id, "INVALID_TRANSACTION", { TxExecutionError: { InvalidTxError: "InvalidSignature" } });
      }
      if (t.nonce <= key.nonce) {
        return rpcError(id, "INVALID_TRANSACTION", { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(t.nonce), ak_nonce: Number(key.nonce) } } } });
      }
      if (!blocks.has(base58Encode(t.blockHash))) {
        return rpcError(id, "INVALID_TRANSACTION", { TxExecutionError: { InvalidTxError: "Expired" } });
      }
      key.nonce = t.nonce;
      let logs = [];
      if (t.actions[0].Transfer) move(t.signerId, t.receiverId, t.actions[0].Transfer.deposit);
      else {
        const call = t.actions[0].FunctionCall, args = JSON.parse(Buffer.from(call.args, "base64").toString());
        if (call.method_name !== "ft_transfer" || call.deposit !== "1") return rpcError(id, "UNSUPPORTED", "unsupported contract call");
        logs = [moveFt(t.receiverId, t.signerId, args.receiver_id, args.amount)];
        move(t.signerId, t.receiverId, 1n);
      }
      const r = record({
        hash, signerId: t.signerId, publicKey: pk, nonce: t.nonce, receiverId: t.receiverId,
        actions: t.actions, signature: "ed25519:" + base58Encode(t.signature), logs,
      });
      return ok(id, r);
    }
    return { httpStatus: 200, body: { jsonrpc: "2.0", id, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: {} }, code: -32601, message: "Method not found" } } };
  };

  /** fetch-compatible: POST JSON-RPC to any URL. */
  chain.fetch = async (url, init = {}) => {
    const req = JSON.parse(init.body);
    const { httpStatus, body } = chain.handle(req);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status: httpStatus, headers: { "content-type": "application/json" } });
  };

  /** Serve the chain over HTTP on 127.0.0.1 (for a server running in a child process). */
  chain.listen = async () => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR", info: {} }, code: -32700 } }));
      }
      const out = chain.handle(body);
      res.writeHead(out.httpStatus, { "content-type": "application/json" });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    chain.url = `http://127.0.0.1:${server.address().port}`;
    chain.close = () => new Promise((r) => server.close(r));
    return chain.url;
  };

  return chain;
}

/** A throwaway ed25519 key in NEAR's `ed25519:<base58(seed‖pub)>` format, generated in-process. */
export async function throwawayNearKey() {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secretKey: "ed25519:" + base58Encode(Buffer.concat([seed, pub])), publicKey: "ed25519:" + base58Encode(pub) };
}

export { base58Decode };

/* ------------------------------------------------------------------ */
/* NanoGPT stand-in and the worked example from docs/near-payments.md  */
/* ------------------------------------------------------------------ */

/** The worked example: text → llm → image, input "Idea". */
export const WORKED_GRAPH = Object.freeze({
  v: 1,
  nodes: [
    { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
    { id: "n2", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write one vivid image prompt for the idea. Reply with the prompt only." } },
    { id: "n3", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024" } },
  ],
  links: [
    { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
    { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "prompt" } },
  ],
});

/** The catalog prices the worked example uses (illustrative, NanoGPT's shapes). */
export const WORKED_CATALOGS = Object.freeze({
  chat: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3, currency: "USD", unit: "per_million_tokens" } }],
  image: [{ id: "blackforestlabs/flux-3/klein/text-to-image", pricing: { per_image: { "1024x1024": 0.009 }, currency: "USD" }, supported_parameters: { max_output_images: 4 } }],
});

/** The stand-in's x402 rate-probe invoice: 0.01 XNO (10^28 raw) for $0.0095, so 1 XNO = $0.95. */
export const XNO_PROBE = Object.freeze({ raw: "10000000000000000000000000000", usd: "0.0095" });

/** 1x1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * NanoGPT stand-in: public catalogs, chat and image generation. The LLM call
 * reports $0.00041 and the image $0.009, so the worked example's actual model
 * cost is $0.00941. A prompt containing "FAIL" gets a 400 (the run fails); one
 * containing "HOLD" never answers (a run in flight when the server dies).
 * A keyless `x-x402: true` chat request is the XNO/USD rate probe: it gets a
 * 402 invoice of 0.01 XNO for $0.0095 (1 XNO = $0.95) and is not counted as a run.
 * `fetch` serves in-process callers; `listen()` serves a child process.
 */
export function nanoGptMock() {
  let chatRuns = 0;
  const chatBodies = [];
  const REPLY = "A lighthouse at dawn, gold light on wet rocks, gulls, long lens";
  const json = (status, obj) => ({ status, body: JSON.stringify(obj) });
  let probes = 0;
  let probe = XNO_PROBE;
  async function handle(method, path, body, headers = {}) {
    const p = path.replace(/^https?:\/\/[^/]+/, "");
    if (method === "POST" && p === "/api/v1/chat/completions" && String(headers["x-x402"] || "") === "true") {
      probes++;
      return json(402, { accepts: [{ scheme: "nano", maxAmountRequired: probe.raw, maxAmountRequiredUSD: probe.usd }] });
    }
    if (method === "GET" && p === "/api/v1/models?detailed=true") return json(200, { data: WORKED_CATALOGS.chat });
    if (method === "GET" && p === "/api/v1/image-models") return json(200, { data: WORKED_CATALOGS.image });
    if (method === "GET" && /^\/api\/v1\/(video|audio|3d)-models$/.test(p)) return json(200, { data: [] });
    if (method === "POST" && p === "/api/v1/chat/completions") {
      chatRuns++;
      chatBodies.push(body);
      const prompt = JSON.stringify(body && body.messages);
      if (/HOLD/.test(prompt)) return new Promise(() => {});
      if (/FAIL/.test(prompt)) return json(400, { error: { message: "stub: the model refused this prompt" } });
      if (/NOCOST/.test(prompt)) return json(200, { choices: [{ message: { content: REPLY } }] });
      return json(200, { choices: [{ message: { content: REPLY } }], x_nanogpt_pricing: { costUsd: 0.00041 } });
    }
    if (method === "POST" && p === "/v1/images/generations") return json(200, { data: [{ b64_json: PNG_B64 }], cost: 0.009 });
    return json(404, { error: `stub: no route for ${method} ${p}` });
  }
  return {
    REPLY,
    runs: () => chatRuns,
    /** XNO/USD rate probes answered (never runs). */
    probes: () => probes,
    /** Change the probe invoice (a moving XNO/USD rate): { raw, usd }. */
    setXnoProbe: (p) => { probe = { raw: String(p.raw), usd: String(p.usd) }; },
    /** Every chat request body, in order. */
    chatBodies: () => chatBodies,
    async fetch(url, init = {}) {
      const method = (init.method || "GET").toUpperCase();
      let body = null;
      try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
      const h = {};
      for (const [k, v] of new Headers(init.headers || {})) h[k] = v;
      const r = await handle(method, String(url), body, h);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
    },
    async listen() {
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        const r = await handle(req.method, req.url, body, req.headers);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      this.close = () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
      return this.url;
    },
  };
}
