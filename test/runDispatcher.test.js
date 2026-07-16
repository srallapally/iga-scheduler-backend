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

  it("self-schedules a second pass after the first completes", async () => {
    const runStore = makeRunStore(["run-1"]);
    const workerRunService = makeWorkerRunService();
    const dispatcher = new RunDispatcher({ runStore, workerRunService, intervalMs: 1000 });
    dispatcher.start();

    await vi.advanceTimersByTimeAsync(1000); // first pass
    await vi.advanceTimersByTimeAsync(1000); // second pass

    expect(workerRunService.executeRun).toHaveBeenCalledTimes(2);
    dispatcher.stop();
  });

  it("stop() halts scheduling — no further executeRun calls after stop", async () => {
    const runStore = makeRunStore(["run-1"]);
    const workerRunService = makeWorkerRunService();
    const dispatcher = new RunDispatcher({ runStore, workerRunService, intervalMs: 1000 });
    dispatcher.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(workerRunService.executeRun).toHaveBeenCalledTimes(1);

    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(5000);
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

    // First pass fires but doesn't finish
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);

    // Self-scheduled next timeout fires while first pass is still running — skipped
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);

    // Unblock first pass; next scheduled timeout fires normally
    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
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

  describe("backpressure", () => {
    it("uses normal interval when failures are below the threshold", async () => {
      const runStore = makeRunStore(["run-1"]);
      const warnSpy = vi.fn();
      const workerRunService = makeWorkerRunService(async () => { throw new Error("worker down"); });
      const dispatcher = new RunDispatcher({
        runStore, workerRunService, intervalMs: 1000, backoffThreshold: 3, maxBackoffMs: 60000,
        logger: { warn: warnSpy }
      });
      dispatcher.start();

      // Two failures — below threshold of 3
      await vi.advanceTimersByTimeAsync(1000); // pass 1 — fails
      await vi.advanceTimersByTimeAsync(1000); // pass 2 — fails

      expect(dispatcher._consecutiveFailures).toBe(2);
      // Third pass should still fire at normal 1000ms interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(dispatcher._consecutiveFailures).toBe(3);

      dispatcher.stop();
    });

    it("applies exponential backoff after threshold is reached", async () => {
      const runStore = makeRunStore(["run-1"]);
      const workerRunService = makeWorkerRunService(async () => { throw new Error("worker down"); });
      const dispatcher = new RunDispatcher({
        runStore, workerRunService, intervalMs: 1000, backoffThreshold: 2, maxBackoffMs: 60000,
        logger: { warn: vi.fn() }
      });
      dispatcher.start();

      // Two failures to reach threshold
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(dispatcher._consecutiveFailures).toBe(2);

      // Next delay should be 1000 * 2^0 = 1000ms (threshold just reached, exponent=0)
      const callsBefore = workerRunService.executeRun.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500); // not enough
      expect(workerRunService.executeRun.mock.calls.length).toBe(callsBefore);
      await vi.advanceTimersByTimeAsync(500); // now at 1000ms — fires
      expect(workerRunService.executeRun.mock.calls.length).toBe(callsBefore + 1);

      // After one more failure: exponent=1, delay = 1000 * 2^1 = 2000ms
      const callsAfter = workerRunService.executeRun.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1500); // not enough
      expect(workerRunService.executeRun.mock.calls.length).toBe(callsAfter);
      await vi.advanceTimersByTimeAsync(500); // now at 2000ms — fires
      expect(workerRunService.executeRun.mock.calls.length).toBe(callsAfter + 1);

      dispatcher.stop();
    });

    it("caps backoff at maxBackoffMs", async () => {
      const runStore = makeRunStore(["run-1"]);
      const workerRunService = makeWorkerRunService(async () => { throw new Error("worker down"); });
      const dispatcher = new RunDispatcher({
        runStore, workerRunService, intervalMs: 1000, backoffThreshold: 1, maxBackoffMs: 4000,
        logger: { warn: vi.fn() }
      });
      dispatcher.start();

      // Reach threshold and drive up failures well past cap
      await vi.advanceTimersByTimeAsync(1000); // failure 1 — exponent 0 → 1000ms
      await vi.advanceTimersByTimeAsync(1000); // failure 2 — exponent 1 → 2000ms
      await vi.advanceTimersByTimeAsync(2000); // failure 3 — exponent 2 → 4000ms
      await vi.advanceTimersByTimeAsync(4000); // failure 4 — exponent 3 → 8000ms, capped at 4000ms

      expect(dispatcher._backoffMs()).toBe(4000);
      dispatcher.stop();
    });

    it("resets consecutive failures and returns to normal interval on success", async () => {
      let shouldFail = true;
      const runStore = makeRunStore(["run-1"]);
      const workerRunService = makeWorkerRunService(async () => {
        if (shouldFail) throw new Error("worker down");
      });
      const dispatcher = new RunDispatcher({
        runStore, workerRunService, intervalMs: 1000, backoffThreshold: 2, maxBackoffMs: 60000,
        logger: { warn: vi.fn() }
      });
      dispatcher.start();

      // Drive into backoff
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(dispatcher._consecutiveFailures).toBe(2);

      // Recover
      shouldFail = false;
      await vi.advanceTimersByTimeAsync(1000); // fires at 1000ms (exponent 0)
      expect(dispatcher._consecutiveFailures).toBe(0);
      expect(dispatcher._backoffMs()).toBe(1000);

      dispatcher.stop();
    });
  });
});
