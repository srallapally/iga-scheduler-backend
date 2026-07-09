import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDispatcher } from "../src/services/runDispatcher.js";

function makeRunStore(runIds = []) {
  return {
    listQueuedRunIds: vi.fn(async () => [...runIds])
  };
}

function makeWorkerRunService(impl) {
  return {
    executeRun: vi.fn(impl || (async () => ({ status: "completed" })))
  };
}

describe("RunDispatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("requires runStore and workerRunService", () => {
    expect(() => new RunDispatcher({})).toThrow("runStore is required");
    expect(() => new RunDispatcher({ runStore: makeRunStore() })).toThrow("workerRunService is required");
  });

  it("start() triggers executeRun for each queued runId after one interval", async () => {
    const runStore = makeRunStore(["run-1", "run-2"]);
    const workerRunService = makeWorkerRunService();
    const dispatcher = new RunDispatcher({ runStore, workerRunService, intervalMs: 1000 });
    dispatcher.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(workerRunService.executeRun).toHaveBeenCalledTimes(2);
    expect(workerRunService.executeRun).toHaveBeenCalledWith({ runId: "run-1" });
    expect(workerRunService.executeRun).toHaveBeenCalledWith({ runId: "run-2" });
    dispatcher.stop();
  });

  it("stop() halts the interval — no further executeRun calls after stop", async () => {
    const runStore = makeRunStore(["run-1"]);
    const workerRunService = makeWorkerRunService();
    const dispatcher = new RunDispatcher({ runStore, workerRunService, intervalMs: 1000 });
    dispatcher.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(workerRunService.executeRun).toHaveBeenCalledTimes(1);

    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(workerRunService.executeRun).toHaveBeenCalledTimes(1);
  });

  it("overlap guard: skips a new pass while the previous is still in flight", async () => {
    let resolveFirst;
    const firstPassPromise = new Promise((r) => { resolveFirst = r; });
    let callCount = 0;

    const runStore = makeRunStore(["slow-run"]);
    const workerRunService = makeWorkerRunService(async () => {
      callCount++;
      await firstPassPromise;
    });

    const dispatcher = new RunDispatcher({ runStore, workerRunService, intervalMs: 100 });
    dispatcher.start();

    // First interval fires, pass starts but doesn't finish
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);

    // Second interval fires while first is still in flight — should be skipped
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);

    // Now unblock first pass
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Third interval fires — first pass is done, second pass should run
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    dispatcher.stop();
  });

  it("executeRun throwing logs a warning and continues to the next runId", async () => {
    const runStore = makeRunStore(["fail-run", "ok-run"]);
    const warnSpy = vi.fn();
    const workerRunService = makeWorkerRunService(async ({ runId }) => {
      if (runId === "fail-run") throw new Error("dispatch failed");
    });
    const dispatcher = new RunDispatcher({
      runStore, workerRunService, intervalMs: 1000,
      logger: { warn: warnSpy }
    });
    dispatcher.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).toHaveBeenCalledWith("dispatch failed", expect.objectContaining({ runId: "fail-run", error: "dispatch failed" }));
    expect(workerRunService.executeRun).toHaveBeenCalledWith({ runId: "ok-run" });
    dispatcher.stop();
  });

  it("no passes are fired before start() is called", async () => {
    const runStore = makeRunStore(["run-1"]);
    const workerRunService = makeWorkerRunService();
    new RunDispatcher({ runStore, workerRunService, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);
    expect(workerRunService.executeRun).not.toHaveBeenCalled();
  });
});
