import { randomUUID } from "crypto";
import { getConfig } from "../config/index.js";

const RETRYABLE_STATES = new Set(["FAILED"]);
const CANCELLABLE_STATES = new Set(["QUEUED", "RUNNING", "CANCELLING"]);
const REDRIVABLE_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export class RunControlService {
  constructor({ esClient, cloudTaskService, config = getConfig(), runsIndex = config.runsIndex, now = () => new Date(), runtimeLauncher = null } = {}) {
    if (!esClient) throw new Error("esClient is required");
    this.esClient = esClient; this.cloudTaskService = cloudTaskService; this.runsIndex = runsIndex; this.now = now; this.runtimeLauncher = runtimeLauncher;
  }

  async retryRun({ runId, enqueue = true } = {}) {
    const loaded = await this.requireRunWithVersion(runId);
    const run = loaded.source;
    if (!RETRYABLE_STATES.has(run.state)) throw this.transitionError(409, `run ${runId} cannot be retried from state ${run.state}`);
    const nowIso = this.now().toISOString();
    const nextAttempt = Number(run.attempt || 0) + 1;
    const dispatchId = randomUUID();
    await this.updateRunWithVersion({ runId, loaded, doc: { state: "QUEUED", attempt: nextAttempt, dispatchId, startedAt: null, endedAt: null, heartbeatAt: null, updatedAt: nowIso, status: { phase: "queued", message: "Run queued for retry" }, error: null, runtimeExecution: null } });
    const enqueued = enqueue ? await this.enqueueRun({ runId, attempt: nextAttempt, dispatchId }) : false;
    return { status: "queued", action: "retry", runId, state: "QUEUED", attempt: nextAttempt, dispatchId, enqueued };
  }

  async cancelRun({ runId, reason, cancelledBy = "operator" } = {}) {
    const loaded = await this.requireRunWithVersion(runId);
    const run = loaded.source;
    if (run.state === "CANCELLED") return { status: "cancelled", action: "cancel", runId, state: "CANCELLED", idempotent: true };
    if (!CANCELLABLE_STATES.has(run.state)) throw this.transitionError(409, `run ${runId} cannot be cancelled from state ${run.state}`);
    if (run.state === "CANCELLING") return { status: "cancelling", action: "cancel", runId, state: "CANCELLING", idempotent: true };
    const nowIso = this.now().toISOString();
    if (run.state === "RUNNING") {
      await this.updateRunWithVersion({ runId, loaded, doc: { state: "CANCELLING", cancelRequestedAt: nowIso, cancelledBy, cancelReason: reason || "Run cancellation requested", updatedAt: nowIso, status: { phase: "cancelling", message: reason || "Run cancellation requested" } } });
      await this.cancelRuntimeExecution(run);
      return { status: "cancelling", action: "cancel", runId, state: "CANCELLING" };
    }
    await this.updateRunWithVersion({ runId, loaded, doc: { state: "CANCELLED", endedAt: nowIso, heartbeatAt: nowIso, cancelledAt: nowIso, cancelledBy, cancelReason: reason || "Run cancelled", updatedAt: nowIso, status: { phase: "cancelled", message: reason || "Run cancelled" }, error: { code: "RUN_CANCELLED", message: reason || "Run cancelled" } } });
    return { status: "cancelled", action: "cancel", runId, state: "CANCELLED" };
  }

  async redriveRun({ runId, enqueue = true } = {}) {
    const loaded = await this.requireRunWithVersion(runId);
    const run = loaded.source;
    if (!REDRIVABLE_STATES.has(run.state)) throw this.transitionError(409, `run ${runId} cannot be re-driven from state ${run.state}`);
    const nowIso = this.now().toISOString();
    const redriveRunId = `${run.runId || runId}:redrive:${randomUUID()}`;
    const dispatchId = randomUUID();
    const document = { ...run, runId: redriveRunId, state: "QUEUED", attempt: 1, dispatchId, parentRunId: run.runId || runId, redriveOfRunId: run.runId || runId, createdAt: nowIso, startedAt: null, endedAt: null, heartbeatAt: null, updatedAt: nowIso, status: { phase: "queued", message: "Run queued by re-drive" }, result: null, error: null, runtimeExecution: null };
    await this.esClient.create({ index: this.runsIndex, id: redriveRunId, refresh: true, document });
    const enqueued = enqueue ? await this.enqueueRun({ runId: redriveRunId, attempt: 1, dispatchId }) : false;
    return { status: "queued", action: "redrive", sourceRunId: runId, runId: redriveRunId, state: "QUEUED", attempt: 1, dispatchId, enqueued };
  }

  async requireRunWithVersion(runId) {
    if (!runId || typeof runId !== "string") throw this.transitionError(400, "runId is required");
    try { const response = await this.esClient.get({ index: this.runsIndex, id: runId }); return { source: response._source, seqNo: response._seq_no, primaryTerm: response._primary_term }; } catch (error) { if (error.meta?.statusCode === 404 || error.statusCode === 404) throw this.transitionError(404, `run ${runId} was not found`); throw error; }
  }

  async requireRun(runId) { return (await this.requireRunWithVersion(runId)).source; }
  async updateRunWithVersion({ runId, loaded, doc }) { try { return await this.esClient.update({ index: this.runsIndex, id: runId, refresh: true, if_seq_no: loaded.seqNo, if_primary_term: loaded.primaryTerm, doc }); } catch (error) { if (error.meta?.statusCode === 409 || error.statusCode === 409) throw this.transitionError(409, `run ${runId} changed during transition`); throw error; } }
  async enqueueRun({ runId, attempt, dispatchId }) { if (!this.cloudTaskService) return false; await this.cloudTaskService.enqueueRun({ runId, attempt, dispatchId }); return true; }
  async cancelRuntimeExecution(run) { if (!this.runtimeLauncher?.cancel || !run.runtimeExecution?.executionId) return false; await this.runtimeLauncher.cancel(run.runtimeExecution); return true; }
  transitionError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
}
