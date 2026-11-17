import { test } from "node:test";
import assert from "node:assert/strict";
import { createBlock, checkAddress, hashBlock } from "nanocurrency";
import { createNanoReadPool } from "../src/nano-read-pool.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";

const ACCOUNT = NANO_GENESIS_REPLY.contents.account, PAYER = "nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7";
const SEND = "A".repeat(64), OTHER = "C".repeat(64);
const absent = () => Object.assign(Error("Block not found"), { authoritative: true });
const pending = amount => ({ blocks: { [SEND]: { amount: String(amount), source: PAYER } } });
function world(count = 3) {
  let at = 1_000;
  const peers = Array.from({ length: count }, (_, index) => ({ base: String(index), info: nanoAccountInfo(), receivable: { blocks: "" }, history: { history: [] }, blocks: {}, network: true }));
  const calls = [];
  const pool = createNanoReadPool({ bases: peers.map(p => p.base), account: ACCOUNT, checkAddress, hashBlock, now: () => at,
    rpc: async (body, base) => {
      calls.push({ action: body.action, base });
      const p = peers.find(p => p.base === base);
      if (body.action === "block_info" && body.hash === NANO_GENESIS_HASH) {
        if (!p.network) throw absent(); return NANO_GENESIS_REPLY;
      }
      if (p.down) throw Error("offline");
      if (body.action === "account_info") return p.info;
      if (body.action === "receivable") { assert.equal(body.include_only_confirmed, "true"); return p.receivable; }
      if (body.action === "account_history") return p.history;
      if (body.action === "block_info") { const value = p.blocks[body.hash]; if (value instanceof Error) throw value; if (!value) throw absent(); return value; }
      assert.fail("not a read-only request");
    } });
  return { pool, peers, calls, tick: ms => { at += ms; } };
}
const receivable = { action: "receivable", account: ACCOUNT, count: "50", threshold: "1", source: "true" };
const info = { action: "account_info", account: ACCOUNT };

test("a frozen first peer cannot hide a confirmed payment behind an empty list", async () => {
  const w = world();
  for (const p of w.peers.slice(1)) { p.info = nanoAccountInfo({ pending: "7" }); p.receivable = pending(7); }
  assert.equal((await w.pool.read(receivable)).blocks[SEND].amount, "7");
  assert.deepEqual(await w.pool.publishBases(), ["1", "2", "0"]);
  assert.equal(w.pool.status().readablePeers, 3);
  assert.ok(w.calls.every(c => ["block_info", "account_info", "receivable"].includes(c.action)));
});

test("a cached incomplete list cannot contradict its atomic account pending total", async () => {
  const w = world();
  for (const p of w.peers) { p.info = nanoAccountInfo({ pending: "7" }); p.receivable = pending(7); }
  w.peers[0].receivable = { blocks: "" };
  assert.equal((await w.pool.read(receivable)).blocks[SEND].amount, "7");
  w.peers[1].receivable = { blocks: "" };
  await assert.rejects(w.pool.read(receivable), { code: "NANO_RPC_READ_QUORUM" });
});

test("the known pending total cannot regress while the account head is unchanged", async () => {
  const w = world();
  for (const p of w.peers) { p.info = nanoAccountInfo({ pending: "7" }); p.receivable = pending(7); }
  await w.pool.read(receivable);
  for (const p of w.peers) { p.info = nanoAccountInfo(); p.receivable = { blocks: "" }; }
  await assert.rejects(w.pool.read(receivable), { code: "NANO_RPC_REGRESSION" });
});

test("a newer account head wins over an old peer's already-pocketed receivable", async () => {
  const w = world();
  w.peers[0].info = nanoAccountInfo({ pending: "7" }); w.peers[0].receivable = pending(7);
  for (const p of w.peers.slice(1)) p.info = nanoAccountInfo({ height: 11, frontier: OTHER, balance: "107" });
  assert.equal((await w.pool.read(receivable)).blocks, "");
  assert.equal((await w.pool.read(info)).frontier, OTHER);
});

test("conflicting heads or balances at the same height refuse new spending", async () => {
  for (const patch of [{ frontier: OTHER, confirmed_frontier: OTHER }, { balance: "101", confirmed_balance: "101" }]) {
    const w = world(); Object.assign(w.peers[0].info, patch);
    await assert.rejects(w.pool.read(info), { code: "NANO_RPC_CONFLICT" });
  }
});

test("malformed financial fields and wrong-chain peers are excluded, never zeroed", async () => {
  const w = world(); w.peers[0].info.balance = "NaN";
  assert.equal((await w.pool.read(info)).balance, "100");
  w.peers[1].down = true;
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_READ_QUORUM" });
  w.peers[0].network = false; w.peers[1].network = false; w.tick(30_000);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_NETWORK_QUORUM" });
});

test("network identity expires, is rechecked, and can recover without restart", async () => {
  const w = world(); await w.pool.read(info);
  w.peers[0].network = false; w.peers[1].network = false; w.tick(30_000);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_NETWORK_QUORUM" });
  assert.equal(w.pool.status().networkPeers, 1);
  w.peers[0].network = true; w.tick(5_000);
  assert.equal((await w.pool.read(info)).balance, "100");
});

test("locally published blocks cannot be replaced by an older cached account state", async () => {
  const w = world(); await w.pool.read(info);
  assert.equal(w.pool.status().checkpoint.head.blockCount, "10");
  w.pool.observe({ frontier: OTHER, balance: 93n, blockCount: 11n, representative: ACCOUNT });
  const captured = w.pool.status().checkpoint;
  assert.deepEqual(captured, { v: 1, networkGenesis: NANO_GENESIS_HASH, account: ACCOUNT,
    head: { hash: OTHER, blockCount: "11" }, confirmed: { hash: "B".repeat(64), blockCount: "10" } });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_REGRESSION" });
  assert.deepEqual(w.pool.status().checkpoint, captured, "a lagging peer cannot lower the operator handoff floor");
  for (const p of w.peers) p.info = nanoAccountInfo({ height: 11, frontier: OTHER, balance: "93" });
  assert.equal((await w.pool.read(info)).balance, "93");
  assert.deepEqual(w.pool.status().checkpoint.confirmed, captured.head);
  captured.head.hash = SEND;
  assert.equal(w.pool.status().checkpoint.head.hash, OTHER, "returned telemetry cannot mutate the live guard");
  w.pool.observe({ frontier: SEND, balance: 93n, blockCount: 11n, representative: ACCOUNT });
  assert.equal(w.pool.status().checkpoint, null, "conflicting local history cannot supply a healthy handoff");
});

test("an unknown unconfirmed head cannot authorize spending, while our own queued chain is retained", async () => {
  const w = world();
  for (const p of w.peers) p.info = nanoAccountInfo({ height: 11, frontier: OTHER, balance: "93", confirmedHeight: 10,
    confirmedFrontier: "B".repeat(64), confirmedBalance: "100" });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_UNCONFIRMED_FRONTIER" });
  assert.equal(w.pool.status().readablePeers, 0);
  w.pool.observe({ frontier: OTHER, balance: 93n, blockCount: 11n, representative: ACCOUNT });
  assert.equal((await w.pool.read(info)).frontier, OTHER);
});

test("history omits unconfirmed entries so the payment cursor cannot skip them forever", async () => {
  const w = world();
  for (const p of w.peers) p.history = { history: [{ hash: SEND, type: "receive", account: PAYER, amount: "7", confirmed: "false" }], previous: "0".repeat(64) };
  assert.deepEqual((await w.pool.read({ action: "account_history", account: ACCOUNT, count: "100" })).history, []);
  for (const p of w.peers) p.history.history[0].confirmed = "true";
  const result = await w.pool.read({ action: "account_history", account: ACCOUNT, count: "100" });
  assert.equal(result.history.length, 1); assert.equal(result.previous, null);
});

test("a stale negative block lookup cannot hide a positive confirmation", async () => {
  const w = world(), prepared = createBlock("0".repeat(64), { work: "0".repeat(16), previous: "B".repeat(64), representative: ACCOUNT, balance: "93", link: PAYER });
  for (const p of w.peers.slice(1)) p.blocks[prepared.hash] = { confirmed: "true", contents: prepared.block };
  assert.equal((await w.pool.block({ action: "block_info", hash: prepared.hash })).confirmed, "true");
  for (const p of w.peers) p.blocks[prepared.hash] = absent();
  await assert.rejects(w.pool.block({ action: "block_info", hash: prepared.hash }), e => e.authoritative === true);
  w.peers[0].blocks[prepared.hash] = Error("offline");
  await assert.rejects(w.pool.block({ action: "block_info", hash: prepared.hash }), { code: "NANO_RPC_BLOCK_UNCERTAIN" });
});

test("an unconfirmed or mismatched block is never permission to sign a replacement", async () => {
  const w = world(), prepared = createBlock("0".repeat(64), { work: "0".repeat(16), previous: "B".repeat(64), representative: ACCOUNT, balance: "93", link: PAYER });
  w.peers[0].blocks[prepared.hash] = { confirmed: "false", contents: prepared.block };
  assert.equal((await w.pool.block({ action: "block_info", hash: prepared.hash })).confirmed, "false");
  w.peers[0].blocks[prepared.hash] = { confirmed: "true", contents: { ...prepared.block, balance: "94" } };
  await assert.rejects(w.pool.block({ action: "block_info", hash: prepared.hash }), { code: "NANO_RPC_BLOCK_UNCERTAIN" });
});

test("the read-only API cannot sign, publish, generate work or switch account scope", async () => {
  const w = world();
  for (const action of ["process", "work_generate", "send"]) await assert.rejects(w.pool.read({ action, account: ACCOUNT }), { code: "NANO_RPC_READ_ACTION" });
  await assert.rejects(w.pool.read({ ...info, account: PAYER }), { code: "NANO_RPC_ACCOUNT_SCOPE" });
  await assert.rejects(w.pool.block({ action: "process", hash: SEND }), { code: "NANO_RPC_READ_ACTION" });
  assert.equal(w.calls.length, 0);
  assert.throws(() => createNanoReadPool({ bases: ["same", "same"], account: ACCOUNT, rpc: () => {} }), /Duplicate/);
});
