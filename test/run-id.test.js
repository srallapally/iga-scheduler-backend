import { describe, expect, it } from "vitest";
import { buildRunId } from "../src/utils/runId.js";

describe("buildRunId", () => {
  it("builds a POC runId without tenantId", () => {
    const runId = buildRunId({
      instanceId: "risk-score-prod-hourly",
      scheduledFireTime: "2026-06-03T18:00:00.000Z"
    });

    expect(runId).toBe(
      "risk-score-prod-hourly:2026-06-03T18:00:00.000Z"
    );
  });

  it("builds a multi-tenant runId when tenantId is present", () => {
    const runId = buildRunId({
      tenantId: "tenant-a",
      instanceId: "risk-score-prod-hourly",
      scheduledFireTime: "2026-06-03T18:00:00.000Z"
    });

    expect(runId).toBe(
      "tenant-a:risk-score-prod-hourly:2026-06-03T18:00:00.000Z"
    );
  });

  it("rejects missing instanceId", () => {
    expect(() => buildRunId({
      scheduledFireTime: "2026-06-03T18:00:00.000Z"
    })).toThrow("instanceId is required");
  });

  it("rejects missing scheduledFireTime", () => {
    expect(() => buildRunId({
      instanceId: "risk-score-prod-hourly"
    })).toThrow("scheduledFireTime is required");
  });
});
