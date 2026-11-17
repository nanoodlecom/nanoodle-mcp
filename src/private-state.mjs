// Synchronous financial metadata: private regular staging file, complete write,
// file sync, atomic rename and directory sync. A failed step never reports success.
import { constants, openSync, closeSync, fstatSync, fchmodSync, ftruncateSync, writeFileSync, fsyncSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export function writePrivateStateSync(file, text, { temporary = `${file}.tmp-${process.pid}` } = {}) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const state = fstatSync(fd);
    if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid()) throw Error("Unsafe financial-state staging file");
    fchmodSync(fd, 0o600); ftruncateSync(fd, 0);
    writeFileSync(fd, text); fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, file);
  const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
