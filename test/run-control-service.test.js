import { describe, expect, it, vi } from "vitest";
import { RunControlService } from "../src/services/runControlService.js";

function run(overrides = {}) { return { runId: "run-1", tenantId: "tenant-1", definitionId: "risk-score", definitionVersion: 1, instanceId: "risk-score-hourly", scheduledFireTime: "2026-06-03T18:00:00.000Z", state: "FAILED", attempt: 1, createdAt: "2026-06-03T18:00:00.000Z", startedAt: "2026-06-03T18:01:00.000Z", endedAt: "2026-06-03T18:01:05.000Z", error: { code: "RUNTIME_PROCESS_EXITED_NON_ZERO", message: "failed" }, result: null, ...overrides }; }
function createEsClient(source = run()) { return { get: vi.fn(async () => ({ _source: source, _seq_no: 7, _primary_term: 3 })), update: vi.fn(async () => ({ result: "updated" })), create: vi.fn(async () => ({ result: "created" })) }; }
function fixedClock(value = "2026-06-03T18:02:00.000Z") { return () => new Date(value); }

describe("RunControlService", () => {
  it("retries failed runs by resetting them to queued", async () => {
    const esClient = createEsClient(run({ attempt: 2 }));
    const cloudTaskService = { enqueueRun: vi.fn(async () => ({})) };
    const service = new RunControlService({ esClient, cloudTaskService, now: fixedClock() });
    const result = await service.retryRun({ runId: "run-1" });
    expect(result).toEqual(expect.objectContaining({ status: "queued", action: "retry", runId: "run-1", state: "QUEUED", attempt: 3, enqueued: true }));
    expect(result.dispatchId).toEqual(expect.any(String));
    expect(esClient.update).toHaveBeenCalledWith(expect.objectContaining({ index: "scheduler_runs_v1", id: "run-1", if_seq_no: 7, if_primary_term: 3, doc: expect.objectContaining({ state: "QUEUED", attempt: 3, dispatchId: result.dispatchId, startedAt: null, endedAt: null, error: null, status: { phase: "queued", message: "Run queued for retry" } }) }));
    expect(cloudTaskService.enqueueRun).toHaveBeenCalledWith({ runId: "run-1", attempt: 3, dispatchId: result.dispatchId });
  });

  it("rejects retry for non-failed runs", async () => { const service = new RunControlService({ esClient: createEsClient(run({ state: "RUNNING" })), now: fixedClock() }); await expect(service.retryRun({ runId: "run-1" })).rejects.toMatchObject({ statusCode: 409, message: "run run-1 cannot be retried from state RUNNING" }); });

  it("cancels queued and running runs", async () => {
    const esClient = createEsClient(run({ state: "QUEUED" }));
    const service = new RunControlService({ esClient, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "no longer needed" });
    expect(result).toEqual({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED" });
    expect(esClient.update).toHaveBeenCalledWith(expect.objectContaining({ if_seq_no: 7, if_primary_term: 3, doc: expect.objectContaining({ state: "CANCELLED", endedAt: "2026-06-03T18:02:00.000Z", error: { code: "RUN_CANCELLED", message: "no longer needed" } }) }));
  });

  it("moves running cancel to cancelling and invokes runtime launcher", async () => {
    const runtimeExecution = { executionId: "exec-1", backend: "cloud-run-job" };
    const esClient = createEsClient(run({ state: "RUNNING", runtimeExecution }));
    const runtimeLauncher = { cancel: vi.fn(async () => ({})) };
    const service = new RunControlService({ esClient, runtimeLauncher, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "stop" });
    expect(result).toEqual({ status: "cancelling", action: "cancel", runId: "run-1", state: "CANCELLING" });
    expect(esClient.update).toHaveBeenCalledWith(expect.objectContaining({ doc: expect.objectContaining({ state: "CANCELLING", cancelReason: "stop" }) }));
    expect(runtimeLauncher.cancel).toHaveBeenCalledWith(runtimeExecution);
  });

  it("treats repeated cancel as idempotent", async () => { const service = new RunControlService({ esClient: createEsClient(run({ state: "CANCELLED" })), now: fixedClock() }); await expect(service.cancelRun({ runId: "run-1" })).resolves.toEqual({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED", idempotent: true }); });

  it("creates a new queued run for re-drive", async () => {
    const esClient = createEsClient(run({ state: "SUCCEEDED", result: { ok: true } }));
    const cloudTaskService = { enqueueRun: vi.fn(async () => ({})) };
    const service = new RunControlService({ esClient, cloudTaskService, now: fixedClock() });
    const result = await service.redriveRun({ runId: "run-1" });
    expect(result).toEqual(expect.objectContaining({ status: "queued", action: "redrive", sourceRunId: "run-1", state: "QUEUED", attempt: 1, enqueued: true }));
    expect(result.runId).toMatch(/^run-1:redrive:/);
    expect(result.dispatchId).toEqual(expect.any(String));
    expect(esClient.create).toHaveBeenCalledWith(expect.objectContaining({ id: result.runId, document: expect.objectContaining({ runId: result.runId, dispatchId: result.dispatchId, parentRunId: "run-1", redriveOfRunId: "run-1", state: "QUEUED", attempt: 1, result: null, error: null, status: { phase: "queued", message: "Run queued by re-drive" } }) }));
    expect(cloudTaskService.enqueueRun).toHaveBeenCalledWith({ runId: result.runId, attempt: 1, dispatchId: result.dispatchId });
  });

  it("rejects re-drive for active runs", async () => { const service = new RunControlService({ esClient: createEsClient(run({ state: "QUEUED" })), now: fixedClock() }); await expect(service.redriveRun({ runId: "run-1" })).rejects.toMatchObject({ statusCode: 409, message: "run run-1 cannot be re-driven from state QUEUED" }); });
});
