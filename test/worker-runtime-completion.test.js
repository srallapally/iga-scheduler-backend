import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

function runningRun(overrides = {}) {
  return { runId: "run-1", definitionId: "simple-job", instanceId: "simple-instance", state: "RUNNING", ...overrides };
}

function serviceWithRun(runDocument, { now = () => new Date("2026-06-15T04:00:00.000Z") } = {}) {
  const succeedCalls = [];
  const failCalls = [];
  const runStore = {
    getRun: vi.fn(async () => runDocument ? { ...runDocument } : null),
    markSucceeded: vi.fn(async (args) => { succeedCalls.push(args); return true; }),
    markFailed: vi.fn(async (args) => { failCalls.push(args); return true; })
  };
  const esClient = { create: vi.fn(async () => ({ result: "created" })) };
  const service = new WorkerRunService({ esClient, runStore, now, auditEnabled: false, definitionsIndex: "scheduler_definitions_v1", auditIndex: "scheduler_audit_v1" });
  return { service, runStore, succeedCalls, failCalls, esClient };
}

describe("WorkerRunService runtime completion", () => {
  it("marks a running isolated runtime run as succeeded", async () => {
    const { service, succeedCalls } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 0, stdout: "hello\n", stderr: "", output: { ok: true } }
    });

    expect(result).toMatchObject({ status: "completed", runId: "run-1", state: "SUCCEEDED", result: { status: "completed", runId: "run-1", exitCode: 0, output: { ok: true }, endedAt: "2026-06-15T04:00:00.000Z" } });
    expect(succeedCalls[0].runId).toBe("run-1");
    expect(succeedCalls[0].result.output).toEqual({ ok: true });
  });

  it("marks a running isolated runtime run as failed for non-zero exit", async () => {
    const { service, failCalls } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 2, stdout: "", stderr: "boom" }
    });

    expect(result).toMatchObject({ status: "failed", runId: "run-1", state: "FAILED", error: { code: "RUNTIME_PROCESS_EXITED_NON_ZERO", message: "boom", execution: { status: "failed", runId: "run-1", exitCode: 2, stderr: "boom" } } });
    expect(failCalls[0].error.execution.stderr).toBe("boom");
  });

  it("marks as FAILED when exitCode is 0 but error payload is present (step 2.3 fix)", async () => {
    const { service, failCalls, succeedCalls } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 0, error: { code: "RUNTIME_CONTAINER_FAILURE", message: "OOM" } }
    });

    expect(result.status).toBe("failed");
    expect(result.state).toBe("FAILED");
    expect(failCalls).toHaveLength(1);
    expect(succeedCalls).toHaveLength(0);
  });

  it("exitCode 0 with no error marks SUCCEEDED", async () => {
    const { service, succeedCalls } = serviceWithRun(runningRun());

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 0 }
    });

    expect(result.status).toBe("completed");
    expect(succeedCalls).toHaveLength(1);
  });

  it("skips completion when the run is no longer running", async () => {
    const { service, runStore } = serviceWithRun(runningRun({ state: "SUCCEEDED" }));

    const result = await service.completeRun({
      runId: "run-1",
      completion: { exitCode: 0, output: { ok: true } }
    });

    expect(result).toMatchObject({ status: "skipped", runId: "run-1", state: "SUCCEEDED" });
    expect(runStore.markSucceeded).not.toHaveBeenCalled();
    expect(runStore.markFailed).not.toHaveBeenCalled();
  });
});
