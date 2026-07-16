import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleRunSweeper } from "../src/services/staleRunSweeper.js";

function makeRunStore({ staleIds = [], staleCancellingIds = [], markFailedResult = true, markCancelledResult = true } = {}) {
  return {
    listStaleRunningIds: vi.fn(async () => [...staleIds]),
    listStaleCancellingIds: vi.fn(async () => [...staleCancellingIds]),
    markFailed: vi.fn(async () => markFailedResult),
    markCancelled: vi.fn(async () => markCancelledResult)
  };
}

describe("StaleRunSweeper", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("requires runStore", () => {
    expect(() => new StaleRunSweeper({})).toThrow("runStore is required");
  });

  it("does nothing before start() is called", async () => {
    const runStore = makeRunStore({ staleIds: ["run-1"] });
    new StaleRunSweeper({ runStore, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(runStore.listStaleRunningIds).not.toHaveBeenCalled();
  });

  it("stop() halts the interval", async () => {
    const runStore = makeRunStore({ staleIds: [] });
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000 });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStore.listStaleRunningIds).toHaveBeenCalledTimes(1);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runStore.listStaleRunningIds).toHaveBeenCalledTimes(1);
  });

  it("passes configured thresholdMs to listStaleRunningIds", async () => {
    const runStore = makeRunStore({ staleIds: [] });
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, thresholdMs: 99000 });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runStore.listStaleRunningIds).toHaveBeenCalledWith({ thresholdMs: 99000, limit: 50 });
    sweeper.stop();
  });

  it("calls markFailed for each stale run with STALE_RUNNING error code", async () => {
    const runStore = makeRunStore({ staleIds: ["run-1", "run-2"] });
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000 });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(runStore.markFailed).toHaveBeenCalledTimes(2);
    expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      error: expect.objectContaining({ code: "STALE_RUNNING", retryable: false })
    }));
    expect(runStore.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-2",
      error: expect.objectContaining({ code: "STALE_RUNNING", retryable: false })
    }));
    sweeper.stop();
  });

  it("logs a warning for each run successfully marked failed", async () => {
    const runStore = makeRunStore({ staleIds: ["run-stale"], markFailedResult: true });
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale run marked failed", { runId: "run-stale" });
    sweeper.stop();
  });

  it("does not log when markFailed returns false (run already transitioned)", async () => {
    const runStore = makeRunStore({ staleIds: ["run-already-done"], markFailedResult: false });
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).not.toHaveBeenCalledWith("stale run marked failed", expect.anything());
    sweeper.stop();
  });

  it("logs a warning and continues when listStaleRunningIds throws", async () => {
    const runStore = {
      listStaleRunningIds: vi.fn(async () => { throw new Error("db unavailable"); }),
      listStaleCancellingIds: vi.fn(async () => []),
      markFailed: vi.fn(),
      markCancelled: vi.fn()
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale running sweep query failed", { error: "db unavailable" });
    expect(runStore.markFailed).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it("logs a warning and continues when markFailed throws for one run", async () => {
    const runStore = {
      listStaleRunningIds: vi.fn(async () => ["fail-run", "ok-run"]),
      listStaleCancellingIds: vi.fn(async () => []),
      markFailed: vi.fn(async ({ runId }) => {
        if (runId === "fail-run") throw new Error("update error");
        return true;
      }),
      markCancelled: vi.fn()
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale run mark failed error", { runId: "fail-run", error: "update error" });
    expect(warnSpy).toHaveBeenCalledWith("stale run marked failed", { runId: "ok-run" });
    sweeper.stop();
  });

  it("calls markCancelled for each stale CANCELLING run with STALE_CANCELLING error code", async () => {
    const runStore = makeRunStore({ staleCancellingIds: ["cancel-1", "cancel-2"] });
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000 });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(runStore.markCancelled).toHaveBeenCalledTimes(2);
    expect(runStore.markCancelled).toHaveBeenCalledWith(expect.objectContaining({
      runId: "cancel-1",
      error: expect.objectContaining({ code: "STALE_CANCELLING", retryable: false })
    }));
    sweeper.stop();
  });

  it("logs a warning for each CANCELLING run successfully force-cancelled", async () => {
    const runStore = makeRunStore({ staleCancellingIds: ["cancel-stale"], markCancelledResult: true });
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale cancelling run force-cancelled", { runId: "cancel-stale" });
    sweeper.stop();
  });

  it("logs a warning and continues when listStaleCancellingIds throws", async () => {
    const runStore = {
      listStaleRunningIds: vi.fn(async () => []),
      listStaleCancellingIds: vi.fn(async () => { throw new Error("db error"); }),
      markFailed: vi.fn(),
      markCancelled: vi.fn()
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale cancelling sweep query failed", { error: "db error" });
    expect(runStore.markCancelled).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it("logs a warning and continues when markCancelled throws for one run", async () => {
    const runStore = {
      listStaleRunningIds: vi.fn(async () => []),
      listStaleCancellingIds: vi.fn(async () => ["fail-cancel", "ok-cancel"]),
      markFailed: vi.fn(),
      markCancelled: vi.fn(async ({ runId }) => {
        if (runId === "fail-cancel") throw new Error("cancel error");
        return true;
      })
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale cancelling mark error", { runId: "fail-cancel", error: "cancel error" });
    expect(warnSpy).toHaveBeenCalledWith("stale cancelling run force-cancelled", { runId: "ok-cancel" });
    sweeper.stop();
  });
});
