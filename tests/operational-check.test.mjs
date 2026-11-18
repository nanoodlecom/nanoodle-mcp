import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { runOperationalCheck, finishOperationalReport, isMarketWorkerAlive } from "../scripts/operational-check.mjs";
import { deliverAlerts, EMBER, failureEvent } from "../scripts/near-alert.mjs";
import { NANO_GENESIS_HASH, NANO_GENESIS_REPLY, nanoAccountInfo } from "./fixtures/nano-protocol.mjs";
import { nearProtocol } from "./fixtures/near-fees.mjs";
import { rpcPeerSetId } from "../src/rpc-backoff.mjs";

const NOW = Date.parse("2026-11-17T01:00:00Z"), ID = "00000000-0000-0000-0000-000000000001";

test("the readiness CLI reports preflight failure when run through a release symlink", t => {
  const root = mkdtempSync(join(tmpdir(), "operational-check-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = join(root, "current"), stateDir = join(root, "state");
  symlinkSync(fileURLToPath(new URL("..", import.meta.url)), selected, "junction");
  // No wallet configuration or inherited runtime flags. Preflight stops before networking.
  const child = spawnSync(process.execPath, [join(selected, "scripts/operational-check.mjs")], {
    env: { OPERATIONAL_CHECK_STATE_DIR: stateDir }, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(readFileSync(join(stateDir, "latest.json"), "utf8"));
  assert.equal(report.ok, false);
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
    computePrice: async () => ({ safety: { ok: true }, pricing: { estimatedCostUsd: 0.01 } }),
    fetch: async (input, init = {}) => {
      const url = new URL(input), body = init.body ? JSON.parse(init.body) : null;
      const call = { url, init, body }; calls.push(call);
      assert.equal(init.redirect, "error"); assert.ok(init.signal);
      const replaced = override(call, config, states); if (replaced) return replaced;
      const json = result => Response.json(body?.jsonrpc ? { jsonrpc: "2.0", id: body.id, result } : result);
      if (/^nano-\d/.test(url.hostname)) {
        if (body.action === "block_info") return json(NANO_GENESIS_REPLY);
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
        if (body.method === "initialize") return json({ serverInfo: { name: "nanoodle" } });
        if (body.method === "tools/list") return json({ tools: ["sing", "price_noodle", "run_noodle", "noodle_guide"].map(name => ({ name })) });
        assert.equal(body.method, "tools/call"); assert.equal(body.params.name, "price_noodle", "never execute a paid tool or request a deposit");
        return json({ structuredContent: { pricing: { safety: { ok: true } } } });
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
  assert.equal(f.calls.filter(c => c.url.hostname === "nano-site.example").length, 2);
  const file = join(f.config.stateDir, "latest.json"), text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /SYNTHETIC|PRIVATE_BUYER|public|ed25519|assignment|account_id/);
  assert.equal(statSync(file).mode & 0o777, 0o644); assert.equal(JSON.stringify(f.states), before);
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

test("a runtime standby is recognized only with a fresh matching primary and without another standby request", async () => {
  for (const failure of [null, "mismatch", "inactive", "digest", "quota", "initializing", "cooling"]) {
    const f = fixture(({ url, body }) => {
      assert.notEqual(url.hostname, "standby.example", "scheduled probes do not spend the standby budget");
      if (url.hostname === "nano-0.example") return new Response("", { status: 503 });
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
    assert.equal(report.admission.nano, failure === null);
    assert.equal(report.admission.near, failure === null);
    if (!failure) assert.ok(report.checks.some(c => c.stage === "nano-standby" && c.code === "nano-standby-covering-quorum"));
    if (failure === "mismatch") assert.ok(report.checks.some(c => c.stage === "nano-frontier-agreement" && c.code === "nano-standby-checkpoint-disagrees"));
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_STANDBY|standby\.example/);
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
  for (const change of [{ enforced: false }, { checkedAt: NOW - 60_001 }, { ok: false }, { canQuoteUsdc: false }]) {
    const f = fixture(({ url }) => url.pathname === "/near/health" ? Response.json({ active: true, network: "mainnet", merchant: "nanoodle.near",
      watcher: { listening: true, lastScanAt: new Date(NOW).toISOString(), height: 100, backfilling: false },
      funding: { enforced: true, ok: true, checkedAt: NOW, canQuoteNear: true, canQuoteUsdc: true, ...change } }) : null);
    const result = await runOperationalCheck(f.config, f.deps);
    assert.equal(result.ok, false); assert.equal(result.admission.usdc, false);
    if (change.canQuoteUsdc === false) assert.equal(result.admission.near, true);
    else assert.equal(result.admission.near, false);
  }
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
  const report = await runOperationalCheck(f.config, f.deps);
  assert.equal(report.ok, false);
  assert.equal(report.nearBackfillSince, started);
  assert.equal(report.admission.near, true);
  assert.equal(report.admission.usdc, true);
  assert.ok(report.checks.some(c => c.stage === "near-payment-watcher" && c.ok));
  const event = failureEvent({ MONITOR_UNIT: "nanoodle-operational-check.service", MONITOR_INVOCATION_ID: "a".repeat(32) }, report, NOW);
  assert.match(event.text, /near-watcher-backfill=near-watcher-backfill-delayed/);
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
    [marketIntakeRow(301_000, { slaDeadlineAt: new Date(NOW - 1).toISOString() }), true, "market-intake-sla-expired"],
    [marketIntakeRow(40_000, { createdAt: "unavailable" }), false, "market-intake-timing-invalid"],
    [{ ...fresh, job: { jobKind: "competition" }, assignment: {} }, false, null],
  ];
  for (const [row, local, code] of cases) {
    const f = fixture(({ url }) => {
      if (url.pathname !== "/v1/agents/me/assignments") return null;
      if (local) f.states["/jobs/nanoodle-image/market-state.json"].assignments[ID] = { phase: "starting" };
      return Response.json({ assignments: [row] });
    });
    const report = await runOperationalCheck(f.config, f.deps);
    const intake = report.checks.find(check => check.stage === "market-intake-nanoodle-image");
    assert.equal(intake.code ?? null, code);
    assert.deepEqual(report.admission, { nano: true, near: true, usdc: true, market: code === null });
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${ID}|PRIVATE_BUYER_BRIEF|PRIVATE_REWORK_DELIVERABLE`));
  }
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
  const first = finishOperationalReport(dir, issues, NOW);
  assert.equal(finishOperationalReport(dir, issues, NOW + 300_000).incidentId, first.incidentId);
  const reminder = finishOperationalReport(dir, issues, NOW + 6 * 3_600_000);
  assert.notEqual(reminder.incidentId, first.incidentId);
  assert.equal(finishOperationalReport(dir, [], NOW + 7 * 3_600_000).ok, true);
  assert.notEqual(finishOperationalReport(dir, issues, NOW + 8 * 3_600_000).incidentId, reminder.incidentId);
});
