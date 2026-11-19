// A stopped service may initialize under a retained pause only when root binds
// the grant to this exact kernel process and its sealed release. No keys or RPC.
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { maintenanceProcessIdentity } from "./maintenance-report.mjs";
import { selectNanoCheckpoint } from "./nano-checkpoint.mjs";
import { readOperatorJson } from "./operator-file.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEALED_NODE_VERSIONS = new Set(["22.23.4", "22.23.5"]);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === keys.sort().join(",");
const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function qualifyStartupPermit({ file, ownerUid, request, releaseRoot = PACKAGE_ROOT }) {
  const read = readOperatorJson(file, ownerUid);
  if (read.status !== "valid") return read;
  try {
    const value = read.value, identity = maintenanceProcessIdentity(), root = realpathSync(releaseRoot), stat = lstatSync(root);
    const newPermit = value?.v === 2;
    if (!exact(value, ["v", "request", "process", "release", ...(newPermit ? ["nanoCheckpoint"] : [])]) || (!newPermit && value.v !== 1)
      || !exact(value.request, ["v", "token", "operation", "revision"])
      || !Object.keys(value.request).every(key => value.request[key] === request[key])
      || !exact(value.process, ["pid", "uid", "bootId", "startTicks"])
      || !Object.keys(identity).every(key => value.process[key] === identity[key])
      || !exact(value.release, ["path", "revision", "tree"]) || value.release.path !== root
      || !hex(value.release.revision, 40) || !hex(value.release.tree, 64)
      || (request.operation === "deploy" && value.release.revision !== request.revision)
      || !stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o222)) return { status: "unavailable" };
    const manifestFile = join(root, ".nanoodle-release.json");
    if (lstatSync(manifestFile).mode & 0o222) return { status: "unavailable" };
    const manifest = readOperatorJson(manifestFile, ownerUid, 16_384);
    if (manifest.status !== "valid") return { status: "unavailable" };
    const m = manifest.value;
    if (!exact(m, ["v", "revision", "repository", "node", "ci", "sourceTree", "tree", "files", "installScripts", "devDependencies"])
      || m.v !== 1 || m.revision !== value.release.revision || m.tree !== value.release.tree
      || m.repository !== "https://github.com/nanoodlecom/nanoodle-mcp.git" || !SEALED_NODE_VERSIONS.has(m.node)
      || !hex(m.sourceTree, 64) || !Number.isSafeInteger(m.files) || m.files < 1
      || !exact(m.ci, ["v", "repository", "revision", "workflow", "runId", "attempt"])
      || m.ci.v !== 1 || m.ci.revision !== m.revision || m.ci.repository !== "nanoodlecom/nanoodle-mcp"
      || m.ci.workflow !== ".github/workflows/test.yml" || !Number.isSafeInteger(m.ci.runId) || m.ci.runId < 1
      || !Number.isSafeInteger(m.ci.attempt) || m.ci.attempt < 1
      || m.installScripts !== false || m.devDependencies !== false) return { status: "unavailable" };
    // Root independently verifies the complete tree before issuing this grant;
    // the app checks this root-owned attestation, not an app-supplied Git SHA.
    return { status: "valid", fingerprint: read.fingerprint,
      ...(newPermit && { nanoCheckpoint: selectNanoCheckpoint(value.nanoCheckpoint) }) };
  } catch { return { status: "unavailable" }; }
}
