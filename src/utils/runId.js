export function buildRunId({ tenantId, instanceId, scheduledFireTime }) {
  if (!instanceId || typeof instanceId !== "string") {
    throw new Error("instanceId is required");
  }

  if (!scheduledFireTime || typeof scheduledFireTime !== "string") {
    throw new Error("scheduledFireTime is required");
  }

  return tenantId
    ? `${tenantId}:${instanceId}:${scheduledFireTime}`
    : `${instanceId}:${scheduledFireTime}`;
}
