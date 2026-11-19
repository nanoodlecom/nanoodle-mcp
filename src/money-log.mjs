// Money events only. No prompts, model output or run error text belongs here.
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export function createMoneyLog({ file, maintenance = null, now = Date.now, log = () => {} }) {
  let chain = Promise.resolve(), pendingWrites = 0, failed = false;
  function write(event, fields) {
    const line = JSON.stringify({ ts: new Date(now()).toISOString(), event, ...fields }) + "\n";
    const append = async () => {
      let handle;
      try {
        await mkdir(dirname(file), { recursive: true });
        handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const state = await handle.stat();
        if (!state.isFile() || state.nlink !== 1 || state.uid !== process.getuid()) throw Error("unsafe money log");
        await handle.chmod(0o600);
        await handle.writeFile(line);
        await handle.sync();
        await handle.close(); handle = null;
        const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        failed = true; // A later append cannot repair a missing prior event.
        try { log("A money event could not be persisted; operator reconciliation is required"); } catch { /* Logging cannot wedge later entries. */ }
      } finally {
        try { await handle?.close(); } catch { failed = true; }
        pendingWrites--;
      }
    };
    const scheduled = maintenance ? maintenance.capture(append, "background") : append;
    pendingWrites++;
    chain = chain.then(scheduled);
  }
  return { write, status: () => ({ ok: !failed, pendingWrites }), flush: () => chain };
}
