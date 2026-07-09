import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SchedulerTickService } from "../src/services/schedulerTickService.js";
import { InstanceStore } from "../src/stores/instanceStore.js";
import { RunStore } from "../src/stores/runStore.js";
import { applyMigrations, createTestPool, pgAvailable, revertMigrations } from "./helpers/pg.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function dueInstance(overrides = {}) {
  return {
    instanceId: "risk-score-prod-hourly",
    definitionId: "risk-score",
    definitionVersion: 1,
    enabled: true,
    state: "ACTIVE",
    nextFireAt: "2026-06-03T18:00:00.000Z",
    schedule: { type: "cron", expression: "*/15 * * * *", timezone: "UTC" },
    parameters: { scanType: { type: "string", value: "FULL" } },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Unit tests — stub-backed, no PG required
// ---------------------------------------------------------------------------

function makeStubPool() {
  // minimal pool stub: connect() returns a fake client
  const client = {
    _queries: [],
    query: vi.fn(async (sql) => { client._queries.push(sql); return { rows: [], rowCount: 0 }; }),
    release: vi.fn()
  };
  return {
    client,
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 }))
  };
}

function makeInstanceStore(instances = []) {
  return {
    claimDueInstances: vi.fn(async () => instances),
    advanceInstance: vi.fn(async () => {})
  };
}

function makeRunStore(createResult = { created: true }) {
  return {
    createRunTx: vi.fn(async () => createResult)
  };
}

describe("SchedulerTickService (unit)", () => {
  it("requires instanceStore, runStore, and pool", () => {
    expect(() => new SchedulerTickService({})).toThrow("instanceStore is required");
    const instanceStore = makeInstanceStore();
    expect(() => new SchedulerTickService({ instanceStore })).toThrow("runStore is required");
    const runStore = makeRunStore();
    expect(() => new SchedulerTickService({ instanceStore, runStore })).toThrow("pool is required");
  });

  it("dryRun returns checked count with no writes", async () => {
    const pool = makeStubPool();
    const instanceStore = makeInstanceStore([dueInstance()]);
    const runStore = makeRunStore();
    const service = new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick({ dryRun: true });

    expect(result).toMatchObject({ status: "ok", checked: 1, createdRuns: 0, duplicates: 0, enqueued: 0, advanced: 0, failed: 0, dryRun: true, enqueue: false });
    expect(instanceStore.claimDueInstances).toHaveBeenCalledWith(pool, expect.objectContaining({ forUpdate: false }));
    expect(runStore.createRunTx).not.toHaveBeenCalled();
    expect(instanceStore.advanceInstance).not.toHaveBeenCalled();
  });

  it("creates run, advances instance, and returns correct summary", async () => {
    const pool = makeStubPool();
    const instanceStore = makeInstanceStore([dueInstance()]);
    const runStore = makeRunStore({ created: true });
    const service = new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result).toMatchObject({ status: "ok", checked: 1, createdRuns: 1, duplicates: 0, advanced: 1, failed: 0, enqueued: 0, enqueue: false });
    expect(runStore.createRunTx).toHaveBeenCalledOnce();
    expect(instanceStore.advanceInstance).toHaveBeenCalledOnce();
    // verify the run document shape
    const [, runDoc] = runStore.createRunTx.mock.calls[0];
    expect(runDoc.instanceId).toBe("risk-score-prod-hourly");
    expect(runDoc.scheduledFireTime).toBe("2026-06-03T18:00:00.000Z");
    expect(runDoc.state).toBe("QUEUED");
    expect(runDoc.attempt).toBe(1);
    expect(runDoc.createdAt).toBe("2026-06-03T18:01:00.000Z");
    // verify nextFireAt advancement
    const advanceArgs = instanceStore.advanceInstance.mock.calls[0][1];
    expect(advanceArgs.lastFireAt).toBe("2026-06-03T18:00:00.000Z");
    expect(advanceArgs.nextFireAt).toBe("2026-06-03T18:15:00.000Z");
  });

  it("counts duplicate run (ON CONFLICT) as duplicate++, advanced++ (still advances)", async () => {
    const pool = makeStubPool();
    const instanceStore = makeInstanceStore([dueInstance()]);
    const runStore = makeRunStore({ created: false });
    const service = new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result.createdRuns).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.advanced).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("per-instance cron parse error increments failed and continues other instances", async () => {
    const badInstance = dueInstance({ instanceId: "bad-inst", schedule: { expression: "NOT_A_CRON" } });
    const goodInstance = dueInstance({ instanceId: "good-inst" });
    const pool = makeStubPool();
    const instanceStore = makeInstanceStore([badInstance, goodInstance]);
    const runStore = makeRunStore({ created: true });
    const service = new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();

    expect(result.failed).toBe(1);
    expect(result.createdRuns).toBe(1);
    expect(result.advanced).toBe(1);
    expect(result.checked).toBe(2);
  });

  it("summary always includes enqueued:0 and enqueue:false for response compatibility", async () => {
    const pool = makeStubPool();
    const instanceStore = makeInstanceStore([]);
    const runStore = makeRunStore();
    const service = new SchedulerTickService({ instanceStore, runStore, pool });
    const result = await service.tick();
    expect(result.enqueued).toBe(0);
    expect(result.enqueue).toBe(false);
  });

  it("supports legacy schedule.cron field", async () => {
    const pool = makeStubPool();
    const instance = dueInstance({ schedule: { cron: "*/15 * * * *", timezone: "UTC" } });
    const instanceStore = makeInstanceStore([instance]);
    const runStore = makeRunStore({ created: true });
    const service = new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date("2026-06-03T18:01:00.000Z")
    });

    const result = await service.tick();
    expect(result.advanced).toBe(1);
    const advanceArgs = instanceStore.advanceInstance.mock.calls[0][1];
    expect(advanceArgs.nextFireAt).toBe("2026-06-03T18:15:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require TEST_DATABASE_URL
// ---------------------------------------------------------------------------

const SKIP = !pgAvailable();

describe.skipIf(SKIP)("SchedulerTickService (integration)", () => {
  let pool;
  let instanceStore;
  let runStore;

  beforeAll(async () => {
    pool = await createTestPool();
    await applyMigrations(pool);
    instanceStore = new InstanceStore({ pool });
    runStore = new RunStore({ pool });
  });

  afterAll(async () => {
    await revertMigrations(pool);
    await pool.end();
  });

  function makeInstance(id, overrides = {}) {
    const now = new Date().toISOString();
    return {
      instanceId: id,
      tenantId: null,
      definitionId: "risk-score",
      definitionVersion: 1,
      definitionParameterSchema: [],
      enabled: true,
      state: "ACTIVE",
      schedule: { type: "cron", expression: "*/15 * * * *", timezone: "UTC" },
      nextFireAt: "2026-01-01T00:00:00.000Z",
      lastFireAt: null,
      parameters: {},
      createdAt: now,
      updatedAt: now,
      ...overrides
    };
  }

  it("two concurrent tick() calls over the same due instances create each run exactly once and advance each instance exactly once", async () => {
    await instanceStore.createInstance(makeInstance("tick-conc-1"));
    await instanceStore.createInstance(makeInstance("tick-conc-2"));

    const nowIso = "2026-06-03T18:01:00.000Z";
    const makeService = () => new SchedulerTickService({
      instanceStore, runStore, pool,
      now: () => new Date(nowIso),
      batchSize: 10
    });

    const [r1, r2] = await Promise.all([makeService().tick(), makeService().tick()]);

    const total = { createdRuns: r1.createdRuns + r2.createdRuns, duplicates: r1.duplicates + r2.duplicates, advanced: r1.advanced + r2.advanced };

    // Together they see 2 instances, create 2 runs, advance 2 instances (one set per winner)
    expect(total.createdRuns).toBe(2);
    expect(total.duplicates).toBe(0);
    expect(total.advanced).toBe(2);

    // Confirm runs exist
    const runA = await runStore.getRun("tick-conc-1:2026-01-01T00:00:00.000Z");
    const runB = await runStore.getRun("tick-conc-2:2026-01-01T00:00:00.000Z");
    expect(runA?.state).toBe("QUEUED");
    expect(runB?.state).toBe("QUEUED");

    // nextFireAt advanced
    const instA = await instanceStore.getInstance("tick-conc-1");
    const instB = await instanceStore.getInstance("tick-conc-2");
    expect(instA.nextFireAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(instB.nextFireAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});
