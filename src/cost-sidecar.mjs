import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

const LOCK_WAIT_MS = 3_000;
const SQLITE_BUSY = 5;

export async function readCostSidecar(path) {
  let parsed;
  try {
    // Open before checking the type so a concurrent rename cannot substitute a
    // blocking special file between the type check and the read.
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      if (!(await file.stat()).isFile()) throw new Error(`${path} is not a regular file`);
      parsed = JSON.parse(await readFile(file, "utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return Object.assign(Object.create(null), parsed && !Array.isArray(parsed) && typeof parsed === "object" ? parsed : null);
}

export function migrateCostName(costs, name) {
  const oldName = `${name}-noodle-graph`;
  if (!costs[name] && costs[oldName]) {
    costs[name] = costs[oldName];
    delete costs[oldName];
  }
}

function observedAt(record) {
  if (Number.isFinite(record.atMs)) return record.atMs;
  return typeof record.at === "string" ? Date.parse(record.at) || 0 : 0;
}

export function observedQuoteHighWater(record) {
  const latestExactUsd = record?.exact !== false && Number.isFinite(record?.usd) ? record.usd : 0;
  const { quoteHiUsd, hiUsd } = record ?? {};
  // Legacy high-water marks have no exactness attached. Keep their pricing
  // protection when a record predates the separate quote high-water field.
  const history = Number.isFinite(quoteHiUsd) && quoteHiUsd >= 0 ? quoteHiUsd : Number.isFinite(hiUsd) ? hiUsd : 0;
  return Math.max(0, latestExactUsd, history);
}

export function mergeCostRecords(previous, incoming) {
  if (!Number.isFinite(incoming?.usd)) return previous;
  if (!Number.isFinite(previous?.usd)) return incoming;
  const latest = observedAt(incoming) >= observedAt(previous) ? incoming : previous;
  const hiUsd = Math.max(0, previous.usd, incoming.usd,
    Number.isFinite(previous.hiUsd) ? previous.hiUsd : 0, Number.isFinite(incoming.hiUsd) ? incoming.hiUsd : 0);
  const quoteHiUsd = Math.max(observedQuoteHighWater(previous), observedQuoteHighWater(incoming));
  const withHistory = hiUsd > latest.usd && hiUsd !== latest.hiUsd ? { ...latest, hiUsd } : latest;
  return quoteHiUsd === latest.quoteHiUsd ? withHistory : { ...withHistory, quoteHiUsd };
}

// The SQLite file supplies an exclusive writer reservation only. The kernel
// releases that reservation if the process dies. Leave the lock file in place
// so all writers continue to lock the same inode.
export async function commitCostObservations(path, observations, toolNames) {
  await mkdir(dirname(path), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const lock = new DatabaseSync(`${path}.lock`);
  try {
    const deadline = performance.now() + LOCK_WAIT_MS;
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (error.errcode !== SQLITE_BUSY || performance.now() >= deadline) throw error;
        // Avoid blocking the event loop, which may also own the first writer.
        await setTimeout(10);
      }
    }

    const costs = await readCostSidecar(path);
    for (const name of toolNames) migrateCostName(costs, name);
    for (const [name, record] of observations) costs[name] = mergeCostRecords(costs[name], record);

    const tmp = `${path}.tmp`;
    // A prior process may have died after staging the JSON. Only the holder
    // of this reservation can discard it and publish a replacement.
    await unlink(tmp).catch(error => { if (error.code !== "ENOENT") throw error; });
    try {
      await writeFile(tmp, JSON.stringify(costs, null, 2) + "\n", { flag: "wx" });
      await rename(tmp, path);
    } catch (error) {
      if (error.code !== "EEXIST") await unlink(tmp).catch(() => {});
      throw error;
    }
    return costs;
  } finally {
    lock.close();
  }
}
