#!/usr/bin/env node
/** Read-only release planning. Never opens the journal, signs, calls RPC or writes a file. */
import { readFile } from "node:fs/promises";
export function inspectLegacyState(data) {
  if (
    !data ||
    ![undefined, 1, 2].includes(data.v) ||
    !Array.isArray(data.quotes) ||
    !Array.isArray(data.owed)
  )
    throw Error("LEGACY_STATE_INVALID");
  const counts = {};
  let unsettled = 0,
    alreadySettled = 0,
    unfinished = 0;
  for (const q of data.quotes) {
    if (
      !q ||
      !["pending", "paid", "consumed", "expired", "refunded"].includes(
        q.status,
      ) ||
      !/^\d+$/.test(q.amountRaw) ||
      BigInt(q.amountRaw) <= 0n
    )
      throw Error("LEGACY_QUOTE_INVALID");
    counts[q.status] = (counts[q.status] || 0) + 1;
    if (q.status === "paid") {
      if (q.settled === true) alreadySettled++;
      else unsettled++;
    }
    if (q.status === "consumed" && !q.result && !q.error) unfinished++;
  }
  return {
    version: data.v ?? 1,
    quoteCounts: counts,
    paidAlreadySettled: alreadySettled,
    paidUnsettled: unsettled,
    unfinishedConsumed: unfinished,
    owed: data.owed.length,
    automaticLegacyTransfersAllowed: false,
    automaticLegacyExecutionAllowed: false,
    activationRequiresReview: true,
    rollbackRequiresJournalAwareWriter: true,
  };
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    if (process.argv.length !== 3)
      throw Error("USAGE: inspect-payment-migration.mjs <legacy-state-file>");
    console.log(
      JSON.stringify(
        inspectLegacyState(JSON.parse(await readFile(process.argv[2], "utf8"))),
      ),
    );
  } catch {
    console.error("Migration inspection failed; no data was changed.");
    process.exitCode = 1;
  }
}
