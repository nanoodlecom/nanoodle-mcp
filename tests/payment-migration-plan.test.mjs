import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectRecoverySet } from "../scripts/inspect-payment-migration.mjs";

const nano = { v: 2, quotes: [], owed: [] };
const near = payouts => ({ v: 1, quotes: {}, refunds: {}, payouts });

test("migration planning requires finality evidence even for historical sent creator records", () => {
  const report = inspectRecoverySet({ nano, near: near({
    old: { paymentId: "old", status: "sent", prepared: { hash: "PRIVATE_HASH", block: { account: "PRIVATE_ACCOUNT" } }, amountRaw: "100" },
    waiting: { paymentId: "waiting", status: "signed", prepared: { hash: "PRIVATE_HASH" }, amountRaw: "200" },
    unknown: { paymentId: "unknown", status: "sent", amountRaw: "300" },
  }) });
  assert.equal(report.near.finalizedCreatorProofsRequired, 3);
  assert.equal(report.near.sentPreparedPayouts, 1); assert.equal(report.near.pendingPreparedPayouts, 1);
  assert.equal(report.near.untraceablePayouts, 1); assert.equal(report.near.creatorObligationsRaw, "200");
  assert.equal(report.opensJournal, false); assert.equal(report.automaticTransfersAllowed, false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test("migration planning finds missing creator outboxes and active assignments without mutating state", () => {
  const state = { nano, near: near({}), markets: [{ v: 1, assignments: {
    job: { id: "job", phase: "submitted", creator: { status: "queued", author: "PRIVATE_AUTHOR", amountRaw: "100" } },
    running: { id: "running", phase: "running" },
  } }] }, before = JSON.stringify(state);
  const report = inspectRecoverySet(state);
  assert.equal(report.markets.orphanedCreatorPayouts, 1); assert.equal(report.markets.activeAssignments, 1);
  assert.equal(report.markets.creatorObligationsRaw, "100"); assert.equal(JSON.stringify(state), before);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_AUTHOR|"job"/);
});
