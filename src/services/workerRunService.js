import { randomUUID } from "crypto";
import { createEsClient } from "../clients/esClient.js";
import { createStorageClient } from "../clients/gcsClient.js";
import { getConfig } from "../config/index.js";
import { sha256 } from "../utils/hash.js";
import { validateZipBuffer } from "../utils/zipValidation.js";
import { JobRuntimeExecutor } from "./jobRuntimeExecutor.js";
import { classifyWorkerError } from "./retryClassifier.js";
import { SecretManagerParameterResolver } from "./secretManagerParameterResolver.js";

export class WorkerRunService {
  constructor({
    esClient = null,
    runStore = null,
    storage = null,
    definitionsIndex = null,
    auditIndex = null,
    auditActor = "scheduler-worker",
    auditEnabled = true,
    logger = console,
    now = () => new Date(),
    runtimeExecutor = new JobRuntimeExecutor(),
    isolatedRuntimeLauncher = null,
    executionMode = "local",
    maxLocalConcurrency = Number(process.env.WORKER_LOCAL_MAX_CONCURRENCY || 1),
    parameterResolver = new SecretManagerParameterResolver()
  } = {}) {
    if (executionMode === "isolated" && !isolatedRuntimeLauncher) {
      throw new Error("isolatedRuntimeLauncher is required when executionMode is isolated");
    }

    this._esClient = esClient;
    this.runStore = runStore;
    this.storage = storage;
    this._definitionsIndex = definitionsIndex;
    this._auditIndex = auditIndex;
    this.auditActor = auditActor;
    this.auditEnabled = auditEnabled;
    this.logger = logger;
    this.now = now;
    this.runtimeExecutor = runtimeExecutor;
    this.isolatedRuntimeLauncher = isolatedRuntimeLauncher;
    this.executionMode = executionMode;
    this.maxLocalConcurrency = maxLocalConcurrency;
    this.localRunning = 0;
    this.parameterResolver = parameterResolver;
  }

  get esClient() {
    if (!this._esClient) this._esClient = createEsClient();
    return this._esClient;
  }

  get definitionsIndex() {
    if (!this._definitionsIndex) this._definitionsIndex = getConfig().definitionsIndex;
    return this._definitionsIndex;
  }

  get auditIndex() {
    if (!this._auditIndex) this._auditIndex = getConfig().auditIndex;
    return this._auditIndex;
  }

  async executeRun({ runId }) {
    return this.executionMode === "isolated" ? this.dispatchRun({ runId }) : this.executeRunLocally({ runId });
  }

  async dispatchRun({ runId }) {
    if (!this.isolatedRuntimeLauncher) {
      throw this.executionMetadataError("RUNTIME_ISOLATION_REQUIRED", "isolated runtime launcher is required for dispatch mode", { retryable: false });
    }

    const { run, startedAt, claim } = await this.claimQueuedRun({ runId });
    if (!claim.claimed) return this.skippedResult({ runId, state: claim.state || "UNKNOWN" });

    try {
      const execution = await this.buildExecutionMetadata({ run });
      this.validateArtifactTrust({ execution });
      const context = this.buildRuntimeContext({ run, execution, params: run.params || {} });
      const runtimeExecution = await this.isolatedRuntimeLauncher.launchExecution({ runId, run, execution, context });
      await this.recordRuntimeExecution({ runId, runtimeExecution, startedAt });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.execution.dispatched",
        outcome: "dispatched",
        runId,
        run,
        execution,
        createdAt: startedAt,
        details: { runtimeExecution }
      }));
      return { status: "dispatched", runId, state: "RUNNING", startedAt, runtimeExecution };
    } catch (error) {
      const endedAt = this.now().toISOString();
      const retryClassification = classifyWorkerError(error);
      await this.markFailed({ runId, endedAt, error, retryClassification });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.execution.failed",
        outcome: "failure",
        runId,
        run,
        createdAt: endedAt,
        error,
        retryClassification,
        details: { startedAt, endedAt }
      }));
      throw error;
    }
  }

  async completeRun({ runId, completion = {} }) {
    if (!runId || typeof runId !== "string") {
      const error = new Error("runId is required");
      error.statusCode = 400;
      throw error;
    }

    if (completion.exitCode === undefined && completion.status === undefined) {
      const error = new Error("completion exitCode or status is required");
      error.statusCode = 400;
      throw error;
    }

    const run = await this.getRun(runId);
    if (!run) {
      const error = new Error("run not found");
      error.statusCode = 404;
      throw error;
    }

    if (run.state !== "RUNNING") {
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.completion.skipped",
        outcome: "skipped",
        runId,
        run,
        details: { state: run.state, reason: "run_not_running" }
      }));
      return this.skippedResult({ runId, state: run.state });
    }

    const endedAt = completion.endedAt || this.now().toISOString();
    const succeeded = !completion.error &&
      (completion.exitCode === 0 || completion.status === "completed" || completion.status === "succeeded");
    const normalizedResult = this.normalizeExecutionResult({
      ...completion,
      status: succeeded ? "completed" : "failed",
      runId,
      endedAt
    });

    if (succeeded) {
      const updated = await this.markSucceeded({ runId, endedAt, result: normalizedResult });
      if (!updated) return this.skippedResult({ runId, state: "UNKNOWN" });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.execution.completed",
        outcome: "success",
        runId,
        run,
        createdAt: endedAt,
        details: { endedAt, result: normalizedResult }
      }));
      return { status: "completed", runId, state: "SUCCEEDED", endedAt, result: normalizedResult };
    }

    const error = this.runtimeCompletionError({ completion, normalizedResult });
    const retryClassification = classifyWorkerError(error);
    const updated = await this.markFailed({ runId, endedAt, error, retryClassification });
    if (!updated) return this.skippedResult({ runId, state: "UNKNOWN" });
    await this.emitAuditEvent(this.buildWorkerAuditEvent({
      eventType: "worker.execution.completed",
      outcome: "failure",
      runId,
      run,
      createdAt: endedAt,
      error,
      retryClassification,
      details: { endedAt, result: normalizedResult }
    }));
    return { status: "failed", runId, state: "FAILED", endedAt, error: this.serializeError(error, retryClassification) };
  }

  async executeRunLocally({ runId }) {
    if (this.localRunning >= this.maxLocalConcurrency) {
      throw this.executionMetadataError("WORKER_LOCAL_CONCURRENCY_EXCEEDED", "local worker concurrency limit exceeded", { retryable: true });
    }

    this.localRunning += 1;
    try {
      return await this.executeRunLocallyInternal({ runId });
    } finally {
      this.localRunning -= 1;
    }
  }

  async claimQueuedRun({ runId }) {
    if (!runId || typeof runId !== "string") {
      const error = new Error("runId is required");
      error.statusCode = 400;
      throw error;
    }

    await this.emitAuditEvent(this.buildWorkerAuditEvent({ eventType: "worker.run.received", outcome: "received", runId }));
    const run = await this.getRun(runId);

    if (!run) {
      const error = new Error("run not found");
      error.statusCode = 404;
      const retryClassification = classifyWorkerError(error);
      await this.emitAuditEvent(this.buildWorkerAuditEvent({ eventType: "worker.execution.failed", outcome: "failure", runId, error, retryClassification }));
      throw error;
    }

    if (run.state !== "QUEUED") {
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.claim.skipped",
        outcome: "skipped",
        runId,
        run,
        details: { state: run.state, reason: "run_not_queued" }
      }));
      return { run, startedAt: null, claim: { claimed: false, state: run.state } };
    }

    const startedAt = this.now().toISOString();
    await this.emitAuditEvent(this.buildWorkerAuditEvent({
      eventType: "worker.claim.attempted",
      outcome: "attempted",
      runId,
      run,
      createdAt: startedAt,
      details: { startedAt }
    }));

    const claim = await this.claimRun({ runId, startedAt });
    if (!claim.claimed) {
      const latestRun = await this.getRun(runId);
      const state = latestRun?.state || "UNKNOWN";
      const reason = claim.missing ? "run_missing_during_claim" : "claim_not_acquired";
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.claim.skipped",
        outcome: "skipped",
        runId,
        run: latestRun || run,
        createdAt: startedAt,
        details: { state, reason }
      }));
      return { run: latestRun || run, startedAt, claim: { ...claim, state } };
    }

    await this.emitAuditEvent(this.buildWorkerAuditEvent({
      eventType: "worker.claim.succeeded",
      outcome: "claimed",
      runId,
      run,
      createdAt: startedAt,
      details: { startedAt }
    }));
    await this.emitAuditEvent(this.buildWorkerAuditEvent({ eventType: "WORKER_RUN_STARTED", outcome: "success", runId, run, createdAt: startedAt, details: { startedAt } }));

    return { run, startedAt, claim };
  }

  async executeRunLocallyInternal({ runId }) {
    const { run, startedAt, claim } = await this.claimQueuedRun({ runId });
    if (!claim.claimed) return this.skippedResult({ runId, state: claim.state || "UNKNOWN" });

    try {
      const execution = await this.buildExecutionMetadata({ run });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.metadata.loaded",
        outcome: "loaded",
        runId,
        run,
        execution,
        createdAt: startedAt,
        details: {
          runtime: execution.definition.runtime,
          runtimeVersion: execution.definition.runtimeVersion,
          entrypoint: execution.definition.entrypoint
        }
      }));
      this.validateArtifactTrust({ execution });
      execution.artifact.verification = await this.verifyApprovedArtifact({ execution });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.artifact.verified",
        outcome: "verified",
        runId,
        run,
        execution,
        createdAt: startedAt,
        details: {
          artifact: {
            uri: execution.artifact.uri,
            sha256: execution.artifact.verification.sha256,
            generation: execution.artifact.verification.generation,
            fileCount: execution.artifact.verification.fileCount,
            uncompressedBytes: execution.artifact.verification.uncompressedBytes
          }
        }
      }));
      await this.emitAuditEvent(this.buildWorkerAuditEvent({ eventType: "worker.execution.started", outcome: "started", runId, run, execution, createdAt: startedAt }));
      const params = await this.resolveRuntimeParameters({ run });
      const result = await this.runtimeExecutor.execute({
        runId,
        run,
        execution,
        artifactBuffer: execution.artifact.verification.buffer,
        context: this.buildRuntimeContext({ run, execution, params })
      });
      const endedAt = this.now().toISOString();
      const normalizedResult = this.normalizeExecutionResult(result);
      const updated = await this.markSucceeded({ runId, endedAt, result: normalizedResult });
      if (!updated) return this.skippedResult({ runId, state: "CANCELLED" });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.execution.succeeded",
        outcome: "success",
        runId,
        run,
        execution,
        createdAt: endedAt,
        details: {
          startedAt,
          endedAt,
          runtime: execution.definition.runtime,
          runtimeVersion: execution.definition.runtimeVersion,
          entrypoint: execution.definition.entrypoint,
          artifact: {
            uri: execution.artifact.uri,
            sha256: execution.artifact.verification.sha256,
            generation: execution.artifact.verification.generation,
            fileCount: execution.artifact.verification.fileCount,
            uncompressedBytes: execution.artifact.verification.uncompressedBytes
          }
        }
      }));
      return { status: "completed", runId, state: "SUCCEEDED", startedAt, endedAt, result: normalizedResult };
    } catch (error) {
      const endedAt = this.now().toISOString();
      const retryClassification = classifyWorkerError(error);
      await this.markFailed({ runId, endedAt, error, retryClassification });
      await this.emitAuditEvent(this.buildWorkerAuditEvent({
        eventType: "worker.execution.failed",
        outcome: "failure",
        runId,
        run,
        createdAt: endedAt,
        error,
        retryClassification,
        details: { startedAt, endedAt }
      }));
      throw error;
    }
  }

  validateArtifactTrust({ execution }) {
    const { artifact } = execution;
    if (artifact.approval?.status !== "APPROVED") throw this.executionMetadataError("ARTIFACT_NOT_APPROVED", "approved artifact is missing APPROVED status", { retryable: false });
    if (artifact.scan?.status !== "CLEAN") throw this.executionMetadataError("ARTIFACT_SCAN_NOT_CLEAN", "approved artifact is missing CLEAN scan status", { retryable: false });
    if (artifact.approval.sha256 && artifact.approval.sha256 !== artifact.sha256) throw this.executionMetadataError("ARTIFACT_APPROVAL_DIGEST_MISMATCH", "artifact approval sha256 does not match executable artifact", { retryable: false });
    if (artifact.approval.generation && String(artifact.approval.generation) !== String(artifact.generation)) throw this.executionMetadataError("ARTIFACT_APPROVAL_GENERATION_MISMATCH", "artifact approval generation does not match executable artifact", { retryable: false });
    if (artifact.scan.sha256 && artifact.scan.sha256 !== artifact.sha256) throw this.executionMetadataError("ARTIFACT_SCAN_DIGEST_MISMATCH", "artifact scan sha256 does not match executable artifact", { retryable: false });
    if (artifact.revoked === true) throw this.executionMetadataError("ARTIFACT_APPROVAL_REVOKED", "artifact approval has been revoked", { retryable: false });
  }

  skippedResult({ runId, state }) {
    return { status: "skipped", runId, state, message: `Run is ${state}; worker execution was not started` };
  }

  async resolveRuntimeParameters({ run }) {
    return this.parameterResolver.resolveParameters(run.params || {});
  }

  buildRuntimeContext({ run, execution, params = {} }) {
    return {
      runId: run.runId,
      definition: execution.definition,
      instance: { instanceId: run.instanceId },
      scheduledFireTime: run.scheduledFireTime,
      attempt: run.attempt,
      params
    };
  }

  async buildExecutionMetadata({ run }) {
    if (!run.definitionId) throw this.executionMetadataError("RUN_DEFINITION_MISSING", "run definitionId is required");
    const definition = await this.getDefinition(run.definitionId);
    if (!definition) throw this.executionMetadataError("DEFINITION_NOT_FOUND", `job definition ${run.definitionId} was not found`);
    if (definition.enabled !== true || definition.state !== "ACTIVE") throw this.executionMetadataError("DEFINITION_NOT_ACTIVE", `job definition ${run.definitionId} is not active`);
    if (run.definitionVersion !== undefined && definition.version !== run.definitionVersion) throw this.executionMetadataError("DEFINITION_VERSION_MISMATCH", `run requires definition version ${run.definitionVersion}, but current version is ${definition.version}`);
    if (!definition.jobZip?.uri || !definition.jobZip?.sha256 || !definition.jobZip?.generation) throw this.executionMetadataError("DEFINITION_ARTIFACT_MISSING", `job definition ${run.definitionId} is missing approved artifact metadata`);
    return {
      definition: {
        definitionId: definition.definitionId,
        version: definition.version,
        runtime: definition.runtime,
        runtimeVersion: definition.runtimeVersion,
        wrapperVersion: definition.wrapperVersion,
        entrypoint: definition.entrypoint,
        timeoutSeconds: definition.timeoutSeconds
      },
      artifact: {
        uri: definition.jobZip.uri,
        sha256: definition.jobZip.sha256,
        generation: String(definition.jobZip.generation),
        approval: definition.jobZip.approval,
        scan: definition.jobZip.scan,
        revoked: definition.jobZip.revoked
      }
    };
  }

  async verifyApprovedArtifact({ execution }) {
    const { bucketName, objectName } = this.parseGcsUri(execution.artifact.uri);
    const file = this.getStorage().bucket(bucketName).file(objectName, { generation: execution.artifact.generation });
    let buffer;
    try {
      [buffer] = await file.download();
    } catch (error) {
      throw this.executionMetadataError("ARTIFACT_DOWNLOAD_FAILED", `approved artifact download failed for ${execution.artifact.uri}: ${error.message}`, { cause: error });
    }
    const actualSha256 = sha256(buffer);
    if (actualSha256 !== execution.artifact.sha256) throw this.executionMetadataError("ARTIFACT_SHA256_MISMATCH", `approved artifact sha256 mismatch for ${execution.artifact.uri}`);
    let zipInfo;
    try {
      zipInfo = await validateZipBuffer(buffer, {
        entrypoint: execution.definition.entrypoint,
        runtime: execution.definition.runtime,
        wrapperVersion: execution.definition.wrapperVersion
      });
    } catch (error) {
      throw this.executionMetadataError("ARTIFACT_ZIP_INVALID", error.message, { cause: error, retryable: false });
    }
    return { sha256: actualSha256, generation: execution.artifact.generation, fileCount: zipInfo.fileCount, uncompressedBytes: zipInfo.uncompressedBytes, buffer };
  }

  getStorage() {
    if (!this.storage) this.storage = createStorageClient();
    return this.storage;
  }

  parseGcsUri(uri) {
    if (!uri || !uri.startsWith("gs://")) throw this.executionMetadataError("ARTIFACT_URI_INVALID", `invalid GCS artifact URI: ${uri}`);
    const withoutScheme = uri.slice("gs://".length);
    const slashIndex = withoutScheme.indexOf("/");
    if (slashIndex <= 0 || slashIndex === withoutScheme.length - 1) throw this.executionMetadataError("ARTIFACT_URI_INVALID", `invalid GCS artifact URI: ${uri}`);
    return { bucketName: withoutScheme.slice(0, slashIndex), objectName: withoutScheme.slice(slashIndex + 1) };
  }

  executionMetadataError(code, message, { cause, retryable } = {}) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    if (typeof retryable === "boolean") error.retryable = retryable;
    return error;
  }

  runtimeCompletionError({ completion, normalizedResult }) {
    const code = completion.error?.code || (completion.timedOut ? "RUNTIME_PROCESS_TIMED_OUT" : "RUNTIME_PROCESS_EXITED_NON_ZERO");
    const message = completion.error?.message || completion.stderr || `Runtime exited with code ${completion.exitCode}`;
    const error = new Error(message);
    error.code = code;
    error.execution = normalizedResult;
    if (typeof completion.retryable === "boolean") error.retryable = completion.retryable;
    return error;
  }

  async getRun(runId) {
    return this.runStore.getRun(runId);
  }

  async getDefinition(definitionId) {
    try {
      const response = await this.esClient.get({ index: this.definitionsIndex, id: definitionId });
      return response._source;
    } catch (error) {
      if (error.meta?.statusCode === 404 || error.statusCode === 404) return null;
      throw error;
    }
  }

  async claimRun({ runId, startedAt }) {
    return this.runStore.claimRun({ runId, startedAt });
  }

  async recordRuntimeExecution({ runId, runtimeExecution, startedAt }) {
    if (this.runStore) return this.runStore.recordRuntimeExecution({ runId, runtimeExecution, startedAt });
    throw new Error("recordRuntimeExecution requires runStore");
  }

  async markSucceeded({ runId, endedAt, result }) {
    if (this.runStore) return this.runStore.markSucceeded({ runId, endedAt, result });
    throw new Error("markSucceeded requires runStore");
  }

  async markFailed({ runId, endedAt, error, retryClassification }) {
    if (this.runStore) return this.runStore.markFailed({ runId, endedAt, error: this.serializeError(error, retryClassification) });
    throw new Error("markFailed requires runStore");
  }

  normalizeExecutionResult(result = {}) {
    return {
      status: result.status,
      runId: result.runId,
      runtime: result.runtime,
      runtimeVersion: result.runtimeVersion,
      entrypoint: result.entrypoint,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      timeoutSeconds: result.timeoutSeconds,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      output: result.output,
      startedAt: result.startedAt,
      endedAt: result.endedAt
    };
  }

  serializeError(error, retryClassification) {
    const serialized = { code: error.code, message: error.message };
    const execution = this.normalizeExecutionResult(error.execution || {});
    const hasExecution = Object.values(execution).some((value) => value !== undefined);
    if (hasExecution) serialized.execution = execution;
    if (retryClassification) serialized.retry = retryClassification;
    return serialized;
  }

  buildWorkerAuditEvent({ eventType, outcome, runId, run, execution, createdAt, error, retryClassification, details = {} }) {
    const event = { eventId: randomUUID(), eventType, outcome, actor: this.auditActor, runId, createdAt: createdAt || this.now().toISOString(), details };
    if (run) {
      event.jobDefinitionId = run.definitionId;
      event.jobInstanceId = run.instanceId;
    }
    if (execution?.definition) {
      event.runtime = execution.definition.runtime;
      event.runtimeVersion = execution.definition.runtimeVersion;
      event.entrypoint = execution.definition.entrypoint;
    }
    if (error) {
      event.errorCode = error.code;
      event.errorMessage = error.message;
    }
    if (retryClassification) {
      event.retryable = retryClassification.retryable;
      event.retryClassification = retryClassification.classification;
      event.retryReason = retryClassification.reason;
    }
    return event;
  }

  async emitAuditEvent(event) {
    if (!this.auditEnabled || typeof this.esClient.create !== "function") return;
    try {
      await this.esClient.create({ index: this.auditIndex, id: event.eventId || randomUUID(), document: event, refresh: true });
    } catch (error) {
      this.logger.warn?.("worker audit emit failed", { error: error.message, eventType: event.eventType, runId: event.runId });
    }
  }
}
