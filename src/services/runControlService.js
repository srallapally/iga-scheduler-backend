import { randomUUID } from "crypto";

const RETRYABLE_STATES = new Set(["FAILED"]);
const CANCELLABLE_STATES = new Set(["QUEUED", "RUNNING", "CANCELLING"]);
const REDRIVABLE_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export class RunControlService {
  constructor({ runStore, now = () => new Date(), runtimeLauncher = null } = {}) {
    if (!runStore) throw new Error("runStore is required");
    this.runStore = runStore;
    this.now = now;
    this.runtimeLauncher = runtimeLauncher;
  }

  async retryRun({ runId } = {}) {
    if (!runId || typeof runId !== "string") throw this.transitionError(400, "runId is required");
    const nowIso = this.now().toISOString();
    const existing = await this.runStore.getRun(runId);
    if (!existing) throw this.transitionError(404, `run ${runId} was not found`);
    if (!RETRYABLE_STATES.has(existing.state)) throw this.transitionError(409, `run ${runId} cannot be retried from state ${existing.state}`);
    const nextAttempt = Number(existing.attempt || 0) + 1;
    const dispatchId = randomUUID();
    const updated = await this.runStore.transition({
      runId,
      fromStates: ["FAILED"],
      set: { state: "QUEUED", attempt: nextAttempt, dispatchId, startedAt: null, endedAt: null, heartbeatAt: null, updatedAt: nowIso, status: { phase: "queued", message: "Run queued for retry" }, error: null, runtimeExecution: null }
    });
    if (!updated) {
      const current = await this.runStore.getRun(runId);
      if (!current) throw this.transitionError(404, `run ${runId} was not found`);
      throw this.transitionError(409, `run ${runId} changed during transition`);
    }
    return { status: "queued", action: "retry", runId, state: "QUEUED", attempt: nextAttempt, dispatchId, enqueued: true };
  }

  async cancelRun({ runId, reason, cancelledBy = "operator" } = {}) {
    if (!runId || typeof runId !== "string") throw this.transitionError(400, "runId is required");
    const run = await this.runStore.getRun(runId);
    if (!run) throw this.transitionError(404, `run ${runId} was not found`);
    if (run.state === "CANCELLED") return { status: "cancelled", action: "cancel", runId, state: "CANCELLED", idempotent: true };
    if (!CANCELLABLE_STATES.has(run.state)) throw this.transitionError(409, `run ${runId} cannot be cancelled from state ${run.state}`);
    if (run.state === "CANCELLING") return { status: "cancelling", action: "cancel", runId, state: "CANCELLING", idempotent: true };
    const nowIso = this.now().toISOString();
    if (run.state === "RUNNING") {
      const updated = await this.runStore.transition({
        runId,
        fromStates: ["RUNNING"],
        set: { state: "CANCELLING", cancelRequestedAt: nowIso, cancelledBy, cancelReason: reason || "Run cancellation requested", updatedAt: nowIso, status: { phase: "cancelling", message: reason || "Run cancellation requested" } }
      });
      if (updated) await this.cancelRuntimeExecution(run);
      return { status: "cancelling", action: "cancel", runId, state: "CANCELLING" };
    }
    await this.runStore.transition({
      runId,
      fromStates: ["QUEUED"],
      set: { state: "CANCELLED", endedAt: nowIso, heartbeatAt: nowIso, cancelledAt: nowIso, cancelledBy, cancelReason: reason || "Run cancelled", updatedAt: nowIso, status: { phase: "cancelled", message: reason || "Run cancelled" }, error: { code: "RUN_CANCELLED", message: reason || "Run cancelled" } }
    });
    return { status: "cancelled", action: "cancel", runId, state: "CANCELLED" };
  }

  async redriveRun({ runId } = {}) {
    if (!runId || typeof runId !== "string") throw this.transitionError(400, "runId is required");
    const run = await this.runStore.getRun(runId);
    if (!run) throw this.transitionError(404, `run ${runId} was not found`);
    if (!REDRIVABLE_STATES.has(run.state)) throw this.transitionError(409, `run ${runId} cannot be re-driven from state ${run.state}`);
    const nowIso = this.now().toISOString();
    const redriveRunId = `${run.runId || runId}:redrive:${randomUUID()}`;
    const dispatchId = randomUUID();
    const document = { ...run, runId: redriveRunId, state: "QUEUED", attempt: 1, dispatchId, parentRunId: run.runId || runId, redriveOfRunId: run.runId || runId, createdAt: nowIso, updatedAt: nowIso, startedAt: null, endedAt: null, heartbeatAt: null, status: { phase: "queued", message: "Run queued by re-drive" }, result: null, error: null, runtimeExecution: null };
    await this.runStore.createRun(document);
    return { status: "queued", action: "redrive", sourceRunId: runId, runId: redriveRunId, state: "QUEUED", attempt: 1, dispatchId, enqueued: true };
  }

  async cancelRuntimeExecution(run) {
    if (!this.runtimeLauncher?.cancel || !run.runtimeExecution?.executionId) return false;
    await this.runtimeLauncher.cancel(run.runtimeExecution);
    return true;
  }

  transitionError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
}
