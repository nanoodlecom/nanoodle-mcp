// Bounded operator-owned JSON reads. No symlinks, blocking special files or
// writable parents; callers decide whether a qualified absence is meaningful.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export function readOperatorJson(file, ownerUid, limit = 4096) {
  let fd;
  const unavailable = { status: "unavailable" };
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16_384) return unavailable;
    const directory = dirname(file);
    if (realpathSync(directory) !== directory) return unavailable;
    const parent = lstatSync(directory, { bigint: true }), uid = BigInt(ownerUid);
    const safeParent = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && !(stat.mode & 0o022n);
    if (!safeParent(parent)) return unavailable;
    const parentUnchanged = () => {
      const current = lstatSync(directory, { bigint: true });
      return safeParent(current) && current.dev === parent.dev && current.ino === parent.ino;
    };
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { return error.code === "ENOENT" && parentUnchanged() ? { status: "absent" } : unavailable; }
    const before = fstatSync(fd, { bigint: true });
    const safe = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.uid === uid
      && !(stat.mode & 0o022n) && stat.size > 0n && stat.size <= BigInt(limit);
    if (!safe(before)) return unavailable;
    // Bound the actual reads, even if an operator changes size after fstat.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    while (size <= limit) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const raw = buffer.subarray(0, size), after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    const same = stat => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => stat[key] === before[key]);
    if (raw.length > limit || !safe(after) || !safe(current) || !same(after) || !same(current) || !parentUnchanged()) return unavailable;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
    return { status: "valid", value, fingerprint: `${before.dev}:${before.ino}:${before.mtimeNs}:${before.ctimeNs}:${createHash("sha256").update(raw).digest("hex")}` };
  } catch { return unavailable; }
  finally { if (fd !== undefined) closeSync(fd); }
}
