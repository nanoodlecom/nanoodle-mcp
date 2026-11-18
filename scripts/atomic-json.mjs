import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Sync the contents and directory before callers publish a payment or report.
export function atomicJson(file, value) {
  const tmp = file + ".tmp", fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(resolve(file, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
