import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

function runningRun(overrides = {}) {
  return {
    runId: "run-1",
    definitionId: "simple-job",
    instanceId: "simple-instance",
    state: "RUNNING",
    ...overrides
  };
}

function serviceWithRun(runDocument, { now = () => new Date("2026-06-15T04:00:00.000Z") } = {}) {
  const updates = [];
  const esClient = {
    get: vi.fn(async () => ({ _source: runDocument })),
    update: vi.fn(async (request) => {
      updates.push(request);
      return { result: "updated" };
    }),
    create: vi.fn(async () => ({ result: "created" }))
  };
  const service = new WorkerRunService({ esClient, now, auditEnabled: false });
  return { service, esClient, updates };
}

describe("WorkerRunService runtime completion", () => {
  it("marks a running isolated runtime run as succeeded", async () => {
    const { service, updates } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: {
        exitCode: 0,
        stdout: "hello\nIGA_RESULT_JSON:{\"ok\":true}\n",
        stderr: "",
        output: { ok: true }
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      runId: "run-1",
      state: "SUCCEEDED",
      result: {
        status: "completed",
        runId: "run-1",
        exitCode: 0,
        output: { ok: true },
        endedAt: "2026-06-15T04:00:00.000Z"
      }
    });
    expect(updates[0].script.params.status).toEqual({ phase: "succeeded", message: "Run completed successfully" });
    expect(updates[0].script.params.result.output).toEqual({ ok: true });
  });

  it("marks a running isolated runtime run as failed for non-zero exit", async () => {
    const { service, updates } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: {
        exitCode: 2,
        stdout: "",
        stderr: "boom"
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      runId: "run-1",
      state: "FAILED",
      error: {
        code: "RUNTIME_PROCESS_EXITED_NON_ZERO",
        message: "boom",
        execution: {
          status: "failed",
          runId: "run-1",
          exitCode: 2,
          stderr: "boom"
        }
      }
    });
    expect(updates[0].script.params.status).toEqual({ phase: "failed", message: "Run failed in worker runtime executor" });
    expect(updates[0].script.params.error.execution.stderr).toBe("boom");
  });

  it("skips completion when the run is no longer running", async () => {
    const { service, esClient } = serviceWithRun(runningRun({ state: "SUCCEEDED" }));

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 0, output: { ok: true } }
    });

    expect(result).toMatchObject({ status: "skipped", runId: "run-1", state: "SUCCEEDED" });
    expect(esClient.update).not.toHaveBeenCalled();
  });
});
