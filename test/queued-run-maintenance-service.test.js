import { describe, expect, it, vi } from "vitest";
import { QueuedRunMaintenanceService } from "../src/services/queuedRunMaintenanceService.js";

function createMockEsClient(runs = []) {
  return {
    search: vi.fn(async () => ({
      hits: {
        hits: runs.map((run) => ({
          _id: run._id || run.runId,
          _source: run
        }))
      }
    })),
    update: vi.fn(async () => ({}))
  };
}

function createMockCloudTaskService() {
  return {
    enqueueRun: vi.fn(async ({ runId }) => ({
      name: `task-${runId}`,
      runId,
      targetUrl: `https://worker.example.test/internal/job-runs/${runId}/execute`
    }))
  };
}

function createService({ runs = [], cloudTaskService = createMockCloudTaskService() } = {}) {
  const esClient = createMockEsClient(runs);

  return {
    esClient,
    cloudTaskService,
    service: new QueuedRunMaintenanceService({
      esClient,
      cloudTaskService,
      now: () => new Date("2026-06-14T18:00:00.000Z")
    })
  };
}

describe("QueuedRunMaintenanceService", () => {
  it("expires stale queued runs", async () => {
    const { esClient, cloudTaskService, service } = createService({
      runs: [
        {
          runId: "old-run",
          state: "QUEUED",
          createdAt: "2026-06-14T16:59:59.000Z"
        }
      ]
    });

    const result = await service.reconcileQueuedRuns({
      maxAgeSeconds: 3600
    });

    expect(result).toMatchObject({
      checked: 1,
      expired: 1,
      redriven: 0,
      skippedRecent: 0,
      failed: 0
    });
    expect(cloudTaskService.enqueueRun).not.toHaveBeenCalled();
    expect(esClient.update).toHaveBeenCalledWith({
      index: "scheduler_runs_v1",
      id: "old-run",
      doc: expect.objectContaining({
        state: "FAILED",
        error: expect.objectContaining({
          code: "QUEUED_RUN_EXPIRED",
          retry: {
            retryable: false,
            classification: "NON_RETRYABLE",
            reason: "queued_run_expired"
          }
        })
      }),
      refresh: true
    });
  });

  it("skips recent queued runs by default", async () => {
    const { esClient, cloudTaskService, service } = createService({
      runs: [
        {
          runId: "recent-run",
          state: "QUEUED",
          createdAt: "2026-06-14T17:30:00.000Z"
        }
      ]
    });

    const result = await service.reconcileQueuedRuns({
      maxAgeSeconds: 3600
    });

    expect(result).toMatchObject({
      checked: 1,
      expired: 0,
      redriven: 0,
      skippedRecent: 1,
      failed: 0
    });
    expect(cloudTaskService.enqueueRun).not.toHaveBeenCalled();
    expect(esClient.update).not.toHaveBeenCalled();
  });

  it("re-drives recent queued runs only when requested", async () => {
    const { esClient, cloudTaskService, service } = createService({
      runs: [
        {
          runId: "recent-run",
          state: "QUEUED",
          createdAt: "2026-06-14T17:30:00.000Z"
        }
      ]
    });

    const result = await service.reconcileQueuedRuns({
      maxAgeSeconds: 3600,
      redriveRecent: true
    });

    expect(result).toMatchObject({
      checked: 1,
      expired: 0,
      redriven: 1,
      skippedRecent: 0,
      failed: 0,
      redriveRecent: true
    });
    expect(cloudTaskService.enqueueRun).toHaveBeenCalledWith({
      runId: "recent-run"
    });
    expect(esClient.update).not.toHaveBeenCalled();
  });
});
