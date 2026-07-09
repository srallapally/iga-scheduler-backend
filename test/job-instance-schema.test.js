import { describe, expect, it } from "vitest";
import { createJobInstanceSchema } from "../src/validation/jobInstanceSchema.js";
import { computeNextFireAt } from "../src/utils/schedule.js";

describe("createJobInstanceSchema", () => {
  it("accepts a valid instance", () => {
    const result = createJobInstanceSchema.parse({
      instanceId: "risk-score-prod-hourly",
      enabled: true,
      schedule: {
        type: "cron",
        expression: "0 * * * *",
        timezone: "America/Los_Angeles"
      },
      parameters: {
        scanType: {
          type: "string",
          value: "FULL"
        },
        applications: {
          type: "string[]",
          value: ["Salesforce", "Workday"]
        },
        apiCredential: {
          type: "sensitive",
          secretRef: "projects/iga-scheduler/secrets/risk-score-api-credential/versions/latest"
        }
      }
    });

    expect(result.instanceId).toBe("risk-score-prod-hourly");
  });

  it("rejects sensitive plaintext values", () => {
    expect(() => createJobInstanceSchema.parse({
      instanceId: "risk-score-prod-hourly",
      schedule: {
        type: "cron",
        expression: "0 * * * *",
        timezone: "America/Los_Angeles"
      },
      parameters: {
        apiCredential: {
          type: "sensitive",
          secretRef: "projects/iga-scheduler/secrets/risk-score-api-credential/versions/latest",
          value: "plaintext"
        }
      }
    })).toThrow();
  });

  it("computes nextFireAt for cron", () => {
    const next = computeNextFireAt({
      type: "cron",
      expression: "0 * * * *",
      timezone: "UTC"
    }, new Date("2026-06-02T07:21:00.000Z"));

    expect(next).toBe("2026-06-02T08:00:00.000Z");
  });
});
