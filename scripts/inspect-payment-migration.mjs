#!/usr/bin/env node
/** Read-only release planning. Never opens the journal, signs, calls RPC or writes a file. */
import { readFile } from "node:fs/promises";
import { creatorRecoveryObligations, marketRecoveryObligations } from "../src/payments/recovery-obligations.mjs";
import { nearCreatorLiabilities, marketCreatorLiabilities } from "../src/funding-liabilities.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const rows = value => { if (!object(value)) throw Error("RECOVERY_STATE_INVALID"); return Object.values(value); };
const counts = records => records.reduce((result, row) => {
  if (!row || typeof row.status !== "string" || !/^[a-z_]{1,40}$/.test(row.status)) throw Error("RECOVERY_STATE_INVALID");
  result[row.status] = (result[row.status] || 0) + 1; return result;
}, {});

export function inspectRecoverySet({ nano, near = null, markets = [] }) {
  const legacy = inspectLegacyState(nano);
  if (near !== null && near?.v !== 1 || !Array.isArray(markets)) throw Error("RECOVERY_STATE_INVALID");
  const payouts = near ? rows(near.payouts ?? {}) : [], quotes = near ? rows(near.quotes) : [], refunds = near ? rows(near.refunds) : [];
  const creator = creatorRecoveryObligations(payouts);
  const outbox = new Map(payouts.map(p => [p.paymentId, p]));
  let missingSettlementOutboxes = 0;
  for (const q of quotes) {
    const intent = q.settlement?.authorPayout;
    if (!intent) continue;
    const payout = outbox.get(q.id);
    if (!payout) missingSettlementOutboxes++;
    else if (payout.to !== intent.to || payout.amountRaw !== intent.amountRaw) throw Error("RECOVERY_OUTBOX_BINDING_INVALID");
  }
  const nearObligationsRaw = nearCreatorLiabilities({ quotes, payouts }).toString();
  let marketObligationsRaw = 0n, orphanedCreatorPayouts = 0, activeAssignments = 0;
  const assignmentPhases = {}, terminal = new Set(["submitted", "declined", "failed", "cancelled", "rejected", "expired"]);
  for (const market of markets) {
    if (market?.v !== 1) throw Error("RECOVERY_STATE_INVALID");
    const records = rows(market.assignments);
    orphanedCreatorPayouts += marketRecoveryObligations(records, payouts).orphanedCreatorPayouts;
    marketObligationsRaw += marketCreatorLiabilities(records, { payouts });
    for (const row of records) {
      if (!row || typeof row.phase !== "string" || !/^[a-z_]{1,40}$/.test(row.phase)) throw Error("RECOVERY_STATE_INVALID");
      assignmentPhases[row.phase] = (assignmentPhases[row.phase] || 0) + 1;
      if (!terminal.has(row.phase)) activeAssignments++;
    }
  }
  return { nano: legacy, near: { quoteCounts: counts(quotes), refundCounts: counts(refunds), payoutCounts: counts(payouts),
    activePaidQuotes: quotes.filter(q => ["paid", "running"].includes(q.status)).length,
    pendingPreparedPayouts: payouts.filter(p => p.status !== "sent" && p.prepared != null).length,
    sentPreparedPayouts: payouts.filter(p => p.status === "sent" && p.prepared != null).length,
    untraceablePayouts: payouts.filter(p => ["signed", "sent"].includes(p.status) && p.prepared == null && !p.txHash).length,
    finalizedCreatorProofsRequired: creator.unverifiedCreatorPayouts, missingSettlementOutboxes, creatorObligationsRaw: nearObligationsRaw },
    markets: { profiles: markets.length, assignmentPhases, activeAssignments, orphanedCreatorPayouts, creatorObligationsRaw: marketObligationsRaw.toString() },
    opensJournal: false, automaticTransfersAllowed: false, automaticExecutionAllowed: false, activationRequiresCanonicalMigration: true };
}
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
    if (process.argv.length < 3) throw Error("Migration inspection needs a legacy Nano file");
    const nano = JSON.parse(await readFile(process.argv[2], "utf8"));
    let near = null; const markets = [];
    for (let i = 3; i < process.argv.length; i += 2) {
      const flag = process.argv[i], file = process.argv[i + 1];
      if (!["--near", "--market"].includes(flag) || !file || flag === "--near" && near !== null) throw Error("Invalid migration inspection arguments");
      const value = JSON.parse(await readFile(file, "utf8"));
      if (flag === "--near") near = value; else markets.push(value);
    }
    console.log(JSON.stringify(process.argv.length === 3 ? inspectLegacyState(nano) : inspectRecoverySet({ nano, near, markets })));
  } catch {
    console.error("Migration inspection failed; no data was changed.");
    process.exitCode = 1;
  }
}
