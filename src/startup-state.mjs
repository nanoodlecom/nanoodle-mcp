// Optional operator-owned production policy. This pins identities/paths and
// requires the complete existing recovery set before any wallet or worker I/O.
// It never initializes, repairs, copies or resumes a ledger.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalStatePath } from "./process-lock.mjs";

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = () => { throw Object.assign(Error("Required payment state is missing, invalid or mismatched; restore and reconcile the recovery set before restarting"), { code: "REQUIRED_STATE_UNAVAILABLE" }); };
function readJson(file, { policy = false } = {}) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (policy && (st.size > 1024 * 1024 || (st.mode & 0o022) || ![0, process.getuid()].includes(st.uid)))) fail();
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (!object(value)) fail();
    return value;
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function verifyStartupState({ policyFile, outDir, nanoAddress = null, chargeNano = false,
  nearMerchant = null, nearNetwork = null, marketRoot = null, marketHandles = [] }) {
  if (!policyFile) return null;
  if (!isAbsolute(policyFile)) fail();
  const p = readJson(policyFile, { policy: true });
  const keys = new Set(["v", "outDir", "nanoAddress", "chargeNano", "near", "marketRoot", "marketHandles"]);
  if (p.v !== 1 || Object.keys(p).some(k => !keys.has(k)) || typeof p.outDir !== "string" || !isAbsolute(p.outDir)
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

  const files = [];
  if (p.chargeNano) {
    const file = join(outDir, "gate-state.json"), s = readJson(file);
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
  return { requireExisting: true, files };
}
