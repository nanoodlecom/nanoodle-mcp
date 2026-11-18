import { test } from "node:test";
import assert from "node:assert/strict";
import { createBlock, checkAddress, hashBlock } from "nanocurrency";
import { createNanoReadPool, nanoStandbyConfig, NANO_COLD_STANDBY_SCAN_REQUESTS } from "../src/nano-read-pool.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";

const ACCOUNT = NANO_GENESIS_REPLY.contents.account, PAYER = "nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7";
const SEND = "A".repeat(64), OTHER = "C".repeat(64);
const absent = () => Object.assign(Error("Block not found"), { authoritative: true });
const pending = amount => ({ blocks: { [SEND]: { amount: String(amount), source: PAYER } } });
function world(count = 3, requestsPerMinute = 0, account = ACCOUNT, persistConfirmed = null) {
  let at = 1_000, elapsed = 0;
  const peers = Array.from({ length: count + Number(requestsPerMinute > 0) }, (_, index) => ({
    base: requestsPerMinute ? `https://peer-${index}.example` : String(index),
    info: nanoAccountInfo(), receivable: { blocks: "" }, history: { history: [] }, blocks: {}, network: true,
  }));
  const calls = [];
  const standby = requestsPerMinute ? { url: peers[count].base, requestsPerMinute } : undefined;
  const pool = createNanoReadPool({ bases: peers.slice(0, count).map(p => p.base), account, checkAddress, hashBlock, standby, persistConfirmed,
    now: () => at, monotonicNow: () => elapsed,
    rpc: async (body, base) => {
      calls.push({ action: body.action, base });
      const p = peers.find(p => p.base === base);
      if (p.error && (!p.errorAction || p.errorAction === body.action)) throw p.error;
      if (body.action === "block_info" && body.hash === NANO_GENESIS_HASH) {
        if (!p.network) throw absent(); return NANO_GENESIS_REPLY;
      }
      if (p.down) throw Error("offline");
      if (body.action === "account_info" && p.accountRead) return p.accountRead();
      if (body.action === "account_info") return p.info;
      if (body.action === "receivable") { assert.equal(body.include_only_confirmed, "true"); return p.receivable; }
      if (body.action === "account_history") return p.history;
      if (body.action === "block_info") { const value = p.blocks[body.hash]; if (value instanceof Error) throw value; if (!value) throw absent(); return value; }
      assert.fail("not a read-only request");
    } });
  return { pool, peers, calls, tick: ms => { at += ms; elapsed += ms; }, jumpWall: ms => { at += ms; } };
}
const receivable = { action: "receivable", account: ACCOUNT, count: "50", threshold: "1", source: "true" };
const info = { action: "account_info", account: ACCOUNT };

test("the optional standby requires two primaries, an independent hostname and an explicit quota", () => {
  const bases = ["https://primary.example", "http://other.example:7077"];
  const url = "https://standby.example/rpc?api_key=PRIVATE";
  assert.equal(nanoStandbyConfig(bases), null);
  assert.deepEqual(nanoStandbyConfig(bases, { url, requestsPerMinute: "5" }), { url, requestsPerMinute: 5 });
  for (const bad of [undefined, "2", 121, "3e1", "5.0"]) {
    assert.throws(() => nanoStandbyConfig(bases, { url, requestsPerMinute: bad }), /explicit budget/);
  }
  assert.throws(() => nanoStandbyConfig(bases.slice(0, 1), { url, requestsPerMinute: 4 }), /two to seven/);
  assert.throws(() => nanoStandbyConfig(bases, { url: "http://PRIMARY.example.:7077/proxy", requestsPerMinute: 4 }), /different hostname/);
  assert.throws(() => nanoStandbyConfig(bases, { url: "https://PRIVATE@standby.example", requestsPerMinute: 4 }), error =>
    error instanceof TypeError && !error.message.includes("PRIVATE"));
});

test("the Nano standby stays idle at quorum and only corroborates an eligible primary", async () => {
  const w = world(2, 10), [primary, spare, standby] = w.peers;
  const standbyCalls = () => w.calls.filter(call => call.base === standby.base);
  await w.pool.read(info);
  assert.equal(standbyCalls().length, 0);
  assert.equal(w.pool.status().standby.inUse, false);
  spare.down = true;
  await w.pool.read(info);
  assert.deepEqual(standbyCalls().map(call => call.action), ["block_info", "account_info"]);
  assert.equal(w.pool.status().standby.inUse, true);
  assert.equal(w.pool.status().readablePeers, 2);
  assert.deepEqual(await w.pool.publishBases(), [primary.base], "only the corroborated primary may receive the signed block");
  // A block lookup shares the read budget, but awaiting its result cannot add a
  // standby to the normal network-eligible publish list.
  spare.network = false; w.tick(30_000);
  await assert.rejects(w.pool.block({ action: "block_info", hash: SEND }), e => e.authoritative === true);
  assert.deepEqual(await w.pool.publishBases(), [primary.base]);
  primary.down = true;
  const before = standbyCalls().length;
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_READ_QUORUM" });
  assert.equal(standbyCalls().length, before, "the standby cannot act as the only peer");
  assert.equal(w.pool.status().readablePeers, 0);
  await assert.rejects(w.pool.publishBases(), { code: "NANO_RPC_NETWORK_QUORUM" });
});

test("a standby can corroborate the owned node when the other primary is one block behind", async () => {
  const saved = [];
  const { pool, peers, calls } = world(2, 10, ACCOUNT, value => saved.push(value));
  const [owned, lagging, standby] = peers;
  await pool.read(info);
  assert.equal(saved.at(-1).head.blockCount, "10");
  assert.ok(calls.every(call => call.base !== standby.base));
  owned.info = standby.info = nanoAccountInfo({ height: 11, frontier: OTHER });
  assert.equal((await pool.read(info)).block_count, "11");
  assert.equal(saved.at(-1).head.blockCount, "11");
  assert.equal(pool.status().standby.inUse, true);
  assert.deepEqual(await pool.publishBases(), [owned.base]);
  lagging.info = owned.info;
  await pool.read(info);
  assert.equal(pool.status().standby.inUse, false);
});

test("the standby cannot hide primary disagreement or contribute a different view", async () => {
  const w = world(2, 10), [, spare, standby] = w.peers;
  const standbyCalls = () => w.calls.filter(call => call.base === standby.base);
  spare.info = nanoAccountInfo({ frontier: OTHER });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_CONFLICT" });
  assert.equal(standbyCalls().length, 0);
  spare.info = nanoAccountInfo({ pending: "2" });
  // The peer returned a valid account view, even though the stale receivable
  // result contradicts its own pending total.
  await assert.rejects(w.pool.read(receivable), { code: "NANO_RPC_CONFLICT" });
  assert.equal(standbyCalls().length, 0);
  spare.down = true;
  for (const different of [{ height: 11, frontier: OTHER }, { frontier: OTHER }, { pending: "2" }]) {
    standby.info = nanoAccountInfo(different);
    await assert.rejects(w.pool.read(info), { code: "NANO_RPC_STANDBY_DISAGREES" });
    assert.equal(w.pool.status().readablePeers, 0);
  }
});

test("a standby's block lookup cannot by itself qualify a later account read", async () => {
  const w = world(2, 6), [, spare] = w.peers;
  await w.pool.read(info);
  w.tick(30_000); spare.network = false;
  await assert.rejects(w.pool.block({ action: "block_info", hash: SEND }), e => e.authoritative === true);
  assert.equal(w.pool.status().standby.inUse, false);
  assert.equal(w.pool.status().networkPeers, 1);
});

test("standby quota covers all attempted reads and refills on monotonic time", async () => {
  const w = world(2, 3), [, spare, standby] = w.peers;
  const standbyCalls = () => w.calls.filter(call => call.base === standby.base);
  spare.down = true;
  await w.pool.read(receivable);
  assert.deepEqual(standbyCalls().map(call => call.action), ["block_info", "receivable", "account_info"]);
  w.jumpWall(600_000);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_STANDBY_BUDGET" });
  w.tick(59_999);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_STANDBY_BUDGET" });
  assert.equal(standbyCalls().length, 3);
  w.tick(1);
  await w.pool.read(info);
  assert.equal(standbyCalls().length, 5);
});

test("a standby defers a payment read if only part of its budget is available", async () => {
  const w = world(2, 4), [, spare, standby] = w.peers;
  const standbyActions = () => w.calls.filter(call => call.base === standby.base).map(call => call.action);
  spare.down = true;
  await w.pool.read(receivable);
  await assert.rejects(w.pool.read(receivable), { code: "NANO_RPC_STANDBY_BUDGET" });
  assert.deepEqual(standbyActions(), ["block_info", "receivable", "account_info"]);
  w.tick(30_000);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_STANDBY_BUDGET" });
  assert.deepEqual(standbyActions(), ["block_info", "receivable", "account_info"]);
  w.tick(30_000);
  await w.pool.read(receivable);
  assert.deepEqual(standbyActions(), ["block_info", "receivable", "account_info", "block_info", "receivable", "account_info"]);
});

test("concurrent payment reads cannot consume each other's standby validation budget", async () => {
  const w = world(2, 4), [, spare, standby] = w.peers;
  spare.down = true;
  const results = await Promise.allSettled([w.pool.read(receivable), w.pool.read(receivable)]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"]);
  assert.equal(results[1].reason.code, "NANO_RPC_STANDBY_BUDGET");
  assert.deepEqual(w.calls.filter(call => call.base === standby.base).map(call => call.action),
    ["block_info", "receivable", "account_info"]);
  await w.pool.read(info);
});

test("a cold standby needs room for both halves of a one-page payment scan", async () => {
  for (const budget of [4, 5]) {
    const w = world(2, budget), [owned, spare, standby] = w.peers;
    const head = owned.info.confirmed_frontier;
    const request = { action: "account_history", account: ACCOUNT, head, raw: "true", count: "1" };
    owned.history = standby.history = { account: ACCOUNT, previous: OTHER, history: [
      { hash: head, type: "state", subtype: "epoch", confirmed: "true", height: "10", previous: OTHER },
    ] };
    spare.down = true;
    const standbyActions = () => w.calls.filter(call => call.base === standby.base).map(call => call.action);
    await w.pool.read(receivable);
    if (budget === 4) {
      await assert.rejects(w.pool.read(request), { code: "NANO_RPC_STANDBY_BUDGET" });
      assert.equal(standbyActions().length, 3);
    } else {
      assert.equal((await w.pool.read(request)).history[0].hash, head);
      assert.deepEqual(standbyActions(), ["block_info", "receivable", "account_info", "account_history", "account_info"]);
      assert.equal(standbyActions().length, NANO_COLD_STANDBY_SCAN_REQUESTS);
    }
  }
});

test("a standby rate limit remains private and prevents attempts until its retry time", async () => {
  const w = world(2, 6), [, spare, standby] = w.peers;
  spare.down = true; standby.error = Object.assign(Error("PRIVATE"), { rateLimited: true, retryAfterMs: 90_000 });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_READ_QUORUM" });
  assert.deepEqual(w.pool.status().cooldowns, [{ peer: 2, until: 91_000 }]);
  w.tick(89_999);
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_READ_QUORUM" });
  assert.equal(w.calls.filter(call => call.base === standby.base).length, 1);
  delete standby.error; w.tick(1);
  await w.pool.read(info);
  assert.equal(w.pool.status().standby.inUse, true);
  assert.doesNotMatch(JSON.stringify(w.pool.status()), /PRIVATE|peer-2\.example/);
});

test("a rate-limited peer stays out of reads and publishes until its retry hint expires", async () => {
  const w = world(), peer = w.peers[0];
  peer.error = Object.assign(Error("429"), { rateLimited: true, retryAfterMs: 90_000 });
  await w.pool.read(info);
  assert.deepEqual(w.pool.status().cooldowns, [{ peer: 0, until: 91_000 }]);
  assert.equal(w.pool.status().readablePeers, 2);
  const calls = () => w.calls.filter(call => call.base === "0").length, before = calls();
  w.tick(89_999); await w.pool.read(info);
  assert.equal(calls(), before); assert.deepEqual(await w.pool.publishBases(), ["1", "2"]);
  delete peer.error; w.tick(1); await w.pool.read(info);
  assert.ok(calls() > before); assert.deepEqual(w.pool.status().cooldowns, []);
  assert.equal(w.pool.status().readablePeers, 3);
});

test("account throttling invalidates a cached network proof and repeated refusals back off", async () => {
  const w = world(), peer = w.peers[0]; await w.pool.read(info);
  peer.error = Object.assign(Error("429"), { rateLimited: true, retryAfterMs: null }); peer.errorAction = "account_info";
  await w.pool.read(info); assert.equal(w.pool.status().cooldowns[0].until, 31_000);
  w.tick(30_000); await w.pool.read(info); assert.equal(w.pool.status().cooldowns[0].until, 91_000);
  const before = w.calls.filter(call => call.base === "0").length;
  w.tick(59_999); await w.pool.read(info); assert.equal(w.calls.filter(call => call.base === "0").length, before);
  delete peer.error; w.tick(1); await w.pool.read(info); assert.deepEqual(w.pool.status().cooldowns, []);
  peer.error = Object.assign(Error("429"), { rateLimited: true });
  await w.pool.read(info); assert.equal(w.pool.status().cooldowns[0].until, 121_000, "successful reads reset escalating backoff");
});

test("losing quorum to cooldown pauses new reads instead of treating one peer as sufficient", async () => {
  const w = world(2);
  w.peers[0].error = Object.assign(Error("429"), { rateLimited: true, retryAfterMs: 60_000 });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_NETWORK_QUORUM" });
  assert.equal(w.pool.status().readablePeers, 0); assert.equal(w.pool.status().networkPeers, 1);
  const before = w.calls.filter(call => call.base === "0").length;
  w.tick(5_001); await assert.rejects(w.pool.read(info), { code: "NANO_RPC_NETWORK_QUORUM" });
  assert.equal(w.calls.filter(call => call.base === "0").length, before);
});

test("an older successful read cannot erase a concurrent rate-limit refusal", async () => {
  const w = world(); await w.pool.read(info);
  const replies = [];
  w.peers[0].accountRead = () => new Promise((resolve, reject) => replies.push({ resolve, reject }));
  const older = w.pool.read(info), newer = w.pool.read(info);
  while (replies.length < 2) await new Promise(resolve => setImmediate(resolve));
  replies[1].reject(Object.assign(Error("429"), { rateLimited: true, retryAfterMs: 60_000 }));
  await newer;
  replies[0].resolve(w.peers[0].info); await older;
  assert.deepEqual(w.pool.status().cooldowns, [{ peer: 0, until: 61_000 }]);
  assert.equal(w.pool.status().readablePeers, 2);
});

test("a throttled block lookup cannot be mistaken for an authoritative absence", async () => {
  const w = world(); await w.pool.read(info);
  w.peers[0].error = Object.assign(Error("429"), { rateLimited: true, retryAfterMs: 60_000 });
  w.peers[0].errorAction = "block_info";
  await assert.rejects(w.pool.block({ action: "block_info", hash: SEND }), { code: "NANO_RPC_BLOCK_UNCERTAIN" });
  assert.deepEqual(w.pool.status().cooldowns, [{ peer: 0, until: 61_000 }]);
  const before = w.calls.filter(call => call.base === "0").length;
  await assert.rejects(w.pool.block({ action: "block_info", hash: SEND }), e => e.authoritative === true);
  assert.equal(w.calls.filter(call => call.base === "0").length, before);
});

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

test("a lagging peer cannot form quorum or receive a publication until its account view catches up", async () => {
  const w = world(), [old, primary, other] = w.peers;
  primary.info = other.info = nanoAccountInfo({ height: 13, frontier: OTHER, balance: "107" });
  assert.equal((await w.pool.read(info)).frontier, OTHER);
  assert.equal(w.pool.status().readablePeers, 2);
  assert.deepEqual(await w.pool.publishBases(), [primary.base, other.base]);
  other.down = true;
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_LAGGING_PEERS" });
  assert.equal(w.pool.status().readablePeers, 0);
  old.info = nanoAccountInfo({ height: 11, frontier: SEND, balance: "102" });
  assert.equal((await w.pool.read(info)).frontier, OTHER);
  assert.deepEqual(await w.pool.publishBases(), [primary.base, old.base, other.base]);
});

test("the metered standby can replace a lagging primary without masking a same-height conflict", async () => {
  const w = world(2, 10), [old, primary, standby] = w.peers;
  primary.info = standby.info = nanoAccountInfo({ height: 13, frontier: OTHER });
  assert.equal((await w.pool.read(info)).frontier, OTHER);
  assert.equal(w.pool.status().standby.inUse, true);
  assert.deepEqual(await w.pool.publishBases(), [primary.base]);
  old.info = nanoAccountInfo({ height: 13, frontier: SEND });
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_CONFLICT" });
  assert.equal(w.pool.status().readablePeers, 0);
  assert.equal(w.calls.filter(call => call.base === standby.base).length, 2);
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

test("a startup checkpoint refuses agreeing stale peers, then seeds the running read guard", async () => {
  const w = world(2);
  const old = { v: 1, account: ACCOUNT, networkGenesis: NANO_GENESIS_HASH,
    confirmed: { hash: "B".repeat(64), blockCount: "10" }, head: { hash: OTHER, blockCount: "11" } };
  await assert.rejects(w.pool.verifyCheckpoint({ ...old, account: PAYER }), { code: "NANO_CHECKPOINT_INVALID" });
  assert.equal(w.calls.length, 0);
  await assert.rejects(w.pool.verifyCheckpoint(old), { code: "NANO_RPC_CHECKPOINT_UNPROVEN" });
  assert.equal(w.pool.status().checkpoint, null);
  w.peers[0].info = nanoAccountInfo({ height: 11, frontier: OTHER });
  await assert.rejects(w.pool.verifyCheckpoint(old), { code: "NANO_RPC_CHECKPOINT_UNPROVEN" });
  w.peers[1].info = nanoAccountInfo({ height: 11, frontier: SEND });
  await assert.rejects(w.pool.verifyCheckpoint(old), { code: "NANO_RPC_CHECKPOINT_CONFLICT" });
  w.peers[1].info = nanoAccountInfo({ height: 11, frontier: OTHER });
  await w.pool.verifyCheckpoint(old);
  assert.deepEqual(w.pool.status().checkpoint.confirmed, old.head);
  for (const peer of w.peers) peer.info = nanoAccountInfo();
  await assert.rejects(w.pool.read(info), { code: "NANO_RPC_REGRESSION" });
});

test("two newer peers each prove the original account block at its confirmed height", async () => {
  const block = createBlock("0".repeat(64), { work: "0".repeat(16), previous: "B".repeat(64), representative: ACCOUNT, balance: "93", link: PAYER });
  const account = block.block.account.replace(/^xrb_/, "nano_"), w = world(2, 0, account);
  const head = { hash: block.hash.toUpperCase(), blockCount: "10" };
  const old = { v: 1, account, networkGenesis: NANO_GENESIS_HASH, head, confirmed: head };
  for (const peer of w.peers) {
    peer.info = nanoAccountInfo({ height: 11, frontier: OTHER });
    peer.blocks[head.hash] = { confirmed: "true", contents: block.block, height: "10" };
  }
  w.peers[0].blocks[head.hash].height = "9";
  await assert.rejects(w.pool.verifyCheckpoint(old), { code: "NANO_RPC_CHECKPOINT_UNPROVEN" });
  w.peers[0].blocks[head.hash].height = "10";
  w.peers[0].blocks[head.hash].contents = { ...block.block, balance: "94" };
  await assert.rejects(w.pool.verifyCheckpoint(old), { code: "NANO_RPC_CHECKPOINT_UNPROVEN" });
  w.peers[0].blocks[head.hash].contents = JSON.stringify(block.block);
  await w.pool.verifyCheckpoint(old);
  assert.deepEqual(w.pool.status().checkpoint.confirmed, { hash: OTHER, blockCount: "11" });
  assert.ok(w.calls.every(call => ["block_info", "account_info"].includes(call.action)));
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

test("anchored raw history falls back when a peer cannot prove continuous confirmed pages", async () => {
  const w = world(), head = "B".repeat(64), tail = "D".repeat(64);
  const request = { action: "account_history", account: ACCOUNT, head, raw: "true", count: "2" };
  const page = { account: ACCOUNT, previous: tail, history: [
    { hash: head, type: "state", subtype: "epoch", confirmed: "true", height: "10", previous: SEND },
    { hash: SEND, type: "state", subtype: "receive", confirmed: "true", height: "9", previous: tail, amount: "7", account: PAYER },
  ] };
  w.peers[1].history = w.peers[2].history = page;
  const corruptions = [
    value => { value.account = PAYER; },
    value => { value.history = []; },
    value => { value.history[0].hash = OTHER; },
    value => { value.history[1].height = "8"; },
    value => { value.history[0].previous = OTHER; },
    value => { value.history[0].confirmed = "false"; },
    value => { value.history[0].height = "11"; value.history[1].height = "10"; },
    value => { value.history[1].previous = head; value.previous = head; },
    value => { value.history[1].type = "unknown"; },
    value => { delete value.history[1].account; },
    value => { delete value.previous; },
  ];
  for (const corrupt of corruptions) {
    const unusable = structuredClone(page);
    corrupt(unusable);
    w.peers[0].history = unusable;
    assert.deepEqual(await w.pool.read(request), page);
  }
  w.peers[1].history = { ...page, history: [] };
  await assert.rejects(w.pool.read(request), { code: "NANO_RPC_READ_QUORUM" });
  assert.equal(w.pool.status().readablePeers, 0);
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
