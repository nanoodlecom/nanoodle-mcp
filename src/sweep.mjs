/**
 * Out-dir artifact sweeper — the privacy backstop for hosted servers.
 *
 * emitResult() writes every generated image/video/audio into the out dir and
 * (in --serve mode) hands callers a /out/<file> URL to fetch it; nothing else
 * ever removes those files, so a paid public server accumulates every customer's
 * generations on disk forever. The product's promise is that the hosted server
 * keeps nothing it doesn't need — this sweep is what makes that true: media
 * older than the TTL is deleted, on a schedule, in the background.
 *
 * The one hard rule: only ever delete media artifacts. The same out dir also
 * holds the operator's own bookkeeping — costs.json, gate-state.json,
 * usage.jsonl — and *.tmp write-then-rename staging files that must never be
 * unlinked mid-rename. So we delete strictly by extension allow-list (the exact
 * set emitResult can produce, incl. the "bin" fallback extForMedia lands on for
 * unrecognized media), never by "everything that isn't bookkeeping". A new
 * sidecar dropped in the out dir later is safe by default — unknown extension,
 * left alone.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Extensions the server itself writes as media, and the ONLY files the sweep may
 * delete. Mirrors MIME_EXT/extForMedia in tools.mjs and OUT_MIME in http.mjs,
 * plus "bin" — the fallback extForMedia stamps on media whose type we couldn't
 * identify, which is still a generated artifact, not bookkeeping.
 */
export const MEDIA_EXTS = new Set([
  "png", "jpg", "gif", "webp",
  "mp3", "wav", "ogg", "aac", "flac", "m4a",
  "mp4", "webm", "mov", "bin",
]);

/** Lower-cased extension after the final dot, or "" for a dotless / dotfile name. */
function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Delete media artifacts in `dir` whose mtime is older than `ttlMs`. Returns the
 * number of files deleted. Never recurses (subdirs are skipped, not descended)
 * and never throws for the expected races: a missing out dir (nothing generated
 * yet) and a file unlinked out from under us (ENOENT) are both fine. Any other
 * per-file failure is logged and the sweep continues — one unreadable file must
 * not strand the rest on disk.
 */
export async function sweepOutDir({ dir, ttlMs, now = Date.now, log = () => {} }) {
  if (!(ttlMs > 0)) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return 0; // out dir not created yet — nothing to sweep
    log(`sweep: cannot read ${dir}: ${e.message}`);
    return 0;
  }
  const cutoff = now() - ttlMs;
  let deleted = 0;
  for (const ent of entries) {
    // Only plain files, only known media extensions — bookkeeping (json/jsonl)
    // and in-flight *.tmp staging are excluded by both checks.
    if (!ent.isFile() || !MEDIA_EXTS.has(extOf(ent.name))) continue;
    const path = join(dir, ent.name);
    try {
      const st = await stat(path);
      if (st.mtimeMs >= cutoff) continue; // still within the retention window
      await unlink(path);
      deleted++;
    } catch (e) {
      if (e.code === "ENOENT") continue; // already gone (rename/unlink race) — not an error
      log(`sweep: cannot remove ${path}: ${e.message}`);
    }
  }
  return deleted;
}

/** How often the background sweep runs after the startup pass. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Sweep once now, then on an interval forever. The interval is unref()'d so it
 * never by itself keeps the process alive — a stdio server that's otherwise done
 * still exits. Logs a single line only when files were actually deleted (a
 * count, never filenames — the whole point is not to keep a record of what was
 * generated). Returns a stop() for tests; the running server never calls it.
 */
export function startSweeper({ dir, ttlMs, now = Date.now, log = () => {}, intervalMs = SWEEP_INTERVAL_MS }) {
  if (!(ttlMs > 0)) return { stop() {} };
  const sweep = async () => {
    const n = await sweepOutDir({ dir, ttlMs, now, log });
    if (n > 0) log(`sweep: deleted ${n} generated file${n > 1 ? "s" : ""} older than the --out-ttl`);
  };
  sweep(); // startup pass — clears anything already stale from a previous run
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}
