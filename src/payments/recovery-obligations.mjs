/** Pure accounting for authority that an older writer may already have used. */
const fail = () => { throw Error("recovery-obligations-invalid"); };
const states = new Set(["pending", "paid", "consumed", "expired", "refunded"]);
export function nanoRecoveryObligations(data, { live = false } = {}) {
  if (!data || ![1, 2, 3].includes(data.v) || !Array.isArray(data.quotes) || !Array.isArray(data.owed)) fail();
  const legacy = data.v !== 3;
  let heldRuns = 0, heldPayouts = 0;
  for (const q of data.quotes) {
    if (!q || !states.has(q.status) || (q.settled != null && typeof q.settled !== "boolean")
      || (q.recoveryRequired != null && typeof q.recoveryRequired !== "boolean")) fail();
    const paid = ["paid", "consumed"].includes(q.status) || q.status === "expired" && !!q.payHash;
    if (q.settled !== true && paid && (legacy || q.recoveryRequired
      || !live && q.execution === "intent" || q.execution === "completed")) heldRuns++;
  }
  for (const o of data.owed) {
    if (!o || (o.legacy != null && typeof o.legacy !== "boolean") || (o.held != null && typeof o.held !== "boolean")) fail();
    if (legacy || o.legacy || o.held || ["review_required", "legacy_uncertain"].includes(o.state)) heldPayouts++;
  }
  return { heldRuns, heldPayouts, queuedPayouts: data.owed.length };
}

export function creatorRecoveryObligations(payouts, { isJournaled = () => false } = {}) {
  if (!Array.isArray(payouts) || typeof isJournaled !== "function") fail();
  let unverifiedCreatorPayouts = 0;
  const seen = new Set();
  for (const p of payouts) {
    if (!p || typeof p.paymentId !== "string" || !p.paymentId || seen.has(p.paymentId)
      || !["queued", "signed", "sent"].includes(p.status)) fail();
    seen.add(p.paymentId);
    // Older "sent" means a publish returned, not necessarily confirmation.
    // Without canonical proof it must not authorize another account frontier.
    if ((p.status === "sent" || p.status === "signed" || p.prepared != null) && isJournaled(p) !== true) unverifiedCreatorPayouts++;
  }
  return { unverifiedCreatorPayouts };
}

export function marketRecoveryObligations(records, payouts) {
  if (!Array.isArray(records) || !Array.isArray(payouts)) fail();
  const outbox = new Map(payouts.map(p => [p.paymentId, p]));
  let orphanedCreatorPayouts = 0;
  for (const r of records) {
    const c = r.creator;
    if (!c || !["owed", "queued"].includes(c.status)) continue;
    const p = outbox.get(`market_${r.id}`);
    if (p && (p.to !== c.author || p.amountRaw !== c.amountRaw)) fail();
    if (!p && c.status === "queued") orphanedCreatorPayouts++;
  }
  return { orphanedCreatorPayouts };
}
