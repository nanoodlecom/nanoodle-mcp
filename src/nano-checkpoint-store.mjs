import { readOperatorJson } from "./operator-file.mjs";
import { selectNanoCheckpoint } from "./nano-checkpoint.mjs";
import { writePrivateStateSync } from "./private-state.mjs";

const unavailable = () => Object.assign(Error("The durable Nano wallet checkpoint is unavailable"), { code: "NANO_CHECKPOINT_STORAGE" });

/** The hosted wallet calls this under its process-lifetime account and state locks. */
export function createNanoCheckpointStore(file, account, assertWriter) {
  const owner = process.getuid();
  let selected = null, fingerprint = null;

  function read() {
    assertWriter();
    const result = readOperatorJson(file, owner);
    if (result.status === "absent") return { checkpoint: null, fingerprint: null };
    if (result.status !== "valid") throw unavailable();
    const checkpoint = selectNanoCheckpoint(result.value, account);
    if (checkpoint.head.blockCount !== checkpoint.confirmed.blockCount) throw unavailable();
    return { checkpoint, fingerprint: result.fingerprint };
  }

  function assertCurrent() {
    if (read().fingerprint !== fingerprint) throw unavailable();
  }

  return {
    load({ allowNew }) {
      ({ checkpoint: selected, fingerprint } = read());
      if (!selected && !allowNew) throw unavailable();
      return selected;
    },
    assertCurrent,
    save(value) {
      assertCurrent();
      const next = selectNanoCheckpoint(value, account);
      if (next.head.blockCount !== next.confirmed.blockCount) throw unavailable();
      if (selected) {
        const difference = BigInt(next.head.blockCount) - BigInt(selected.head.blockCount);
        if (difference === 0n && next.head.hash === selected.head.hash) return;
        if (difference <= 0n) throw unavailable();
      }
      try {
        writePrivateStateSync(file, JSON.stringify(next) + "\n");
      } catch {
        throw unavailable();
      }
      const saved = read();
      if (JSON.stringify(saved.checkpoint) !== JSON.stringify(next)) throw unavailable();
      ({ checkpoint: selected, fingerprint } = saved);
    },
  };
}
