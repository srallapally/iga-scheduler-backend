import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

describe("WorkerRunService duplicate delivery guard", () => {
  it("skips when run is already beyond QUEUED state", async () => {
    const runStore = {
      getRun: vi.fn(async () => ({ runId: "run-1", state: "RUNNING" })),
      claimRun: vi.fn()
    };
    const esClient = {
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({}))
    };
    const service = new WorkerRunService({ esClient, runStore, executionMode: "local" });

    const result = await service.executeRun({ runId: "run-1" });

    expect(result.status).toBe("skipped");
    expect(result.state).toBe("RUNNING");
    expect(runStore.claimRun).not.toHaveBeenCalled();
  });
});
