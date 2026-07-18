import { describe, expect, it, vi } from "vitest";
import { createPollLoop } from "../src/workers/pollLoop.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function createRunStore(claimBatches = [[]]) {
  let call = 0;
  return {
    claimNextQueued: vi.fn(async () => claimBatches[Math.min(call++, claimBatches.length - 1)]),
    touchHeartbeat: vi.fn(async () => "RUNNING")
  };
}

describe("createPollLoop (AVL-1 residual)", () => {
  it("pollOnce claims up to the free concurrency slots and executes each claimed run", async () => {
    const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }, { runId: "run-2", dispatchId: "d-2" }]]);
    const workerRunService = { executeClaimedRun: vi.fn(async () => ({ status: "completed" })) };
    const activeExecutions = new Set();
    const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5 });

    await loop.pollOnce();

    expect(runStore.claimNextQueued).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    expect(workerRunService.executeClaimedRun).toHaveBeenCalledWith({ runId: "run-1", dispatchId: "d-1" });
    expect(workerRunService.executeClaimedRun).toHaveBeenCalledWith({ runId: "run-2", dispatchId: "d-2" });
  });

  it("does not poll when there are no free concurrency slots", async () => {
    const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
    const workerRunService = { executeClaimedRun: vi.fn(async () => ({ status: "completed" })) };
    const activeExecutions = new Set([Promise.resolve(), Promise.resolve()]);
    const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 2 });

    await loop.pollOnce();

    expect(runStore.claimNextQueued).not.toHaveBeenCalled();
  });

  it("tracks in-flight executions in activeExecutions and removes them on settle", async () => {
    const gate = deferred();
    const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
    const workerRunService = { executeClaimedRun: vi.fn(() => gate.promise) };
    const activeExecutions = new Set();
    const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5 });

    await loop.pollOnce();
    expect(activeExecutions.size).toBe(1);
    expect(loop.owned.get("run-1")).toBe("d-1");

    gate.resolve({ status: "completed" });
    await vi.waitFor(() => expect(activeExecutions.size).toBe(0));
    expect(loop.owned.has("run-1")).toBe(false);
  });

  it("removes a run from tracking even when execution rejects", async () => {
    const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
    const workerRunService = { executeClaimedRun: vi.fn(async () => { throw new Error("boom"); }) };
    const activeExecutions = new Set();
    const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5 });

    await loop.pollOnce();
    await vi.waitFor(() => expect(activeExecutions.size).toBe(0));
  });

  it("a claim failure does not crash the loop", async () => {
    const runStore = { claimNextQueued: vi.fn(async () => { throw new Error("db unavailable"); }), touchHeartbeat: vi.fn() };
    const workerRunService = { executeClaimedRun: vi.fn() };
    const activeExecutions = new Set();
    const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5, logger: { error: vi.fn() } });

    await expect(loop.pollOnce()).resolves.toEqual([]);
    expect(workerRunService.executeClaimedRun).not.toHaveBeenCalled();
  });

  describe("heartbeatOnce", () => {
    it("touches heartbeat for each owned run", async () => {
      const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
      const workerRunService = { executeClaimedRun: vi.fn(() => new Promise(() => {})) };
      const activeExecutions = new Set();
      const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5 });
      await loop.pollOnce();

      await loop.heartbeatOnce();

      expect(runStore.touchHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", dispatchId: "d-1" }));
    });

    it("calls executor.cancel when touchHeartbeat reports CANCELLING", async () => {
      const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
      runStore.touchHeartbeat = vi.fn(async () => "CANCELLING");
      const workerRunService = { executeClaimedRun: vi.fn(() => new Promise(() => {})) };
      const executor = { cancel: vi.fn(() => ({ status: "killed" })) };
      const activeExecutions = new Set();
      const loop = createPollLoop({ runStore, workerRunService, executor, activeExecutions, maxConcurrency: 5 });
      await loop.pollOnce();

      await loop.heartbeatOnce();

      expect(executor.cancel).toHaveBeenCalledWith("run-1");
    });

    it("does not call executor.cancel while still RUNNING", async () => {
      const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
      const workerRunService = { executeClaimedRun: vi.fn(() => new Promise(() => {})) };
      const executor = { cancel: vi.fn() };
      const activeExecutions = new Set();
      const loop = createPollLoop({ runStore, workerRunService, executor, activeExecutions, maxConcurrency: 5 });
      await loop.pollOnce();

      await loop.heartbeatOnce();

      expect(executor.cancel).not.toHaveBeenCalled();
    });

    it("a heartbeat failure for one run does not stop others from being touched", async () => {
      const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }, { runId: "run-2", dispatchId: "d-2" }]]);
      let call = 0;
      runStore.touchHeartbeat = vi.fn(async () => { call++; if (call === 1) throw new Error("db blip"); return "RUNNING"; });
      const workerRunService = { executeClaimedRun: vi.fn(() => new Promise(() => {})) };
      const activeExecutions = new Set();
      const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5, logger: { error: vi.fn() } });
      await loop.pollOnce();

      await loop.heartbeatOnce();

      expect(runStore.touchHeartbeat).toHaveBeenCalledTimes(2);
    });
  });

  describe("start/stop", () => {
    it("stop() prevents any further claims from a scheduled poll", async () => {
      const runStore = createRunStore([[{ runId: "run-1", dispatchId: "d-1" }]]);
      const workerRunService = { executeClaimedRun: vi.fn(async () => ({ status: "completed" })) };
      const activeExecutions = new Set();
      const loop = createPollLoop({ runStore, workerRunService, executor: {}, activeExecutions, maxConcurrency: 5, pollIntervalMs: 5, heartbeatIntervalMs: 1000 });

      loop.start();
      loop.stop();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(runStore.claimNextQueued).not.toHaveBeenCalled();
    });
  });
});
