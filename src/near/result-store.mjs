import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateStateSync } from "../private-state.mjs";

const ID = /^nq_[A-Za-z0-9_-]{12}$/;
const FILE = /^nq_[A-Za-z0-9_-]{12}\.json(?:\.tmp-\d+)?$/;
const digest = text => createHash("sha256").update(text).digest("hex");

/** Private checkout results, separate from the financial ledger and its evidence exports. */
export function createNearResultStore(ledgerFile, { now, retentionMs, log }) {
  const directory = join(dirname(ledgerFile), ".near-results");
  function path(id) {
    if (!ID.test(id)) throw new TypeError("Invalid checkout result ID");
    return join(directory, id + ".json");
  }
  function checkDirectory() {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) {
      throw new Error("Unsafe checkout result directory");
    }
  }
  function store(id, content) {
    const file = path(id);
    const record = JSON.stringify({ content });
    const expiresAt = now() + retentionMs;
    try { checkDirectory(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    writePrivateStateSync(file, record);
    return { sha256: digest(record), expiresAt };
  }
  function load(id, reference) {
    let fd;
    try {
      checkDirectory();
      fd = openSync(path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 0o077) return null;
      const record = readFileSync(fd, "utf8");
      return digest(record) === reference.sha256 ? JSON.parse(record) : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  function sweep() {
    try {
      const cutoff = now() - retentionMs;
      checkDirectory();
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !FILE.test(file.name)) continue;
        const artifact = join(directory, file.name);
        try {
          if (lstatSync(artifact).mtimeMs <= cutoff) rmSync(artifact, { force: true });
        } catch {
          log("Could not remove an expired NEAR checkout result");
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") log("Could not sweep expired NEAR checkout results");
    }
  }
  return { store, load, sweep };
}
