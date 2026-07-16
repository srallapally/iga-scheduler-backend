import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleRunSweeper } from "../src/services/staleRunSweeper.js";

function makeRunStore({ staleIds = [], markFailedResult = true } = {}) {
  return {
    listStaleRunningIds: vi.fn(async () => [...staleIds]),
    markFailed: vi.fn(async () => markFailedResult)
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
      markFailed: vi.fn()
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale run sweep query failed", { error: "db unavailable" });
    expect(runStore.markFailed).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it("logs a warning and continues when markFailed throws for one run", async () => {
    const runStore = {
      listStaleRunningIds: vi.fn(async () => ["fail-run", "ok-run"]),
      markFailed: vi.fn(async ({ runId }) => {
        if (runId === "fail-run") throw new Error("update error");
        return true;
      })
    };
    const warnSpy = vi.fn();
    const sweeper = new StaleRunSweeper({ runStore, intervalMs: 1000, logger: { warn: warnSpy } });
    sweeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warnSpy).toHaveBeenCalledWith("stale run mark failed error", { runId: "fail-run", error: "update error" });
    expect(warnSpy).toHaveBeenCalledWith("stale run marked failed", { runId: "ok-run" });
    sweeper.stop();
  });
});
