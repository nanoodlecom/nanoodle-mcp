/**
 * Offline tests for the out-dir artifact sweeper (src/sweep.mjs). Everything runs
 * against a real temp dir with mtimes faked via fs.utimes — no network, no timers
 * left running (sweepOutDir is the one-shot the scheduler calls). The stakes:
 * the sweep must clear stale *media* and never, ever touch the operator's
 * bookkeeping (costs.json, gate-state.json, usage.jsonl) or in-flight *.tmp
 * staging files, regardless of their age.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOutDir, MEDIA_EXTS } from "../src/sweep.mjs";

/** Write a file and stamp its mtime `ageMs` in the past. */
async function writeAged(dir, name, ageMs) {
  const path = join(dir, name);
  await writeFile(path, "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

const HOUR = 60 * 60 * 1000;

test("old media is deleted, fresh media is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-media-"));
  try {
    await writeAged(dir, "run_noodle-image-old.png", 48 * HOUR);
    await writeAged(dir, "poster-clip-old.mp4", 48 * HOUR);
    await writeAged(dir, "run_noodle-image-fresh.png", 1 * HOUR);

    const deleted = await sweepOutDir({ dir, ttlMs: 24 * HOUR });
    assert.equal(deleted, 2);

    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["run_noodle-image-fresh.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bookkeeping and .tmp staging survive regardless of age", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-safe-"));
  try {
    // All ancient — only their extensions keep them alive.
    await writeAged(dir, "costs.json", 1000 * HOUR);
    await writeAged(dir, "gate-state.json", 1000 * HOUR);
    await writeAged(dir, "usage.jsonl", 1000 * HOUR);
    await writeAged(dir, "costs.json.7.tmp", 1000 * HOUR);
    await writeAged(dir, "gate-state.json.2.tmp", 1000 * HOUR);
    // A stale media file alongside them proves the sweep did run.
    await writeAged(dir, "poster-image-old.webp", 1000 * HOUR);

    const deleted = await sweepOutDir({ dir, ttlMs: 24 * HOUR });
    assert.equal(deleted, 1);

    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [
      "costs.json", "costs.json.7.tmp", "gate-state.json", "gate-state.json.2.tmp", "usage.jsonl",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every emitted media extension is swept when stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-exts-"));
  try {
    for (const ext of MEDIA_EXTS) await writeAged(dir, `out-${ext}.${ext}`, 48 * HOUR);
    const deleted = await sweepOutDir({ dir, ttlMs: 24 * HOUR });
    assert.equal(deleted, MEDIA_EXTS.size);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subdirectories are never recursed into or deleted", async () => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "sweep-nested-"));
  try {
    const sub = join(dir, "keep");
    await mkdir(sub);
    await writeAged(sub, "nested-old.png", 48 * HOUR); // stale, but one level down
    await writeAged(dir, "top-old.png", 48 * HOUR);

    const deleted = await sweepOutDir({ dir, ttlMs: 24 * HOUR });
    assert.equal(deleted, 1); // only the top-level file
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["keep"]);
    assert.deepEqual(await readdir(sub), ["nested-old.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing out dir is tolerated, not an error", async () => {
  const missing = join(tmpdir(), `sweep-nonexistent-${Date.now()}`);
  const deleted = await sweepOutDir({ dir: missing, ttlMs: 24 * HOUR });
  assert.equal(deleted, 0);
});

test("ttl of 0 (disabled) deletes nothing, however old", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-off-"));
  try {
    await writeAged(dir, "old.png", 1000 * HOUR);
    assert.equal(await sweepOutDir({ dir, ttlMs: 0 }), 0);
    assert.deepEqual(await readdir(dir), ["old.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fractional-hour TTL is honored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sweep-frac-"));
  try {
    await writeAged(dir, "past.png", 40 * 60 * 1000); // 40 min old
    await writeAged(dir, "recent.png", 10 * 60 * 1000); // 10 min old
    const deleted = await sweepOutDir({ dir, ttlMs: 0.5 * HOUR }); // 30 min
    assert.equal(deleted, 1);
    assert.deepEqual(await readdir(dir), ["recent.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
