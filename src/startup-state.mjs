// Optional operator-owned production policy. This pins identities/paths and
// requires the complete existing recovery set before any wallet or worker I/O.
// It never initializes, repairs, copies or resumes a ledger.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalStatePath } from "./process-lock.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = () => { throw Object.assign(Error("Required payment state is missing, invalid or mismatched; restore and reconcile the recovery set before restarting"), { code: "REQUIRED_STATE_UNAVAILABLE" }); };
function readJson(file, { policy = false, sha256 = null } = {}) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (policy && (st.size > 1024 * 1024 || (st.mode & 0o022) || ![0, process.getuid()].includes(st.uid)))) fail();
    const bytes = readFileSync(fd);
    if (sha256 !== null && createHash("sha256").update(bytes).digest("hex") !== sha256) fail();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!object(value)) fail();
    return value;
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function readStartupPolicy(policyFile) {
  if (!isAbsolute(policyFile || "")) fail();
  const policy = readJson(policyFile, { policy: true });
  if (![1, 2].includes(policy.v)) fail();
  return policy;
}

export function verifyStartupState({ policyFile, outDir, nanoAddress = null, chargeNano = false,
  nearMerchant = null, nearNetwork = null, marketRoot = null, marketHandles = [], recoveryDb = null, requireRecoveryMonitoring = false }) {
  if (!policyFile) return null;
  if (!isAbsolute(policyFile)) fail();
  const p = readStartupPolicy(policyFile);
  const keys = new Set(["v", "outDir", "nanoAddress", "chargeNano", "near", "marketRoot", "marketHandles", ...(p.v === 2 ? ["recovery"] : [])]);
  if (![1, 2].includes(p.v) || Object.keys(p).some(k => !keys.has(k)) || typeof p.outDir !== "string" || !isAbsolute(p.outDir)
    || typeof p.chargeNano !== "boolean" || p.chargeNano !== chargeNano || p.nanoAddress !== nanoAddress
    || canonicalStatePath(p.outDir) !== canonicalStatePath(outDir)
    || !Array.isArray(p.marketHandles) || p.marketHandles.some(h => typeof h !== "string" || !/^(?:[a-z0-9][a-z0-9-]{0,63})?$/.test(h))
    || new Set(p.marketHandles).size !== p.marketHandles.length || (p.marketHandles.includes("") && p.marketHandles.length !== 1)
    || JSON.stringify([...p.marketHandles].sort()) !== JSON.stringify([...marketHandles].sort())) fail();
  if (nearMerchant) {
    if (!object(p.near) || p.near.merchant !== nearMerchant || p.near.network !== nearNetwork) fail();
  } else if (p.near !== null) fail();
  if (p.marketHandles.length) {
    if (typeof p.marketRoot !== "string" || !isAbsolute(p.marketRoot) || !marketRoot || canonicalStatePath(p.marketRoot) !== canonicalStatePath(marketRoot)) fail();
  } else if (p.marketRoot !== null) fail();

  let recovery = null;
  if (p.v === 1 && recoveryDb !== null) fail();
  if (p.v === 2) {
    const r = p.recovery;
    if (!object(r) || Object.keys(r).sort().join(",") !== "legacySha256,path,receiptSha256,schema"
      || r.schema !== 3 || typeof nanoAddress !== "string" || !isAbsolute(r.path || "")
      || !/^[a-f0-9]{64}$/.test(r.legacySha256 || "") || !/^[a-f0-9]{64}$/.test(r.receiptSha256 || "")
      || !recoveryDb || !isAbsolute(recoveryDb) || canonicalStatePath(r.path) !== canonicalStatePath(recoveryDb)
      || requireRecoveryMonitoring !== true) fail();
    const path = canonicalStatePath(r.path), output = canonicalStatePath(outDir);
    if (path === output || path.startsWith(output + "/")) fail(); // Never expose a financial DB through /out.
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077 || st.size === 0) fail();
    } catch { fail(); } finally { if (fd !== undefined) closeSync(fd); }
    recovery = { path, schema: 3, account: nanoAddress, legacySha256: r.legacySha256, receiptSha256: r.receiptSha256,
      scopes: ["nano", ...(p.near ? ["near"] : []), ...p.marketHandles.map(handle => `market:${handle}`)] };
  }

  const files = [];
  if (p.chargeNano || recovery) {
    const file = join(outDir, "gate-state.json"), s = readJson(file, { sha256: recovery?.legacySha256 ?? null });
    if (![1, 2].includes(s.v) || !Array.isArray(s.quotes) || !Array.isArray(s.owed)) fail();
    files.push(file);
  }
  if (p.near) {
    const file = join(outDir, "near-state.json"), s = readJson(file);
    if (s.v !== 1 || s.merchant !== nearMerchant || s.network !== nearNetwork
      || ![s.quotes, s.consumedTx, s.refunds, s.payouts ?? {}, s.meta ?? {}].every(object)) fail();
    files.push(file);
  }
  for (const handle of p.marketHandles) {
    const file = join(marketRoot, handle, "market-state.json"), s = readJson(file);
    if (s.v !== 1 || !object(s.assignments)) fail();
    files.push(file);
  }
  return { requireExisting: true, files, ...(recovery ? { recovery } : {}) };
}
