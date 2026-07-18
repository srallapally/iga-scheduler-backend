import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

function queuedRun(overrides = {}) { return { runId: "run-1", instanceId: "risk-score-prod-hourly", definitionId: "risk-score", definitionVersion: 1, state: "QUEUED", createdAt: "2026-06-03T18:00:00.000Z", params: {}, ...overrides }; }
function trustedJobZip(overrides = {}) { return { uri: "gs://iga-scheduler-jobs/approved/risk-score/hash/job.zip", sha256: "hash", generation: "123", approval: { status: "APPROVED", sha256: "hash", generation: "123", approvedBy: "iga" }, scan: { status: "CLEAN", sha256: "hash", scannedBy: "iga" }, ...overrides }; }
function activeDefinition(overrides = {}) { return { definitionId: "risk-score", version: 1, state: "ACTIVE", enabled: true, runtime: "javascript", runtimeVersion: "nodejs22", wrapperVersion: "1.0.0", entrypoint: "index.js", timeoutSeconds: 1800, jobZip: trustedJobZip(), ...overrides }; }

function createRunStore(runDoc) {
  const store = {
    _run: runDoc ? { ...runDoc } : null,
    claimResult: { claimed: true, dispatchId: "dispatch-1" },
    getRun: vi.fn(async () => store._run ? { ...store._run } : null),
    claimRun: vi.fn(async () => store.claimResult),
    recordRuntimeExecution: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => true),
    markFailed: vi.fn(async () => true)
  };
  return store;
}

const TEST_DEFINITIONS_INDEX = "scheduler_definitions_v1";

function createMockEsClient({ definition = activeDefinition() } = {}) {
  return {
    get: vi.fn(async () => ({ _source: definition })),
    create: vi.fn(async () => ({ result: "created" }))
  };
}

function createRuntimeExecutor(result = { status: "completed", output: { ok: true } }) { return { execute: vi.fn(async () => result) }; }
function createParameterResolver(resolved = {}) { return { resolveParameters: vi.fn(async () => resolved) }; }
function stubArtifactVerification(service) { vi.spyOn(service, "verifyApprovedArtifact").mockResolvedValue({ sha256: "hash", generation: "123", fileCount: 2, uncompressedBytes: 53, buffer: Buffer.from("zip-bytes") }); }
function fixedClock(...values) { let index = 0; return () => new Date(values[Math.min(index++, values.length - 1)]); }
function auditEvents(esClient) { return esClient.create.mock.calls.map(([call]) => call.document).filter((event) => event?.eventType); }
function auditEventTypes(esClient) { return auditEvents(esClient).map((event) => event.eventType); }

describe("WorkerRunService", () => {
  it("marks a queued run running and then succeeded", async () => {
    const run = queuedRun({ params: { window: { type: "string", value: "PT1H" }, apiKey: { type: "sensitive", secretRef: "iga-api-key" } } });
    const runStore = createRunStore(run);
    const esClient = createMockEsClient();
    const runtimeExecutor = createRuntimeExecutor({ status: "completed", runId: "run-1", runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js", exitCode: 0, timedOut: false, stdout: "ok", stdoutTruncated: false, output: { ok: true }, ignoredField: "do-not-persist" });
    const parameterResolver = createParameterResolver({ window: "PT1H", apiKey: "resolved-secret" });
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver, now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
    stubArtifactVerification(service);
    const result = await service.executeRun({ runId: "run-1" });
    expect(result.status).toBe("completed");
    expect(result.state).toBe("SUCCEEDED");
    expect(result.result).toEqual({ status: "completed", runId: "run-1", runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js", exitCode: 0, timedOut: false, stdout: "ok", stdoutTruncated: false, output: { ok: true } });
    expect(result.result.ignoredField).toBeUndefined();
    expect(parameterResolver.resolveParameters).toHaveBeenCalledWith({ window: { type: "string", value: "PT1H" }, apiKey: { type: "sensitive", secretRef: "iga-api-key" } });
    expect(runStore.claimRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(runStore.markSucceeded).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", result: result.result, dispatchId: "dispatch-1" }));
    expect(auditEventTypes(esClient)).toEqual(["worker.run.received", "worker.claim.attempted", "worker.claim.succeeded", "WORKER_RUN_STARTED", "worker.metadata.loaded", "worker.artifact.verified", "worker.execution.started", "worker.execution.succeeded"]);
  });

  it("requires a launcher when constructed in isolated mode", () => {
    expect(() => new WorkerRunService({ esClient: createMockEsClient(), runStore: createRunStore(), storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", executionMode: "isolated" })).toThrow("isolatedRuntimeLauncher is required when executionMode is isolated");
  });

  it("dispatches isolated runs without resolving sensitive parameters", async () => {
    const run = queuedRun({ params: { apiKey: { type: "sensitive", secretRef: "iga-api-key" }, window: { type: "string", value: "PT1H" } } });
    const runStore = createRunStore(run);
    const esClient = createMockEsClient();
    const parameterResolver = createParameterResolver({ apiKey: "resolved-secret", window: "PT1H" });
    const isolatedRuntimeLauncher = { launchExecution: vi.fn(async () => ({ backend: "cloud-run-job", executionId: "exec-1" })) };
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", executionMode: "isolated", isolatedRuntimeLauncher, parameterResolver, now: fixedClock("2026-06-03T18:01:00.000Z") });
    const result = await service.executeRun({ runId: "run-1" });
    expect(result.status).toBe("dispatched");
    expect(parameterResolver.resolveParameters).not.toHaveBeenCalled();
    const launchRequest = isolatedRuntimeLauncher.launchExecution.mock.calls[0][0];
    expect(launchRequest.context.params).toEqual(run.params);
    expect(JSON.stringify(launchRequest.context)).not.toContain("resolved-secret");
    expect(launchRequest.dispatchId).toBe("dispatch-1");
    expect(runStore.recordRuntimeExecution).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "dispatch-1" }));
  });

  it("fences markFailed to the claimed dispatch attempt when dispatch fails (COR-1)", async () => {
    const run = queuedRun();
    const runStore = createRunStore(run);
    const esClient = createMockEsClient();
    const isolatedRuntimeLauncher = { launchExecution: vi.fn(async () => { throw new Error("worker unreachable"); }) };
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", executionMode: "isolated", isolatedRuntimeLauncher, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
    await expect(service.executeRun({ runId: "run-1" })).rejects.toThrow("worker unreachable");
    expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "dispatch-1" }));
  });

  it("skips duplicate delivery when claimRun returns claimed: false", async () => {
    const runStore = createRunStore(queuedRun());
    runStore.claimResult = { claimed: false };
    // second getRun call returns RUNNING state
    let calls = 0;
    runStore.getRun = vi.fn(async () => ({ ...queuedRun({ state: calls++ === 0 ? "QUEUED" : "RUNNING" }) }));
    const esClient = createMockEsClient();
    const runtimeExecutor = createRuntimeExecutor();
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z") });
    const result = await service.executeRun({ runId: "run-1" });
    expect(result.status).toBe("skipped");
    expect(result.state).toBe("RUNNING");
    expect(runtimeExecutor.execute).not.toHaveBeenCalled();
  });

  it("fails non-retryably when artifact approval is missing", async () => {
    const runStore = createRunStore(queuedRun());
    const esClient = createMockEsClient({ definition: activeDefinition({ jobZip: trustedJobZip({ approval: undefined }) }) });
    const runtimeExecutor = createRuntimeExecutor();
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
    await expect(service.executeRun({ runId: "run-1" })).rejects.toMatchObject({ code: "ARTIFACT_NOT_APPROVED" });
    expect(runtimeExecutor.execute).not.toHaveBeenCalled();
    expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "ARTIFACT_NOT_APPROVED" }) }));
  });

  it("returns not found for missing run", async () => {
    const runStore = createRunStore(null);
    const esClient = createMockEsClient();
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", parameterResolver: createParameterResolver() });
    await expect(service.executeRun({ runId: "missing-run" })).rejects.toMatchObject({ message: "run not found", statusCode: 404 });
    expect(runStore.markFailed).not.toHaveBeenCalled();
    expect(auditEventTypes(esClient)).toEqual(["worker.run.received", "worker.execution.failed"]);
  });

  it("is idempotent for non-queued runs", async () => {
    const runStore = createRunStore(queuedRun({ state: "SUCCEEDED" }));
    const esClient = createMockEsClient();
    const runtimeExecutor = createRuntimeExecutor();
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver() });
    const result = await service.executeRun({ runId: "run-1" });
    expect(result).toEqual({ status: "skipped", runId: "run-1", state: "SUCCEEDED", message: "Run is SUCCEEDED; worker execution was not started" });
    expect(runtimeExecutor.execute).not.toHaveBeenCalled();
    expect(runStore.claimRun).not.toHaveBeenCalled();
    expect(auditEventTypes(esClient)).toEqual(["worker.run.received", "worker.claim.skipped"]);
  });

  it("records claim skipped when the queued run is already claimed", async () => {
    const runStore = createRunStore(queuedRun());
    runStore.claimResult = { claimed: false };
    let calls = 0;
    runStore.getRun = vi.fn(async () => ({ ...queuedRun({ state: calls++ === 0 ? "QUEUED" : "RUNNING" }) }));
    const esClient = createMockEsClient();
    const runtimeExecutor = createRuntimeExecutor();
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z") });
    const result = await service.executeRun({ runId: "run-1" });
    expect(result.status).toBe("skipped");
    expect(result.state).toBe("RUNNING");
    expect(runtimeExecutor.execute).not.toHaveBeenCalled();
    expect(runStore.claimRun).toHaveBeenCalledTimes(1);
    expect(auditEventTypes(esClient)).toEqual(["worker.run.received", "worker.claim.attempted", "worker.claim.skipped"]);
  });

  it("marks a run failed when runtime executor throws", async () => {
    const runStore = createRunStore(queuedRun());
    const esClient = createMockEsClient();
    const runtimeError = new Error("runtime failed");
    runtimeError.code = "RUNTIME_PROCESS_EXITED_NON_ZERO";
    runtimeError.execution = { status: "failed", exitCode: 7, stderr: "boom", ignoredFailureField: "do-not-persist" };
    const runtimeExecutor = { execute: vi.fn(async () => { throw runtimeError; }) };
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
    stubArtifactVerification(service);
    await expect(service.executeRun({ runId: "run-1" })).rejects.toThrow("runtime failed");
    expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      endedAt: "2026-06-03T18:01:05.000Z",
      error: expect.objectContaining({ code: "RUNTIME_PROCESS_EXITED_NON_ZERO", retry: { retryable: true, classification: "RETRYABLE", reason: "retryable_code:RUNTIME_PROCESS_EXITED_NON_ZERO" } })
    }));
    expect(runStore.markFailed.mock.calls[0][0].error.execution.ignoredFailureField).toBeUndefined();
    const failedEvent = auditEvents(esClient).find((event) => event.eventType === "worker.execution.failed");
    expect(failedEvent).toEqual(expect.objectContaining({ eventType: "worker.execution.failed", runId: "run-1", retryable: true, retryClassification: "RETRYABLE", errorCode: "RUNTIME_PROCESS_EXITED_NON_ZERO" }));
  });

  it("does not fail the worker run when audit recording fails", async () => {
    const runStore = createRunStore(queuedRun());
    const esClient = createMockEsClient();
    esClient.create = vi.fn(async () => { throw new Error("audit unavailable"); });
    const logger = { warn: vi.fn() };
    const runtimeExecutor = createRuntimeExecutor({ status: "completed", runId: "run-1" });
    const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", logger, runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
    stubArtifactVerification(service);
    const result = await service.executeRun({ runId: "run-1" });
    expect(result.status).toBe("completed");
    expect(result.state).toBe("SUCCEEDED");
    expect(logger.warn).toHaveBeenCalledWith("worker audit emit failed", expect.objectContaining({ error: "audit unavailable" }));
  });

  describe("executeClaimedRun (AVL-1 residual — pull-worker poll loop entry point)", () => {
    it("runs the full pipeline for a run already claimed elsewhere, without re-claiming", async () => {
      const run = queuedRun({ state: "RUNNING", params: { window: { type: "string", value: "PT1H" } } });
      const runStore = createRunStore(run);
      const esClient = createMockEsClient();
      const runtimeExecutor = createRuntimeExecutor({ status: "completed", runId: "run-1" });
      const parameterResolver = createParameterResolver({ window: "PT1H" });
      const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver, now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
      stubArtifactVerification(service);

      const result = await service.executeClaimedRun({ runId: "run-1", dispatchId: "dispatch-from-batch-claim" });

      expect(result.status).toBe("completed");
      expect(result.state).toBe("SUCCEEDED");
      expect(runStore.claimRun).not.toHaveBeenCalled();
      expect(runtimeExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "dispatch-from-batch-claim" }));
      expect(runStore.markSucceeded).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "dispatch-from-batch-claim" }));
    });

    it("fences markFailed to the given dispatchId when execution throws", async () => {
      const run = queuedRun({ state: "RUNNING" });
      const runStore = createRunStore(run);
      const esClient = createMockEsClient();
      const runtimeExecutor = { execute: vi.fn(async () => { throw new Error("boom"); }) };
      const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", runtimeExecutor, parameterResolver: createParameterResolver(), now: fixedClock("2026-06-03T18:01:00.000Z", "2026-06-03T18:01:05.000Z") });
      stubArtifactVerification(service);

      await expect(service.executeClaimedRun({ runId: "run-1", dispatchId: "dispatch-xyz" })).rejects.toThrow("boom");
      expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "dispatch-xyz" }));
    });

    it("returns skipped for a runId no longer present", async () => {
      const runStore = createRunStore(null);
      const esClient = createMockEsClient();
      const service = new WorkerRunService({ esClient, runStore, storage: {}, definitionsIndex: TEST_DEFINITIONS_INDEX, auditIndex: "scheduler_audit_v1", parameterResolver: createParameterResolver() });

      const result = await service.executeClaimedRun({ runId: "vanished-run", dispatchId: "dispatch-1" });

      expect(result).toEqual({ status: "skipped", runId: "vanished-run", state: "UNKNOWN", message: "Run is UNKNOWN; worker execution was not started" });
    });
  });
});
