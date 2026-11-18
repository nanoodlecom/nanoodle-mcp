import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { hashBlock } from "nanocurrency";
import { runOperationalCheck, finishOperationalReport, isMarketWorkerAlive } from "../scripts/operational-check.mjs";
import { deliverAlerts, EMBER, failureEvent } from "../scripts/near-alert.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";
import { nearProtocol } from "./fixtures/near-fees.mjs";
import { rpcPeerSetId } from "../src/rpc-backoff.mjs";
import { parseNearSecretKey, USDC_CONTRACTS } from "../src/near/index.mjs";
import { signTransfer } from "../src/near/tx.mjs";
import { base58Encode } from "../src/near/base58.mjs";
import { nearFundingNeed, nearRefundClaims, nearRefundCosts } from "../src/near/funding.mjs";

const NOW = Date.parse("2026-11-17T01:00:00Z"), ID = "00000000-0000-0000-0000-000000000001";

function rawHistory(request, receive = null) {
  const previous = "E".repeat(64);
  const history = [{ hash: request.head, type: "state", subtype: "change",
    height: "10", confirmed: "true", previous: receive?.hash ?? previous }];
  if (receive) history.push({ height: "9", confirmed: "true", previous, ...receive });
  return { account: request.account, history, previous };
}

test("the readiness CLI reports preflight failure when run through a release symlink", t => {
  const root = mkdtempSync(join(tmpdir(), "operational-check-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = join(root, "current"), stateDir = join(root, "state");
  symlinkSync(fileURLToPath(new URL("..", import.meta.url)), selected, "junction");
  // No wallet configuration or inherited runtime flags. Preflight stops before networking.
  const invocationId = "a".repeat(32);
  const child = spawnSync(process.execPath, [join(selected, "scripts/operational-check.mjs")], {
    env: { OPERATIONAL_CHECK_STATE_DIR: stateDir, INVOCATION_ID: invocationId }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.invocationId, invocationId);
  assert.equal(report.checks[0].code, "check-could-not-finish");
});

test("Market liveness follows the selected release and rejects a worker left behind by a switched symlink", async t => {
  const root = mkdtempSync(join(tmpdir(), "operational-market-release-")), children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }));
    rmSync(root, { recursive: true, force: true });
  });
  const old = join(root, "old"), next = join(root, "next"), current = join(root, "current");
  for (const dir of [old, next]) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin/nanoodle-mcp.mjs"), 'console.log("ready"); setInterval(() => {}, 1000);');
  }
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), host = hostname();
  const start = async directory => {
    const child = spawn(process.execPath, [join(directory, "bin/nanoodle-mcp.mjs")],
      { cwd: directory, env: {}, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => assert.fail("Worker fixture exited early"))]);
    return { pid: child.pid, boot, host };
  };
  assert.equal(isMarketWorkerAlive(await start(old), old), true, "the legacy layout still works");
  symlinkSync(old, current);
  const original = await start(current);
  assert.equal(isMarketWorkerAlive(original, old), true);
  symlinkSync(next, current + ".new"); renameSync(current + ".new", current);
  assert.equal(isMarketWorkerAlive(original, next), false, "resolving argv alone would mistake the original worker for its replacement");
  assert.equal(isMarketWorkerAlive(await start(current), next), true);
  assert.throws(() => isMarketWorkerAlive({ ...original, boot: "foreign" }, next), /market-worker-lock-is-foreign/);
});

const SAVED_TOOLS = ["image-model-arena", "mix-the-references", "neon-shrine-duel", "photo-to-video", "sing"];
const toolsList = (deposit = "0.05") => [
  ...SAVED_TOOLS.map(name => ({ name, description: `Runs on NanoGPT — $${deposit} deposit per call, paid in Nano (XNO) — settles at actual model cost + 20%` })),
  ...["price_noodle", "run_noodle", "noodle_guide"].map(name => ({ name })),
];
const pricePreview = (asset) => ({
  pricing: { currency: "USD", estimatedCost: { usd: "0.01" }, likelyCharge: { usd: "0.012" }, deposit: { usd: "0.03" },
    safety: { ok: true }, unpriced: [] },
  ...(asset === "usdc" ? { usdc: { network: "mainnet", tokenContract: USDC_CONTRACTS.mainnet, decimals: 6, usdcUsd: "1" } }
    : { near: { network: "mainnet", rate: { nearUsd: "3" }, likelyChargeNear: "0.004", depositNear: "0.01" } }),
});

function fixture(override = () => null) {
  const calls = [], stateDir = mkdtempSync(join(tmpdir(), "operational-check-"));
  const config = { stateDir, outDir: "/state", marketStateDir: "/jobs", network: "mainnet", merchant: "nanoodle.near", nearPublicKey: "ed25519:public",
    nanoAddress: NANO_GENESIS_REPLY.contents.account, nanoRpcUrls: ["https://nano-0.example", "https://nano-1.example"], nearRpcUrls: ["https://near-0.example", "https://near-1.example"],
    site: "https://site.example", nanoSite: "https://nano-site.example", marketUrl: "https://market.example", nanoGptBase: "https://models.example",
    agents: [{ handle: "nanoodle-image", tokenFile: "/private-token", defaultWorkflow: { graph: { v: 1, nodes: [], links: [] }, inputName: "Idea" } }] };
  const states = {
    "/state/gate-state.json": { v: 2, quotes: [], owed: [] },
    "/state/funding-health.json": { v: 1, checkedAt: new Date(NOW).toISOString(), ok: true, enforced: true, protectTransfers: true,
      writerProtection: { enforced: true, requiredState: true },
      balanceRaw: String(10n * 10n ** 30n), liabilitiesRaw: "100", reservedRaw: "200", activeRuns: 0, oldestStartedAt: null,
      nanoRpc: { enforced: true, configuredPeers: 2, minimumPeers: 2, networkPeers: 2, readablePeers: 2, lastReadAt: NOW,
        checkpoint: { v: 1, networkGenesis: NANO_GENESIS_HASH, account: config.nanoAddress,
          head: { hash: "A".repeat(64), blockCount: "10" }, confirmed: { hash: "A".repeat(64), blockCount: "10" } } } },
    "/state/near-state.json": { v: 1, network: "mainnet", merchant: "nanoodle.near", quotes: {}, refunds: {}, payouts: {} },
    "/jobs/nanoodle-image/market-state.json": { v: 1, assignments: {} },
    "/jobs/nanoodle-image/worker.lock": { pid: 1 },
  };
  const deps = {
    now: () => NOW, readJson: path => states[path], readText: () => "SYNTHETIC_PRIVATE_TOKEN",
    statfs: () => ({ bavail: 1e6, blocks: 2e6, bsize: 4096, ffree: 1e6 }),
    isWorkerAlive: () => true,
    probeStateWrite: () => {},
    unitState: unit => unit.endsWith(".timer") ? { ActiveState: "active", UnitFileState: "enabled", LastTriggerUSec: "@" + String(NOW / 1000) } : { ActiveState: "inactive", Result: "success" },
    computePrice: async () => ({ safety: { ok: true }, pricing: { estimatedCostUsd: 0.01, likelyChargeUsd: 0.012 } }),
    fetch: async (input, init = {}) => {
      const url = new URL(input), body = init.body ? JSON.parse(init.body) : null;
      const call = { url, init, body }; calls.push(call);
      assert.equal(init.redirect, "error"); assert.ok(init.signal);
      const replaced = override(call, config, states); if (replaced) return replaced;
      const json = result => Response.json(body?.jsonrpc ? { jsonrpc: "2.0", id: body.id, result } : result);
      if (/^nano-\d/.test(url.hostname)) {
        if (body.action === "block_info") return json(NANO_GENESIS_REPLY);
        if (body.action === "account_history") {
          assert.equal(body.raw, "true");
          return json(rawHistory(body));
        }
        if (body.action === "receivable") return json({ blocks: "" });
        assert.equal(body.action, "account_info");
        return json(nanoAccountInfo({ frontier: "A".repeat(64), balance: "10000000000000000000000000000000" }));
      }
      if (url.hostname.startsWith("near-")) {
        if (body.method === "status") return json({ chain_id: "mainnet", sync_info: { syncing: false } });
        if (body.method === "block") return json({ header: { height: 100, hash: "same-block", timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } });
        if (body.method === "gas_price") return json({ gas_price: "100000000" });
        if (body.method === "EXPERIMENTAL_protocol_config") {
          return json(nearProtocol({ chainId: "mainnet" }));
        }
        if (body.method === "query") {
          const at = { block_height: 100, block_hash: "same-block" };
          if (body.params.request_type === "view_access_key") return json({ permission: "FullAccess", nonce: 100, ...at });
          if (body.params.request_type === "view_account") return json({ amount: "1000000000000000000000000", storage_usage: 500, ...at });
          if (body.params.request_type === "call_function") {
            const results = { ft_metadata: { spec: "ft-1.0.0", symbol: "USDC", decimals: 6 }, storage_balance_of: { total: "1" }, ft_balance_of: "1000000" };
            assert.ok(body.params.method_name in results);
            return json({ result: [...Buffer.from(JSON.stringify(results[body.params.method_name]))], ...at });
          }
        }
        assert.fail("Unexpected NEAR RPC: " + body.method);
      }
      if (url.hostname === "site.example" || url.hostname === "nano-site.example") {
        if (url.pathname === "/rates") return json({ quoting: true, nearUsd: "3", xnoUsd: "1", sources: Object.fromEntries(["nearUsd", "xnoUsd"].map(name => [name, { usable: true, live: true, at: new Date(NOW).toISOString() }])) });
        if (url.pathname === "/near/health") return json({ active: true, network: "mainnet", merchant: "nanoodle.near",
          funding: { enforced: true, ok: true, checkedAt: NOW, canQuoteNear: true, canQuoteUsdc: true }, watcher: { listening: true, lastScanAt: new Date(NOW).toISOString(), height: 100, backfilling: false } });
        const near = url.hostname === "site.example";
        const unissued = near ? "/nq_operational_probe_unissued" : "/pay_operational_probe_unissued";
        const prefix = near ? "/near" : "/x402";
        if (url.pathname.endsWith(unissued)) {
          assert.equal(init.method || "GET", "GET");
          assert.equal(body, null);
          const missing = { status: "unknown", done: true, next: "Ask for a fresh quote." };
          if (url.pathname.startsWith("/pay/")) return new Response("<h1>Unknown or expired payment</h1>", { status: 404, headers: { "content-type": "text/html" } });
          if (url.pathname.startsWith(prefix + "/status/")) {
            assert.equal(url.searchParams.get("wait"), "1");
            return Response.json(missing, { status: near ? 404 : 200 });
          }
          if (url.pathname.startsWith(prefix + "/watch/")) {
            assert.equal(url.searchParams.get("run"), near ? "1" : null);
            return new Response(`event: status\ndata: ${JSON.stringify(missing)}\n\n`, { headers: { "content-type": "text/event-stream" } });
          }
          if (url.pathname.startsWith("/near/result/")) return Response.json({ error: "Unknown or expired payment" }, { status: 404 });
        }
        if (/^\/(?:graph|examples)\//.test(url.pathname)) {
          assert.equal(init.method || "GET", "GET");
          const name = url.pathname.split("/")[2].slice(0, -5);
          return json({ v: 1, name, nodes: [{ id: "input", type: "text", fields: { text: "sample" } }], links: [] });
        }
        if (body.method === "initialize") return json({ serverInfo: { name: "nanoodle" } });
        if (body.method === "tools/list") return json({ tools: toolsList() });
        assert.equal(body.method, "tools/call"); assert.equal(body.params.name, "price_noodle", "never execute a paid tool or request a deposit");
        return json({ structuredContent: pricePreview(body.params.arguments._pay_with) });
      }
      if (url.hostname === "market.example") {
        assert.equal(init.method || "GET", "GET", "Market probes never mutate jobs/listings");
        if (url.pathname === "/v1/platform/config") return json({ platform_fee_bps: 500 });
        if (url.pathname === "/v1/agents/me/assignments") {
          assert.equal(init.headers.authorization, "Bearer SYNTHETIC_PRIVATE_TOKEN");
          return json({ assignments: [], ignored_private_content: "PRIVATE_BUYER_TEXT" });
        }
        if (url.pathname === "/v1/agents/nanoodle-image") return json({ agent_id: ID, handle: "nanoodle-image" });
        if (url.pathname === `/v1/agents/${ID}/pricing-plans`) return json([{ is_default: true, price_amount: "1.00", listing_status: "live" }]);
      }
      assert.fail(`Unexpected request ${url.hostname}${url.pathname}`);
    },
  };
  return { config, deps, calls, states };
}

test("operational probes cover live readiness with no inference, signing or Market mutation and a redacted report", async () => {
  const f = fixture(), before = JSON.stringify(f.states);
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, true); assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.ok(report.checks.some(c => c.stage === "nano-liquidity")); assert.ok(report.checks.some(c => c.stage === "usdc-liquidity"));
  assert.ok(report.checks.some(c => c.stage === "workflow-price-nanoodle-image"));
  assert.ok(report.checks.some(c => c.stage === "runtime-funding" && c.ok));
  for (const stage of ["nano-payment-page", "nano-payment-status-route", "nano-payment-event-stream",
    "near-payment-page", "near-payment-status-route", "near-payment-event-stream", "near-payment-result-route"]) {
    assert.ok(report.checks.some(c => c.stage === stage && c.ok));
  }
  const saved = report.checks.filter(c => c.stage.startsWith("saved-workflow-"));
  assert.equal(saved.length, 17);
  assert.ok(saved.every(c => c.ok));
  assert.equal(f.calls.filter(c => c.url.hostname === "nano-site.example" && c.url.pathname.startsWith("/graph/")).length, 5);
  assert.equal(f.calls.filter(c => c.url.hostname === "site.example" && c.url.pathname.startsWith("/graph/")).length, 5);
  const file = join(f.config.stateDir, "latest.json"), text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /SYNTHETIC|PRIVATE_BUYER|public|ed25519|assignment|account_id/);
  assert.equal(statSync(file).mode & 0o777, 0o644); assert.equal(JSON.stringify(f.states), before);
});

test("the scheduled check alerts when the payment stream stops returning a terminal status frame", async t => {
  for (const [rail, path, domains, done] of [
    ["near", "/near/watch/", ["near", "usdc"], false],
    ["nano", "/x402/watch/", ["nano"], false],
    ["nano", "/x402/watch/", ["nano"], true],
  ]) {
    const frame = { status: "unknown", done, private: "PRIVATE_BODY" };
    const f = fixture(({ url }) => url.pathname.startsWith(path)
      ? new Response(`event: status\ndata: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    assert.deepEqual(report.checks.filter(c => !c.ok), [{ stage: `${rail}-payment-event-stream`, ok: false,
      code: `${rail}-payment-stream-response-invalid`, domains }]);
    assert.deepEqual(report.admission, { nano: rail !== "nano", near: rail !== "near", usdc: rail !== "near", market: true });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY/);
  }
});

test("the Nano checkout probe expects the existing unknown-payment status contract", async t => {
  const f = fixture(({ url }) => url.pathname.startsWith("/x402/status/")
    ? Response.json({ status: "unknown", done: true, next: "Ask for a fresh quote." }, { status: 404 })
    : null);
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.filter(c => !c.ok), [{ stage: "nano-payment-status-route", ok: false,
    code: "nano-payment-status-response-invalid", domains: ["nano"] }]);
  assert.deepEqual(report.admission, { nano: false, near: true, usdc: true, market: true });
});

test("the scheduled check flags a late Nano deposit that lacks a refund record on a legacy writer", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.states["/state/gate-state.json"].quotes.push({ id: "private-nano-quote", status: "expired", payHash: "private-nano-hash",
    expiresAt: NOW - 1_000_001, paidAt: NOW - 1_000_000, amountRaw: "2000" });
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === "nano-late-refund-intent-unknown"), { stage: "nano-late-refund-intent-unknown",
    ok: false, code: "nano-late-refund-intent-unknown", domains: [] });
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-nano-/);
});

test("the scheduled check detects legacy send debt and a Nano block claimed by two obligations", async t => {
  const f = fixture(), hash = "A".repeat(64);
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.states["/state/gate-state.json"].owed.push(
    { amountRaw: "10", event: "refund", fields: { paymentId: "private-fixture-legacy" }, createdAt: NOW },
    { amountRaw: "10", event: "change", fields: { paymentId: "private-fixture-quote" }, createdAt: NOW, journaled: true, prepared: { hash } },
  );
  f.states["/state/near-state.json"].payouts = { fixture: { paymentId: "private-fixture-creator", amountRaw: "10", status: "sent", txHash: hash } };
  const report = await runOperationalCheck(f.config, f.deps);
  for (const stage of ["nano-settlement-legacy-unverified", "nano-settlement-duplicate-block"]) {
    assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: false, code: stage, domains: [] });
  }
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-fixture-|AAAAAAA/);
});

test("Nano checkout detects stale coverage only while a quote has been waiting", async t => {
  for (const [scenario, coveredAt, waiting, createdAt, code] of [
    ["current", NOW - 120_000, true, NOW - 180_000, undefined],
    ["stale", NOW - 120_001, true, NOW - 180_000, "nano-payment-coverage-stale"],
    ["missing", null, true, NOW - 180_000, "nano-payment-coverage-stale"],
    ["future", NOW + 31_000, true, NOW - 180_000, "nano-payment-coverage-invalid"],
    ["idle", NOW - 600_000, false, NOW - 180_000, undefined],
    ["recent quote", null, true, NOW - 119_999, undefined],
  ]) {
    const f = fixture();
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const ledger = f.states["/state/gate-state.json"];
    ledger.historyScan = { through: null, coveredAt, backfill: null };
    if (waiting) ledger.quotes.push({ id: "private-watched-quote", status: "pending", amountRaw: "50000000000000000000000",
      createdAt, expiresAt: NOW + 600_000 });
    const report = await runOperationalCheck(f.config, f.deps);
    const probe = report.checks.find(c => c.stage === "nano-payment-scan-progress");
    assert.equal(probe?.ok, code === undefined, scenario);
    assert.equal(probe?.code, code, scenario);
    assert.deepEqual(report.admission, { nano: code === undefined, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /private-watched-quote|coveredAt/);
  }
});

test("a legacy Nano writer alerts on an aged confirmed matching transfer missing from its ledger", async t => {
  const account = NANO_GENESIS_REPLY.contents.account;
  const sender = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
  const amount = "50000000000000000000123";
  const block = { type: "state", account: sender, representative: sender, balance: "10000000000000000000000000000000",
    previous: "C".repeat(64), link: NANO_GENESIS_REPLY.contents.source };
  const hash = hashBlock(block), receiveHash = "D".repeat(64);
  for (const scenario of ["receivable", "already-pocketed", "fresh", "old", "unconfirmed", "fallback",
    "recorded-during-read", "known-receive-alias", "observation-unavailable"]) {
    const f = fixture(({ url, body }, _config, states) => {
      if (!/^nano-\d/.test(url.hostname) || !["receivable", "account_history", "block_info"].includes(body?.action)) return null;
      if (body.action !== "block_info") assert.equal(body.account, account);
      if (body.action === "receivable") {
        assert.equal(body.include_only_confirmed, "true");
        return Response.json({ blocks: scenario === "already-pocketed" ? {} : { [hash]: { amount, source: sender } } });
      }
      if (body.action === "account_history") {
        assert.equal(body.raw, "true");
        if (scenario === "observation-unavailable" || (scenario === "fallback" && url.hostname === "nano-0.example")) {
          return new Response(null, { status: 503 });
        }
        const receive = ["already-pocketed", "known-receive-alias"].includes(scenario) ? {
          type: "state", subtype: "receive", hash: receiveHash, link: hash, amount, account: sender,
        } : null;
        return Response.json(rawHistory(body, receive));
      }
      if (body.hash !== hash) return null;
      if (scenario === "recorded-during-read") Object.assign(states["/state/gate-state.json"].quotes[0], { status: "paid", payHash: hash });
      const at = NOW - (scenario === "fresh" ? 60_000 : scenario === "old" ? 600_000 : 180_000);
      return Response.json({ confirmed: scenario !== "unconfirmed", subtype: "send", amount,
        local_timestamp: String(at / 1000), contents: block });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const expired = scenario === "already-pocketed";
    const ledger = f.states["/state/gate-state.json"];
    ledger.quotes.push({ id: "private-watched-quote", status: expired ? "expired" : "pending",
      amountRaw: "50000000000000000000000", createdAt: NOW - 300_000, expiresAt: NOW + (expired ? -60_000 : 600_000) });
    if (scenario === "known-receive-alias") ledger.quotes.push({ id: "recorded", status: "paid", settled: true,
      amountRaw: "40000000000000000000000", payHash: receiveHash });
    const report = await runOperationalCheck(f.config, f.deps);
    const missed = ["receivable", "already-pocketed", "fallback"].includes(scenario);
    const probe = report.checks.find(c => c.stage === "nano-payment-scan-progress");
    assert.equal(probe?.ok, !missed, scenario);
    assert.equal(probe?.code, missed ? "nano-confirmed-payment-unrecorded" : undefined, scenario);
    assert.deepEqual(report.admission, { nano: !missed, near: true, usdc: true, market: true }, scenario);
    if (scenario === "observation-unavailable") assert.deepEqual(report.checks.find(c => c.stage === "nano-legacy-payment-observation"),
      { stage: "nano-legacy-payment-observation", ok: false, code: "http-503", domains: [] });
    assert.doesNotMatch(JSON.stringify(report), /private-watched-quote|50000000000000000000123/);
    assert.ok(!JSON.stringify(report).includes(hash));
    if (scenario === "known-receive-alias") assert.ok(!f.calls.some(c => c.body?.hash === hash));
  }
});

test("the scheduled check detects overdue Nano execution and unverified legacy execution without inference", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.states["/state/gate-state.json"].quotes.push(
    { id: "private-exec-overdue", amountRaw: "10", status: "consumed", runDeadlineAt: NOW - 300_001 },
    { id: "private-exec-legacy", amountRaw: "10", status: "paid", executionNeedsReconciliation: true },
    { id: "private-exec-ready", amountRaw: "10", status: "paid", runDeadlineAt: null, paidAt: NOW },
  );
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.filter(c => c.stage.startsWith("nano-execution-")).map(({ stage, ok, code }) => ({ stage, ok, code })), [
    { stage: "nano-execution-legacy-unverified", ok: false, code: "nano-execution-legacy-unverified" },
    { stage: "nano-execution-overdue", ok: false, code: "nano-execution-overdue" },
  ]);
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-exec-/);
});

test("the scheduled check reserves incomplete Nano settlements and flags their evidence without inference", async t => {
  const f = fixture(), source = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.states["/state/gate-state.json"].quotes.push({
    id: "private-payment-proof", status: "paid", settled: true, runDeadlineAt: NOW,
    amountRaw: "100", source, settleReceipt: { author: false, authorAddress: null, change: "70", take: "0" },
    transferReceipts: { change: { to: source, amountRaw: "40", hash: "A".repeat(64) } },
  }, {
    id: "private-refund-proof", status: "refunded", refundExpected: true, amountRaw: "50", source,
  });
  const report = await runOperationalCheck(f.config, f.deps);
  for (const stage of ["nano-settlement-intent-missing", "nano-settlement-evidence-mismatch"]) {
    assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: false, code: stage, domains: [] });
  }
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-payment-proof|private-refund-proof|AAAAAAA|nano_3t6k35/);
});

test("the scheduled check detects NEAR, USDC and Market settlement mismatches without inference", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const state = f.states["/state/near-state.json"];
  state.quotes = { privateJob: { id: "private-near-job", status: "settled", payer: "private.testnet",
    asset: "usdc", tokenContract: f.config.usdcToken, refundId: "private-refund",
    settlement: { refundYocto: "70", authorPayout: { amountRaw: "30", to: "private-author" } } } };
  state.refunds = { refund: { id: "private-refund", paymentId: "private-near-job", status: "sent",
    asset: "near", amountYocto: "10", to: "private.testnet", txHash: "private-transaction" },
    previous: { id: "private-previous-refund", paymentId: "private-old-job", status: "sent",
      amountYocto: "10", supersededTxHashes: ["private-transaction"] } };
  const signer = parseNearSecretKey(`ed25519:${base58Encode(Buffer.alloc(32, 38))}`);
  const proof = signTransfer({ signer, signerId: f.config.merchant, receiverId: "private-actual.testnet", nonce: 17n,
    blockHash: base58Encode(Buffer.alloc(32, 39)), amountYocto: 20n });
  state.refunds.invalidProof = { id: "private-proof", paymentId: "private-old-proof", status: "sent",
    amountYocto: "20", to: "private-recorded.testnet", ...proof };
  state.payouts = { near: { paymentId: "private-near-job", status: "sent", amountRaw: "15", to: "private-author" },
    market: { paymentId: "market_private-market-job", status: "sent", amountRaw: "15", to: "wrong-author" } };
  const marketFile = Object.keys(f.states).find(path => path.endsWith("/market-state.json"));
  f.states[marketFile].assignments = { job: { id: "private-market-job", phase: "submitted",
    creator: { status: "queued", author: "private-author", amountRaw: "30" } } };
  const report = await runOperationalCheck(f.config, f.deps);
  for (const stage of ["near-refund-evidence-mismatch", "creator-payout-evidence-mismatch", "near-refund-duplicate-transaction",
    "near-refund-signed-terms-mismatch"]) {
    assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: false, code: stage, domains: [] });
  }
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-near-job|private-refund|private-market-job|private\.testnet|private-author|wrong-author|private-transaction/);
  assert.doesNotMatch(JSON.stringify(report), /private-actual|private-recorded|private-proof/);
  assert.ok(!JSON.stringify(report).includes(proof.signedTxBase64));
  assert.ok(!JSON.stringify(report).includes(proof.txHash));
});

test("the VPS monitor reports backup capture and export age without closing payment admission", async t => {
  const f = fixture(), date = at => new Date(at).toISOString();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.config.backupExportReport = "/backup-health/latest.json";
  const proof = { v: 1, capturedAt: date(NOW - 27 * 3600_000), verifiedAt: date(NOW - 3 * 3600_000),
    path: "private-archive-path" };
  f.states[f.config.backupExportReport] = proof;
  const report = await runOperationalCheck(f.config, f.deps);
  for (const [stage, code] of [["backup-export-freshness", "backup-export-overdue"], ["backup-capture-freshness", "backup-capture-overdue"]]) {
    assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: false, code, domains: [] });
  }
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-archive-path|\/backup-health|2026-11-1[56]T/);
  const alert = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: ID.replaceAll("-", ""),
    MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" },
    { ...report, invocationId: ID.replaceAll("-", "") }, NOW);
  assert.match(alert.text, /backup-capture-overdue/);
  assert.match(alert.text, /backup-export-overdue/);
  assert.doesNotMatch(alert.text, /private-archive-path/);

  proof.verifiedAt = date(NOW - 60_000);
  const currentExport = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(currentExport.checks.find(c => c.stage === "backup-export-freshness"), { stage: "backup-export-freshness", ok: true });
  assert.equal(currentExport.checks.find(c => c.stage === "backup-capture-freshness").code, "backup-capture-overdue");
  proof.verifiedAt = date(NOW + 60_000);
  const future = await runOperationalCheck(f.config, f.deps);
  assert.equal(future.checks.find(c => c.stage === "backup-export-proof").code, "backup-export-proof-invalid");
  const read = f.deps.readJson;
  f.deps.readJson = path => {
    if (path === f.config.backupExportReport) throw Error("backup report unavailable");
    return read(path);
  };
  const missing = await runOperationalCheck(f.config, f.deps);
  assert.equal(missing.checks.find(c => c.stage === "backup-export-proof").code, "backup-export-proof-unavailable");
});

test("an up-to-date VPS export cannot hide a missing or stale offsite verification", async t => {
  const f = fixture(), date = at => new Date(at).toISOString();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.config.backupExportReport = "/backup-export/latest.json";
  f.config.backupCopyReport = "/backup-copy/latest.json";
  const local = { v: 1, capturedAt: date(NOW - 4 * 3600_000), verifiedAt: date(NOW - 60_000) };
  const copy = { ...local, verifiedAt: date(NOW - 2 * 3600_000 - 1), archive: "private-offsite-path" };
  f.states[f.config.backupExportReport] = local;
  f.states[f.config.backupCopyReport] = copy;
  const report = await runOperationalCheck(f.config, f.deps);
  assert.ok(report.checks.find(c => c.stage === "backup-export-freshness")?.ok);
  assert.deepEqual(report.checks.find(c => c.stage === "backup-copy-freshness"),
    { stage: "backup-copy-freshness", ok: false, code: "backup-copy-overdue", domains: [] });
  assert.equal(report.checks.find(c => c.stage === "backup-copy-generation")?.code, "backup-copy-generation-unavailable");
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  const alert = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: ID.replaceAll("-", ""),
    MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" },
  { ...report, invocationId: ID.replaceAll("-", "") }, NOW);
  assert.match(alert.text, /backup-copy-overdue/);
  assert.doesNotMatch(JSON.stringify([report, alert]), /private-offsite-path|\/backup-copy/);

  copy.verifiedAt = date(NOW - 2 * 3600_000);
  assert.ok((await runOperationalCheck(f.config, f.deps)).checks.find(c => c.stage === "backup-copy-freshness")?.ok);
  copy.capturedAt = date(NOW);
  assert.equal((await runOperationalCheck(f.config, f.deps)).checks.find(c => c.stage === "backup-copy-proof")?.code,
    "backup-copy-proof-invalid");
  const read = f.deps.readJson;
  f.deps.readJson = path => {
    if (path === f.config.backupCopyReport) throw Error("backup copy receipt missing");
    return read(path);
  };
  assert.equal((await runOperationalCheck(f.config, f.deps)).checks.find(c => c.stage === "backup-copy-proof")?.code,
    "backup-copy-proof-unavailable");
});

test("fresh backup receipts must cover the newest published ciphertext after the replication window", async t => {
  const f = fixture(), date = at => new Date(at).toISOString();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.config.backupExportReport = "/backup-export/latest.json";
  f.config.backupCopyReport = "/backup-copy/latest.json";
  const capturedAt = date(NOW - 3_600_000), generation = "a".repeat(64), oldGeneration = "b".repeat(64);
  const backup = { v: 1, capturedAt, generation, verifiedAt: date(NOW - 60_000),
    publishedAt: date(NOW - 15 * 60_000) };
  const copy = { v: 1, capturedAt, generation: oldGeneration, verifiedAt: date(NOW - 60_000) };
  f.states[f.config.backupExportReport] = backup;
  f.states[f.config.backupCopyReport] = copy;
  const get = (report, stage) => report.checks.find(c => c.stage === stage);

  const pending = await runOperationalCheck(f.config, f.deps);
  assert.ok(get(pending, "backup-copy-generation-pending")?.ok);
  assert.equal(get(pending, "backup-copy-generation"), undefined);
  backup.publishedAt = date(NOW - 15 * 60_000 - 1);
  const overdue = await runOperationalCheck(f.config, f.deps);
  assert.ok(get(overdue, "backup-export-freshness")?.ok);
  assert.ok(get(overdue, "backup-copy-freshness")?.ok);
  assert.deepEqual(get(overdue, "backup-copy-generation"), {
    stage: "backup-copy-generation", ok: false, code: "backup-copy-generation-overdue", domains: [],
  });
  assert.deepEqual(overdue.admission, { nano: true, near: true, usdc: true, market: true });
  const alert = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: ID.replaceAll("-", ""),
    MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" },
    { ...overdue, invocationId: ID.replaceAll("-", "") }, NOW);
  assert.match(alert.text, /backup-copy-generation-overdue/);
  assert.ok(!JSON.stringify([overdue, alert]).includes(generation));
  assert.ok(!JSON.stringify([overdue, alert]).includes(oldGeneration));

  copy.capturedAt = date(NOW - 25_000);
  copy.verifiedAt = date(NOW - 10_000);
  assert.ok(get(await runOperationalCheck(f.config, f.deps), "backup-copy-generation-pending")?.ok);
  copy.generation = generation;
  assert.equal(get(await runOperationalCheck(f.config, f.deps), "backup-copy-generation")?.code,
    "backup-copy-generation-inconsistent");
  copy.capturedAt = capturedAt;
  assert.ok(get(await runOperationalCheck(f.config, f.deps), "backup-copy-generation")?.ok);

  delete backup.publishedAt;
  assert.equal(get(await runOperationalCheck(f.config, f.deps), "backup-export-proof")?.code, "backup-export-proof-invalid");
  copy.generation = "malformed";
  assert.equal(get(await runOperationalCheck(f.config, f.deps), "backup-copy-proof")?.code, "backup-copy-proof-invalid");
});

test("the scheduled disk probe verifies a complete commit and refuses a state directory it cannot synchronize", async t => {
  const f = fixture(), tmp = mkdtempSync(join(tmpdir(), "operational-durable-write-"));
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const actual = join(tmp, "actual"), alias = join(tmp, "alias");
  mkdirSync(actual);
  symlinkSync(actual, alias, "dir");
  const previousRead = f.deps.readJson, standard = f.config.outDir;
  delete f.deps.probeStateWrite;
  const check = async outDir => {
    f.config.outDir = outDir;
    f.deps.readJson = path => previousRead(path.startsWith(outDir + "/") ? standard + path.slice(outDir.length) : path);
    const report = await runOperationalCheck(f.config, f.deps);
    return report.checks.find(c => c.stage === "state-writable");
  };
  assert.deepEqual(await check(actual), { stage: "state-writable", ok: true });
  assert.deepEqual(await check(alias), { stage: "state-writable", ok: false, code: "state-disk-write-failed", domains: ["nano", "near", "usdc", "market"] });
  assert.deepEqual(readdirSync(actual), []);
});

test("saved workflow probes flag thin Nano deposits, invalid USDC previews and missing templates independently", async () => {
  const f = fixture(({ url, body }) => {
    const rpc = result => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (url.hostname === "nano-site.example" && body?.method === "tools/list") {
      const tools = toolsList();
      tools.find(t => t.name === "sing").description = toolsList("0.01").find(t => t.name === "sing").description;
      return rpc({ tools });
    }
    if (url.hostname === "site.example" && url.pathname === "/examples/idea-to-3d-model.json") {
      return new Response("private-example-error", { status: 404 });
    }
    const args = body?.params?.arguments;
    if (url.hostname === "site.example" && args?.graph?.name === "sing" && args._pay_with === "usdc") {
      const preview = pricePreview("usdc");
      delete preview.usdc;
      return rpc({ structuredContent: preview });
    }
    return null;
  });
  try {
    const report = await runOperationalCheck(f.config, f.deps);
    assert.deepEqual(Object.fromEntries(report.checks.filter(c => !c.ok).map(c => [c.stage, c.code])), {
      "saved-workflow-nano-sing": "saved-nano-deposit-too-low",
      "saved-workflow-near-idea-to-3d-model": "http-404",
      "saved-workflow-usdc-idea-to-3d-model": "http-404",
      "saved-workflow-usdc-sing": "saved-workflow-denomination-invalid",
    });
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /private-example-error/);
  } finally {
    rmSync(f.config.stateDir, { recursive: true, force: true });
  }
});

test("a formerly adequate deposit fails when fresh provider pricing rises or a model disappears", async t => {
  const f = fixture(), price = f.deps.computePrice, localCalls = [];
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.deps.computePrice = async ({ graph, inputs }, options) => {
    assert.equal(options.requireFreshCatalogs, true);
    assert.equal(options.allowShortLinks, false);
    localCalls.push(graph.name);
    if (graph.name === "sing") return { safety: { ok: true }, pricing: { likelyChargeUsd: 0.06 } };
    if (graph.name === "photo-to-video") return { safety: { ok: false }, pricing: null };
    if (inputs?.Marker) return { safety: { ok: true }, pricing: { likelyChargeUsd: 0.04 } };
    return price();
  };
  const report = await runOperationalCheck(f.config, f.deps);
  const outcome = stage => report.checks.find(c => c.stage === stage);
  for (const asset of ["nano", "near", "usdc"]) {
    assert.equal(outcome(`saved-workflow-${asset}-sing`).code,
      asset === "nano" ? "saved-nano-deposit-too-low" : "saved-workflow-deposit-too-low");
    assert.equal(outcome(`saved-workflow-${asset}-photo-to-video`).code, "workflow-provider-pricing-unavailable");
    assert.deepEqual(outcome(`saved-workflow-${asset}-sing`).domains, []);
  }
  assert.equal(localCalls.filter(name => name === "sing").length, 2);
  assert.equal(outcome("custom-workflow-pricing").code, "custom-workflow-deposit-too-low");
});

test("saved NEAR deposit conversion includes the quoted spread and rounds up to a microNEAR", async t => {
  const f = fixture(({ url, body }) => {
    const args = body?.params?.arguments;
    if (url.hostname !== "site.example" || args?._pay_with !== "near") return null;
    if (!["sing", "photo-to-video"].includes(args.graph.name)) return null;
    const preview = pricePreview("near");
    preview.near.rate.nearUsd = "7";
    preview.near.rate.spreadBps = 149;
    preview.near.depositNear = args.graph.name === "sing" ? "0.00435" : "0.004349";
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: preview } });
  });
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const report = await runOperationalCheck(f.config, f.deps);
  const outcome = stage => report.checks.find(c => c.stage === stage);
  assert.equal(outcome("saved-workflow-near-sing").ok, true);
  assert.equal(outcome("saved-workflow-near-photo-to-video").code, "near-deposit-conversion-invalid");
  assert.equal(outcome("saved-workflow-usdc-photo-to-video").ok, true);
});

test("the monitor warns before the shared NEAR and USDC quote queue fills and reports it full at the limit", async t => {
  for (const count of [799, 800, 1000]) {
    const f = fixture();
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const quotes = f.states["/state/near-state.json"].quotes;
    for (let i = 0; i < count; i++) {
      quotes[i] = { id: "private-open-" + i, status: "pending", asset: i % 2 ? "near" : "usdc",
        amountYocto: String(i + 1), expiresAt: NOW };
    }
    quotes.old = { id: "private-expired", status: "pending", amountYocto: "5001", expiresAt: NOW - 1 };
    const report = await runOperationalCheck(f.config, f.deps);
    const capacity = report.checks.find(c => c.stage === "near-open-quote-capacity");
    const warning = report.checks.find(c => c.stage === "near-open-quote-headroom");
    assert.equal(capacity.ok, count !== 1000);
    assert.equal(capacity.code, count === 1000 ? "near-open-quote-capacity-exhausted" : undefined);
    assert.equal(warning?.code, count === 800 ? "near-open-quote-capacity-low" : undefined);
    assert.deepEqual(report.admission, { nano: true, near: count !== 1000, usdc: count !== 1000, market: true });
    assert.doesNotMatch(JSON.stringify(report), /private-open|private-expired/);
  }
});

test("the monitor reports an unattached NEAR payment claim without exposing its quote or tx hash", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const near = f.states["/state/near-state.json"];
  near.consumedTx = { "private-payment-hash": "private-payment-id", "pruned-payment-hash": "pruned-payment-id" };
  const quote = near.quotes["private-payment-id"] = { status: "expired", expiresAt: NOW - 1, amountYocto: "1" };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === "near-payment-claim-unattached"), {
    stage: "near-payment-claim-unattached", ok: false, code: "near-payment-claim-unattached", domains: [],
  });
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /private-payment-|pruned-payment-/);
  quote.payTx = "private-payment-hash";
  const recovered = await runOperationalCheck(f.config, f.deps);
  assert.ok(!recovered.checks.some(c => c.stage === "near-payment-claim-unattached"));
});

test("scheduled checks catch expired quote windows that finalized backfill has not covered", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const near = f.states["/state/near-state.json"], retentionEnd = NOW - 120_000;
  near.quotes["private-pending-quote"] = { status: "expired", expiresAt: retentionEnd - 3_600_000, amountYocto: "1" };
  const watch = { height: 100, hash: "private-block-hash", backfill: { nextHash: "private-child-hash", cutoffMs: NOW - 4_000_000 } };
  near.meta = { paymentWatch: watch };
  const hasIssue = report => report.checks.some(c => c.stage === "near-quote-payment-scan-overdue" && !c.ok);
  const legacyReport = await runOperationalCheck(f.config, f.deps);
  assert.ok(hasIssue(legacyReport));
  assert.deepEqual(legacyReport.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(legacyReport), /private-(pending|block|child)/);

  watch.backfill = null;
  watch.coveredThroughMs = retentionEnd;
  assert.ok(hasIssue(await runOperationalCheck(f.config, f.deps)), "coverage must advance past the inclusive window");
  watch.coveredThroughMs++;
  assert.ok(!hasIssue(await runOperationalCheck(f.config, f.deps)));
});

test("expired but refundable quotes can exhaust a single price without closing the rail", async t => {
  for (const [asset, retained] of [["usdc", 800], ["usdc", 999], ["near", 999]]) {
    const f = fixture();
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const quotes = f.states["/state/near-state.json"].quotes;
    const step = asset === "near" ? 10n ** 18n : 1n;
    const base = asset === "near" ? 10n ** 22n : 30_000n;
    for (let i = 1; i <= 999; i++) {
      quotes[i] = { id: "private-retained-quote-" + i, status: "expired", ...(asset === "usdc" && { asset }),
        amountYocto: String(base + step * BigInt(i)), expiresAt: NOW - 3_600_000 - Number(i > retained) };
    }
    const report = await runOperationalCheck(f.config, f.deps);
    const stage = (name) => report.checks.find(c => c.stage === name);
    assert.equal(stage("near-open-quote-capacity").ok, true);
    const other = asset === "usdc" ? "near" : "usdc";
    assert.equal(stage(`saved-workflow-${other}-sing`).ok, true);
    assert.equal(stage(`saved-workflow-${asset}-sing`).code,
      retained === 999 ? "saved-workflow-quote-amounts-exhausted" : "saved-workflow-quote-amounts-low");
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /private-retained-quote/);
  }
});

test("numeric and HTTP rate limits have precise diagnostics without hiding loss of quorum", async () => {
  for (const http of [false, true]) {
    const f = fixture(({ url }) => url.hostname === "nano-0.example"
      ? http ? new Response("private rate limit body", { status: 429 }) : Response.json({ error: 429, retry_after: 120 }) : null);
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.some(check => check.stage === "nano-node-0" && check.code === "nano-rpc-rate-limited"));
    assert.equal(report.admission.nano, false, "two configured peers still require two readable peers");
    assert.doesNotMatch(JSON.stringify(report), /private rate limit/);
  }
});

test("live Nano reservations can exhaust working capital while disk and runtime coverage still pass", async t => {
  const raw = 10n ** 30n;
  for (const shortfall of [0n, 1n]) {
    const f = fixture();
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    Object.assign(f.states["/state/funding-health.json"], {
      balanceRaw: String(10n * raw), liabilitiesRaw: String(raw),
      reservedRaw: String(7n * raw + shortfall), activeRuns: 1, oldestStartedAt: NOW - 1000,
    });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.some(c => c.stage === "nano-liquidity" && c.ok));
    assert.ok(report.checks.some(c => c.stage === "runtime-funding" && c.ok));
    const headroom = report.checks.find(c => c.stage === "nano-unreserved-liquidity");
    assert.equal(headroom.ok, shortfall === 0n);
    assert.equal(report.ok, headroom.ok);
    if (shortfall) assert.equal(headroom.code, "nano-pool-insufficient-after-reservations");
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /balanceRaw|liabilitiesRaw|reservedRaw|availableRaw/);
  }
});

test("paid NEAR and USDC workflows must fit together at their locked Nano rates", async t => {
  const raw = 10n ** 30n, required = 54n * raw / 10n;
  for (const scenario of ["exact", "live-short", "chain-short", "missing-locked-rate", "started-during-sample"]) {
    const f = fixture();
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const quotes = f.states["/state/near-state.json"].quotes;
    quotes.native = { id: "private-near-payment", status: "paid", asset: "near", depositUsd: "1.2",
      paidYocto: "400000000000000000000000", paidAtBlockMs: NOW, rate: { xnoUsd: "0.5" } };
    quotes.stable = { id: "private-usdc-payment", status: "paid", asset: "usdc", depositUsd: "0.6",
      paidYocto: "600000", paidAtBlockMs: NOW, rate: { xnoUsd: scenario === "missing-locked-rate" ? undefined : "0.2" } };
    quotes.running = { id: "private-reserved-payment", status: "running", depositUsd: "50",
      paidYocto: "1", paidAtBlockMs: NOW, rate: { xnoUsd: "0.1" } };
    const report = f.states["/state/funding-health.json"];
    report.liabilitiesRaw = "0";
    const belowBothBudgets = ["live-short", "started-during-sample"].includes(scenario);
    report.reservedRaw = String(10n * raw - required + (belowBothBudgets ? 1n : 0n));
    Object.assign(report, { activeRuns: 1, oldestStartedAt: NOW - 1000 });
    if (scenario === "chain-short") {
      f.states["/state/gate-state.json"].owed.push({ amountRaw: String(10n * raw - required + 1n),
        journaled: true, tries: 0, createdAt: NOW });
    }
    if (scenario === "started-during-sample") {
      const read = f.deps.readJson;
      f.deps.readJson = path => {
        if (path === "/state/funding-health.json") quotes.stable.status = "running";
        return structuredClone(read(path));
      };
    }
    const result = await runOperationalCheck(f.config, f.deps);
    for (const stage of ["runtime-funding", "nano-liquidity", "nano-unreserved-liquidity"]) {
      assert.equal(result.checks.find(c => c.stage === stage)?.ok, true, scenario + " " + stage);
    }
    const finding = result.checks.find(c => c.stage === "near-paid-run-funding");
    const covered = ["exact", "started-during-sample"].includes(scenario);
    assert.equal(finding?.ok, covered, scenario);
    if (!covered) {
      assert.equal(finding.code, scenario === "missing-locked-rate"
        ? "near-paid-run-funding-unverified" : "near-paid-run-funding-insufficient", scenario);
      assert.deepEqual(finding.domains, []);
    }
    assert.deepEqual(result.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(result), /private-.*-payment|availableRaw|depositUsd/);
  }
});

test("valid NEAR and USDC previews must fit both independent Nano balances and already paid work", async t => {
  const raw = 10n ** 30n;
  for (const mode of ["healthy", "runtime-reserved", "chain-obligations", "paid-waiting"]) {
    const f = fixture(({ url, body }) => {
      const args = body?.params?.arguments;
      if (url.hostname !== "site.example" || !(args?.graph?.name === "sing" || args?.inputs?.Marker)) return null;
      const preview = pricePreview(args._pay_with);
      preview.pricing.deposit.usd = "3";
      if (preview.near) preview.near.depositNear = "1";
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: preview } });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const funding = f.states["/state/funding-health.json"];
    funding.liabilitiesRaw = "0";
    funding.reservedRaw = String(mode === "runtime-reserved" ? 15n * raw / 2n : 69n * raw / 10n);
    funding.activeRuns = 1;
    funding.oldestStartedAt = NOW - 1000;
    if (mode === "chain-obligations") {
      f.states["/state/gate-state.json"].owed.push({ amountRaw: String(15n * raw / 2n), journaled: true, tries: 0, createdAt: NOW });
    }
    if (mode === "paid-waiting") {
      f.states["/state/near-state.json"].quotes.queued = { id: "private-queued-funding-sample", status: "paid", asset: "usdc",
        depositUsd: "1", paidYocto: "1000000", paidAtBlockMs: NOW, rate: { xnoUsd: "2" } };
    }
    const report = await runOperationalCheck(f.config, f.deps);
    const check = stage => report.checks.find(row => row.stage === stage);
    for (const stage of ["nano-liquidity", "nano-unreserved-liquidity", "near-paid-run-funding", "saved-workflow-near-sing",
      "saved-workflow-usdc-sing", "custom-workflow-pricing"]) assert.ok(check(stage)?.ok, mode + " " + stage);
    for (const stage of ["workflow-nano-capital-near-sing", "workflow-nano-capital-usdc-sing",
      "workflow-nano-capital-near-custom", "workflow-nano-capital-usdc-custom"]) {
      assert.equal(check(stage)?.ok, mode === "healthy", mode + " " + stage);
      if (mode !== "healthy") assert.deepEqual(check(stage), { stage, ok: false, code: "workflow-nano-capital-insufficient", domains: [] });
    }
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /private-queued-funding-sample|reservedRaw|depositUsd/);
    if (mode === "runtime-reserved") {
      const invocationId = ID.replaceAll("-", "");
      const alert = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: invocationId,
        MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" }, { ...report, invocationId }, NOW);
      assert.match(alert.text, /workflow-nano-capital-insufficient/);
      assert.doesNotMatch(alert.text, /private-queued-funding-sample|reservedRaw|depositUsd/);
    }
  }
});

test("the maximum quote dust is included in the saved creator workflow's Nano funding", async t => {
  for (const author of [null, NANO_GENESIS_REPLY.contents.account]) {
    const f = fixture(({ url, body }) => {
      if (url.hostname !== "site.example") return null;
      if (url.pathname === "/graph/sing.json") {
        return Response.json({ v: 1, name: "sing", x402: { author },
          nodes: [{ id: "input", type: "text", fields: { text: "sample" } }], links: [] });
      }
      const args = body?.params?.arguments;
      if (args?.graph?.name !== "sing") return null;
      const preview = pricePreview(args._pay_with);
      preview.pricing.deposit.usd = "3";
      if (preview.near) preview.near.depositNear = "1";
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: preview } });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const funding = f.states["/state/funding-health.json"];
    Object.assign(funding, { liabilitiesRaw: "0", reservedRaw: String(7n * 10n ** 30n), activeRuns: 1, oldestStartedAt: NOW - 1000 });
    const checks = (await runOperationalCheck(f.config, f.deps)).checks;
    for (const asset of ["near", "usdc"]) {
      assert.ok(checks.find(check => check.stage === `saved-workflow-${asset}-sing`)?.ok);
      const proof = checks.find(check => check.stage === `workflow-nano-capital-${asset}-sing`);
      assert.equal(proof?.ok, author === null, asset);
      if (author) assert.equal(proof.code, "workflow-nano-capital-insufficient");
    }
  }
});

test("profitable Market listings and bid caps still need spendable Nano upfront", async t => {
  for (const providerUsesWallet of [true, false]) {
    const f = fixture(({ url }) => url.pathname === `/v1/agents/${ID}/pricing-plans`
      ? Response.json([{ is_default: true, price_amount: "4.00", listing_status: "live" }]) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    f.config.providerUsesWallet = providerUsesWallet;
    const agent = f.config.agents[0];
    Object.assign(agent, { bids: true, maxBidUsd: 4 });
    const original = f.deps.computePrice;
    f.deps.computePrice = (args, options) => args.graph === agent.defaultWorkflow.graph
      ? { safety: { ok: true }, pricing: { estimatedCostUsd: 2.50 } } : original(args, options);
    Object.assign(f.states["/state/funding-health.json"], { liabilitiesRaw: "0",
      reservedRaw: String(15n * 10n ** 30n / 2n), activeRuns: 1, oldestStartedAt: NOW - 1000 });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.find(check => check.stage === "workflow-price-nanoodle-image")?.ok);
    assert.equal(report.admission.market, true);
    const capital = report.checks.filter(check => check.stage.startsWith("workflow-nano-capital-market"));
    assert.equal(capital.length, providerUsesWallet ? 2 : 0);
    assert.ok(capital.every(check => !check.ok && check.code === "workflow-nano-capital-insufficient"));
  }
});

test("a low canary payer is visible without closing customer payment lanes", async t => {
  const payer = "dedicated-canary.testnet";
  const f = fixture(({ body }) => body?.params?.request_type === "view_account" && body.params.account_id === payer
    ? Response.json({ jsonrpc: "2.0", id: body.id, result: { amount: "10000000000000000000000",
      storage_usage: 182, block_height: 100, block_hash: "same-block" } }) : null);
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.config.canaryPayer = { accountId: payer, publicKey: "ed25519:PRIVATE_CHECK_TEST_KEY", maxNear: "0.01" };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === "near-canary-payer-funding"), {
    stage: "near-canary-payer-funding", ok: false, code: "near-canary-payer-insufficient", domains: [],
  });
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /dedicated-canary|PRIVATE_CHECK_TEST_KEY|10000000000000000000000/);
});

test("a fresh runtime cooldown prevents monitor retries while other independent peers remain healthy", async () => {
  const f = fixture(); f.config.nanoRpcUrls.push("https://nano-2.example");
  Object.assign(f.states["/state/funding-health.json"].nanoRpc, { configuredPeers: 3, configuration: rpcPeerSetId(f.config.nanoRpcUrls),
    cooldowns: [{ peer: 0, until: NOW + 60_000, secret: "PRIVATE_URL" }] });
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(f.calls.filter(call => call.url.hostname === "nano-0.example").length, 0);
  assert.ok(report.checks.some(check => check.stage === "nano-node-0" && check.code === "nano-rpc-rate-limited"));
  assert.ok(report.checks.some(check => check.stage === "nano-frontier-agreement" && check.ok));
  assert.equal(report.ok, false); assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_URL|configuration|cooldowns/);
});

test("Nano fallback peers must serve the payment reads even while the preferred node is healthy", async t => {
  for (const failure of [null, "history-http", "wrong-head", "cut-short", "inconsistent-receivable", "moved-after-history"]) {
    const f = fixture(({ url, body }) => {
      if (url.hostname !== "nano-2.example") return null;
      if (body.action === "account_history" && failure === "history-http") return new Response("PRIVATE_RPC_DETAIL", { status: 503 });
      if (body.action === "account_history" && failure === "wrong-head") {
        return Response.json(rawHistory({ ...body, head: "B".repeat(64) }));
      }
      if (body.action === "account_history" && failure === "cut-short") {
        const page = rawHistory(body);
        delete page.previous;
        return Response.json(page);
      }
      if (body.action === "receivable" && failure === "inconsistent-receivable") {
        return Response.json({ blocks: { ["B".repeat(64)]: { amount: "1", source: body.account } } });
      }
      if (body.action === "account_info" && failure === "moved-after-history"
        && f.calls.some(c => c.url.hostname === url.hostname && c.body.action === "receivable")) {
        return Response.json(nanoAccountInfo({ height: 11, frontier: "B".repeat(64) }));
      }
      return null;
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    f.config.nanoRpcUrls.push("https://nano-2.example", "https://nano-3.example");
    Object.assign(f.states["/state/funding-health.json"].nanoRpc, { configuredPeers: 4, configuration: rpcPeerSetId(f.config.nanoRpcUrls),
      cooldowns: [{ peer: 3, until: NOW + 60_000 }] });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.checks.find(c => c.stage === "nano-frontier-agreement")?.ok, true);
    const readiness = report.checks.find(c => c.stage === "nano-fallback-payment-reads");
    assert.equal(readiness?.ok, failure === null, failure);
    if (failure) {
      assert.equal(readiness.code, "nano-fallback-payment-read-quorum-unavailable");
      assert.deepEqual(readiness.domains, []);
    }
    const calls = f.calls.filter(c => ["account_history", "receivable"].includes(c.body?.action));
    assert.ok(calls.every(c => ["nano-1.example", "nano-2.example"].includes(c.url.hostname)));
    assert.ok(calls.some(c => c.body.action === "account_history" && c.body.count === "100" && c.body.raw === "true"));
    assert.ok(calls.some(c => c.body.action === "receivable" && c.body.count === "500" && c.body.include_only_confirmed === "true"));
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_RPC_DETAIL|nano-2\.example|BBBBBBBB/);
  }
});

test("a runtime standby is recognized only with a fresh matching primary and without another standby request", async () => {
  for (const failure of [null, "matching-with-lagging-peer", "mismatch", "inactive", "digest", "quota", "initializing", "cooling"]) {
    const f = fixture(({ url, body }) => {
      assert.notEqual(url.hostname, "standby.example", "scheduled probes do not spend the standby budget");
      if (url.hostname === "nano-0.example") {
        if (failure !== "matching-with-lagging-peer") return new Response("", { status: 503 });
        if (body.action === "account_info") return Response.json(nanoAccountInfo({ height: 9 }));
      }
      if (failure === "mismatch" && url.hostname === "nano-1.example" && body.action === "account_info") {
        return Response.json(nanoAccountInfo({ frontier: "C".repeat(64), balance: "10000000000000000000000000000000" }));
      }
      return null;
    });
    const url = "https://standby.example/rpc?api_key=PRIVATE_STANDBY";
    f.config.nanoStandby = { url, requestsPerMinute: 10 };
    const rpc = f.states["/state/funding-health.json"].nanoRpc;
    Object.assign(rpc, { configuredPeers: 3,
      configuration: failure === "digest" ? "a".repeat(64) : rpcPeerSetId([...f.config.nanoRpcUrls, url]),
      standby: { inUse: failure !== "inactive", requestsPerMinute: failure === "quota" ? 11 : 10 },
      cooldowns: failure === "cooling" ? [{ peer: 2, until: NOW + 60_000 }] : [],
      ...(failure === "initializing" && { lastReadAt: NOW - 61_000 }) });
    const report = await runOperationalCheck(f.config, f.deps);
    const ready = failure === null || failure === "matching-with-lagging-peer";
    assert.equal(report.admission.nano, ready);
    assert.equal(report.admission.near, ready);
    if (ready) assert.ok(report.checks.some(c => c.stage === "nano-standby" && c.code === "nano-standby-covering-quorum"));
    if (failure === "mismatch") assert.ok(report.checks.some(c => c.stage === "nano-frontier-agreement" && c.code === "nano-standby-checkpoint-disagrees"));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_STANDBY|standby\.example/);
  }
});

test("independent Nano peers must corroborate the runtime's confirmed checkpoint", async t => {
  const account = NANO_GENESIS_REPLY.contents.account;
  const block = { type: "state", account, representative: account, balance: "10000000000000000000000000000000",
    previous: "B".repeat(64), link: "C".repeat(64) };
  const anchor = { hash: hashBlock(block), blockCount: "10" };
  for (const [scenario, height, frontier, expected] of [
    ["agree", 10, anchor.hash, undefined],
    ["behind", 9, "B".repeat(64), "nano-confirmed-checkpoint-regressed"],
    ["conflict", 10, "C".repeat(64), "nano-confirmed-checkpoint-disagrees"],
    ["one-peer-behind", 10, anchor.hash, "nano-confirmed-checkpoint-unverified"],
    ["newer", 11, "D".repeat(64), undefined],
    ["newer-with-unconfirmed-history", 11, "D".repeat(64), "nano-confirmed-checkpoint-unverified"],
    ["newer-with-wrong-history", 11, "D".repeat(64), "nano-confirmed-checkpoint-unverified"],
    ["redundant-with-wrong-history", 11, "D".repeat(64), undefined],
    ["newest-unverified", 10, anchor.hash, "nano-confirmed-checkpoint-unverified"],
  ]) {
    const wrongHistory = ["newer-with-wrong-history", "redundant-with-wrong-history", "newest-unverified"].includes(scenario);
    const f = fixture(({ url, body }) => {
      if (!/^nano-\d/.test(url.hostname)) return null;
      const secondary = url.hostname === "nano-1.example";
      if (body.action === "account_info") {
        if (secondary && scenario === "one-peer-behind") return Response.json(nanoAccountInfo({ height: 9, frontier: "B".repeat(64) }));
        if (secondary && scenario === "newest-unverified") return Response.json(nanoAccountInfo({ height: 11, frontier: "D".repeat(64) }));
        return Response.json(nanoAccountInfo({ height, frontier, balance: block.balance }));
      }
      if (body.action !== "block_info" || body.hash !== anchor.hash) return null;
      return Response.json({
        height: anchor.blockCount,
        confirmed: !secondary || scenario !== "newer-with-unconfirmed-history",
        contents: secondary && wrongHistory ? { ...block, link: "E".repeat(64) } : block,
      });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const rpc = f.states["/state/funding-health.json"].nanoRpc;
    if (["redundant-with-wrong-history", "newest-unverified"].includes(scenario)) {
      f.config.nanoRpcUrls.push("https://nano-2.example");
      rpc.configuredPeers = 3;
    }
    const { checkpoint } = rpc;
    checkpoint.confirmed = anchor;
    // A locally published head can be ahead of the last confirmed block.
    checkpoint.head = { hash: "A".repeat(64), blockCount: "11" };
    const report = await runOperationalCheck(f.config, f.deps);
    const check = report.checks.find(c => c.stage === "nano-frontier-agreement");
    assert.equal(check.code, expected, scenario);
    assert.equal(check.ok, expected === undefined, scenario);
    assert.ok(Object.values(report.admission).every(ready => ready === (expected === undefined)), scenario);
    const history = f.calls.filter(c => c.body?.action === "block_info" && c.body.hash === anchor.hash);
    assert.equal(history.length, height > 10 ? f.config.nanoRpcUrls.length : Number(scenario === "newest-unverified"), scenario);
    if (wrongHistory) {
      assert.deepEqual(report.checks.find(c => c.stage === "nano-node-1"),
        { stage: "nano-node-1", ok: false, code: "nano-confirmed-checkpoint-unverified", domains: [] }, scenario);
    }
    if (scenario === "newest-unverified") assert.ok(!report.checks.some(c => c.stage === "nano-liquidity"));
    assert.ok(!JSON.stringify(report).includes(anchor.hash), scenario);
  }
});

test("mismatched or malformed cooldown observations cannot hide live peer failures", async () => {
  for (const patch of [{ configuration: "a".repeat(64) }, { cooldowns: [{ peer: true, until: NOW + 60_000 }] }]) {
    const f = fixture(); Object.assign(f.states["/state/funding-health.json"].nanoRpc,
      { configuration: rpcPeerSetId(f.config.nanoRpcUrls), cooldowns: [], ...patch });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.some(check => check.stage === "runtime-funding" && !check.ok));
    assert.ok(f.calls.some(call => call.url.hostname === "nano-0.example"));
    assert.equal(report.admission.nano, false);
  }
});

test("the no-inference check distinguishes wallet read refusal from missing funding enforcement", async () => {
  for (const [stored, expected] of [["nano-rpc-frontier-regressed", "nano-rpc-frontier-regressed"],
    ["nano-checkpoint-unproven", "nano-checkpoint-unproven"], ["nano-checkpoint-storage-unavailable", "nano-checkpoint-storage-unavailable"],
    ["funding-state-unavailable", "funding-state-unavailable"], ["PRIVATE_PROVIDER_DETAILS", "funding-state-unavailable"]]) {
    const f = fixture();
    f.states["/state/funding-health.json"] = { v: 1, checkedAt: new Date(NOW).toISOString(), ok: false, code: stored };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.some(check => check.stage === "runtime-funding" && check.code === expected));
    assert.deepEqual(report.admission, { nano: false, near: false, usdc: false, market: false });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_DETAILS/);
  }
});

test("a funding pause that recovers between probes leaves readiness open and reaches the existing durable alert queue", async () => {
  const f = fixture();
  const runtime = f.states["/state/funding-health.json"];
  const pause = { lastFailedAt: NOW - 10_000, recoveredAt: NOW - 5000, code: "nano-rpc-read-quorum" };
  runtime.pause = { ...pause, secret: "PRIVATE_RPC_URL" };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, true);
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.deepEqual(report.fundingPause, pause);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_RPC_URL/);

  const requests = [];
  const config = { stateDir: f.config.stateDir, operationalReportFile: join(f.config.stateDir, "latest.json"), conversation: "near_check_alerts" };
  const alert = { env: {}, now: () => NOW, call: async (_tool, args) => {
    requests.push(args);
    assert.equal(JSON.parse(readFileSync(join(config.stateDir, "alerts", args.message_id + ".json"), "utf8")).status, "pending");
    if (requests.length === 1) throw Error("lost response");
    return { message: { id: args.message_id, recipient: EMBER, status: "queued" } };
  } };
  assert.equal((await deliverAlerts(config, { ...alert, enqueueOnly: true })).messageId, undefined);
  assert.equal((await deliverAlerts(config, alert)).ok, false);
  assert.equal((await deliverAlerts(config, alert)).queued, 1);
  assert.equal((await deliverAlerts(config, alert)).queued, 0);
  assert.deepEqual(requests[0], requests[1]);
  assert.match(requests[0].text, /wallet funding paused and recovered/);
  assert.match(requests[0].text, /reported nano-rpc-read-quorum/);
  assert.doesNotMatch(requests[0].text, /PRIVATE_RPC_URL|FAILED/);

  runtime.pause = { ...pause, lastFailedAt: NOW - 4000, recoveredAt: NOW - 3000 };
  await runOperationalCheck(f.config, f.deps);
  assert.equal((await deliverAlerts(config, alert)).queued, 1);
  assert.notEqual(requests[2].message_id, requests[0].message_id);
});

test("ongoing, expired, or invalid pause history cannot announce a funding recovery", async () => {
  const f = fixture(), runtime = f.states["/state/funding-health.json"];
  for (const pause of [
    { lastFailedAt: NOW - 5000, recoveredAt: null },
    { lastFailedAt: NOW - 5000, recoveredAt: NOW + 5 },
    { lastFailedAt: NOW - 16 * 60_000, recoveredAt: NOW - 15 * 60_000 - 1 },
    { lastFailedAt: NOW - 5000, recoveredAt: NOW - 6000 },
  ]) {
    runtime.pause = pause;
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, true); assert.equal(report.fundingPause, undefined);
  }
  runtime.pause = { lastFailedAt: NOW - 10_000, recoveredAt: NOW - 5000, code: "nano-rpc-read-quorum" };
  runtime.ok = false; runtime.code = "funding-state-unavailable";
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.fundingPause, undefined); assert.equal(report.admission.near, false);
});

test("stale, disabled, underfunded or stuck live reservations fail independently of the public site", async () => {
  for (const change of [
    { checkedAt: new Date(NOW - 61_000).toISOString() }, { enforced: false }, { protectTransfers: false },
    { balanceRaw: "299" }, { reservedRaw: "NaN" }, { ok: false }, { activeRuns: 1, oldestStartedAt: NOW - 46 * 60_000 }, { runTimeoutMs: null },
  ]) {
    const f = fixture();
    Object.assign(f.states["/state/funding-health.json"], change);
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(c => c.stage === "runtime-funding" && !c.ok));
    assert.ok(report.checks.some(c => c.stage === "mcp-discovery" && c.ok));
  }
});

test("stuck scope observations use the operator's execution limit plus reconciliation grace", async () => {
  const f = fixture(), state = f.states["/state/funding-health.json"];
  Object.assign(state, { runTimeoutMs: 2 * 3_600_000, activeRuns: 1, oldestStartedAt: NOW - 60 * 60_000 });
  assert.equal((await runOperationalCheck(f.config, f.deps)).ok, true);
  state.oldestStartedAt = NOW - 136 * 60_000;
  const report = await runOperationalCheck(f.config, f.deps);
  assert.ok(report.checks.some(c => c.stage === "runtime-funding" && c.code === "funding-run-stuck"));
});

test("disabled, stale or insufficient Nano read enforcement cannot be hidden by fresh funding telemetry", async () => {
  for (const change of [{ enforced: false }, { networkPeers: 1 }, { readablePeers: 1 }, { configuredPeers: 1 }, { lastReadAt: NOW - 61_000 }]) {
    const f = fixture(); Object.assign(f.states["/state/funding-health.json"].nanoRpc, change);
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.nano, false);
    assert.ok(report.checks.some(c => c.stage === "runtime-funding" && !c.ok));
  }
});

test("monitoring rejects a missing or wrong-wallet checkpoint without copying it to the public report", async () => {
  for (const change of [null, { account: "invalid" }, { networkGenesis: "F".repeat(64) }, { head: { hash: "A".repeat(64), blockCount: "9" } }]) {
    const f = fixture(), rpc = f.states["/state/funding-health.json"].nanoRpc;
    rpc.checkpoint = change === null ? null : { ...rpc.checkpoint, ...change };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.nano, false);
    assert.ok(report.checks.some(c => c.code === "nano-checkpoint-unavailable"));
    assert.doesNotMatch(JSON.stringify(report), /networkGenesis|blockCount|nano_3/);
  }
});

test("missing startup policy or writer protection fails the existing no-inference runtime probe", async () => {
  for (const proof of [undefined, { enforced: false, requiredState: true }, { enforced: true, requiredState: false }]) {
    const f = fixture(); f.states["/state/funding-health.json"].writerProtection = proof;
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.nano, false);
    assert.ok(report.checks.some(c => c.stage === "runtime-funding" && !c.ok));
  }
});

test("loss of the separate Nano ingress is visible without executing tools or disabling the NEAR rail", async () => {
  const f = fixture(({ url }) => url.hostname === "nano-site.example" ? new Response("PRIVATE_ERROR", { status: 503 }) : null);
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.admission.nano, false); assert.equal(report.admission.near, true);
  assert.ok(report.checks.some(c => c.stage === "nano-mcp-discovery" && !c.ok));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ERROR/);
});

test("periodic readiness verifies fresh enforced refund funding and each asset's admission capacity", async () => {
  for (const change of [{ enforced: false }, { checkedAt: NOW - 60_001 }, { ok: false }, { canQuoteUsdc: false },
    { canQuoteUsdc: false, usdcCode: "USDC_FUNDING_UNAVAILABLE" }]) {
    const f = fixture(({ url }) => url.pathname === "/near/health" ? Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near",
      watcher: { listening: true, lastScanAt: new Date(NOW).toISOString(), height: 100, backfilling: false },
      funding: { enforced: true, ok: true, checkedAt: NOW, canQuoteNear: true, canQuoteUsdc: true, ...change } }) : null);
    const result = await runOperationalCheck(f.config, f.deps);
    assert.equal(result.ok, false); assert.equal(result.admission.usdc, false);
    if (change.canQuoteUsdc === false) assert.equal(result.admission.near, true);
    else assert.equal(result.admission.near, false);
    if (change.usdcCode) assert.ok(result.checks.some(check => check.stage === "usdc-refund-admission"
      && check.code === "usdc-refund-funding-unavailable"));
  }
});

test("independent token reads preserve native readiness unless a paid USDC claim needs the missing balance", async () => {
  for (const paid of [false, true]) {
    const f = fixture(({ body }) => body?.params?.method_name === "ft_balance_of" ? new Response(null, { status: 503 }) : null);
    if (paid) f.states["/state/near-state.json"].quotes.paid = { id: "paid", asset: "usdc", status: "paid", paidYocto: "17" };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.admission.near, !paid);
    assert.equal(report.admission.usdc, false);
    assert.ok(report.checks.some(c => c.stage === "near-fee-and-balance-reads" && c.ok));
    assert.ok(report.checks.some(c => c.stage === "usdc-funding-reads" && c.code === "usdc-refund-funding-unavailable"));
    assert.equal(report.checks.some(c => c.stage === "usdc-liquidity"), false);
  }
});

test("independent funding rejects a balance before a refund finalized during the read", async t => {
  for (const fallback of [false, true]) {
    let completed = false;
    const f = fixture(({ url, body }, _config, states) => {
      if (body?.params?.request_type === "view_account" && url.hostname === "near-0.example") {
        const key = "/state/near-state.json";
        states[key] = { ...states[key], meta: { refundFinalHeight: 101 } };
        completed = true;
      }
      if (!fallback || !completed || url.hostname !== "near-1.example") return null;
      const rpc = result => Response.json({ jsonrpc: "2.0", id: body.id, result });
      const at = { block_height: 101, block_hash: "post-refund" };
      if (body?.method === "block") {
        return rpc({ header: { height: 101, hash: at.block_hash, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } });
      }
      if (body?.method !== "query" || body.params.block_id !== at.block_hash) return null;
      if (body.params.request_type === "view_access_key") return rpc({ permission: "FullAccess", nonce: 101, ...at });
      if (body.params.request_type === "view_account") return rpc({ amount: "1000000000000000000000000", storage_usage: 500, ...at });
      const result = body.params.method_name === "ft_balance_of" ? "1000000" : { total: "1" };
      return rpc({ result: [...Buffer.from(JSON.stringify(result))], ...at });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    const proof = report.checks.find(c => c.stage === "near-fee-and-balance-reads");
    assert.equal(proof.ok, fallback);
    assert.equal(proof.code, fallback ? undefined : "near-refund-balance-before-checkpoint");
    assert.deepEqual(report.admission, { nano: true, near: fallback, usdc: fallback, market: true });
    assert.ok(f.calls.some(c => c.url.hostname === "near-1.example" && c.body?.params?.request_type === "view_account"
      && c.body.params.block_id === (fallback ? "post-refund" : "same-block")));
    assert.doesNotMatch(JSON.stringify(report), /post-refund|block_height|refundFinalHeight/);
  }
});

test("same-block funding disagreement is scoped to the assets that depend on the read", async t => {
  for (const [caseName, request, value, debt, nativeReady, tokenReady] of [
    ["native balance", "view_account", { amount: "900000000000000000000000", storage_usage: 500 }, false, false, false],
    ["native storage", "view_account", { amount: "1000000000000000000000000", storage_usage: 501 }, false, false, false],
    ["signing nonce", "view_access_key", { permission: "FullAccess", nonce: 101 }, false, false, false],
    ["gas cost", "gas_price", { gas_price: "1000000000000" }, false, false, false],
    ["token balance", "ft_balance_of", "900000", false, true, false],
    ["token refund debt", "ft_balance_of", "900000", true, false, false],
    ["token registration", "storage_balance_of", null, false, true, false],
  ]) {
    const f = fixture(({ url, body }) => {
      const params = body?.params;
      if (url.hostname !== "near-1.example") return null;
      if (body.method === "gas_price" && request === "gas_price" && params[0] === "same-block") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: value });
      }
      if (params?.block_id !== "same-block" || (params.method_name ?? params.request_type) !== request) return null;
      const view = params.method_name ? { result: [...Buffer.from(JSON.stringify(value))] } : value;
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { block_hash: "same-block", block_height: 100, ...view } });
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    if (debt) f.states["/state/near-state.json"].quotes.paid = { id: "paid", asset: "usdc", status: "paid", paidYocto: "17" };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.deepEqual(report.admission, { nano: true, near: nativeReady, usdc: tokenReady, market: true }, caseName);
    const token = request.startsWith("ft_") || request.startsWith("storage_");
    const asset = token ? "usdc" : "near";
    assert.ok(report.checks.some(c => c.code === `${asset}-funding-peers-disagree`
      && c.stage === `${asset}-funding-peer-1`), caseName);
    assert.doesNotMatch(JSON.stringify(report), /same-block|900000|near-1\.example/);
  }
});

test("unavailable corroboration reports an advisory and keeps the proven funding source usable", async t => {
  for (const request of ["view_account", "ft_balance_of"]) {
    const f = fixture(({ url, body }) => url.hostname === "near-1.example" && body?.params?.block_id === "same-block"
      && (body.params.method_name ?? body.params.request_type) === request ? new Response(null, { status: 503 }) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    const asset = request === "view_account" ? "near" : "usdc";
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.deepEqual(report.checks.find(c => c.stage === `${asset}-funding-peer-1`),
      { stage: `${asset}-funding-peer-1`, ok: false, code: `${asset}-funding-peer-proof-unavailable`, domains: [] });
  }
});

test("a slightly lagging funding peer corroborates the common block without replacing the balance used for refunds", async t => {
  const f = fixture(({ body, url }) => {
    const params = body?.params;
    const lagging = url.hostname === "near-1.example";
    const reply = result => Response.json({ id: body.id, result });
    if (body?.method === "block" && (params.block_id === 99 || lagging)) {
      return reply({ header: { height: 99, hash: "overlap", timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } });
    }
    if (body?.method !== "query" || params.block_id !== "overlap") return null;
    const at = { block_hash: "overlap", block_height: 99 };
    if (params.request_type === "view_account") return reply({ ...at, amount: "1", storage_usage: 500 });
    if (params.request_type === "view_access_key") return reply({ ...at, permission: "FullAccess", nonce: 99 });
    const token = params.method_name === "ft_balance_of" ? "1000000" : { total: "1" };
    return reply({ ...at, result: [...Buffer.from(JSON.stringify(token))] });
  });
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  for (const asset of ["near", "usdc"]) assert.ok(report.checks.some(c => c.stage === `${asset}-funding-peer-1` && c.ok));
  assert.deepEqual(f.calls.filter(({ body }) => body?.params?.request_type === "view_account")
    .map(({ url, body }) => [url.hostname, body.params.block_id]).sort(),
  [["near-0.example", "overlap"], ["near-0.example", "same-block"], ["near-1.example", "overlap"]]);
});

test("a refund finalized during the corroboration also advances the minimum funding block", async t => {
  const f = fixture(({ url, body }, _config, states) => {
    if (url.hostname === "near-1.example" && body?.params?.block_id === "same-block"
      && body.params.request_type === "view_account") states["/state/near-state.json"].meta = { refundFinalHeight: 101 };
    return null;
  });
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.admission, { nano: true, near: false, usdc: false, market: true });
  assert.ok(report.checks.some(c => c.stage === "refund-liquidity-accounting" && c.code === "near-refund-balance-before-checkpoint"));
});

test("independent refund headroom distinguishes paid liabilities from the next quote fee", async t => {
  const costs = nearRefundCosts(nearProtocol({ chainId: "mainnet" }), "100000000");
  const claims = nearRefundClaims({ quotes: {}, refunds: {} });
  const storageUsage = 500;
  const nearBalance = nearFundingNeed({ claims, costs, storageUsage, extraAsset: "near" });
  const f = fixture(({ body }) => body?.params?.request_type === "view_account" && body.params.block_id
    ? Response.json({ jsonrpc: "2.0", id: body.id, result: { block_height: 100, block_hash: "same-block", amount: nearBalance.toString(), storage_usage: storageUsage } })
    : null);
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const report = await runOperationalCheck(f.config, f.deps);
  const check = stage => report.checks.find(c => c.stage === stage);
  assert.equal(check("near-liquidity").ok, true);
  assert.equal(check("near-independent-refund-headroom").ok, true);
  assert.equal(check("usdc-independent-refund-headroom").code, "independent-refund-headroom-insufficient");
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: false, market: true });
});

test("retained NEAR and USDC quotes share refund gas and warn before deposits arrive", async t => {
  const storageUsage = 500;
  const costs = nearRefundCosts(nearProtocol({ chainId: "mainnet" }), "100000000");
  const expiresAt = NOW - 3_660_000, retainThrough = expiresAt + 3_600_000;
  const quotes = {
    native: { id: "native", asset: "near", status: "pending", amountYocto: "500", expiresAt: NOW + 1000 },
    token: { id: "token", asset: "usdc", status: "expired", amountYocto: "12347", expiresAt },
    paid: { id: "paid", asset: "usdc", status: "paid", paidYocto: "17" },
  };
  const meta = { paymentWatch: { coveredThroughMs: retainThrough } };
  const claims = nearRefundClaims({ quotes, refunds: {}, meta }, { now: NOW });
  const threshold = nearFundingNeed({ claims, costs, storageUsage, pending: true });
  assert.equal(claims.pendingNativeRefunds, 1);
  assert.equal(claims.pendingTokenRefunds, 1);
  let amount = threshold - 1n;
  const f = fixture(({ body }) => body?.params?.request_type === "view_account" && body.params.block_id
    ? Response.json({ id: body.id, result: { block_height: 100, block_hash: "same-block", amount: amount.toString(), storage_usage: storageUsage } })
    : null);
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const ledger = f.states["/state/near-state.json"];
  Object.assign(ledger, { quotes, meta });
  const stage = "near-open-quote-refund-fees";
  let report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
  assert.deepEqual(report.checks.find(c => c.stage === stage),
    { stage, ok: false, code: "near-open-quote-refund-fees-underfunded", domains: [] });
  assert.doesNotMatch(JSON.stringify(report), /"12347"|"pendingNativeRefunds"|"pendingTokenRefunds"/);

  amount = threshold;
  report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: true });

  // Once the watcher has scanned past the retained deadline, the expired
  // token quote can no longer contribute a potential new refund.
  amount = threshold - 1n;
  meta.paymentWatch.coveredThroughMs = retainThrough + 1;
  report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === stage), { stage, ok: true });
});

test("an independently proven USDC refund shortfall pauses both quote rails", async t => {
  const f = fixture();
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  f.states["/state/near-state.json"].quotes.paid = { id: "paid", asset: "usdc", status: "paid", paidYocto: "1000001" };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.admission, { nano: true, near: false, usdc: false, market: true });
  assert.ok(report.checks.some(c => c.stage === "near-independent-refund-headroom" && c.code === "independent-usdc-refund-debt-uncovered"));
});

test("an unverified outgoing refund alerts immediately while its principal remains in the accounting", async () => {
  const f = fixture();
  f.states["/state/near-state.json"].refunds.pending = { id: "pending", paymentId: "paid", amountYocto: "17",
    status: "signed", lastError: "RPC_HTTP", outcomeUnverified: true, createdAt: NOW - 1000 };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.ok(report.checks.some(check => check.stage === "near-refund-outcome-unverified"
    && check.code === "near-refund-outcome-unverified"));
  assert.ok(report.checks.some(check => check.stage === "refund-liquidity-accounting" && check.ok));
  assert.equal(report.admission.near, true);
  assert.equal(JSON.stringify(report).includes("paymentId"), false);
});

test("historical NEAR scan delays reach the existing alert route while a fresh tip remains ready", async t => {
  let backfilling = true;
  const f = fixture(({ url }) => url.pathname === "/near/health" ? Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near",
    watcher: { listening: true, lastScanAt: new Date(NOW).toISOString(), height: 100, backfilling },
    funding: { enforced: true, ok: true, checkedAt: NOW, canQuoteNear: true, canQuoteUsdc: true } }) : null);
  const dir = f.config.stateDir;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const started = NOW - 300_000;
  const first = finishOperationalReport(dir, [], started, { nearBackfilling: true });
  assert.equal(first.ok, true, "a newly observed backfill gets time to complete");
  assert.equal(first.nearBackfillSince, started);
  assert.equal(finishOperationalReport(dir, [], NOW - 1).nearBackfillSince, started, "missing observations do not clear the episode");
  f.config.invocationId = "a".repeat(32);
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, false);
  assert.equal(report.nearBackfillSince, started);
  assert.equal(report.admission.near, true);
  assert.equal(report.admission.usdc, true);
  assert.ok(report.checks.some(c => c.stage === "near-payment-watcher" && c.ok));
  const event = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: f.config.invocationId,
    MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" }, report, NOW);
  assert.match(event.text, /near-watcher-backfill=near-watcher-backfill-delayed/);
  assert.match(event.text, /readiness advisory/);
  assert.equal((await runOperationalCheck(f.config, f.deps)).incidentId, report.incidentId);
  backfilling = false;
  const recovered = await runOperationalCheck(f.config, f.deps);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.nearBackfillSince, undefined);
  backfilling = true;
  assert.equal((await runOperationalCheck(f.config, f.deps)).nearBackfillSince, NOW);
});

test("watcher readiness rejects malformed heights, impossible leads and unknown backfill status", async t => {
  for (const [change, code] of [[{ height: "Infinity" }, "near-watcher-observation-invalid"], [{ height: 221 }, "near-watcher-ahead"],
    [{ backfilling: null }, "near-watcher-observation-invalid"]]) {
    const f = fixture(({ url }) => url.pathname === "/near/health" ? Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near",
      watcher: { listening: true, lastScanAt: new Date(NOW).toISOString(), height: 100, backfilling: false, ...change },
      funding: { enforced: true, ok: true, checkedAt: NOW, canQuoteNear: true, canQuoteUsdc: true } }) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.admission.near, false);
    assert.equal(report.admission.usdc, false);
    assert.ok(report.checks.some(c => c.stage === "near-payment-watcher" && c.code === code));
  }
});

test("a healthy idle NEAR watcher still needs proof that its RPCs can discover a real receipt", async t => {
  const payer = "private-canary.near", paymentTx = base58Encode(Buffer.alloc(32, 3));
  const receiptId = base58Encode(Buffer.alloc(32, 4)), receiptBlock = base58Encode(Buffer.alloc(32, 5));
  for (const scenario of ["complete", "empty-changes", "wrong-transaction", "stale-proof"]) {
    const f = fixture(({ url, body }, config) => {
      if (!url.hostname.startsWith("near-") || !body) return null;
      const json = result => Response.json({ jsonrpc: "2.0", id: body.id, result });
      const merchant = config.merchant;
      if (body.method === "tx") {
        assert.deepEqual(body.params, { tx_hash: paymentTx, sender_account_id: payer, wait_until: "FINAL" });
        return json({ final_execution_status: "FINAL", status: { SuccessValue: "" },
          transaction: { hash: paymentTx, signer_id: payer, receiver_id: merchant, actions: [{ Transfer: { deposit: "1" } }] },
          receipts_outcome: [{ id: receiptId, block_hash: receiptBlock, outcome: { executor_id: merchant, status: { SuccessValue: "" } } }] });
      }
      if (body.method === "block" && body.params.block_id === receiptBlock) {
        return json({ header: { height: 80, hash: receiptBlock } });
      }
      if (body.method === "EXPERIMENTAL_changes") {
        assert.deepEqual(body.params, { changes_type: "account_changes", account_ids: [merchant, USDC_CONTRACTS.mainnet],
          block_id: receiptBlock });
        return json({ block_hash: receiptBlock, changes: scenario === "empty-changes" ? []
          : [{ cause: { type: "receipt_processing", receipt_hash: receiptId }, change: { account_id: merchant } }] });
      }
      if (body.method === "EXPERIMENTAL_receipt_to_tx") {
        assert.deepEqual(body.params, { receipt_id: receiptId, block_height: 80 });
        return json({ transaction_hash: scenario === "wrong-transaction" && url.hostname === "near-1.example" ? receiptId : paymentTx,
          sender_account_id: payer });
      }
      return null;
    });
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    f.config.canaryPayer = { accountId: payer, maxNear: "0.01", publicKey: "ed25519:private-canary-key" };
    f.config.nearDiscoveryReport = "/discovery/latest.json";
    f.states[f.config.nearDiscoveryReport] = { v: 1, paymentTx, checkedAt: new Date(NOW - (scenario === "stale-proof"
      ? 27 * 3600_000 + 1 : 60_000)).toISOString() };
    const report = await runOperationalCheck(f.config, f.deps);
    const find = stage => report.checks.find(c => c.stage === stage);
    assert.equal(find("near-payment-watcher")?.ok, true);
    assert.equal(find("near-canary-discovery-proof")?.ok, scenario !== "stale-proof");
    if (scenario === "stale-proof") {
      assert.equal(find("near-canary-discovery-proof").code, "near-discovery-canary-proof-stale");
      assert.ok(f.calls.every(call => call.body?.method !== "tx"));
    } else {
      assert.equal(find("near-payment-discovery")?.ok, scenario !== "empty-changes");
      assert.equal(find("near-discovery-peer-1")?.ok, scenario === "complete");
      if (scenario !== "complete") assert.deepEqual(find("near-discovery-peer-1").domains, []);
    }
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.ok(!JSON.stringify(report).includes(paymentTx));
    assert.ok(!JSON.stringify(report).includes(payer));
  }
});

test("scheduled readiness separates watcher failure from refund proof, shortfall and stale funding", async t => {
  for (const [code, expected] of [
    ["NEAR_FUNDING_UNAVAILABLE", "near-refund-funding-unavailable"],
    ["NEAR_FUNDING_INSUFFICIENT", "near-refund-funding-insufficient"],
    ["NEAR_FUNDING_STALE", "near-refund-funding-stale"],
    ["PRIVATE_UPSTREAM_DETAIL", "near-refund-funding-unhealthy"],
  ]) {
    const f = fixture(({ url }) => url.pathname === "/near/health" ? Response.json({
      active: true, network: "mainnet", merchant: "nanoodle.near",
      watcher: { listening: false, lastScanAt: new Date(NOW).toISOString(), height: 100 },
      funding: { enforced: true, ok: false, checkedAt: NOW, code },
    }) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.admission.near, false);
    assert.equal(report.admission.usdc, false);
    assert.ok(report.checks.some(c => c.stage === "near-payment-watcher" && c.code === "near-watcher-stale"));
    assert.ok(report.checks.some(c => c.stage === "near-refund-funding" && c.code === expected));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_UPSTREAM_DETAIL/);
  }
});

test("a stale node is reported while a fresh fallback remains usable; loss of all fresh NEAR nodes blocks that rail", async () => {
  for (const both of [false, true]) {
    const f = fixture(({ url, body }) => {
      if ((both ? url.hostname.startsWith("near-") : url.hostname === "near-0.example") && body.method === "block") {
        return Response.json({ id: body.id, result: { header: { height: 100, hash: "old", timestamp_nanosec: String(BigInt(NOW - 180_000) * 1_000_000n) } } });
      }
    });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.near, !both); assert.equal(report.admission.nano, true);
    assert.ok(report.checks.some(c => c.code === "near-finalized-head-stale"));
  }
});

test("nearby NEAR finalized heads must agree at each endpoint's observed height", async t => {
  for (const kind of ["fork", "agree", "wrong-height", "missing"]) {
    const f = fixture(({ url, body }) => {
      if (!url.hostname.startsWith("near-") || body?.method !== "block") return;
      const header = (height, hash) => Response.json({ id: body.id,
        result: { header: { height, hash, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } } });
      if (url.hostname === "near-1.example" && body.params.finality === "final") return header(99, "observed-99");
      if (url.hostname === "near-2.example" && body.params.finality === "final") return header(98, "observed-98");
      if (url.hostname === "near-0.example" && body.params.block_id === 98) return header(98, "observed-98");
      if (url.hostname === "near-0.example" && body.params.block_id === 99) {
        if (kind === "missing") return new Response("unavailable", { status: 503 });
        return header(kind === "wrong-height" ? 98 : 99, kind === "fork" ? "private-other-fork" : "observed-99");
      }
    });
    f.config.nearRpcUrls.push("https://near-2.example");
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    const report = await runOperationalCheck(f.config, f.deps);
    const expected = kind === "agree" ? { stage: "near-rpc-ready", ok: true }
      : { stage: "near-rpc-ready", ok: false, domains: ["near", "usdc"],
        code: kind === "fork" ? "near-finalized-nodes-disagree" : "near-finalized-overlap-unverified" };
    assert.deepEqual(report.checks.find(c => c.stage === expected.stage), expected, kind);
    assert.deepEqual(report.admission, { nano: true, near: kind === "agree", usdc: kind === "agree", market: true });
    assert.deepEqual(f.calls.filter(({ body }) => body?.method === "block" && typeof body.params.block_id === "number")
      .map(({ url, body }) => [url.hostname, body.params.block_id]).sort(),
    [["near-0.example", 98], ["near-0.example", 99]]);
    assert.doesNotMatch(JSON.stringify(report), /observed-9[89]|private-other-fork|near-[012]\.example/);
  }
});

test("disagreeing Nano frontiers, an underfunded pool and stale exchange rates cannot produce healthy admission", async () => {
  for (const kind of ["frontier", "funds", "rates"]) {
    const f = fixture(({ url, body }) => {
      if (url.hostname.startsWith("nano-") && body?.action === "account_info" && kind === "funds") return Response.json(nanoAccountInfo({ balance: "0", frontier: "A".repeat(64) }));
      if (url.hostname === "nano-0.example" && body?.action === "account_info" && kind === "frontier") return Response.json(nanoAccountInfo({ balance: "100", frontier: "B".repeat(64) }));
      if (url.pathname === "/rates" && kind === "rates") return Response.json({ quoting: false, nearUsd: "3", xnoUsd: "1" });
    });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.nano, false); assert.equal(report.admission.market, false);
  }
});

test("a readable endpoint on the wrong Nano network cannot satisfy operational readiness", async () => {
  const f = fixture(({ url, body }) => url.hostname === "nano-0.example" && body?.action === "block_info"
    ? Response.json({ confirmed: "true", contents: { ...NANO_GENESIS_REPLY.contents, source: "0".repeat(64) } }) : null);
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, false); assert.equal(report.admission.nano, false);
  assert.ok(report.checks.some(c => c.stage === "nano-node-0" && c.code === "NANO_RPC_WRONG_NETWORK"));
});

test("the monitor reports a lagging peer and requires two current views for payment readiness", async t => {
  for (const third of [true, false]) {
    const f = fixture(({ url, body }) => url.hostname === "nano-0.example" && body?.action === "account_info"
      ? Response.json(nanoAccountInfo({ height: 7, frontier: "B".repeat(64) })) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    if (third) {
      f.config.nanoRpcUrls.push("https://nano-2.example");
      f.states["/state/funding-health.json"].nanoRpc.configuredPeers = 3;
    }
    const result = await runOperationalCheck(f.config, f.deps);
    assert.equal(result.ok, false);
    assert.ok(Object.values(result.admission).every(value => value === third));
    assert.ok(result.checks.some(c => c.stage === "nano-node-0-lag" && c.code === "nano-rpc-peer-lagging"));
    assert.ok(result.checks.some(c => c.stage === "nano-frontier-agreement" && c.ok === third
      && (third || c.code === "nano-rpc-lagging-peers")));
  }
});

test("the read-only Market probe reports unverified active escrow without retaining assignment data", async () => {
  const f = fixture(({ url }) => url.pathname === "/v1/agents/me/assignments"
    ? Response.json({ assignments: [
      { job: { jobKind: "competition" }, assignment: { escrowToken: "NEAR", escrowAmount: "0" } },
      { assignment: { escrowToken: "USDC", escrowAmount: "unavailable" }, private: "SECRET_ESCROW_FIXTURE" },
    ] })
    : null);
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.admission.market, false);
  assert.deepEqual(report.checks.find(check => check.stage === "market-escrow-nanoodle-image"), {
    stage: "market-escrow-nanoodle-image", ok: false, code: "market-escrow-unavailable", domains: ["market"],
  });
  assert.doesNotMatch(JSON.stringify(report), /SECRET_ESCROW_FIXTURE/);
  const entry = f.calls.find(call => call.url.pathname === "/v1/agents/me/assignments");
  assert.equal(entry.init.method || "GET", "GET");
  assert.equal(entry.url.searchParams.get("limit"), "100");
});

function marketIntakeRow(age, fields = {}) {
  return { assignment: { assignmentId: ID, status: "in_progress", escrowAmount: "1.00", escrowToken: "USDC",
    createdAt: new Date(NOW - age).toISOString(), slaDeadlineAt: new Date(NOW + 600_000).toISOString(), ...fields },
  job: { jobKind: "instant", title: "PRIVATE_BUYER_BRIEF" } };
}

test("Market intake catches unclaimed hires, remote starts missing local state and expired SLAs", async () => {
  const fresh = marketIntakeRow(40_000);
  const cases = [
    [fresh, false, null],
    [marketIntakeRow(301_000), false, "market-intake-untracked"],
    [marketIntakeRow(40_000, { startedAt: new Date(NOW - 1000).toISOString() }), false, "market-intake-start-without-record"],
    [marketIntakeRow(40_000, { deliverableUrl: "/PRIVATE_REWORK_DELIVERABLE" }), false, "market-intake-start-without-record"],
    [{ ...fresh, latestMessage: { senderSide: "worker" } }, false, "market-intake-start-without-record"],
    [marketIntakeRow(301_000), true, null],
    [marketIntakeRow(40_000, { escrowAmount: "0.02" }), true, "market-intake-escrow-below-priced-need"],
    [marketIntakeRow(301_000, { slaDeadlineAt: new Date(NOW - 1).toISOString() }), true, "market-intake-sla-expired"],
    [marketIntakeRow(40_000, { createdAt: "unavailable" }), false, "market-intake-timing-invalid"],
    [{ ...fresh, job: { jobKind: "competition" }, assignment: {} }, false, null],
  ];
  for (const [row, local, code] of cases) {
    const f = fixture(({ url }) => {
      if (url.pathname !== "/v1/agents/me/assignments") return null;
      if (local) f.states["/jobs/nanoodle-image/market-state.json"].assignments[ID] = { phase: "starting", pricing: { depositUsd: 0.03 } };
      return Response.json({ assignments: [row] });
    });
    const report = await runOperationalCheck(f.config, f.deps);
    const intake = report.checks.find(check => check.stage === "market-intake-nanoodle-image");
    assert.equal(intake.code ?? null, code);
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: code === null });
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${ID}|PRIVATE_BUYER_BRIEF|PRIVATE_REWORK_DELIVERABLE`));
  }
});

test("Market delivery windows warn before expiry without changing payment readiness", async t => {
  const cases = [
    ["started", 30_000, 3600, {}, "market-sla-start-window-ended"],
    ["running", 30_000, 3600, {}, "market-sla-execution-overdue"],
    ["running", 700_000, 3600, { executionDeadlineAt: NOW - 1 }, "market-sla-execution-overdue"],
    ["started", 700_000, 3600, { nextAttemptAt: NOW + 650_000 }, "market-sla-retry-after-cutoff"],
    ["delivering", 700_000, 3600, { nextAttemptAt: NOW + 650_000 }, null],
    ["submitting", 700_000, 3600, { nextAttemptAt: NOW + 700_000 }, "market-sla-retry-after-cutoff"],
    ["delivering", 600_000, 3600, {}, "market-sla-delivery-due"],
    ["running", 30_000, 60, {}, null],
  ];
  for (const [phase, left, slaSeconds, record, warning] of cases) {
    const row = marketIntakeRow(slaSeconds * 1000 - left, { slaSeconds, slaDeadlineAt: new Date(NOW + left).toISOString() });
    const f = fixture(({ url }) => url.pathname === "/v1/agents/me/assignments"
      ? Response.json({ assignments: [row] }) : null);
    t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
    f.states["/jobs/nanoodle-image/market-state.json"].assignments[ID] = { phase, pricing: { depositUsd: 0.03 }, ...record };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.ok(report.checks.find(c => c.stage === "market-intake-nanoodle-image")?.ok);
    const finding = report.checks.find(c => c.stage === "market-sla-nanoodle-image");
    assert.equal(finding.ok, warning === null);
    assert.equal(finding.code ?? null, warning);
    if (warning) assert.deepEqual(finding.domains, []);
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: true });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BUYER_BRIEF|executionDeadlineAt|nextAttemptAt/);
    if (warning === "market-sla-delivery-due") {
      const invocationId = ID.replaceAll("-", "");
      const alert = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: invocationId,
        MONITOR_SERVICE_RESULT: "exit-code", MONITOR_EXIT_CODE: "exited", MONITOR_EXIT_STATUS: "1" }, { ...report, invocationId }, NOW);
      assert.match(alert.text, /market-sla-delivery-due/);
    }
  }
});

test("a Market listing can cover the demo brief and still be underpriced for its supported fields", async t => {
  const f = fixture(), originalPrice = f.deps.computePrice;
  t.after(() => rmSync(f.config.stateDir, { recursive: true, force: true }));
  const workflow = f.config.agents[0].defaultWorkflow;
  workflow.fieldNames = ["Duration", "Style"];
  workflow.fieldSpecs = { Duration: { seconds: { min: 30, max: 240, defaultMin: 120, defaultMax: 180 } } };
  f.deps.computePrice = async (args, options) => {
    if (args.graph !== workflow.graph) return originalPrice(args, options);
    // The live listing leaves $0.95 after the Market fee. Only the longer
    // brief with both supported fields requires $0.96 for the run.
    const full = args.inputs.Idea?.length === 20_000 && args.inputs.Style?.length === 20_000
      && args.inputs.Duration === "240 seconds";
    return { safety: { ok: true }, pricing: { estimatedCostUsd: full ? 0.80 : 0.01 } };
  };
  const report = await runOperationalCheck(f.config, f.deps);
  assert.deepEqual(report.checks.find(c => c.stage === "workflow-price-nanoodle-image"), {
    stage: "workflow-price-nanoodle-image", ok: false, code: "market-workflow-underpriced", domains: ["market"],
  });
  assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: false });
});

test("Market intake reads later pages and reports an exhausted scan budget", async () => {
  for (const exhausted of [false, true]) {
    const page = Array.from({ length: 100 }, () => ({ job: { jobKind: "competition" } }));
    const f = fixture(({ url }) => {
      if (url.pathname !== "/v1/agents/me/assignments") return null;
      const offset = Number(url.searchParams.get("offset"));
      return Response.json({ assignments: exhausted || offset === 0 ? page : [marketIntakeRow(301_000)] });
    });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.admission.market, false);
    assert.equal(report.checks.find(check => check.stage === "market-intake-nanoodle-image").code,
      exhausted ? "market-intake-scan-incomplete" : "market-intake-untracked");
    const offsets = f.calls.filter(call => call.url.pathname === "/v1/agents/me/assignments").map(call => call.url.searchParams.get("offset"));
    assert.deepEqual(offsets, exhausted ? ["0", "100", "200", "300", "400"] : ["0", "100"]);
  }
});

test("a changed Market fee or invalid agent token is actionable even when public listings still respond", async () => {
  for (const kind of ["fee", "token"]) {
    const f = fixture(({ url }) => {
      if (url.pathname === "/v1/platform/config" && kind === "fee") return Response.json({ platform_fee_bps: 1000 });
      if (url.pathname === "/v1/agents/me/assignments" && kind === "token") return new Response("PRIVATE_ERROR_PAYLOAD", { status: 401 });
    });
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false); assert.equal(report.admission.market, false); assert.equal(report.admission.nano, true);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ERROR|SYNTHETIC_PRIVATE/);
  }
});

test("dead workers, a stale payment watcher and low disk space are reported independently of public availability", async () => {
  const f = fixture(({ url }) => {
    if (url.pathname === "/near/health") return Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near", watcher: { listening: true, height: 100, lastScanAt: new Date(NOW - 300_000).toISOString() } });
  });
  f.deps.isWorkerAlive = () => false;
  f.deps.statfs = () => ({ bavail: 1, blocks: 1e6, bsize: 4096, ffree: 100 });
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, false);
  for (const stage of ["market-process-nanoodle-image", "near-payment-watcher", "state-disk-space"]) assert.ok(report.checks.some(c => c.stage === stage && !c.ok));
});

test("disabled and overdue timers are detected, while a newly enabled daily timer has time for its first run", async () => {
  for (const disabled of [true, false]) {
    const f = fixture();
    f.deps.unitState = unit => {
      if (!unit.endsWith(".timer")) return { ActiveState: "inactive", Result: "success" };
      if (unit === "nanoodle-near-check.timer") return { ActiveState: "active", UnitFileState: "enabled", LastTriggerUSec: "n/a", ActiveEnterTimestamp: "@" + String(NOW / 1000) };
      return { ActiveState: "active", UnitFileState: disabled ? "disabled" : "enabled", LastTriggerUSec: "Tue 2026-11-17 00:00:00 UTC" };
    };
    const report = await runOperationalCheck(f.config, f.deps);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some(c => c.stage === "timer-nanoodle-near-check" && c.ok));
    assert.ok(report.checks.some(c => c.code === (disabled ? "check-timer-not-enabled" : "check-timer-missed")));
  }
});

test("unchanged incidents retain one identity; six-hour reminders, recovery and new incidents remain distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "operational-incident-"));
  const issues = [{ stage: "nano-liquidity", ok: false, code: "insufficient", domains: ["nano"] }];
  const first = finishOperationalReport(dir, issues, NOW, { invocationId: "a".repeat(32) });
  const next = finishOperationalReport(dir, issues, NOW + 300_000, { invocationId: "b".repeat(32) });
  assert.equal(next.invocationId, "b".repeat(32));
  assert.equal(next.incidentId, first.incidentId);
  const reminder = finishOperationalReport(dir, issues, NOW + 6 * 3_600_000);
  assert.notEqual(reminder.incidentId, first.incidentId);
  assert.equal(finishOperationalReport(dir, [], NOW + 7 * 3_600_000).ok, true);
  assert.notEqual(finishOperationalReport(dir, issues, NOW + 8 * 3_600_000).incidentId, reminder.incidentId);
  const scoped = finishOperationalReport(dir, issues, NOW + 8 * 3_600_000 + 300_000);
  const advisory = finishOperationalReport(dir, [{ ...issues[0], domains: [] }], NOW + 8 * 3_600_000 + 600_000);
  assert.notEqual(advisory.incidentId, scoped.incidentId, "an admission impact change opens a new incident");
});
