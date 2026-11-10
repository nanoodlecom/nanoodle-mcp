/**
 * Durable state for the Agent Market worker: one record per assignment, in
 * `<dir>/market-state.json`, plus the run's media files under `<dir>/out/`.
 *
 * Every change is written synchronously (temp file, fsync, rename, directory
 * fsync) before the remote call that depends on it, so a crash at any point
 * leaves a record that says what may already have happened:
 *
 *   phase "running" on disk  => the paid workflow may have started; never run it again.
 *   phase "submitting"       => a submit may have landed; look before submitting again.
 *
 * A file that exists but cannot be read stops the worker instead of starting
 * empty (an empty start could run a paid workflow a second time).
 *
 * One process owns a state directory: `worker.lock` holds its pid, host name,
 * boot id and a random nonce. It is taken over only when it was written on this
 * host in this boot and that pid is gone; a lock from another host or boot (two
 * containers sharing a volume) is never taken over automatically. Every write
 * first checks that the lock still holds this process's nonce, so a lost race
 * for a stale lock stops the loser instead of letting two processes write, and
 * close() removes the lock only while it is still this process's.
 *
 * The directory and files are created owner-only (0700 / 0600): records hold
 * the run's text outputs until the delivery is no longer needed.
 */
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, unlinkSync, rmSync, chmodSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

export const STATE_FILE = "market-state.json";
const LOCK_FILE = "worker.lock";

function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* not supported everywhere */ } finally { if (fd !== undefined) closeSync(fd); }
}

function writeAtomic(file, dir, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncDir(dir);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

function bootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null; } catch { return null; }
}

/** Parse a lock file: JSON { pid, host, boot, nonce }, or a bare pid (older locks). */
function parseLock(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") return { pid: Number(j.pid), host: j.host ?? null, boot: j.boot ?? null, nonce: j.nonce ?? null };
  } catch { /* not JSON */ }
  const pid = parseInt(text, 10);
  return { pid, host: null, boot: null, nonce: null };
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/**
 * Take the lock or throw. Returns { path, nonce }. `hooks.beforeTakeover` is a
 * test seam called between deciding that a lock is stale and removing it.
 */
function takeLock(dir, hooks = {}) {
  const lock = join(dir, LOCK_FILE);
  const host = hostname(), boot = bootId();
  for (let attempt = 0; attempt < 3; attempt++) {
    const nonce = randomBytes(12).toString("hex");
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host, boot, nonce }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      fsyncDir(dir);
      return { path: lock, nonce };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const seen = readText(lock);
    if (seen === null) continue; // removed meanwhile: try to create it again
    const held = parseLock(seen);
    if ((held.host && held.host !== host) || (held.boot && boot && held.boot !== boot)) {
      throw new Error(`${lock} was written by pid ${held.pid} on ${held.host || "an unknown host"}${held.boot && held.boot !== boot ? " in another boot" : ""}; ` +
        `this process cannot tell whether that worker is alive. Make sure no worker uses ${dir}, then remove the lock file by hand.`);
    }
    if (held.pid !== process.pid && pidAlive(held.pid)) {
      throw new Error(`another worker (pid ${held.pid}) owns ${dir}; run one worker per state directory`);
    }
    if (hooks.beforeTakeover) hooks.beforeTakeover();
    // Remove it only if it is still the stale lock we judged: another process may have taken it over meanwhile.
    if (readText(lock) !== seen) continue;
    try { unlinkSync(lock); } catch { /* raced */ }
  }
  throw new Error(`could not lock ${dir}`);
}

/**
 * @param {object} o
 * @param {string} o.dir           state directory (created 0700)
 * @param {() => number} [o.now]
 * @param {boolean} [o.lock]       take the one-process lock (default true)
 */
export function openMarketState({ dir, now = Date.now, lock = true, _lockHooks }) {
  if (typeof dir !== "string" || !dir) throw new TypeError("openMarketState needs a directory");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const held = lock ? takeLock(dir, _lockHooks) : null;
  const lockPath = held ? held.path : null;
  /** True while worker.lock still holds this process's nonce. */
  const ownsLock = () => {
    if (!held) return true;
    let text;
    try { text = readText(lockPath); } catch { return false; }
    return text !== null && parseLock(text).nonce === held.nonce;
  };
  const file = join(dir, STATE_FILE);

  let state;
  let text = null;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`market state ${file} could not be read: ${e.message}`);
  }
  if (text === null) {
    state = { v: 1, assignments: {} };
  } else {
    try { state = JSON.parse(text); } catch {
      throw new Error(`market state ${file} is not valid JSON; refusing to start empty (it may record a paid run). Inspect or move it aside.`);
    }
    if (!state || state.v !== 1 || typeof state.assignments !== "object" || state.assignments === null) {
      throw new Error(`market state ${file} has an unknown shape; refusing to start empty.`);
    }
  }

  let closed = false;
  const persist = () => {
    if (closed) throw new Error("market state is closed");
    if (!ownsLock()) {
      closed = true;
      throw new Error(`${lockPath} is no longer this process's lock (another worker took the state directory over); stopping without writing`);
    }
    writeAtomic(file, dir, JSON.stringify(state, null, 1));
  };

  return {
    dir,
    file,
    outDir: (id) => {
      const d = join(dir, "out", String(id).replace(/[^\w.-]+/g, "_"));
      mkdirSync(d, { recursive: true, mode: 0o700 });
      return d;
    },
    get: (id) => (state.assignments[id] ? structuredClone(state.assignments[id]) : null),
    all: () => Object.values(state.assignments).map((r) => structuredClone(r)),
    /** Create a record. Throws if it exists. */
    create(id, fields) {
      if (state.assignments[id]) throw new Error(`assignment ${id} already has a record`);
      const t = now();
      state.assignments[id] = { id, createdAt: t, updatedAt: t, attempts: 0, nextAttemptAt: 0, lastError: null, ...structuredClone(fields) };
      persist();
      return structuredClone(state.assignments[id]);
    },
    /** Merge fields into a record and write it to disk before returning. */
    update(id, fields) {
      const cur = state.assignments[id];
      if (!cur) throw new Error(`no record for assignment ${id}`);
      state.assignments[id] = { ...cur, ...structuredClone(fields), updatedAt: now() };
      persist();
      return structuredClone(state.assignments[id]);
    },
    /** Drop records (and their files) that finished before `before` (ms). */
    prune(before, isFinished) {
      let n = 0;
      for (const [id, r] of Object.entries(state.assignments)) {
        if (isFinished(r) && (r.finishedAt || r.updatedAt) < before) {
          delete state.assignments[id];
          try { rmSync(join(dir, "out", String(id).replace(/[^\w.-]+/g, "_")), { recursive: true, force: true }); } catch { /* best effort */ }
          n++;
        }
      }
      if (n) persist();
      return n;
    },
    close() {
      if (closed && !held) return;
      closed = true;
      // Only our own lock is removed; one another process holds now stays.
      if (lockPath && ownsLock()) try { unlinkSync(lockPath); } catch { /* gone */ }
    },
  };
}
