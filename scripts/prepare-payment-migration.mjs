#!/usr/bin/env node
/** Explicit same-host offline preparation. No keys, signing, inference or activation.
 * Stop the original service first; use its OS user and writer-lock namespace. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { checkAddress, hashBlock } from "nanocurrency";
import { acquireWriterLocks, canonicalStatePath, paymentWriterResources } from "../src/process-lock.mjs";
import { readStartupPolicy, verifyStartupState } from "../src/startup-state.mjs";
import { selectNanoCheckpoint } from "../src/nano-checkpoint.mjs";
import { createNanoReadPool, NANO_GENESIS } from "../src/nano-read-pool.mjs";
import { createProbeFetch } from "../src/probe-http.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { paymentLiabilities } from "../src/operational-state.mjs";
import { openRecoveryStore } from "../src/payments/recovery-store.mjs";
import { receiptDigest, validateInitialHead, validateMigrationReceipt } from "../src/payments/migration-receipt.mjs";
import { inspectRecoverySet } from "./inspect-payment-migration.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (condition, code) => { if (!condition) throw Object.assign(Error(code), { code }); };
const inside = (path, root) => path === root || path.startsWith(root + "/");
const financialDigest = quotes => sha(JSON.stringify(quotes.map(q => ({ id: q.id, tool: q.tool, argsHash: q.argsHash, usd: q.usd,
  pair: { raw: BigInt(q.pair.raw).toString(), usdNano: BigInt(q.pair.usdNano).toString() }, amountRaw: q.amountRaw,
  source: q.source ?? null, payHash: q.payHash ?? null, paidAt: q.paidAt ?? null, createdAt: q.createdAt, expiresAt: q.expiresAt,
  completedAt: q.completedAt ?? null, settled: q.settled === true, settleReceipt: q.settleReceipt ?? null }))
  .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
function frozenFile(path, { publicPolicy = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    need(s.isFile() && s.nlink === 1 && s.size <= 64 * 1024 * 1024
      && (publicPolicy ? [0, process.getuid()].includes(s.uid) && !(s.mode & 0o022)
        : s.uid === process.getuid() && !(s.mode & 0o077)), "MIGRATION_SOURCE_UNSAFE");
    const bytes = readFileSync(fd), value = JSON.parse(bytes);
    return { path, value, sha256: sha(bytes), dev: s.dev, ino: s.ino, publicPolicy };
  } finally { closeSync(fd); }
}
function unchanged(file) {
  const current = frozenFile(file.path, file);
  need(current.dev === file.dev && current.ino === file.ino && current.sha256 === file.sha256, "MIGRATION_SOURCE_CHANGED");
}
function privateDirectory(path) {
  const s = lstatSync(path);
  need(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077), "MIGRATION_DESTINATION_UNSAFE");
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableJson(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}

/** The sole transport is read-only RPC. Unknown or lagging ancestry fails closed. */
export async function preparePaymentMigration({ policyFile, destination, rpcUrls, fetch = globalThis.fetch,
  lockDir, now = Date.now, timeoutMs = 30_000 }) {
  need(isAbsolute(policyFile || "") && isAbsolute(destination || "") && Number.isSafeInteger(timeoutMs)
    && timeoutMs > 0 && timeoutMs <= 30_000, "MIGRATION_ARGUMENT_INVALID");
  need(Array.isArray(rpcUrls) && rpcUrls.length >= 2 && rpcUrls.length <= 8 && new Set(rpcUrls).size === rpcUrls.length,
    "MIGRATION_RPC_QUORUM_REQUIRED");
  for (const url of rpcUrls) {
    let parsed; try { parsed = new URL(url); } catch { need(false, "MIGRATION_ARGUMENT_INVALID"); }
    need(["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password, "MIGRATION_ARGUMENT_INVALID");
  }
  const p = readStartupPolicy(policyFile);
  need(p.v === 1 && checkAddress(p.nanoAddress), "MIGRATION_POLICY_INVALID");
  destination = canonicalStatePath(destination);
  need(!inside(destination, canonicalStatePath(p.outDir)) && (!p.marketRoot || !inside(destination, canonicalStatePath(p.marketRoot))),
    "MIGRATION_DESTINATION_UNSAFE");
  privateDirectory(dirname(destination));
  try { lstatSync(destination); need(false, "MIGRATION_DESTINATION_EXISTS"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const database = join(destination, "recovery.sqlite");
  const resources = paymentWriterResources({ nanoAddress: p.nanoAddress, outDir: p.outDir,
    nearMerchant: p.near?.merchant, nearNetwork: p.near?.network, marketRoot: p.marketRoot, recoveryDb: database });
  const locks = acquireWriterLocks({ resources, ...(lockDir ? { dir: lockDir } : {}) });
  let store, gate, actions = 0, forbiddenEffects = 0;
  const deadline = performance.now() + timeoutMs, signal = AbortSignal.timeout(timeoutMs);
  const live = () => { locks.assertHeld(); need(!signal.aborted && performance.now() < deadline, "MIGRATION_OBSERVATION_EXPIRED"); };
  try {
    const policySource = frozenFile(policyFile, { publicPolicy: true });
    need(JSON.stringify(policySource.value) === JSON.stringify(p), "MIGRATION_SOURCE_CHANGED");
    verifyStartupState({ policyFile, outDir: p.outDir, nanoAddress: p.nanoAddress, chargeNano: p.chargeNano,
      nearMerchant: p.near?.merchant, nearNetwork: p.near?.network, marketRoot: p.marketRoot, marketHandles: p.marketHandles });
    // Reject undisclosed dormant profiles rather than omitting their debts.
    if (p.marketRoot) {
      const actual = readdirSync(p.marketRoot, { withFileTypes: true }).flatMap(entry => {
        if (entry.name === "market-state.json") return [""];
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
        try { lstatSync(join(p.marketRoot, entry.name, "market-state.json")); return [entry.name]; }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
      });
      need(JSON.stringify(actual.sort()) === JSON.stringify([...p.marketHandles].sort()), "MIGRATION_SOURCE_SCOPE_MISMATCH");
    }
    const sources = [{ scope: "nano", ...frozenFile(join(p.outDir, "gate-state.json")) },
      ...(p.near ? [{ scope: "near", ...frozenFile(join(p.outDir, "near-state.json")) }] : []),
      ...p.marketHandles.map(handle => ({ scope: `market:${handle}`, ...frozenFile(join(p.marketRoot, handle, "market-state.json")) }))];
    const nano = sources[0].value, near = sources.find(s => s.scope === "near")?.value ?? null;
    const markets = sources.filter(s => s.scope.startsWith("market:")).map(s => s.value);
    const audit = inspectRecoverySet({ nano, near, markets });
    const expectedFinancialDigest = financialDigest(nano.quotes);
    const debts = paymentLiabilities({ nano, near: near ?? { v: 1, quotes: {}, refunds: {} }, market: markets }, { now: now() });
    need(audit.nano.paidUnsettled === 0 && audit.nano.unfinishedConsumed === 0 && audit.nano.owed === 0
      && !audit.nano.quoteCounts.pending && !audit.near.quoteCounts.pending && audit.near.activePaidQuotes === 0
      && audit.near.finalizedCreatorProofsRequired === 0 && audit.near.missingSettlementOutboxes === 0
      && Object.keys(audit.near.refundCounts).every(k => k === "sent")
      && audit.markets.activeAssignments === 0 && audit.markets.orphanedCreatorPayouts === 0
      && debts.nanoRaw === 0n && debts.nearYocto === 0n && debts.usdcAtomic === 0n && debts.marketUsdNano === 0n
      && debts.issues.length === 0, "MIGRATION_NOT_QUIESCENT");
    const fundingSource = frozenFile(join(p.outDir, "funding-health.json")), funding = fundingSource.value;
    const age = now() - Date.parse(funding.checkedAt);
    need(funding.v === 1 && funding.ok === true && funding.activeRuns === 0 && funding.oldestStartedAt === null
      && funding.liabilitiesRaw === "0" && funding.reservedRaw === "0" && funding.enforced === true && funding.protectTransfers === true
      && funding.writerProtection?.enforced === true && funding.writerProtection.requiredState === true
      && Number.isFinite(age) && age >= -30_000 && age <= 60_000, "MIGRATION_CHECKPOINT_UNAVAILABLE");
    const floor = selectNanoCheckpoint(funding.nanoRpc?.checkpoint, p.nanoAddress), rpc = funding.nanoRpc;
    need(rpc.enforced === true && rpc.configuredPeers === rpcUrls.length && rpc.minimumPeers === 2
      && [rpc.networkPeers, rpc.readablePeers].every(n => Number.isSafeInteger(n) && n >= 2 && n <= rpcUrls.length)
      && Number.isSafeInteger(rpc.lastReadAt) && now() - rpc.lastReadAt >= -30_000 && now() - rpc.lastReadAt <= 60_000,
      "MIGRATION_CHECKPOINT_UNAVAILABLE");
    const http = createProbeFetch({ fetch, timeoutMs: Math.min(timeoutMs, 5_000), maxBytes: 256 * 1024 });
    const pool = createNanoReadPool({ bases: rpcUrls, account: p.nanoAddress, checkAddress, hashBlock, now,
      rpc: async (body, url) => {
        live(); need(["account_info", "block_info"].includes(body.action), "MIGRATION_EFFECT_FORBIDDEN"); actions++;
        const response = await http(url, { method: "POST", headers: { "content-type": "application/json" }, signal, body: JSON.stringify(body) });
        live(); need(response.ok, "MIGRATION_RPC_UNAVAILABLE");
        const value = await response.json(); need(value && !value.error, "MIGRATION_RPC_UNAVAILABLE"); return value;
      } });
    const view = await pool.read({ action: "account_info", account: p.nanoAddress }); live();
    need(view.block_count === view.confirmed_height && view.frontier === view.confirmed_frontier
      && BigInt(view.block_count) >= BigInt(floor.head.blockCount), "MIGRATION_HEAD_BEHIND_FLOOR");
    const distance = BigInt(view.block_count) - BigInt(floor.confirmed.blockCount);
    need(distance <= 256n, "MIGRATION_ANCESTRY_LIMIT");
    let id = view.frontier.toUpperCase(), height = BigInt(view.block_count), initialHead;
    for (let walked = 0n; walked <= distance; walked++) {
      const info = await pool.block({ action: "block_info", hash: id }); live();
      need([true, "true"].includes(info.confirmed) && info.height === height.toString(), "MIGRATION_ANCESTRY_INVALID");
      let block = info.contents; if (typeof block === "string") block = JSON.parse(block);
      const head = { hash: id, blockCount: height.toString(), balance: block?.balance, representative: block?.representative, block };
      validateInitialHead(p.nanoAddress, head);
      if (!initialHead) {
        need(head.balance === view.confirmed_balance && head.representative === view.confirmed_representative,
          "MIGRATION_ANCESTRY_INVALID"); initialHead = head;
      }
      if (height === BigInt(floor.head.blockCount)) need(id === floor.head.hash, "MIGRATION_ANCESTRY_INVALID");
      if (height === BigInt(floor.confirmed.blockCount)) need(id === floor.confirmed.hash, "MIGRATION_ANCESTRY_INVALID");
      id = block.previous; height--;
    }
    const fingerprints = sources.map(({ scope, sha256 }) => ({ scope, sha256 }));
    const receipt = { v: 1, schema: 3, account: p.nanoAddress, networkGenesis: NANO_GENESIS, createdAt: now(),
      legacySha256: sources[0].sha256, sources: fingerprints, sourceSetSha256: sha(JSON.stringify(fingerprints)), initialHead };
    validateMigrationReceipt(receipt, { account: p.nanoAddress, scopes: fingerprints.map(s => s.scope) });
    live(); for (const source of [policySource, fundingSource, ...sources]) unchanged(source);
    mkdirSync(destination, { mode: 0o700 }); // Exclusive: partial attempts are never reused or overwritten.
    syncDirectory(dirname(destination));
    store = openRecoveryStore(database); store.bindAccount(p.nanoAddress, { requireHeight: true });
    const forbid = async () => { forbiddenEffects++; need(false, "MIGRATION_EFFECT_FORBIDDEN"); };
    gate = createChargeGate({ address: p.nanoAddress, ops: { rpc: forbid, transferId: forbid, reconcileTransfer: forbid },
      usd: 0.05, xnoUsd: 1, publicBase: "http://migration.invalid", stateFile: sources[0].path,
      requireExistingState: true, recoveryStore: store, canQuote: () => false });
    await gate.stopWatching(); gate = null;
    need(forbiddenEffects === 0, "MIGRATION_EFFECT_FORBIDDEN");
    const imported = store.load(`gate:${p.nanoAddress}`).data;
    need(imported.quotes.length === nano.quotes.length && financialDigest(imported.quotes) === expectedFinancialDigest,
      "MIGRATION_IMPORT_INCOMPLETE");
    store.initializeMigration(receipt); store.close(); store = null;
    const proposedPolicy = { ...p, v: 2, recovery: { path: database, schema: 3,
      legacySha256: receipt.legacySha256, receiptSha256: receiptDigest(receipt) } };
    store = openRecoveryStore(database, { requireExisting: true, migration: { ...proposedPolicy.recovery,
      account: p.nanoAddress, scopes: fingerprints.map(s => s.scope) } });
    need(store.status(p.nanoAddress).ready === true, "MIGRATION_IMPORT_INCOMPLETE"); store.close(); store = null;
    live(); for (const source of [policySource, fundingSource, ...sources]) unchanged(source);
    durableJson(join(destination, "migration-receipt.json"), receipt);
    durableJson(join(destination, "preparation.json"), { v: 1, preparedAt: new Date(now()).toISOString(),
      sourcePolicySha256: policySource.sha256, receiptSha256: receiptDigest(receipt), sources: fingerprints,
      financialSha256: expectedFinancialDigest,
      handoff: { fundingSha256: fundingSource.sha256, checkedAt: funding.checkedAt, checkpoint: floor },
      readOnlyRpcActions: actions, signatures: 0, transfers: 0, workflows: 0, activationInstalled: false });
    durableJson(join(destination, "state-policy.v2.json"), proposedPolicy); syncDirectory(destination);
    return { ok: true, schema: 3, sourceCount: sources.length, receiptSha256: receiptDigest(receipt),
      readOnlyRpcActions: actions, signatures: 0, transfers: 0, workflows: 0, activationInstalled: false };
  } finally {
    try { await gate?.stopWatching(); } finally { try { store?.close(); } finally { locks.close(); } }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = { rpcUrls: [] };
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      need(["--policy", "--destination", "--rpc"].includes(flag) && value, "MIGRATION_ARGUMENT_INVALID");
      if (flag === "--rpc") options.rpcUrls.push(value);
      else { const key = flag === "--policy" ? "policyFile" : "destination";
        need(options[key] === undefined, "MIGRATION_ARGUMENT_INVALID"); options[key] = value; }
    }
    console.log(JSON.stringify(await preparePaymentMigration(options)));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: /^(MIGRATION_[A-Z_]+|WRITER_BUSY|REQUIRED_STATE_UNAVAILABLE)$/.test(error.code || "")
      ? error.code : "MIGRATION_PREPARATION_FAILED", activationInstalled: false })); process.exitCode = 1;
  }
}
