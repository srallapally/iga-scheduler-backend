import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstanceStore } from "../src/stores/instanceStore.js";
import { applyMigrations, createTestPool, pgAvailable, revertMigrations } from "./helpers/pg.js";

const SKIP = !pgAvailable();

function baseInstance(overrides = {}) {
  const now = new Date().toISOString();
  return {
    instanceId: "risk-score-prod-hourly",
    tenantId: null,
    definitionId: "risk-score",
    definitionVersion: 1,
    definitionParameterSchema: [{ name: "scanType", type: "string", required: true }],
    enabled: true,
    state: "ACTIVE",
    schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
    nextFireAt: "2026-06-03T18:00:00.000Z",
    lastFireAt: null,
    parameters: { scanType: { type: "string", value: "FULL" } },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe.skipIf(SKIP)("InstanceStore integration", () => {
  let pool;
  let store;

  beforeAll(async () => {
    pool = await createTestPool();
    await applyMigrations(pool);
    store = new InstanceStore({ pool });
  });

  afterAll(async () => {
    await revertMigrations(pool);
    await pool.end();
  });

  it("creates and retrieves an instance (round-trip)", async () => {
    const doc = baseInstance();
    const created = await store.createInstance(doc);
    expect(created.instanceId).toBe("risk-score-prod-hourly");

    const fetched = await store.getInstance("risk-score-prod-hourly");
    expect(fetched.instanceId).toBe("risk-score-prod-hourly");
    expect(fetched.definitionId).toBe("risk-score");
    expect(fetched.definitionVersion).toBe(1);
    expect(fetched.definitionParameterSchema).toEqual([{ name: "scanType", type: "string", required: true }]);
    expect(fetched.enabled).toBe(true);
    expect(fetched.state).toBe("ACTIVE");
    expect(fetched.schedule).toEqual({ type: "cron", expression: "0 * * * *", timezone: "UTC" });
    expect(fetched.nextFireAt).toBe("2026-06-03T18:00:00.000Z");
    expect(fetched.lastFireAt).toBeNull();
    expect(fetched.parameters).toEqual({ scanType: { type: "string", value: "FULL" } });
  });

  it("throws statusCode 409 on duplicate createInstance", async () => {
    const doc = baseInstance({ instanceId: "dup-instance" });
    await store.createInstance(doc);
    await expect(store.createInstance(doc)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updateInstance persists changes", async () => {
    const doc = baseInstance({ instanceId: "updatable-instance" });
    await store.createInstance(doc);
    const updated = await store.updateInstance("updatable-instance", {
      ...doc,
      enabled: false,
      state: "PAUSED",
      updatedAt: new Date().toISOString()
    });
    expect(updated.enabled).toBe(false);
    expect(updated.state).toBe("PAUSED");
  });

  it("updateInstance throws statusCode 404 for missing instance", async () => {
    await expect(store.updateInstance("no-such-instance", baseInstance({ instanceId: "no-such-instance" }))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("getInstance returns null for missing instance", async () => {
    const result = await store.getInstance("does-not-exist");
    expect(result).toBeNull();
  });

  it("listInstancesForDefinition returns all matching instances", async () => {
    const defId = "list-test-def";
    await store.createInstance(baseInstance({ instanceId: "list-inst-1", definitionId: defId }));
    await store.createInstance(baseInstance({ instanceId: "list-inst-2", definitionId: defId }));
    const items = await store.listInstancesForDefinition(defId);
    expect(items.length).toBe(2);
    expect(items.every((i) => i.definitionId === defId)).toBe(true);
  });

  it("listInstancesForDefinition returns empty array when no instances exist", async () => {
    const items = await store.listInstancesForDefinition("no-instances-def");
    expect(items).toEqual([]);
  });

  it("advanceInstance updates next_fire_at, last_fire_at, updated_at", async () => {
    const doc = baseInstance({ instanceId: "advance-test" });
    await store.createInstance(doc);
    const client = await pool.connect();
    try {
      const nowIso = new Date().toISOString();
      await store.advanceInstance(client, {
        instanceId: "advance-test",
        lastFireAt: "2026-06-03T18:00:00.000Z",
        nextFireAt: "2026-06-03T19:00:00.000Z",
        nowIso
      });
    } finally {
      client.release();
    }
    const fetched = await store.getInstance("advance-test");
    expect(fetched.lastFireAt).toBe("2026-06-03T18:00:00.000Z");
    expect(fetched.nextFireAt).toBe("2026-06-03T19:00:00.000Z");
  });

  it("claimDueInstances with SKIP LOCKED returns disjoint sets across two concurrent transactions", async () => {
    const now = new Date().toISOString();
    const defId = "concurrent-def";
    // insert 4 due instances
    for (let i = 1; i <= 4; i++) {
      await store.createInstance(baseInstance({
        instanceId: `concurrent-inst-${i}`,
        definitionId: defId,
        nextFireAt: "2026-01-01T00:00:00.000Z"
      }));
    }

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query("BEGIN");
      await clientB.query("BEGIN");

      const [setA, setB] = await Promise.all([
        store.claimDueInstances(clientA, { nowIso: now, batchSize: 4 }),
        store.claimDueInstances(clientB, { nowIso: now, batchSize: 4 })
      ]);

      const idsA = new Set(setA.map((i) => i.instanceId));
      const idsB = new Set(setB.map((i) => i.instanceId));
      const total = idsA.size + idsB.size;

      // disjoint and together cover all 4
      expect(total).toBe(4);
      for (const id of idsA) expect(idsB.has(id)).toBe(false);

      await clientA.query("ROLLBACK");
      await clientB.query("ROLLBACK");
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
