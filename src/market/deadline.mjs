const MAX_DELIVERY_RESERVE_MS = 60_000;
const MAX_SLA_WARNING_MS = 10 * 60_000;

export function marketDeliveryWindow(assignment) {
  const hiredAt = typeof assignment?.createdAt === "string" ? Date.parse(assignment.createdAt) : NaN;
  const deadline = typeof assignment?.slaDeadlineAt === "string" ? Date.parse(assignment.slaDeadlineAt) : NaN;
  if (!Number.isFinite(hiredAt) || !Number.isFinite(deadline) || deadline <= hiredAt) return null;
  // The current epoch can be newer than createdAt after a Market rework.
  const span = Number.isSafeInteger(assignment.slaSeconds) && assignment.slaSeconds > 0
    ? assignment.slaSeconds * 1_000 : deadline - hiredAt;
  // Leave time to upload and submit while scaling the reserve for short SLAs.
  return { hiredAt, deadline,
    executionDeadlineAt: deadline - Math.min(MAX_DELIVERY_RESERVE_MS, Math.floor(span / 10)),
    warningAt: deadline - Math.min(MAX_SLA_WARNING_MS, Math.floor(span / 4)) };
}
