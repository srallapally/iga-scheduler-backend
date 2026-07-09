import { describe, expect, it, vi } from "vitest";
import { JobInstanceService } from "../src/services/jobInstanceService.js";

// ---------------------------------------------------------------------------
// In-memory instance store stub
// ---------------------------------------------------------------------------

function createMockInstanceStore() {
  const docs = new Map();

  return {
    docs,
    createInstance: vi.fn(async (doc) => {
      if (docs.has(doc.instanceId)) {
        const err = new Error("instance already exists");
        err.statusCode = 409;
        throw err;
      }
      docs.set(doc.instanceId, { ...doc });
      return { ...doc };
    }),
    getInstance: vi.fn(async (instanceId) => {
      return docs.has(instanceId) ? { ...docs.get(instanceId) } : null;
    }),
    updateInstance: vi.fn(async (instanceId, doc) => {
      if (!docs.has(instanceId)) {
        const err = new Error("instance not found");
        err.statusCode = 404;
        throw err;
      }
      docs.set(instanceId, { ...doc });
      return { ...doc };
    }),
    listInstancesForDefinition: vi.fn(async (definitionId) => {
      return [...docs.values()].filter((d) => d.definitionId === definitionId);
    })
  };
}

function createMockEs() {
  return {
    get: vi.fn(async () => ({
      _source: {
        definitionId: "risk-score",
        version: 1,
        state: "ACTIVE",
        enabled: true,
        parameters: [
          { name: "scanType", type: "string", required: true },
          { name: "applications", type: "string[]", required: false },
          { name: "apiCredential", type: "sensitive", required: false }
        ]
      }
    }))
  };
}

async function createRiskScoreInstance(service) {
  return service.createInstance("risk-score", {
    instanceId: "risk-score-prod-hourly",
    enabled: true,
    schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    parameters: { scanType: { type: "string", value: "FULL" } }
  });
}

describe("JobInstanceService", () => {
  it("creates an instance for an active definition", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });

    const instance = await service.createInstance("risk-score", {
      instanceId: "risk-score-prod-hourly",
      enabled: true,
      schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
      parameters: {
        scanType: { type: "string", value: "FULL" },
        applications: { type: "string[]", value: ["Salesforce"] },
        apiCredential: { type: "sensitive", secretRef: "projects/iga-scheduler/secrets/risk-score-api-credential/versions/latest" }
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
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });

    await expect(service.createInstance("risk-score", {
      instanceId: "risk-score-prod-hourly",
      enabled: true,
      schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
      parameters: {}
    })).rejects.toThrow("Missing required parameter: scanType");
  });

  it("patches schedule without revalidating against current definition", async () => {
    const instanceStore = createMockInstanceStore();
    const es = createMockEs();
    const service = new JobInstanceService({ instanceStore, esClient: es, definitionsIndex: "scheduler_definitions_v1" });

    await createRiskScoreInstance(service);

    // definition changes in ES — patch should use instance snapshot, not re-fetch definition
    es.get.mockResolvedValue({
      _source: { definitionId: "risk-score", version: 2, state: "ACTIVE", enabled: true, parameters: [{ name: "newRequired", type: "string", required: true }] }
    });

    const patched = await service.patchInstance("risk-score-prod-hourly", {
      schedule: { type: "cron", expression: "*/15 * * * *", timezone: "UTC" }
    });

    expect(patched.schedule.expression).toBe("*/15 * * * *");
  });

  it("validates parameter patches against the instance definition snapshot", async () => {
    const instanceStore = createMockInstanceStore();
    const es = createMockEs();
    const service = new JobInstanceService({ instanceStore, esClient: es, definitionsIndex: "scheduler_definitions_v1" });

    await createRiskScoreInstance(service);

    es.get.mockResolvedValue({
      _source: { definitionId: "risk-score", version: 2, state: "ACTIVE", enabled: true, parameters: [{ name: "newRequired", type: "string", required: true }] }
    });

    const patched = await service.patchInstance("risk-score-prod-hourly", {
      parameters: { scanType: { type: "string", value: "DELTA" } }
    });

    expect(patched.parameters.scanType.value).toBe("DELTA");
  });

  it("pauses, resumes, and deletes an instance", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });

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

  it("getInstance returns null for missing instance", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });
    const result = await service.getInstance("no-such");
    expect(result).toBeNull();
  });

  it("patchInstance throws 404 for missing instance", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });
    await expect(service.patchInstance("no-such", { enabled: false })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("listInstancesForDefinition returns items for the definition", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });

    await createRiskScoreInstance(service);
    await service.createInstance("risk-score", {
      instanceId: "risk-score-staging",
      enabled: false,
      schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
      parameters: { scanType: { type: "string", value: "DELTA" } }
    });

    const items = await service.listInstancesForDefinition("risk-score");
    expect(items.length).toBe(2);
    expect(items.every((i) => i.definitionId === "risk-score")).toBe(true);
  });

  it("listInstancesForDefinition returns empty array for unknown definition", async () => {
    const instanceStore = createMockInstanceStore();
    const service = new JobInstanceService({ instanceStore, esClient: createMockEs(), definitionsIndex: "scheduler_definitions_v1" });
    const items = await service.listInstancesForDefinition("no-such-def");
    expect(items).toEqual([]);
  });
});
