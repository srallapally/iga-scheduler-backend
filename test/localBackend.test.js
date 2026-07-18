import { mkdirSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
import { createLocalDb } from "../src/backends/local/db.js";
import { LocalRunStore } from "../src/backends/local/localRunStore.js";
import { LocalInstanceStore } from "../src/backends/local/localInstanceStore.js";
import { LocalDefinitionService } from "../src/backends/local/localDefinitionService.js";
import { LocalParameterResolver } from "../src/backends/local/localParameterResolver.js";
import { LocalPool } from "../src/backends/local/localPool.js";
import { SchedulerTickService } from "../src/services/schedulerTickService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return path.join(os.tmpdir(), `iga-local-test-${randomUUID()}`);
}

function makeDb(dir) {
  mkdirSync(dir, { recursive: true });
  return createLocalDb(dir);
}

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sampleRun(overrides = {}) {
  const now = isoNow();
  return {
    runId: `run-${randomUUID()}`,
    instanceId: "inst-1",
    definitionId: "def-1",
    scheduledFireTime: now,
    state: "QUEUED",
    attempt: 1,
    params: { key: "value" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function sampleInstance(overrides = {}) {
  const now = isoNow();
  return {
    instanceId: `inst-${randomUUID()}`,
    definitionId: "def-1",
    enabled: true,
    state: "ACTIVE",
    schedule: { expression: "0 * * * *" },
    nextFireAt: isoNow(60_000),
    parameters: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// LocalRunStore
// ---------------------------------------------------------------------------

describe("LocalRunStore", () => {
  let dir, db, store;

  beforeEach(() => {
    dir = tmpDir();
    db = makeDb(dir);
    store = new LocalRunStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  it("creates and retrieves a run (round-trip)", async () => {
    const run = sampleRun({ params: { x: 1 }, status: { phase: "queued" } });
    const { created } = await store.createRun(run);
    expect(created).toBe(true);
    const fetched = await store.getRun(run.runId);
    expect(fetched.runId).toBe(run.runId);
    expect(fetched.state).toBe("QUEUED");
    expect(fetched.params).toEqual({ x: 1 });
    expect(fetched.status).toEqual({ phase: "queued" });
  });

  it("createRun ON CONFLICT returns created:false for duplicate runId", async () => {
    const run = sampleRun();
    await store.createRun(run);
    const { created } = await store.createRun(run);
    expect(created).toBe(false);
  });

  it("getRun returns null for unknown runId", async () => {
    expect(await store.getRun("nonexistent")).toBeNull();
  });

  it("claimRun transitions QUEUED → RUNNING and returns claimed:true", async () => {
    const run = sampleRun();
    await store.createRun(run);
    const startedAt = isoNow();
    const result = await store.claimRun({ runId: run.runId, startedAt });
    expect(result.claimed).toBe(true);
    const fetched = await store.getRun(run.runId);
    expect(fetched.state).toBe("RUNNING");
    expect(fetched.startedAt).toBe(startedAt);
  });

  it("claimRun second call on same run returns claimed:false", async () => {
    const run = sampleRun();
    await store.createRun(run);
    await store.claimRun({ runId: run.runId, startedAt: isoNow() });
    const result = await store.claimRun({ runId: run.runId, startedAt: isoNow() });
    expect(result.claimed).toBe(false);
  });

  it("claimRun on missing run returns claimed:false, missing:true", async () => {
    const result = await store.claimRun({ runId: "ghost", startedAt: isoNow() });
    expect(result.claimed).toBe(false);
    expect(result.missing).toBe(true);
  });

  it("markSucceeded transitions RUNNING → SUCCEEDED", async () => {
    const run = sampleRun();
    await store.createRun(run);
    await store.claimRun({ runId: run.runId, startedAt: isoNow() });
    const endedAt = isoNow();
    const ok = await store.markSucceeded({ runId: run.runId, endedAt, result: { code: 0 } });
    expect(ok).toBe(true);
    const fetched = await store.getRun(run.runId);
    expect(fetched.state).toBe("SUCCEEDED");
    expect(fetched.result).toEqual({ code: 0 });
  });

  it("markFailed transitions RUNNING → FAILED", async () => {
    const run = sampleRun();
    await store.createRun(run);
    await store.claimRun({ runId: run.runId, startedAt: isoNow() });
    const ok = await store.markFailed({ runId: run.runId, endedAt: isoNow(), error: { message: "oops" } });
    expect(ok).toBe(true);
    const fetched = await store.getRun(run.runId);
    expect(fetched.state).toBe("FAILED");
    expect(fetched.error).toEqual({ message: "oops" });
  });

  it("listQueuedRunIds returns only QUEUED runs in created_at order", async () => {
    const r1 = sampleRun({ createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const r2 = sampleRun({ createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" });
    await store.createRun(r1);
    await store.createRun(r2);
    await store.claimRun({ runId: r1.runId, startedAt: isoNow() }); // r1 → RUNNING
    const ids = await store.listQueuedRunIds({ limit: 10 });
    expect(ids).toEqual([r2.runId]);
  });

  it("listRunsForInstance without state filter returns all runs for the instance", async () => {
    const r1 = sampleRun({ instanceId: "inst-A", state: "QUEUED" });
    const r2 = sampleRun({ instanceId: "inst-A", state: "QUEUED" });
    const r3 = sampleRun({ instanceId: "inst-B", state: "QUEUED" });
    await store.createRun(r1);
    await store.createRun(r2);
    await store.createRun(r3);
    const runs = await store.listRunsForInstance({ instanceId: "inst-A" });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.runId)).toContain(r1.runId);
    expect(runs.map((r) => r.runId)).toContain(r2.runId);
  });

  it("listRunsForInstance with state filter returns only matching runs", async () => {
    const queued = sampleRun({ instanceId: "inst-A", state: "QUEUED" });
    await store.createRun(queued);
    await store.claimRun({ runId: queued.runId, startedAt: isoNow() });
    const failed = sampleRun({ instanceId: "inst-A", state: "QUEUED" });
    await store.createRun(failed);
    await store.claimRun({ runId: failed.runId, startedAt: isoNow() });
    await store.markFailed({ runId: failed.runId, endedAt: isoNow() });
    const failedRuns = await store.listRunsForInstance({ instanceId: "inst-A", state: "FAILED" });
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0].runId).toBe(failed.runId);
  });
});

// ---------------------------------------------------------------------------
// LocalInstanceStore
// ---------------------------------------------------------------------------

describe("LocalInstanceStore", () => {
  let dir, db, store;

  beforeEach(() => {
    dir = tmpDir();
    db = makeDb(dir);
    store = new LocalInstanceStore({ db });
  });

  afterEach(() => {
    db.close();
  });

  it("creates and retrieves an instance (round-trip)", async () => {
    const inst = sampleInstance({ parameters: { env: "test" } });
    const created = await store.createInstance(inst);
    expect(created.instanceId).toBe(inst.instanceId);
    const fetched = await store.getInstance(inst.instanceId);
    expect(fetched.instanceId).toBe(inst.instanceId);
    expect(fetched.enabled).toBe(true);
    expect(fetched.parameters).toEqual({ env: "test" });
  });

  it("createInstance throws 409 for duplicate instanceId", async () => {
    const inst = sampleInstance();
    await store.createInstance(inst);
    await expect(store.createInstance(inst)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("getInstance returns null for unknown instanceId", async () => {
    expect(await store.getInstance("ghost")).toBeNull();
  });

  it("updateInstance persists changes", async () => {
    const inst = sampleInstance();
    await store.createInstance(inst);
    const updated = await store.updateInstance(inst.instanceId, { ...inst, enabled: false, updatedAt: isoNow() });
    expect(updated.enabled).toBe(false);
    const fetched = await store.getInstance(inst.instanceId);
    expect(fetched.enabled).toBe(false);
  });

  it("updateInstance throws 404 for missing instance", async () => {
    await expect(store.updateInstance("ghost", sampleInstance({ instanceId: "ghost" }))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("listInstancesForDefinition returns all instances for a definition", async () => {
    const i1 = sampleInstance({ definitionId: "def-A" });
    const i2 = sampleInstance({ definitionId: "def-A" });
    const i3 = sampleInstance({ definitionId: "def-B" });
    await store.createInstance(i1);
    await store.createInstance(i2);
    await store.createInstance(i3);
    const items = await store.listInstancesForDefinition("def-A");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.instanceId)).toContain(i1.instanceId);
  });

  it("listInstancesForDefinition returns empty array when none exist", async () => {
    expect(await store.listInstancesForDefinition("missing-def")).toEqual([]);
  });

  it("claimDueInstances only returns instances where next_fire_at <= now", async () => {
    const past = sampleInstance({ nextFireAt: isoNow(-60_000) });
    const future = sampleInstance({ nextFireAt: isoNow(60_000) });
    await store.createInstance(past);
    await store.createInstance(future);
    const now = isoNow();
    const claimed = await store.claimDueInstances(null, { nowIso: now, batchSize: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].instanceId).toBe(past.instanceId);
  });

  it("advanceInstance updates next_fire_at and last_fire_at", async () => {
    const inst = sampleInstance({ nextFireAt: isoNow(-60_000) });
    await store.createInstance(inst);
    const newNext = isoNow(3600_000);
    const newLast = isoNow();
    await store.advanceInstance(null, {
      instanceId: inst.instanceId,
      lastFireAt: newLast,
      nextFireAt: newNext,
      nowIso: newLast
    });
    const fetched = await store.getInstance(inst.instanceId);
    expect(fetched.nextFireAt).toBe(newNext);
    expect(fetched.lastFireAt).toBe(newLast);
  });
});

// ---------------------------------------------------------------------------
// LocalDefinitionService
// ---------------------------------------------------------------------------

describe("LocalDefinitionService", () => {
  let dir, db, service;

  beforeEach(() => {
    dir = tmpDir();
    db = makeDb(dir);
    service = new LocalDefinitionService({ db, dataDir: dir });
  });

  afterEach(() => {
    db.close();
  });

  const VALID_METADATA = {
    definitionId: "def-test",
    name: "Test Definition",
    runtime: "javascript",
    runtimeVersion: "22",
    wrapperVersion: "1.0.0",
    entrypoint: "index.js"
  };

  async function makeMinimalZip({ entrypoint = "index.js", runtime = "javascript", wrapperVersion = "1.0.0" } = {}) {
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "iga-zip-src-"));
    const zipPath = path.join(os.tmpdir(), `iga-test-${randomUUID()}.zip`);
    try {
      await fs.writeFile(path.join(srcDir, "manifest.json"), JSON.stringify({ entrypoint, runtime, wrapperVersion }));
      await fs.writeFile(path.join(srcDir, entrypoint), "// entry");
      await execFileAsync("zip", ["-qry", zipPath, "."], { cwd: srcDir });
      return await fs.readFile(zipPath);
    } finally {
      await fs.rm(srcDir, { recursive: true, force: true });
      await fs.rm(zipPath, { force: true });
    }
  }

  it("createDefinition writes artifact to disk and stores metadata in SQLite", async () => {
    const artifact = await makeMinimalZip();
    const doc = await service.createDefinition({ metadata: VALID_METADATA, artifactBuffer: artifact });
    expect(doc.definitionId).toBe("def-test");
    expect(doc.state).toBe("ACTIVE");
    expect(doc.jobZip.uri).toMatch(/^local:\/\//);
    // Artifact file must exist on disk
    const { existsSync } = await import("fs");
    expect(existsSync(doc.jobZip.uri.slice("local://".length))).toBe(true);
  });

  it("getDefinition returns the stored definition", async () => {
    const artifact = await makeMinimalZip();
    await service.createDefinition({ metadata: { ...VALID_METADATA, definitionId: "def-get" }, artifactBuffer: artifact });
    const def = await service.getDefinition("def-get");
    expect(def).not.toBeNull();
    expect(def.definitionId).toBe("def-get");
  });

  it("getDefinition returns null for unknown definitionId", async () => {
    expect(await service.getDefinition("ghost")).toBeNull();
  });

  it("patchDefinition merges fields", async () => {
    const artifact = await makeMinimalZip();
    await service.createDefinition({ metadata: { ...VALID_METADATA, definitionId: "def-patch" }, artifactBuffer: artifact });
    const patched = await service.patchDefinition("def-patch", { enabled: false });
    expect(patched.enabled).toBe(false);
  });

  it("deleteDefinition soft-deletes the definition", async () => {
    const artifact = await makeMinimalZip();
    await service.createDefinition({ metadata: { ...VALID_METADATA, definitionId: "def-del" }, artifactBuffer: artifact });
    await service.deleteDefinition("def-del");
    const items = await service.listDefinitions();
    expect(items.find((d) => d.definitionId === "def-del")).toBeUndefined();
    const all = await service.listDefinitions({ includeDeleted: true });
    const found = all.find((d) => d.definitionId === "def-del");
    expect(found.state).toBe("DELETED");
  });
});

// ---------------------------------------------------------------------------
// LocalParameterResolver
// ---------------------------------------------------------------------------

describe("LocalParameterResolver", () => {
  it("passes through string parameters unchanged", async () => {
    const { LocalParameterResolver: R } = await import("../src/backends/local/localParameterResolver.js");
    const resolver = new R();
    const resolved = await resolver.resolveParameters({ name: "Alice", count: 3 });
    expect(resolved).toEqual({ name: "Alice", count: 3 });
  });

  it("resolves sensitive params from LOCAL_SECRET_* env vars", async () => {
    const { LocalParameterResolver: R } = await import("../src/backends/local/localParameterResolver.js");
    process.env.LOCAL_SECRET_API_KEY = "secret-value";
    try {
      const resolver = new R();
      const resolved = await resolver.resolveParameters({ api_key: { type: "sensitive", secretRef: "my-secret" } });
      expect(resolved.api_key).toBe("secret-value");
    } finally {
      delete process.env.LOCAL_SECRET_API_KEY;
    }
  });

  it("falls back to secretRef when env var is absent", async () => {
    const { LocalParameterResolver: R } = await import("../src/backends/local/localParameterResolver.js");
    delete process.env.LOCAL_SECRET_TOKEN;
    const resolver = new R();
    const resolved = await resolver.resolveParameters({ token: { type: "sensitive", secretRef: "fallback-ref" } });
    expect(resolved.token).toBe("fallback-ref");
  });

  it("handles empty/null params gracefully", async () => {
    const { LocalParameterResolver: R } = await import("../src/backends/local/localParameterResolver.js");
    const resolver = new R();
    expect(await resolver.resolveParameters(null)).toEqual({});
    expect(await resolver.resolveParameters({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// LocalPool + SchedulerTickService integration
// ---------------------------------------------------------------------------

describe("LocalPool + SchedulerTickService tick integration", () => {
  let dir, db, pool, runStore, instanceStore, tickService;

  beforeEach(() => {
    dir = tmpDir();
    db = makeDb(dir);
    pool = new LocalPool(db);
    runStore = new LocalRunStore({ db });
    instanceStore = new LocalInstanceStore({ db });
    tickService = new SchedulerTickService({ instanceStore, runStore, pool });
  });

  afterEach(() => {
    db.close();
  });

  it("tick() creates a run and advances the instance, exercising the full BEGIN/SAVEPOINT/COMMIT path", async () => {
    const now = new Date();
    const pastFireAt = new Date(now.getTime() - 60_000).toISOString();
    const inst = sampleInstance({
      instanceId: "tick-inst",
      definitionId: "tick-def",
      nextFireAt: pastFireAt,
      schedule: { expression: "0 * * * *" }
    });
    await instanceStore.createInstance(inst);

    const nowFn = () => now;
    const svc = new SchedulerTickService({ instanceStore, runStore, pool, now: nowFn });
    const summary = await svc.tick();

    expect(summary.checked).toBe(1);
    expect(summary.createdRuns).toBe(1);
    expect(summary.advanced).toBe(1);
    expect(summary.failed).toBe(0);

    // Run was created
    const runIds = await runStore.listQueuedRunIds({ limit: 10 });
    expect(runIds).toHaveLength(1);

    // Instance was advanced (next_fire_at moved forward)
    const advanced = await instanceStore.getInstance("tick-inst");
    expect(advanced.nextFireAt).not.toBe(pastFireAt);
  });

  it("tick() with dryRun:true does not write any runs or advance instances", async () => {
    const pastFireAt = isoNow(-60_000);
    const inst = sampleInstance({ instanceId: "dry-inst", nextFireAt: pastFireAt });
    await instanceStore.createInstance(inst);

    const summary = await tickService.tick({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.checked).toBe(1);
    expect(summary.createdRuns).toBe(0);

    const runIds = await runStore.listQueuedRunIds({ limit: 10 });
    expect(runIds).toHaveLength(0);

    const inst2 = await instanceStore.getInstance("dry-inst");
    expect(inst2.nextFireAt).toBe(pastFireAt);
  });
});
