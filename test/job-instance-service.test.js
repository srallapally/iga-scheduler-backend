import { describe, expect, it, vi } from "vitest";
import { JobInstanceService } from "../src/services/jobInstanceService.js";

function createMockEs() {
  const docs = new Map();

  docs.set("scheduler_definitions_v1:risk-score", {
    definitionId: "risk-score",
    version: 1,
    state: "ACTIVE",
    enabled: true,
    parameters: [
      { name: "scanType", type: "string", required: true },
      { name: "applications", type: "string[]", required: false },
      { name: "apiCredential", type: "sensitive", required: false }
    ]
  });

  return {
    docs,
    create: vi.fn(async ({ index, id, document }) => {
      const key = `${index}:${id}`;
      if (docs.has(key)) {
        const error = new Error("conflict");
        error.meta = { statusCode: 409 };
        throw error;
      }
      docs.set(key, document);
      return {};
    }),
    get: vi.fn(async ({ index, id }) => {
      const key = `${index}:${id}`;
      if (!docs.has(key)) {
        const error = new Error("not found");
        error.meta = { statusCode: 404 };
        throw error;
      }
      return { _source: docs.get(key) };
    }),
    update: vi.fn(async ({ index, id, doc }) => {
      const key = `${index}:${id}`;
      if (!docs.has(key)) {
        const error = new Error("not found");
        error.meta = { statusCode: 404 };
        throw error;
      }
      docs.set(key, { ...docs.get(key), ...doc });
      return {};
    }),
    search: vi.fn(async () => ({
      hits: {
        hits: [...docs.entries()]
          .filter(([key]) => key.startsWith("scheduler_instances_v1:"))
          .map(([, value]) => ({ _source: value }))
      }
    }))
  };
}

async function createRiskScoreInstance(service) {
  return service.createInstance("risk-score", {
    instanceId: "risk-score-prod-hourly",
    enabled: true,
    schedule: {
      type: "cron",
      expression: "0 * * * *",
      timezone: "UTC"
    },
    parameters: {
      scanType: { type: "string", value: "FULL" }
    }
  });
}

describe("JobInstanceService", () => {
  it("creates an instance for an active definition", async () => {
    const service = new JobInstanceService({ esClient: createMockEs() });

    const instance = await service.createInstance("risk-score", {
      instanceId: "risk-score-prod-hourly",
      enabled: true,
      schedule: {
        type: "cron",
        expression: "0 * * * *",
        timezone: "UTC"
      },
      parameters: {
        scanType: { type: "string", value: "FULL" },
        applications: { type: "string[]", value: ["Salesforce"] },
        apiCredential: {
          type: "sensitive",
          secretRef: "projects/iga-scheduler/secrets/risk-score-api-credential/versions/latest"
        }
      }
    });

    expect(instance.instanceId).toBe("risk-score-prod-hourly");
    expect(instance.definitionVersion).toBe(1);
    expect(instance.definitionParameterSchema).toEqual([
      { name: "scanType", type: "string", required: true },
      { name: "applications", type: "string[]", required: false },
      { name: "apiCredential", type: "sensitive", required: false }
    ]);
    expect(instance.state).toBe("ACTIVE");
    expect(instance.nextFireAt).toBeTruthy();
  });

  it("rejects missing required parameters", async () => {
    const service = new JobInstanceService({ esClient: createMockEs() });

    await expect(service.createInstance("risk-score", {
      instanceId: "risk-score-prod-hourly",
      enabled: true,
      schedule: {
        type: "cron",
        expression: "0 * * * *",
        timezone: "UTC"
      },
      parameters: {}
    })).rejects.toThrow("Missing required parameter: scanType");
  });

  it("patches schedule without revalidating against current definition", async () => {
    const esClient = createMockEs();
    const service = new JobInstanceService({ esClient });

    await createRiskScoreInstance(service);

    esClient.docs.set("scheduler_definitions_v1:risk-score", {
      definitionId: "risk-score",
      version: 2,
      state: "ACTIVE",
      enabled: true,
      parameters: [
        { name: "newRequired", type: "string", required: true }
      ]
    });

    const patched = await service.patchInstance("risk-score-prod-hourly", {
      schedule: {
        type: "cron",
        expression: "*/15 * * * *",
        timezone: "UTC"
      }
    });

    expect(patched.schedule.expression).toBe("*/15 * * * *");
  });

  it("validates parameter patches against the instance definition snapshot", async () => {
    const esClient = createMockEs();
    const service = new JobInstanceService({ esClient });

    await createRiskScoreInstance(service);

    esClient.docs.set("scheduler_definitions_v1:risk-score", {
      definitionId: "risk-score",
      version: 2,
      state: "ACTIVE",
      enabled: true,
      parameters: [
        { name: "newRequired", type: "string", required: true }
      ]
    });

    const patched = await service.patchInstance("risk-score-prod-hourly", {
      parameters: {
        scanType: { type: "string", value: "DELTA" }
      }
    });

    expect(patched.parameters.scanType.value).toBe("DELTA");
  });

  it("pauses, resumes, and deletes an instance", async () => {
    const service = new JobInstanceService({ esClient: createMockEs() });

    await createRiskScoreInstance(service);

    const paused = await service.pauseInstance("risk-score-prod-hourly");
    expect(paused.state).toBe("PAUSED");
    expect(paused.enabled).toBe(false);

    const resumed = await service.resumeInstance("risk-score-prod-hourly");
    expect(resumed.state).toBe("ACTIVE");
    expect(resumed.enabled).toBe(true);

    const deleted = await service.deleteInstance("risk-score-prod-hourly");
    expect(deleted.state).toBe("DELETED");
    expect(deleted.enabled).toBe(false);
  });
});
