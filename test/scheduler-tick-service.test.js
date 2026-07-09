import { describe, expect, it, vi } from "vitest";
import { SchedulerTickService } from "../src/services/schedulerTickService.js";

function dueInstance(overrides = {}) {
  return {
    instanceId: "risk-score-prod-hourly",
    definitionId: "risk-score",
    definitionVersion: 1,
    enabled: true,
    state: "ACTIVE",
    nextFireAt: "2026-06-03T18:00:00.000Z",
    schedule: {
      type: "cron",
      expression: "*/15 * * * *",
      timezone: "UTC"
    },
    parameters: {
      scanType: {
        type: "string",
        value: "FULL"
      }
    },
    ...overrides
  };
}

function createMockEsClient({ searchHits = [], createImpl, updateImpl } = {}) {
  return {
    search: vi.fn(async () => ({
      hits: {
        hits: searchHits
      }
    })),
    create: vi.fn(createImpl || (async () => ({}))),
    update: vi.fn(updateImpl || (async () => ({})))
  };
}

function createMockCloudTaskService() {
  return {
    enqueueRun: vi.fn(async ({ runId }) => ({
      name: "task-1",
      runId
    }))
  };
}

describe("SchedulerTickService", () => {
  it("queries due active instances", async () => {
    const esClient = createMockEsClient();
    const cloudTaskService = createMockCloudTaskService();

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    await service.tick({
      enqueue: false
    });

    expect(esClient.search).toHaveBeenCalledWith({
      index: "scheduler_instances_v1",
      size: 100,
      sort: [
        {
          nextFireAt: {
            order: "asc"
          }
        }
      ],
      query: {
        bool: {
          filter: [
            {
              term: {
                enabled: true
              }
            },
            {
              term: {
                state: "ACTIVE"
              }
            },
            {
              range: {
                nextFireAt: {
                  lte: "2026-06-03T18:01:00.000Z"
                }
              }
            }
          ]
        }
      }
    });
  });

  it("creates a queued run, enqueues it, and advances nextFireAt", async () => {
    const instance = dueInstance();

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ]
    });

    const cloudTaskService = createMockCloudTaskService();

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result).toEqual({
      status: "ok",
      checked: 1,
      createdRuns: 1,
      duplicates: 0,
      enqueued: 1,
      advanced: 1,
      failed: 0,
      dryRun: false,
      enqueue: true
    });

    expect(esClient.create).toHaveBeenCalledWith({
      index: "scheduler_runs_v1",
      id: "risk-score-prod-hourly:2026-06-03T18:00:00.000Z",
      document: expect.objectContaining({
        runId: "risk-score-prod-hourly:2026-06-03T18:00:00.000Z",
        definitionId: "risk-score",
        definitionVersion: 1,
        instanceId: "risk-score-prod-hourly",
        scheduledFireTime: "2026-06-03T18:00:00.000Z",
        state: "QUEUED",
        attempt: 1,
        createdAt: "2026-06-03T18:01:00.000Z"
      }),
      refresh: true
    });

    expect(cloudTaskService.enqueueRun).toHaveBeenCalledWith({
      runId: "risk-score-prod-hourly:2026-06-03T18:00:00.000Z"
    });

    expect(esClient.update).toHaveBeenCalledWith({
      index: "scheduler_instances_v1",
      id: "risk-score-prod-hourly",
      doc: {
        lastFireAt: "2026-06-03T18:00:00.000Z",
        nextFireAt: "2026-06-03T18:15:00.000Z",
        updatedAt: "2026-06-03T18:01:00.000Z"
      },
      refresh: true
    });
  });

  it("supports legacy schedule.cron while advancing instances", async () => {
    const instance = dueInstance({
      schedule: {
        cron: "*/15 * * * *",
        timezone: "UTC"
      }
    });

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ]
    });

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService: createMockCloudTaskService(),
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick({
      enqueue: false
    });

    expect(result.advanced).toBe(1);
    expect(esClient.update).toHaveBeenCalledWith({
      index: "scheduler_instances_v1",
      id: "risk-score-prod-hourly",
      doc: {
        lastFireAt: "2026-06-03T18:00:00.000Z",
        nextFireAt: "2026-06-03T18:15:00.000Z",
        updatedAt: "2026-06-03T18:01:00.000Z"
      },
      refresh: true
    });
  });

  it("skips Cloud Tasks enqueue when enqueue is false", async () => {
    const instance = dueInstance();

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ]
    });

    const cloudTaskService = createMockCloudTaskService();

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick({
      enqueue: false
    });

    expect(result.enqueued).toBe(0);
    expect(result.createdRuns).toBe(1);
    expect(result.advanced).toBe(1);
    expect(cloudTaskService.enqueueRun).not.toHaveBeenCalled();
  });

  it("does not mutate ES or enqueue in dryRun mode", async () => {
    const instance = dueInstance();

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ]
    });

    const cloudTaskService = createMockCloudTaskService();

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick({
      dryRun: true
    });

    expect(result).toEqual({
      status: "ok",
      checked: 1,
      createdRuns: 0,
      duplicates: 0,
      enqueued: 0,
      advanced: 0,
      failed: 0,
      dryRun: true,
      enqueue: true
    });

    expect(esClient.create).not.toHaveBeenCalled();
    expect(esClient.update).not.toHaveBeenCalled();
    expect(cloudTaskService.enqueueRun).not.toHaveBeenCalled();
  });

  it("handles duplicate run creation and advances nextFireAt", async () => {
    const instance = dueInstance();

    const conflict = new Error("document already exists");
    conflict.meta = {
      statusCode: 409
    };

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ],
      createImpl: async () => {
        throw conflict;
      }
    });

    const cloudTaskService = createMockCloudTaskService();

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result.createdRuns).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.advanced).toBe(1);
    expect(cloudTaskService.enqueueRun).not.toHaveBeenCalled();
  });

  it("marks run failed if dispatch fails", async () => {
    const instance = dueInstance();

    const esClient = createMockEsClient({
      searchHits: [
        {
          _id: instance.instanceId,
          _source: instance
        }
      ]
    });

    const cloudTaskService = {
      enqueueRun: vi.fn(async () => {
        throw new Error("Cloud Tasks unavailable");
      })
    };

    const service = new SchedulerTickService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result.createdRuns).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.advanced).toBe(0);

    expect(esClient.update).toHaveBeenCalledWith({
      index: "scheduler_runs_v1",
      id: "risk-score-prod-hourly:2026-06-03T18:00:00.000Z",
      doc: {
        state: "FAILED",
        endedAt: "2026-06-03T18:01:00.000Z",
        error: {
          code: "DISPATCH_FAILED",
          message: "Cloud Tasks unavailable"
        }
      },
      refresh: true
    });
  });
});
