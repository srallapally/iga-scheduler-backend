import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunStore } from "../src/stores/runStore.js";
import { pgAvailable, TEST_DATABASE_URL, createTestPool, applyMigrations, revertMigrations } from "./helpers/pg.js";

function makeRun(overrides = {}) {
  return {
    runId: "run-integration-1",
    tenantId: null,
    instanceId: "inst-1",
    definitionId: "def-1",
    definitionVersion: 1,
    scheduledFireTime: "2026-06-03T18:00:00.000Z",
    state: "QUEUED",
    attempt: 1,
    dispatchId: "dispatch-1",
    params: { window: "PT1H" },
    status: { phase: "queued", message: "queued" },
    createdAt: "2026-06-03T18:00:00.000Z",
    updatedAt: "2026-06-03T18:00:00.000Z",
    ...overrides
  };
}

describe.skipIf(!pgAvailable())("RunStore integration", () => {
  let pool;
  let store;

  beforeAll(async () => {
    pool = await createTestPool();
    try { await revertMigrations(pool); } catch {}
    await applyMigrations(pool);
    store = new RunStore({ pool });
  });

  afterAll(async () => {
    if (pool) {
      await revertMigrations(pool);
      await pool.end();
    }
  });

  it("createRun inserts a new run", async () => {
    const { created } = await store.createRun(makeRun());
    expect(created).toBe(true);
  });

  it("createRun is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const { created } = await store.createRun(makeRun());
    expect(created).toBe(false);
  });

  it("getRun returns the inserted run with camelCase fields and ISO timestamps", async () => {
    const run = await store.getRun("run-integration-1");
    expect(run).toMatchObject({
      runId: "run-integration-1",
      instanceId: "inst-1",
      definitionId: "def-1",
      state: "QUEUED",
      attempt: 1,
      params: { window: "PT1H" }
    });
    expect(typeof run.scheduledFireTime).toBe("string");
    expect(run.scheduledFireTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("getRun returns null for unknown runId", async () => {
    expect(await store.getRun("does-not-exist")).toBeNull();
  });

  it("claimRun transitions QUEUED→RUNNING atomically and mints a dispatch_id", async () => {
    const result = await store.claimRun({ runId: "run-integration-1", startedAt: "2026-06-03T18:01:00.000Z" });
    expect(result).toEqual({ claimed: true, dispatchId: expect.any(String) });
    const run = await store.getRun("run-integration-1");
    expect(run.state).toBe("RUNNING");
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.dispatchId).toBe(result.dispatchId);
  });

  it("claimRun on already-RUNNING run returns claimed: false (not missing)", async () => {
    const result = await store.claimRun({ runId: "run-integration-1", startedAt: "2026-06-03T18:01:00.000Z" });
    expect(result).toEqual({ claimed: false });
    expect(result.missing).toBeUndefined();
  });

  it("claimRun on missing run returns claimed: false, missing: true", async () => {
    const result = await store.claimRun({ runId: "not-a-run", startedAt: "2026-06-03T18:01:00.000Z" });
    expect(result).toEqual({ claimed: false, missing: true });
  });

  it("concurrent claimRun on a QUEUED run — exactly one wins", async () => {
    await store.createRun(makeRun({ runId: "run-race-1" }));
    const [r1, r2] = await Promise.all([
      store.claimRun({ runId: "run-race-1", startedAt: "2026-06-03T18:01:00.000Z" }),
      store.claimRun({ runId: "run-race-1", startedAt: "2026-06-03T18:01:00.000Z" })
    ]);
    const wins = [r1, r2].filter((r) => r.claimed);
    const losses = [r1, r2].filter((r) => !r.claimed);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0].missing).toBeUndefined();
  });

  describe("claimNextQueued (AVL-1 residual — pull-worker batch claim)", () => {
    it("returns [] when the QUEUED backlog is empty", async () => {
      const claimed = await store.claimNextQueued({ limit: 10, startedAt: "2026-06-04T10:05:00.000Z" });
      expect(claimed).toEqual([]);
    });

    it("claims up to limit QUEUED runs atomically, each with a distinct dispatch_id", async () => {
      await store.createRun(makeRun({ runId: "run-batch-a", createdAt: "2026-06-04T10:00:00.000Z", updatedAt: "2026-06-04T10:00:00.000Z" }));
      await store.createRun(makeRun({ runId: "run-batch-b", createdAt: "2026-06-04T10:01:00.000Z", updatedAt: "2026-06-04T10:01:00.000Z" }));
      await store.createRun(makeRun({ runId: "run-batch-c", createdAt: "2026-06-04T10:02:00.000Z", updatedAt: "2026-06-04T10:02:00.000Z" }));

      const claimed = await store.claimNextQueued({ limit: 2, startedAt: "2026-06-04T10:05:00.000Z" });

      expect(claimed).toHaveLength(2);
      expect(claimed.map((c) => c.runId)).toEqual(["run-batch-a", "run-batch-b"]);
      expect(new Set(claimed.map((c) => c.dispatchId)).size).toBe(2);
      for (const { runId, dispatchId } of claimed) {
        const run = await store.getRun(runId);
        expect(run.state).toBe("RUNNING");
        expect(run.dispatchId).toBe(dispatchId);
      }
      const untouched = await store.getRun("run-batch-c");
      expect(untouched.state).toBe("QUEUED");

      // Drain the remaining backlog so it doesn't leak into later tests.
      await store.claimNextQueued({ limit: 10, startedAt: "2026-06-04T10:06:00.000Z" });
    });

    it("two concurrent calls against the same backlog claim disjoint sets", async () => {
      await store.createRun(makeRun({ runId: "run-race-batch-1", createdAt: "2026-06-04T11:00:00.000Z", updatedAt: "2026-06-04T11:00:00.000Z" }));
      await store.createRun(makeRun({ runId: "run-race-batch-2", createdAt: "2026-06-04T11:01:00.000Z", updatedAt: "2026-06-04T11:01:00.000Z" }));

      const [batch1, batch2] = await Promise.all([
        store.claimNextQueued({ limit: 10, startedAt: "2026-06-04T11:05:00.000Z" }),
        store.claimNextQueued({ limit: 10, startedAt: "2026-06-04T11:05:00.000Z" })
      ]);

      const claimedIds = [...batch1, ...batch2].map((c) => c.runId);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds.sort()).toEqual(["run-race-batch-1", "run-race-batch-2"]);
    });
  });

  it("markSucceeded transitions RUNNING→SUCCEEDED", async () => {
    const ok = await store.markSucceeded({ runId: "run-integration-1", endedAt: "2026-06-03T18:02:00.000Z", result: { ok: true } });
    expect(ok).toBe(true);
    const run = await store.getRun("run-integration-1");
    expect(run.state).toBe("SUCCEEDED");
    expect(run.result).toEqual({ ok: true });
    expect(run.error).toBeNull();
  });

  it("markSucceeded on non-RUNNING run returns false", async () => {
    const ok = await store.markSucceeded({ runId: "run-integration-1", endedAt: "2026-06-03T18:02:00.000Z", result: {} });
    expect(ok).toBe(false);
  });

  it("markFailed transitions RUNNING→FAILED", async () => {
    await store.createRun(makeRun({ runId: "run-fail-1" }));
    await store.claimRun({ runId: "run-fail-1", startedAt: "2026-06-03T18:01:00.000Z" });
    const ok = await store.markFailed({ runId: "run-fail-1", endedAt: "2026-06-03T18:02:00.000Z", error: { code: "ERR", message: "boom" } });
    expect(ok).toBe(true);
    const run = await store.getRun("run-fail-1");
    expect(run.state).toBe("FAILED");
    expect(run.error).toEqual({ code: "ERR", message: "boom" });
  });

  it("transition updates using generic guarded UPDATE", async () => {
    await store.createRun(makeRun({ runId: "run-transition-1", state: "FAILED" }));
    const updated = await store.transition({
      runId: "run-transition-1",
      fromStates: ["FAILED"],
      set: { state: "QUEUED", attempt: 2, error: null, status: { phase: "queued", message: "retry" } }
    });
    expect(updated).not.toBeNull();
    expect(updated.state).toBe("QUEUED");
    expect(updated.attempt).toBe(2);
  });

  it("transition returns null if state not in fromStates", async () => {
    const result = await store.transition({
      runId: "run-transition-1",
      fromStates: ["FAILED"],
      set: { state: "RUNNING" }
    });
    expect(result).toBeNull();
  });

  it("listQueuedRunIds returns QUEUED run ids ordered by created_at", async () => {
    await store.createRun(makeRun({ runId: "run-queued-a", createdAt: "2026-06-03T17:00:00.000Z", updatedAt: "2026-06-03T17:00:00.000Z" }));
    await store.createRun(makeRun({ runId: "run-queued-b", createdAt: "2026-06-03T17:30:00.000Z", updatedAt: "2026-06-03T17:30:00.000Z" }));
    const ids = await store.listQueuedRunIds({ limit: 10 });
    expect(ids).toContain("run-queued-a");
    expect(ids).toContain("run-queued-b");
    expect(ids.indexOf("run-queued-a")).toBeLessThan(ids.indexOf("run-queued-b"));
  });

  it("recordRuntimeExecution updates while RUNNING", async () => {
    await store.createRun(makeRun({ runId: "run-record-1" }));
    await store.claimRun({ runId: "run-record-1", startedAt: "2026-06-03T18:01:00.000Z" });
    const ok = await store.recordRuntimeExecution({ runId: "run-record-1", runtimeExecution: { executionId: "exec-1", backend: "cloud-run-job" }, startedAt: "2026-06-03T18:01:00.000Z" });
    expect(ok).toBe(true);
    const run = await store.getRun("run-record-1");
    expect(run.runtimeExecution).toEqual({ executionId: "exec-1", backend: "cloud-run-job" });
  });

  describe("touchHeartbeat (AVL-1 residual — pull-worker heartbeat/cancel detection)", () => {
    it("updates heartbeat_at and returns RUNNING for a live owned run", async () => {
      await store.createRun(makeRun({ runId: "run-heartbeat-1" }));
      const { dispatchId } = await store.claimRun({ runId: "run-heartbeat-1", startedAt: "2026-06-05T09:00:00.000Z" });

      const state = await store.touchHeartbeat({ runId: "run-heartbeat-1", dispatchId, heartbeatAt: "2026-06-05T09:00:30.000Z" });

      expect(state).toBe("RUNNING");
      const run = await store.getRun("run-heartbeat-1");
      expect(run.heartbeatAt).toMatch(/^2026-06-05T09:00:30/);
    });

    it("returns CANCELLING when the run has been flipped to cancelling", async () => {
      await store.createRun(makeRun({ runId: "run-heartbeat-2" }));
      const { dispatchId } = await store.claimRun({ runId: "run-heartbeat-2", startedAt: "2026-06-05T09:00:00.000Z" });
      await store.transition({ runId: "run-heartbeat-2", fromStates: ["RUNNING"], set: { state: "CANCELLING" } });

      const state = await store.touchHeartbeat({ runId: "run-heartbeat-2", dispatchId, heartbeatAt: "2026-06-05T09:00:30.000Z" });

      expect(state).toBe("CANCELLING");
    });

    it("returns null when fenced against a stale dispatchId", async () => {
      await store.createRun(makeRun({ runId: "run-heartbeat-3" }));
      await store.claimRun({ runId: "run-heartbeat-3", startedAt: "2026-06-05T09:00:00.000Z" });

      const state = await store.touchHeartbeat({ runId: "run-heartbeat-3", dispatchId: "not-the-real-dispatch-id", heartbeatAt: "2026-06-05T09:00:30.000Z" });

      expect(state).toBeNull();
    });

    it("returns null for a run that has already completed", async () => {
      await store.createRun(makeRun({ runId: "run-heartbeat-4" }));
      const { dispatchId } = await store.claimRun({ runId: "run-heartbeat-4", startedAt: "2026-06-05T09:00:00.000Z" });
      await store.markSucceeded({ runId: "run-heartbeat-4", endedAt: "2026-06-05T09:01:00.000Z", result: {}, dispatchId });

      const state = await store.touchHeartbeat({ runId: "run-heartbeat-4", dispatchId, heartbeatAt: "2026-06-05T09:01:30.000Z" });

      expect(state).toBeNull();
    });
  });

  describe("dispatch_id fencing (COR-1)", () => {
    it("markSucceeded with the correct dispatchId succeeds", async () => {
      await store.createRun(makeRun({ runId: "run-fence-1" }));
      const { dispatchId } = await store.claimRun({ runId: "run-fence-1", startedAt: "2026-06-03T18:01:00.000Z" });
      const ok = await store.markSucceeded({ runId: "run-fence-1", endedAt: "2026-06-03T18:02:00.000Z", result: {}, dispatchId });
      expect(ok).toBe(true);
    });

    it("markSucceeded with a stale dispatchId is fenced out", async () => {
      await store.createRun(makeRun({ runId: "run-fence-2" }));
      await store.claimRun({ runId: "run-fence-2", startedAt: "2026-06-03T18:01:00.000Z" });
      const ok = await store.markSucceeded({ runId: "run-fence-2", endedAt: "2026-06-03T18:02:00.000Z", result: {}, dispatchId: "not-the-real-dispatch-id" });
      expect(ok).toBe(false);
      const run = await store.getRun("run-fence-2");
      expect(run.state).toBe("RUNNING");
    });

    it("markFailed with a stale dispatchId is fenced out", async () => {
      await store.createRun(makeRun({ runId: "run-fence-3" }));
      await store.claimRun({ runId: "run-fence-3", startedAt: "2026-06-03T18:01:00.000Z" });
      const ok = await store.markFailed({ runId: "run-fence-3", endedAt: "2026-06-03T18:02:00.000Z", error: { code: "ERR" }, dispatchId: "not-the-real-dispatch-id" });
      expect(ok).toBe(false);
    });

    it("recordRuntimeExecution with a stale dispatchId is fenced out", async () => {
      await store.createRun(makeRun({ runId: "run-fence-4" }));
      await store.claimRun({ runId: "run-fence-4", startedAt: "2026-06-03T18:01:00.000Z" });
      const ok = await store.recordRuntimeExecution({ runId: "run-fence-4", runtimeExecution: { backend: "x" }, startedAt: "2026-06-03T18:01:00.000Z", dispatchId: "not-the-real-dispatch-id" });
      expect(ok).toBe(false);
    });

    it("a ghost subprocess from a stale-marked, then retried, attempt cannot clobber the re-claimed run", async () => {
      // Simulates the exact COR-1 race: sweeper marks a still-alive run FAILED,
      // an operator retries it (fresh dispatch_id, back to QUEUED), it's
      // re-claimed (another fresh dispatch_id) -- and the original ghost
      // subprocess, still carrying the very first dispatch_id, finally
      // completes and must not be able to overwrite the new attempt.
      await store.createRun(makeRun({ runId: "run-ghost-1" }));
      const firstClaim = await store.claimRun({ runId: "run-ghost-1", startedAt: "2026-06-03T18:01:00.000Z" });

      // Sweeper force-fails the still-running attempt.
      await store.markFailed({ runId: "run-ghost-1", endedAt: "2026-06-03T18:05:00.000Z", error: { code: "STALE_RUNNING" } });

      // Operator retries: back to QUEUED (dispatch_id value here doesn't matter,
      // since claimRun always mints a fresh one on the next claim).
      await store.transition({ runId: "run-ghost-1", fromStates: ["FAILED"], set: { state: "QUEUED", attempt: 2 } });

      // Re-claimed: a new dispatch_id, distinct from the first claim's.
      const secondClaim = await store.claimRun({ runId: "run-ghost-1", startedAt: "2026-06-03T18:06:00.000Z" });
      expect(secondClaim.dispatchId).not.toBe(firstClaim.dispatchId);

      // The original ghost subprocess finally finishes, still carrying the
      // FIRST dispatch_id -- must be rejected, not silently accepted.
      const ghostSucceeded = await store.markSucceeded({
        runId: "run-ghost-1",
        endedAt: "2026-06-03T18:07:00.000Z",
        result: { fromGhost: true },
        dispatchId: firstClaim.dispatchId
      });
      expect(ghostSucceeded).toBe(false);

      const runAfterGhost = await store.getRun("run-ghost-1");
      expect(runAfterGhost.state).toBe("RUNNING");
      expect(runAfterGhost.result).toBeNull();

      // The real, currently-claimed attempt can still complete correctly.
      const realSucceeded = await store.markSucceeded({
        runId: "run-ghost-1",
        endedAt: "2026-06-03T18:08:00.000Z",
        result: { fromGhost: false },
        dispatchId: secondClaim.dispatchId
      });
      expect(realSucceeded).toBe(true);
      const finalRun = await store.getRun("run-ghost-1");
      expect(finalRun.state).toBe("SUCCEEDED");
      expect(finalRun.result).toEqual({ fromGhost: false });
    });
  });
});
