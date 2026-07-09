import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

describe("WorkerRunService duplicate delivery guard", () => {
  it("skips placeholder work when the state transition is not applied", async () => {
    const getResponses = [
      { _source: { runId: "run-1", state: "QUEUED" } },
      { _source: { runId: "run-1", state: "RUNNING" } }
    ];
    const esClient = {
      get: vi.fn(async () => getResponses.shift()),
      update: vi.fn(async () => ({ result: "no" + "op" }))
    };
    const executePlaceholder = vi.fn(async () => ({ runId: "run-1" }));
    const service = new WorkerRunService({ esClient, executePlaceholder });

    const result = await service.executeRun({ runId: "run-1" });

    expect(result.status).toBe("skipped");
    expect(result.state).toBe("RUNNING");
    expect(executePlaceholder).not.toHaveBeenCalled();
    expect(esClient.update).toHaveBeenCalledTimes(1);
  });
});
