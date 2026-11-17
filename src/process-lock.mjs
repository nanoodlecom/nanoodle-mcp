// Process-lifetime advisory locks, before any hosted payment recovery or PoW.
// Keep the parent's fd open: flock's short-lived child inherits the same Linux
// open-file description. Never unlink a lock file, including during shutdown.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export function canonicalStatePath(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (error.code !== "ENOENT" || dirname(absolute) === absolute) throw error;
    return join(canonicalStatePath(dirname(absolute)), basename(absolute));
  }
}

export function defaultWriterLockDir(env = process.env) {
  if (env.NANOODLE_WRITER_LOCK_DIR !== undefined) {
    if (!isAbsolute(env.NANOODLE_WRITER_LOCK_DIR)) throw TypeError("NANOODLE_WRITER_LOCK_DIR must be absolute");
    return resolve(env.NANOODLE_WRITER_LOCK_DIR);
  }
  // Use the OS account, not HOME/XDG overrides that can differ between a shell
  // and systemd. Explicit alternate namespaces must be shared by every writer.
  return join(userInfo().homedir, ".local", "state", "nanoodle-mcp", "writer-locks");
}

/** Use the same account/path scopes for the app and an offline migration. */
export function paymentWriterResources({ nanoAddress = null, nearMerchant = null, nearNetwork = null,
  outDir = null, marketRoot = null, recoveryDb = null }) {
  return [
    ...(nanoAddress ? [`nano:${nanoAddress}`] : []),
    ...(nearMerchant ? [`near:${nearNetwork}:${nearMerchant}`] : []),
    ...(outDir ? [`state:${canonicalStatePath(outDir)}`] : []),
    ...(marketRoot ? [`market:${canonicalStatePath(marketRoot)}`] : []),
    ...(recoveryDb ? [`recovery:${canonicalStatePath(recoveryDb)}`] : []),
  ];
}

export function acquireWriterLocks({ resources, dir = defaultWriterLockDir() }) {
  if (!Array.isArray(resources) || resources.some(r => typeof r !== "string" || !r)) throw TypeError("invalid writer resources");
  if (!resources.length) throw TypeError("no writer resources");
  if (process.platform !== "linux") throw Error("Automatic payment writer protection requires Linux and /usr/bin/flock");
  const uid = process.getuid();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o077)) {
    throw Error("Writer lock directory must be owned by this user, mode 0700, and not a symlink");
  }
  const held = [];
  const count = new Set(resources).size;
  const close = () => { for (const { fd } of held.splice(0)) closeSync(fd); };
  try {
    for (const resource of [...new Set(resources)].sort()) {
      const digest = createHash("sha256").update(resource).digest("hex");
      const file = join(dir, digest + ".lock");
      const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      held.push({ fd, file });
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) || st.nlink !== 1) throw Error("Unsafe writer lock file");
      try {
        execFileSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
          stdio: ["ignore", "ignore", "pipe", fd], env: { PATH: "/usr/bin:/bin" }, timeout: 3000,
        });
      } catch (error) {
        if (error.status === 75) throw Object.assign(Error("Another payment writer owns this account or state directory; stop it before starting a replacement"), { code: "WRITER_BUSY" });
        throw Object.assign(Error("Cannot acquire payment writer protection; Linux /usr/bin/flock must be available"), { code: "WRITER_LOCK_UNAVAILABLE" });
      }
    }
  } catch (error) { close(); throw error; }
  // Holding these descriptors neither creates a timer nor keeps Node alive.
  // SIGKILL/reboot closes them in the kernel; there is no stale-PID takeover.
  function assertHeld() {
    try {
      const currentDir = lstatSync(dir);
      if (held.length !== count || currentDir.dev !== directory.dev || currentDir.ino !== directory.ino
        || currentDir.uid !== uid || (currentDir.mode & 0o077)) throw Error();
      for (const { fd, file } of held) {
        const opened = fstatSync(fd), current = lstatSync(file);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
          || current.nlink !== 1 || current.uid !== uid || (current.mode & 0o077)) throw Error();
      }
    } catch { throw Object.assign(Error("Payment writer lock was removed, replaced or closed; stop and reconcile before restarting"), { code: "WRITER_LOCK_LOST" }); }
  }
  return { close, count, assertHeld };
}
