import { describe, expect, it, vi } from "vitest";
import { RunControlService } from "../src/services/runControlService.js";

function run(overrides = {}) {
  return { runId: "run-1", tenantId: "tenant-1", definitionId: "risk-score", definitionVersion: 1, instanceId: "risk-score-hourly", scheduledFireTime: "2026-06-03T18:00:00.000Z", state: "FAILED", attempt: 1, createdAt: "2026-06-03T18:00:00.000Z", startedAt: "2026-06-03T18:01:00.000Z", endedAt: "2026-06-03T18:01:05.000Z", error: { code: "RUNTIME_PROCESS_EXITED_NON_ZERO", message: "failed" }, result: null, ...overrides };
}

function createRunStore(source = run()) {
  const store = {
    _doc: { ...source },
    getRun: vi.fn(async (runId) => store._doc?.runId === runId ? { ...store._doc } : null),
    createRun: vi.fn(async (doc) => { store._created = doc; return { created: true }; }),
    transition: vi.fn(async ({ runId, fromStates, set }) => {
      if (store._doc?.runId !== runId) return null;
      if (!fromStates.includes(store._doc.state)) return null;
      store._doc = { ...store._doc, ...set };
      return { ...store._doc };
    })
  };
  return store;
}

function fixedClock(value = "2026-06-03T18:02:00.000Z") { return () => new Date(value); }

describe("RunControlService", () => {
  it("retries failed runs by resetting them to queued", async () => {
    const runStore = createRunStore(run({ attempt: 2 }));
    const service = new RunControlService({ runStore, now: fixedClock() });
    const result = await service.retryRun({ runId: "run-1" });
    expect(result).toEqual(expect.objectContaining({ status: "queued", action: "retry", runId: "run-1", state: "QUEUED", attempt: 3, enqueued: true }));
    expect(result.dispatchId).toEqual(expect.any(String));
    expect(runStore.transition).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      fromStates: ["FAILED"],
      set: expect.objectContaining({ state: "QUEUED", attempt: 3, dispatchId: result.dispatchId, startedAt: null, endedAt: null, error: null, status: { phase: "queued", message: "Run queued for retry" } })
    }));
  });

  it("rejects retry for non-failed runs", async () => {
    const service = new RunControlService({ runStore: createRunStore(run({ state: "RUNNING" })), now: fixedClock() });
    await expect(service.retryRun({ runId: "run-1" })).rejects.toMatchObject({ statusCode: 409, message: "run run-1 cannot be retried from state RUNNING" });
  });

  it("cancels queued runs", async () => {
    const runStore = createRunStore(run({ state: "QUEUED" }));
    const service = new RunControlService({ runStore, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "no longer needed" });
    expect(result).toEqual({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED" });
    expect(runStore.transition).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ state: "CANCELLED", endedAt: "2026-06-03T18:02:00.000Z", error: { code: "RUN_CANCELLED", message: "no longer needed" } })
    }));
  });

  it("moves running cancel to cancelling and invokes runtime launcher, but stays CANCELLING when the worker can't confirm a kill (COR-2)", async () => {
    const runtimeExecution = { backend: "cloud-run-job" };
    const runStore = createRunStore(run({ state: "RUNNING", runtimeExecution }));
    const runtimeLauncher = { cancel: vi.fn(async () => ({ status: "not_found" })) };
    const service = new RunControlService({ runStore, runtimeLauncher, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "stop" });
    expect(result).toEqual({ status: "cancelling", action: "cancel", runId: "run-1", state: "CANCELLING" });
    expect(runStore.transition).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ state: "CANCELLING", cancelReason: "stop" }) }));
    expect(runtimeLauncher.cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", state: "CANCELLING" }));
    expect(runStore.transition).toHaveBeenCalledTimes(1);
    const finalRun = await runStore.getRun("run-1");
    expect(finalRun.state).toBe("CANCELLING");
  });

  it("transitions CANCELLING straight to CANCELLED when the worker confirms the subprocess was killed (COR-2)", async () => {
    const runStore = createRunStore(run({ state: "RUNNING" }));
    const runtimeLauncher = { cancel: vi.fn(async () => ({ status: "killed" })) };
    const service = new RunControlService({ runStore, runtimeLauncher, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "stop" });
    expect(result).toEqual({ status: "cancelling", action: "cancel", runId: "run-1", state: "CANCELLING" });
    expect(runStore.transition).toHaveBeenCalledTimes(2);
    expect(runStore.transition).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runId: "run-1",
      fromStates: ["CANCELLING"],
      set: expect.objectContaining({ state: "CANCELLED", cancelledAt: "2026-06-03T18:02:00.000Z" })
    }));
    const finalRun = await runStore.getRun("run-1");
    expect(finalRun.state).toBe("CANCELLED");
  });

  it("does not throw when the worker is unreachable — CANCELLING stands, sweeper remains the backstop", async () => {
    const runStore = createRunStore(run({ state: "RUNNING" }));
    const runtimeLauncher = { cancel: vi.fn(async () => { throw new Error("worker unreachable"); }) };
    const service = new RunControlService({ runStore, runtimeLauncher, now: fixedClock() });
    const result = await service.cancelRun({ runId: "run-1", reason: "stop" });
    expect(result).toEqual({ status: "cancelling", action: "cancel", runId: "run-1", state: "CANCELLING" });
    expect(runStore.transition).toHaveBeenCalledTimes(1);
  });

  it("treats repeated cancel as idempotent", async () => {
    const service = new RunControlService({ runStore: createRunStore(run({ state: "CANCELLED" })), now: fixedClock() });
    await expect(service.cancelRun({ runId: "run-1" })).resolves.toEqual({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED", idempotent: true });
  });

  it("creates a new queued run for re-drive", async () => {
    const runStore = createRunStore(run({ state: "SUCCEEDED", result: { ok: true } }));
    const service = new RunControlService({ runStore, now: fixedClock() });
    const result = await service.redriveRun({ runId: "run-1" });
    expect(result).toEqual(expect.objectContaining({ status: "queued", action: "redrive", sourceRunId: "run-1", state: "QUEUED", attempt: 1, enqueued: true }));
    expect(result.runId).toMatch(/^run-1:redrive:/);
    expect(result.dispatchId).toEqual(expect.any(String));
    expect(runStore.createRun).toHaveBeenCalledWith(expect.objectContaining({ runId: result.runId, dispatchId: result.dispatchId, parentRunId: "run-1", redriveOfRunId: "run-1", state: "QUEUED", attempt: 1, result: null, error: null, status: { phase: "queued", message: "Run queued by re-drive" } }));
  });

  it("rejects re-drive for active runs", async () => {
    const service = new RunControlService({ runStore: createRunStore(run({ state: "QUEUED" })), now: fixedClock() });
    await expect(service.redriveRun({ runId: "run-1" })).rejects.toMatchObject({ statusCode: 409, message: "run run-1 cannot be re-driven from state QUEUED" });
  });

  it("concurrent retryRun — only one wins", async () => {
    // Both callers read state=FAILED, then race on transition().
    // First call wins (returns updated doc), second gets null (row already moved).
    const runStore = createRunStore(run({ state: "FAILED" }));
    let transitionCalls = 0;
    runStore.transition = vi.fn(async (opts) => {
      const callIndex = transitionCalls++;
      if (callIndex === 0) {
        // Winner: apply the transition
        runStore._doc = { ...runStore._doc, ...opts.set };
        return { ...runStore._doc };
      }
      // Loser: state no longer in fromStates, return null
      return null;
    });
    // After null transition, service re-reads to get 404-vs-409 — return the run (409, not 404)
    const originalGetRun = runStore.getRun;
    runStore.getRun = vi.fn(async (id) => {
      return runStore._doc?.runId === id ? { ...runStore._doc } : null;
    });

    const service = new RunControlService({ runStore, now: fixedClock() });
    const [r1, r2] = await Promise.allSettled([
      service.retryRun({ runId: "run-1" }),
      service.retryRun({ runId: "run-1" })
    ]);
    const wins = [r1, r2].filter((r) => r.status === "fulfilled");
    const losses = [r1, r2].filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].reason.statusCode).toBe(409);
  });
});
