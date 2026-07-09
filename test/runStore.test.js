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

  it("claimRun transitions QUEUED→RUNNING atomically", async () => {
    const result = await store.claimRun({ runId: "run-integration-1", startedAt: "2026-06-03T18:01:00.000Z" });
    expect(result).toEqual({ claimed: true });
    const run = await store.getRun("run-integration-1");
    expect(run.state).toBe("RUNNING");
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
});
