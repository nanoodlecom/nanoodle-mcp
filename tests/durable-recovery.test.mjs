/** Offline qualification only. Every Nano RPC and provider effect is synthetic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBlock,
  deriveAddress,
  derivePublicKey,
  hashBlock,
  checkAddress,
  verifyBlock,
} from "nanocurrency";
import { openRecoveryStore } from "../src/payments/recovery-store.mjs";
import { createDurableSender } from "../src/payments/durable-send.mjs";
import { createNanoWallet } from "../src/wallet.mjs";
import { createChargeGate } from "../src/gate.mjs";

const secret = "1".repeat(64),
  publicKey = derivePublicKey(secret);
const account = deriveAddress(publicKey, { useNanoPrefix: true });
const payerSecret = "2".repeat(64),
  payer = deriveAddress(derivePublicKey(payerSecret), { useNanoPrefix: true });
const frontier = "A".repeat(64),
  balance = 10n ** 32n;
const binding = { account, to: payer, amountRaw: "100" };
function candidate(to = payer, amount = "100", previous = frontier) {
  const { hash, block } = createBlock(secret, {
    previous,
    representative: account,
    balance: (balance - BigInt(amount)).toString(),
    link: to,
    work: "0".repeat(16),
  });
  block.account = account;
  return { hash, block, previousBalance: balance.toString() };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "nano-durable-"));
  const path = join(dir, "recovery.sqlite");
  const stores = [];
  const open = (opts) => {
    const store = openRecoveryStore(path, opts);
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const s of stores) s.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, path, open };
}
async function until(fn) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const x = await fn();
    if (x) return x;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("fixture condition timed out");
}
function sender(
  store,
  {
    prepare = async () => candidate(),
    publish = async () => {},
    lookup = async () => null,
  } = {},
) {
  return createDurableSender({
    store,
    account,
    publicKey,
    prepare,
    publish,
    lookup,
    crypto: { checkAddress, hashBlock, verifyBlock, deriveAddress },
  });
}
const confirmed = (c) => ({
  confirmed: "true",
  amount: "100",
  contents: c.block,
});

test("operation binding and signed block persist before publish, completed restart never republishes", async (t) => {
  const f = await fixture(t);
  let store = f.open(),
    publishes = 0;
  const c = candidate();
  const run = sender(store, {
    publish: async (b) => {
      publishes++;
      assert.equal(store.getSend("op").state, "submitted");
      assert.equal(hashBlock(b), c.hash);
    },
    lookup: async () => confirmed(c),
  });
  assert.equal(await run.transfer("op", payer, "100"), c.hash);
  store.close();
  store = f.open();
  assert.equal(
    await sender(store, {
      publish: async () => {
        publishes++;
      },
    }).transfer("op", payer, "100"),
    c.hash,
  );
  assert.equal(publishes, 1);
  await assert.rejects(
    () => sender(store).transfer("op", payer, "101"),
    /SEND_BINDING_CONFLICT/,
  );
});
test("accepted send with lost reply stays uncertain; restart reconciles without another transfer", async (t) => {
  const f = await fixture(t);
  let store = f.open(),
    publishes = 0;
  const c = candidate();
  const run = sender(store, {
    publish: async () => {
      publishes++;
      throw Error("lost response");
    },
  });
  await assert.rejects(
    () => run.transfer("op", payer, "100"),
    /SEND_CONFIRMATION_REQUIRED/,
  );
  assert.equal(store.getSend("op").state, "uncertain");
  await assert.rejects(
    () => run.transfer("another", payer, "100"),
    /WALLET_RECONCILIATION_REQUIRED/,
  );
  store.close();
  store = f.open();
  const restored = sender(store, {
    publish: async () => {
      publishes++;
    },
    lookup: async () => confirmed(c),
  });
  assert.equal(await restored.transfer("op", payer, "100"), c.hash);
  assert.equal(publishes, 1);
});
test("crash after submitted commit and before publish cannot authorize a fresh send", async (t) => {
  const f = await fixture(t);
  let store = f.open();
  const lease = store.beginSend("op", binding);
  store.submitted("op", { ...candidate(), epoch: lease.epoch });
  store.close();
  store = f.open();
  let publishes = 0;
  await assert.rejects(
    () =>
      sender(store, {
        publish: async () => {
          publishes++;
        },
      }).transfer("op", payer, "100"),
    /SEND_CONFIRMATION_REQUIRED/,
  );
  assert.equal(publishes, 0);
  assert.equal(store.activeSend(account).id, "op");
});
test("unconfirmed, missing, wrong-amount or wrong-block receipts never complete a send", async (t) => {
  for (const proof of [
    null,
    { ...confirmed(candidate()), confirmed: "false" },
    { ...confirmed(candidate()), amount: "101" },
    confirmed(candidate(payer, "100", "B".repeat(64))),
  ]) {
    const f = await fixture(t);
    const store = f.open();
    await assert.rejects(
      () =>
        sender(store, { lookup: async () => proof }).transfer(
          "op",
          payer,
          "100",
        ),
      /SEND_CONFIRMATION/,
    );
    assert.notEqual(store.getSend("op").state, "completed");
    assert.equal(store.activeSend(account).id, "op");
  }
});
test("malformed or rebound signed preparation never reaches publish", async (t) => {
  const f = await fixture(t);
  const store = f.open();
  let publishes = 0;
  for (const c of [
    { ...candidate(), previousBalance: "10" },
    candidate(account),
    { ...candidate(), hash: "F".repeat(64) },
  ]) {
    await assert.rejects(
      () =>
        sender(store, {
          prepare: async () => c,
          publish: async () => {
            publishes++;
          },
        }).transfer("op", payer, "100"),
      /SIGNED_SEND/,
    );
  }
  assert.equal(publishes, 0);
  assert.equal(store.getSend("op").state, "intent");
});
test("two workers racing one operation publish only the committed winner", async (t) => {
  const f = await fixture(t);
  const a = f.open(),
    b = f.open();
  let release,
    publishes = 0,
    ready = 0;
  const start = new Promise((r) => {
    release = r;
  });
  const c = candidate();
  const opts = {
    prepare: async () => {
      if (++ready === 2) release();
      await start;
      return c;
    },
    publish: async () => {
      publishes++;
    },
    lookup: async () => confirmed(c),
  };
  const results = await Promise.all([
    sender(a, opts).transfer("op", payer, "100"),
    sender(b, opts).transfer("op", payer, "100"),
  ]);
  assert.deepEqual(results, [c.hash, c.hash]);
  assert.equal(publishes, 1);
});
test("commit uncertainty poisons the writer and restart sees the committed operation", async (t) => {
  const f = await fixture(t);
  let once = true;
  const a = f.open({
    fault: (point) => {
      if (once && point === "after_commit") {
        once = false;
        throw Error("reply lost");
      }
    },
  });
  assert.throws(() => a.beginSend("op", binding), /RECOVERY_COMMIT_UNCERTAIN/);
  assert.throws(
    () => a.beginSend("other", binding),
    /RECOVERY_STORE_UNAVAILABLE/,
  );
  a.close();
  assert.equal(f.open().getSend("op").state, "intent");
});
test("failed commit has no operation and cannot permit any subsequent effect", async (t) => {
  const f = await fixture(t);
  const a = f.open({
    fault: () => {
      throw Error("disk failure");
    },
  });
  assert.throws(() => a.beginSend("op", binding), /RECOVERY_COMMIT_UNCERTAIN/);
  a.close();
  assert.equal(f.open().getSend("op"), null);
});
test("gate snapshot and payout intents commit atomically, stale writers cannot overwrite them", async (t) => {
  const f = await fixture(t);
  const a = f.open(),
    b = f.open();
  assert.equal(
    a.save(
      "gate",
      0,
      { settled: true },
      { intents: [{ id: "change", ...binding }] },
    ),
    1,
  );
  assert.throws(
    () => b.save("gate", 0, { settled: false }),
    /RECOVERY_STATE_CONFLICT/,
  );
  assert.equal(a.load("gate").data.settled, true);
  assert.equal(a.getSend("change").state, "intent");
  assert.throws(
    () =>
      a.save(
        "gate",
        1,
        { settled: false },
        { intents: [{ id: "change", ...binding, amountRaw: "101" }] },
      ),
    /SEND_BINDING_CONFLICT/,
  );
  assert.equal(a.load("gate").revision, 1);
});
test("consumed payment identity and amount buckets survive pruning and restart", async (t) => {
  const f = await fixture(t);
  let a = f.open();
  const h = "C".repeat(64);
  a.save("gate", 0, { paid: true }, { payment: { hash: h, quoteId: "q" } });
  assert.throws(
    () =>
      a.save(
        "gate",
        1,
        { paid: true },
        { payment: { hash: h, quoteId: "other" } },
      ),
    /PAYMENT_ALREADY_CONSUMED/,
  );
  assert.equal(a.reserveAmount("5", "q"), true);
  a.close();
  a = f.open();
  assert.equal(a.paymentOwner(h), "q");
  assert.equal(a.reserveAmount("5", "other"), false);
});
function fakeRpc() {
  const state = {
    frontier,
    balance,
    receivable: {},
    history: [],
    ledger: new Map(),
    publishes: 0,
  };
  const rpc = async (body) => {
    if (body.action === "account_info")
      return {
        frontier: state.frontier,
        balance: state.balance.toString(),
        representative: account,
        confirmed_frontier: state.frontier,
        confirmed_balance: state.balance.toString(),
        confirmed_representative: account,
      };
    if (body.action === "work_generate") return { work: "0".repeat(16) };
    if (body.action === "receivable") return { blocks: state.receivable };
    if (body.action === "account_history") {
      const at = body.head
          ? state.history.findIndex((x) => x.hash === body.head)
          : 0,
        n = Number(body.count);
      return {
        history: state.history.slice(at, at + n),
        ...(at + n < state.history.length
          ? { previous: state.history[at + n].hash }
          : {}),
      };
    }
    if (body.action === "block_info") {
      if (!state.ledger.has(body.hash)) throw Error("Block not found");
      return state.ledger.get(body.hash);
    }
    if (body.action === "process") {
      const h = hashBlock(body.block);
      state.publishes++;
      const delta = state.balance - BigInt(body.block.balance);
      const amount = (delta < 0n ? -delta : delta).toString();
      if (body.subtype === "receive") delete state.receivable[body.block.link];
      state.ledger.set(h, { confirmed: "true", amount, contents: body.block });
      state.balance = BigInt(body.block.balance);
      state.frontier = h;
      return { hash: h };
    }
    throw Error("unexpected fixture RPC " + body.action);
  };
  return {
    state,
    rpc,
    fetch: async (_url, init) =>
      new Response(JSON.stringify(await rpc(JSON.parse(init.body))), {
        status: 200,
      }),
  };
}
function gateFixture(
  store,
  rpc,
  onCall = async () => ({
    content: [{ type: "text", text: "PRIVATE-OUTPUT" }],
    textOutput: true,
    costUsd: 0.02,
  }),
  options = {},
) {
  const wallet = createNanoWallet({
    secretKey: secret,
    recoveryStore: store,
    fetch: rpc.fetch,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
  });
  const gate = createChargeGate({
    address: account,
    ops: wallet.ops,
    recoveryStore: store,
    usd: 0.05,
    xnoUsd: 1,
    publicBase: "http://fixture.invalid",
    pollMs: 5,
    waitMs: 1000,
    ...options,
  });
  const registry = {
    tools: [{ name: "poster" }],
    listTools: () => [
      { name: "poster", description: "fixture", inputSchema: {} },
    ],
    callTool: onCall,
  };
  return { gate, wrapped: gate.wrapRegistry(registry), wallet };
}
test("actual wallet payment retries use the same durable invoice operation", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const wallet = createNanoWallet({
    secretKey: secret,
    recoveryStore: store,
    fetch: rpc.fetch,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
  });
  const inv = {
    paymentId: "invoice",
    completeUrl: "https://provider.invalid/complete",
    payTo: payer,
    amountRaw: "100",
    amountUsd: 0.01,
  };
  await wallet.payment(inv);
  await wallet.payment(inv);
  assert.equal(rpc.state.publishes, 1);
  await assert.rejects(
    () => wallet.payment({ ...inv, amountRaw: "101" }),
    /SEND_BINDING_CONFLICT/,
  );
});
test("actual gate commits execution and settlement intents before effects, restart cannot regenerate text", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  let calls = 0;
  const first = gateFixture(store, rpc, async () => {
    calls++;
    assert.equal(
      store.load(`gate:${account}`).data.quotes[0].execution,
      "intent",
    );
    return {
      content: [{ type: "text", text: "PRIVATE-OUTPUT" }],
      textOutput: true,
      costUsd: 0.02,
    };
  });
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  rpc.state.receivable["D".repeat(64)] = { amount: x.amountRaw, source: payer };
  const retry = { name: "poster", arguments: { _payment_id: x.paymentId } };
  const output = await first.wrapped.callTool(retry);
  assert.ok(!output.isError);
  assert.equal(calls, 1);
  await until(() => store.load(`gate:${account}`).data.owed.length === 0);
  const saved = store.load(`gate:${account}`).data;
  assert.equal(saved.quotes[0].settled, true);
  assert.equal(saved.quotes[0].execution, "completed");
  assert.equal(saved.quotes[0].result, null);
  assert.equal(
    store.getSend(`gate:${account}:${x.paymentId}:change`).state,
    "completed",
  );
  assert.equal(rpc.state.publishes, 1);
  // A new gate reading the same canonical revision models a completed-process restart.
  first.gate.stopWatching();
  const second = gateFixture(store, rpc, async () => {
    calls++;
    return { content: [] };
  });
  t.after(() => second.gate.stopWatching());
  const recovered = await second.wrapped.callTool(retry);
  assert.equal(recovered.isError, true);
  assert.match(recovered.content[0].text, /reconciliation/);
  assert.equal(calls, 1);
  assert.equal(rpc.state.publishes, 1);
  const bytes = await readFile(f.path);
  assert.equal(bytes.includes(Buffer.from("PRIVATE-OUTPUT")), false);
});

test("new history scan checkpoints survive a 1000-entry cap and a restart", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const first = gateFixture(store, rpc);
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  first.gate.stopWatching();
  await new Promise((r) => setTimeout(r, 10));
  const send = createBlock(payerSecret, {
    previous: "B".repeat(64),
    representative: payer,
    balance: (balance - BigInt(x.amountRaw)).toString(),
    link: account,
    work: "0".repeat(16),
  });
  const receive = createBlock(secret, {
    previous: "C".repeat(64),
    representative: account,
    balance: (balance + BigInt(x.amountRaw)).toString(),
    link: send.hash,
    work: "0".repeat(16),
  });
  rpc.state.ledger.set(send.hash, {
    confirmed: "true",
    amount: x.amountRaw,
    contents: send.block,
  });
  rpc.state.ledger.set(receive.hash, {
    confirmed: "true",
    amount: x.amountRaw,
    contents: receive.block,
  });
  rpc.state.history = Array.from({ length: 1150 }, (_, i) => ({
    hash: (i + 100).toString(16).padStart(64, "0").toUpperCase(),
    type: "send",
    amount: "1",
  }));
  rpc.state.history[1149] = {
    hash: receive.hash,
    type: "receive",
    amount: x.amountRaw,
    account: payer,
  };
  const second = gateFixture(store, rpc, undefined, { pollMs: 60000 });
  await until(
    () =>
      store.load(`gate:${account}`).data.historyCursor.head ===
      rpc.state.history[1000].hash,
  );
  assert.equal(second.gate.quote(x.paymentId).status, "pending");
  second.gate.stopWatching();
  const third = gateFixture(store, rpc);
  t.after(() => third.gate.stopWatching());
  await until(() => third.gate.quote(x.paymentId).status === "paid");
  assert.equal(store.paymentOwner(send.hash), x.paymentId);
  const cursor = store.load(`gate:${account}`).data.historyCursor;
  assert.equal(cursor.head, null);
  assert.equal(cursor.marker, rpc.state.history[0].hash);
  assert.equal(
    rpc.state.publishes,
    0,
    "history reconciliation cannot send money",
  );
});
test("an interrupted execution is held rather than rerun or refunded after restart", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const first = gateFixture(store, rpc);
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  first.gate.stopWatching();
  await new Promise((r) => setTimeout(r, 10));
  const saved = store.load(`gate:${account}`);
  saved.data.quotes[0].status = "consumed";
  saved.data.quotes[0].execution = "intent";
  store.save(`gate:${account}`, saved.revision, saved.data);
  let calls = 0;
  const second = gateFixture(store, rpc, async () => {
    calls++;
    return { content: [] };
  });
  t.after(() => second.gate.stopWatching());
  const result = await second.wrapped.callTool({
    name: "poster",
    arguments: { _payment_id: x.paymentId },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reconciliation/);
  assert.equal(calls, 0);
  assert.equal(rpc.state.publishes, 0);
});
test("write failure before quote admission cannot issue a payable challenge", async (t) => {
  const f = await fixture(t);
  let fail = false;
  const store = f.open({
      fault: (point) => {
        if (fail && point === "before_commit") throw Error("disk full");
      },
    }),
    rpc = fakeRpc();
  const first = gateFixture(store, rpc);
  t.after(() => first.gate.stopWatching());
  fail = true;
  await assert.rejects(
    () => first.wrapped.callTool({ name: "poster", arguments: {} }),
    /RECOVERY_COMMIT_UNCERTAIN/,
  );
  assert.equal(rpc.state.publishes, 0);
  await assert.rejects(
    () => first.wrapped.callTool({ name: "poster", arguments: {} }),
    /RECOVERY_COMMIT_UNCERTAIN|RECOVERY_STORE_UNAVAILABLE/,
  );
});
test("old JSON import retains money metadata but never retries legacy effects", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { hashArgs } = await import("../src/gate.mjs");
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc(),
    legacy = join(f.dir, "gate-state.json");
  const q = {
    id: "legacy",
    tool: "poster",
    argsHash: hashArgs("poster", {}),
    status: "paid",
    settled: true,
    amountRaw: (5n * 10n ** 28n).toString(),
    usd: 0.05,
    pair: { usdNano: "1000000000", raw: (10n ** 30n).toString() },
    createdAt: Date.now(),
    expiresAt: Date.now() + 900000,
    source: payer,
  };
  const data = {
    v: 2,
    quotes: [q],
    owed: [
      {
        to: payer,
        amountRaw: "100",
        describe: "refunded",
        event: "refund",
        fields: { paymentId: "legacy", reason: "run_failed" },
        tries: 1,
      },
    ],
  };
  const bytes = JSON.stringify(data);
  await writeFile(legacy, bytes);
  const wallet = createNanoWallet({
    secretKey: secret,
    recoveryStore: store,
    fetch: rpc.fetch,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
  });
  const gate = createChargeGate({
    address: account,
    ops: wallet.ops,
    recoveryStore: store,
    stateFile: legacy,
    usd: 0.05,
    xnoUsd: 1,
    publicBase: "http://fixture.invalid",
    pollMs: 5,
  });
  t.after(() => gate.stopWatching());
  const saved = store.load(`gate:${account}`).data;
  assert.equal(saved.quotes[0].recoveryRequired, true);
  assert.equal(saved.owed[0].state, "legacy_uncertain");
  assert.equal(saved.owed[0].legacy, true);
  assert.equal(await readFile(legacy, "utf8"), bytes);
  assert.equal(rpc.state.publishes, 0);
  assert.equal(store.getSend(saved.owed[0].id), null);
});

test("SIGKILL after journal submission preserves the signed operation without a second publish", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const f = await fixture(t);
  const moduleUrl = new URL(
    "../src/payments/recovery-store.mjs",
    import.meta.url,
  ).href;
  const code = `import {openRecoveryStore} from ${JSON.stringify(moduleUrl)};
 const store=openRecoveryStore(process.argv[1]);
 const lease=store.beginSend('op',${JSON.stringify(binding)});store.submitted('op',{...${JSON.stringify(candidate())},epoch:lease.epoch});
 process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, f.path],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL");
  const store = f.open();
  let publishes = 0;
  await assert.rejects(
    () =>
      sender(store, {
        publish: async () => {
          publishes++;
        },
      }).transfer("op", payer, "100"),
    /SEND_CONFIRMATION_REQUIRED/,
  );
  assert.equal(publishes, 0);
  assert.equal(store.getSend("op").hash, candidate().hash);
});
test("unknown or incomplete database schemas fail closed without repairing away financial records", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  const store = f.open();
  store.beginSend("op", binding);
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE consumed_payment");
  db.close();
  assert.throws(() => f.open(), /RECOVERY_SCHEMA_UNSUPPORTED/);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(read.prepare("SELECT id FROM sends").get().id, "op");
  read.close();
});
test("malformed or overflowing baseline cannot create a payable quote", async (t) => {
  for (const response of [
    { history: null, blocks: {} },
    { history: [], blocks: [] },
    {
      history: [],
      blocks: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [
          (i + 1).toString(16).padStart(64, "0"),
          { amount: "1", source: payer },
        ]),
      ),
    },
  ]) {
    const f = await fixture(t),
      store = f.open(),
      rpc = fakeRpc();
    const original = rpc.fetch;
    rpc.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      if (b.action === "account_history")
        return new Response(JSON.stringify({ history: response.history }));
      if (b.action === "receivable")
        return new Response(JSON.stringify({ blocks: response.blocks }));
      return original(url, init);
    };
    const first = gateFixture(store, rpc);
    t.after(() => first.gate.stopWatching());
    await assert.rejects(
      () => first.wrapped.callTool({ name: "poster", arguments: {} }),
      /baseline/,
    );
    assert.equal(store.load(`gate:${account}`).data.quotes.length, 0);
    assert.equal(rpc.state.publishes, 0);
  }
});

test("gate refund recovery after an accepted lost reply performs only read-only reconciliation", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  let blocked = true,
    calls = 0,
    time = Date.now();
  const original = rpc.fetch;
  rpc.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.action === "process") {
      await original(url, init);
      throw Error("accepted but response lost");
    }
    if (b.action === "block_info" && blocked)
      throw Error("confirmation lookup unavailable");
    return original(url, init);
  };
  const first = gateFixture(
    store,
    rpc,
    async () => {
      calls++;
      throw Error("PRIVATE-PROVIDER-ERROR");
    },
    { now: () => time },
  );
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  rpc.state.receivable["E".repeat(64)] = { amount: x.amountRaw, source: payer };
  const retry = { name: "poster", arguments: { _payment_id: x.paymentId } };
  const result = await first.wrapped.callTool(retry);
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.equal(rpc.state.publishes, 1);
  assert.equal(store.load(`gate:${account}`).data.owed[0].state, "uncertain");
  first.gate.stopWatching();
  const second = gateFixture(
    store,
    rpc,
    async () => {
      calls++;
      return { content: [] };
    },
    { now: () => time },
  );
  t.after(() => second.gate.stopWatching());
  await second.wrapped.callTool(retry);
  assert.equal(calls, 1);
  time += 31000;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rpc.state.publishes, 1);
  blocked = false;
  time += 120000;
  await until(() => store.load(`gate:${account}`).data.owed.length === 0);
  assert.equal(second.gate.quote(x.paymentId).status, "refunded");
  assert.equal(rpc.state.publishes, 1);
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(f.dir))
    assert.equal(
      (await readFile(join(f.dir, name))).includes(
        Buffer.from("PRIVATE-PROVIDER-ERROR"),
      ),
      false,
    );
});
test("lost gate completion commit cannot repeat a wallet send already committed as completed", async (t) => {
  const f = await fixture(t);
  let fail = false,
    operationId = null;
  const store = f.open({
      fault: (point, operation) => {
        if (
          fail &&
          point === "before_commit" &&
          operation === "save" &&
          operationId &&
          store.getSend(operationId)?.state === "completed"
        ) {
          fail = false;
          throw Error("completion disk write failed");
        }
      },
    }),
    rpc = fakeRpc();
  const first = gateFixture(store, rpc);
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  operationId = `gate:${account}:${x.paymentId}:change`;
  rpc.state.receivable["F".repeat(64)] = { amount: x.amountRaw, source: payer };
  fail = true;
  await first.wrapped.callTool({
    name: "poster",
    arguments: { _payment_id: x.paymentId },
  });
  await until(() => {
    try {
      store.getSend(operationId);
      return false;
    } catch {
      return true;
    }
  });
  first.gate.stopWatching();
  store.close();
  const restored = f.open();
  let time = Date.now();
  const second = gateFixture(restored, rpc, undefined, { now: () => time });
  t.after(() => second.gate.stopWatching());
  time += 31000;
  await until(() => restored.load(`gate:${account}`).data.owed.length === 0);
  assert.equal(rpc.state.publishes, 1);
  assert.equal(restored.getSend(operationId).state, "completed");
});
test("read-only migration inspection emits only aggregate metadata and preserves its input", async (t) => {
  const { inspectLegacyState } = await import(
    "../scripts/inspect-payment-migration.mjs"
  );
  const { writeFile } = await import("node:fs/promises");
  const f = await fixture(t);
  const file = join(f.dir, "legacy.json");
  const data = { v: 2, quotes: [], owed: [] };
  const bytes = JSON.stringify(data);
  await writeFile(file, bytes);
  const result = inspectLegacyState(data);
  assert.equal(result.automaticLegacyTransfersAllowed, false);
  assert.equal(result.rollbackRequiresJournalAwareWriter, true);
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.throws(
    () => inspectLegacyState({ v: 3, quotes: [], owed: [] }),
    /LEGACY_STATE_INVALID/,
  );
});

test("a missing durable history marker halts reconciliation without advancing past a gap", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const marker = "9".repeat(64);
  rpc.state.history = [{ type: "send", hash: marker, amount: "1" }];
  const first = gateFixture(store, rpc);
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  first.gate.stopWatching();
  await new Promise((r) => setTimeout(r, 10));
  rpc.state.history = [];
  const logs = [];
  const second = gateFixture(store, rpc, undefined, {
    log: (line) => logs.push(line),
  });
  t.after(() => second.gate.stopWatching());
  await until(() =>
    logs.some((line) => line.includes("ended before its durable marker")),
  );
  assert.equal(store.load(`gate:${account}`).data.historyCursor.marker, marker);
  assert.equal(second.gate.quote(x.paymentId).status, "pending");
  assert.equal(rpc.state.publishes, 0);
});
test("concurrent first quotes share one durable baseline", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const original = rpc.fetch;
  let baselines = 0;
  rpc.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "account_history" && body.count === "1") baselines++;
    return original(url, init);
  };
  const first = gateFixture(store, rpc);
  t.after(() => first.gate.stopWatching());
  const results = await Promise.all([
    first.wrapped.callTool({ name: "poster", arguments: { a: 1 } }),
    first.wrapped.callTool({ name: "poster", arguments: { a: 2 } }),
  ]);
  assert.equal(baselines, 1);
  assert.equal(store.load(`gate:${account}`).data.quotes.length, 2);
  assert.notEqual(
    results[0].structuredContent.x402.paymentId,
    results[1].structuredContent.x402.paymentId,
  );
});

test("an unresolved wallet send blocks new paid admission without issuing another quote", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc();
  const lease = store.beginSend("unknown", binding);
  store.submitted("unknown", { ...candidate(), epoch: lease.epoch });
  store.uncertain("unknown");
  const first = gateFixture(store, rpc);
  t.after(() => first.gate.stopWatching());
  await assert.rejects(
    () => first.wrapped.callTool({ name: "poster", arguments: {} }),
    /wallet recovery is pending/,
  );
  assert.equal(store.load(`gate:${account}`).data.quotes.length, 0);
  assert.equal(rpc.state.publishes, 0);
});

test("missing canonical history or signed-operation records cannot silently restart a financial writer", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  for (const missing of ["history", "send"]) {
    const f = await fixture(t),
      store = f.open(),
      rpc = fakeRpc();
    const data = {
      v: 3,
      quotes: [],
      owed: [],
      historyCursor: { marker: null, head: null, newest: null },
    };
    if (missing === "history") delete data.historyCursor;
    if (missing === "send")
      data.owed = [
        {
          id: "op",
          to: payer,
          amountRaw: "100",
          describe: "refunded",
          event: "refund",
          fields: {},
          tries: 1,
          state: "uncertain",
        },
      ];
    store.save(`gate:${account}`, 0, data, {
      intents: missing === "send" ? [{ id: "op", ...binding }] : [],
    });
    if (missing === "send") {
      const db = new DatabaseSync(f.path);
      db.exec("DELETE FROM sends");
      db.close();
    }
    assert.throws(
      () => gateFixture(store, rpc),
      /invalid durable payment history state|cannot restore gate state/,
    );
    assert.equal(rpc.state.publishes, 0);
  }
});

test("a receive cannot publish over another process’s durable signed send", async (t) => {
  const f = await fixture(t),
    a = f.open(),
    b = f.open(),
    rpc = fakeRpc();
  const incoming = "8".repeat(64);
  rpc.state.receivable[incoming] = { amount: "1000", source: payer };
  let readStarted, releaseRead, sendStarted, releaseSend;
  const reading = new Promise((r) => {
      readStarted = r;
    }),
    readGate = new Promise((r) => {
      releaseRead = r;
    });
  const publishing = new Promise((r) => {
      sendStarted = r;
    }),
    sendGate = new Promise((r) => {
      releaseSend = r;
    });
  const original = rpc.fetch;
  let receivePublishes = 0,
    competingReceives = 0,
    firstRead = true;
  async function strictFetch(url, init) {
    const body = JSON.parse(init.body);
    if (body.action === "process") {
      if (body.subtype === "receive") {
        receivePublishes++;
        if (b.activeSend(account)?.id === "other-process-send")
          competingReceives++;
      }
      if (body.block.previous !== rpc.state.frontier)
        return new Response(JSON.stringify({ error: "Fork" }));
    }
    return original(url, init);
  }
  const receiver = createNanoWallet({
    secretKey: secret,
    recoveryStore: a,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "receivable" && firstRead) {
        firstRead = false;
        readStarted();
        await readGate;
      }
      return strictFetch(url, init);
    },
  });
  const senderWallet = createNanoWallet({
    secretKey: secret,
    recoveryStore: b,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "process" && body.subtype === "send") {
        sendStarted();
        await sendGate;
      }
      return strictFetch(url, init);
    },
  });
  const pocket = receiver.ops.pocket();
  await reading;
  const sending = senderWallet.ops.transferId(
    "other-process-send",
    payer,
    "100",
  );
  sending.catch(() => {});
  await publishing;
  assert.equal(b.getSend("other-process-send").state, "submitted");
  try {
    releaseRead();
    await pocket;
    assert.equal(
      competingReceives,
      0,
      "housekeeping must not publish while another process owns the account",
    );
    assert.equal(receivePublishes, 0);
    releaseSend();
    await sending;
    assert.equal(b.getSend("other-process-send").state, "completed");
    await receiver.ops.pocket();
    assert.equal(
      receivePublishes,
      1,
      "the deferred receive can run after the send completes",
    );
  } finally {
    releaseRead();
    releaseSend();
    await Promise.allSettled([pocket, sending]);
  }
});

test("a workflow receipt cannot claim change was returned before the queued send is confirmed", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc(),
    original = rpc.fetch;
  let release;
  const processGate = new Promise((r) => {
    release = r;
  });
  rpc.fetch = async (url, init) => {
    if (JSON.parse(init.body).action === "process") await processGate;
    return original(url, init);
  };
  const first = gateFixture(store, rpc);
  const x = (await first.wrapped.callTool({ name: "poster", arguments: {} }))
    .structuredContent.x402;
  rpc.state.receivable["7".repeat(64)] = { amount: x.amountRaw, source: payer };
  try {
    const result = await first.wrapped.callTool({
      name: "poster",
      arguments: { _payment_id: x.paymentId },
    });
    const receipt = result.content.at(-1).text;
    assert.doesNotMatch(receipt, /change returned to your wallet/);
    assert.match(receipt, /change queued for return/);
  } finally {
    release();
    await until(() => store.load(`gate:${account}`).data.owed.length === 0);
    first.gate.stopWatching();
  }
});

test("account-slot generations fence a stale preparation after release and reacquisition", async (t) => {
  const f = await fixture(t),
    store = f.open();
  const old = store.beginSend("same-operation", binding);
  store.releaseUnsigned("same-operation", old.epoch);
  const receiveCycle = store.beginSend("receive-cycle", {
    account,
    to: "F".repeat(64),
    amountRaw: "1000",
  });
  store.releaseUnsigned("receive-cycle", receiveCycle.epoch);
  const fresh = store.beginSend("same-operation", binding);
  assert.ok(fresh.epoch > old.epoch);
  store.releaseUnsigned("same-operation", old.epoch);
  assert.equal(
    store.activeSend(account).epoch,
    fresh.epoch,
    "a stale callback cannot unlock the new generation",
  );
  assert.throws(
    () =>
      store.submitted("same-operation", { ...candidate(), epoch: old.epoch }),
    /ACCOUNT_WRITER_FENCED/,
  );
  assert.equal(store.getSend("same-operation").state, "intent");
  let publishes = 0;
  const c = candidate(payer, "100", "B".repeat(64));
  const run = sender(store, {
    prepare: async () => c,
    publish: async () => {
      publishes++;
    },
    lookup: async () => confirmed(c),
  });
  assert.equal(await run.transfer("same-operation", payer, "100"), c.hash);
  assert.equal(publishes, 1);
});

test("two receive workers publish one committed winner under the shared account slot", async (t) => {
  const { createDurableReceiver } = await import(
    "../src/payments/durable-send.mjs"
  );
  const f = await fixture(t),
    a = f.open(),
    b = f.open(),
    sourceHash = "F".repeat(64);
  const c = createBlock(secret, {
    previous: frontier,
    representative: account,
    balance: (balance + 1000n).toString(),
    link: sourceHash,
    work: "0".repeat(16),
  });
  c.block.account = account;
  delete c.block.link_as_account;
  let ready = 0,
    release,
    publishes = 0;
  const both = new Promise((r) => {
    release = r;
  });
  const options = {
    account,
    publicKey,
    crypto: { checkAddress, hashBlock, verifyBlock, deriveAddress },
    prepare: async () => {
      if (++ready === 2) release();
      await both;
      return { ...c, previousBalance: balance.toString() };
    },
    publish: async () => {
      publishes++;
      assert.equal(a.activeSend(account).id, "shared-receive");
    },
    lookup: async () => ({
      confirmed: "true",
      amount: "1000",
      contents: c.block,
    }),
  };
  const first = createDurableReceiver({ ...options, store: a }),
    second = createDurableReceiver({ ...options, store: b });
  const results = await Promise.all([
    first.receive("shared-receive", sourceHash.toLowerCase(), "1000"),
    second.receive("shared-receive", sourceHash, "1000"),
  ]);
  assert.deepEqual(results, [c.hash, c.hash]);
  assert.equal(publishes, 1);
  assert.equal(a.activeSend(account), null);
});

test("an uncertain receive survives restart and blocks sends until read-only confirmation succeeds", async (t) => {
  const f = await fixture(t),
    a = f.open(),
    b = f.open(),
    rpc = fakeRpc(),
    original = rpc.fetch;
  rpc.state.receivable["6".repeat(64)] = { amount: "1000", source: payer };
  let blockProof = true;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === "process" && body.subtype === "receive") {
      await original(url, init);
      throw Error("lost receive reply");
    }
    if (body.action === "block_info" && blockProof)
      throw Error("receive proof unavailable");
    return original(url, init);
  };
  const first = createNanoWallet({
    secretKey: secret,
    recoveryStore: a,
    fetch,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
  });
  await first.ops.pocket();
  const pending = a.activeSend(account);
  assert.match(pending.id, /^receive:/);
  assert.equal(pending.state, "uncertain");
  assert.equal(rpc.state.publishes, 1);
  a.close();
  const second = createNanoWallet({
    secretKey: secret,
    recoveryStore: b,
    fetch,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
  });
  await assert.rejects(
    () => second.ops.transferId("after-receive", payer, "100"),
    /RECONCILIATION/,
  );
  assert.equal(rpc.state.publishes, 1);
  assert.equal(b.getSend("after-receive"), null);
  blockProof = false;
  await second.ops.transferId("after-receive", payer, "100");
  assert.equal(rpc.state.publishes, 2);
  assert.equal(b.getSend(pending.id).state, "completed");
  assert.equal(b.getSend("after-receive").state, "completed");
});

test("short-balance funding commits a receive before claiming and publishing its send", async (t) => {
  const f = await fixture(t),
    store = f.open(),
    rpc = fakeRpc(),
    original = rpc.fetch;
  rpc.state.balance = 10n;
  rpc.state.receivable["5".repeat(64)] = { amount: "1000", source: payer };
  const order = [];
  const wallet = createNanoWallet({
    secretKey: secret,
    recoveryStore: store,
    rpcUrl: "http://fixture.invalid",
    localWork: false,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === "process") {
        assert.equal(body.block.previous, rpc.state.frontier);
        order.push(body.subtype);
        assert.equal(
          store.activeSend(account).id,
          body.subtype === "receive"
            ? `receive:${account}:${"5".repeat(64)}`
            : "funded-send",
        );
      }
      return original(url, init);
    },
  });
  await wallet.ops.transferId("funded-send", payer, "500");
  assert.deepEqual(order, ["receive", "send"]);
  assert.equal(rpc.state.balance, 510n);
  assert.equal(store.activeSend(account), null);
});

test("the unfenced schema-1 candidate is refused without modifying its financial records", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t),
    store = f.open();
  store.beginSend("preserved", binding);
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE recovery_schema SET version=1");
  db.close();
  const before = await readFile(f.path);
  assert.throws(() => f.open(), /RECOVERY_SCHEMA_UNSUPPORTED/);
  assert.deepEqual(await readFile(f.path), before);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(read.prepare("SELECT id FROM sends").get().id, "preserved");
  read.close();
});

test("a missing durable account slot cannot silently admit a new writer over an unresolved block", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t),
    store = f.open();
  const lease = store.beginSend("preserved", binding);
  store.submitted("preserved", { ...candidate(), epoch: lease.epoch });
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec("DELETE FROM active_send");
  db.close();
  const before = await readFile(f.path);
  assert.throws(() => f.open(), /RECOVERY_ACCOUNT_STATE_INVALID/);
  assert.deepEqual(await readFile(f.path), before);
  const read = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(
    read.prepare("SELECT state FROM sends").get().state,
    "submitted",
  );
  read.close();
});
