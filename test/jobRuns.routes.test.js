import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createJobRunRouter, createInstanceRunRouter } from "../src/routes/jobRuns.js";
import { createPublicAuthMiddleware } from "../src/middleware/publicAuth.js";

const AUTH_OPTS = {
  issuer: "https://auth.example.test",
  audience: "https://scheduler.example.test",
  verifyToken: vi.fn(async () => ({ sub: "client-1" }))
};

function sampleRun(overrides = {}) {
  return {
    runId: "run-1",
    tenantId: null,
    instanceId: "inst-1",
    definitionId: "def-1",
    definitionVersion: "1",
    scheduledFireTime: "2026-07-01T00:00:00.000Z",
    state: "SUCCEEDED",
    attempt: 1,
    dispatchId: null,
    params: {},
    status: null,
    result: null,
    error: null,
    runtimeExecution: { jobName: "projects/p/jobs/j", executionName: "e", generation: 1 },
    parentRunId: null,
    redriveOfRunId: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    startedAt: "2026-07-01T00:00:01.000Z",
    endedAt: "2026-07-01T00:00:05.000Z",
    heartbeatAt: "2026-07-01T00:00:05.000Z",
    updatedAt: "2026-07-01T00:00:05.000Z",
    ...overrides
  };
}

function createRunApp(runStore) {
  const app = express();
  const auth = createPublicAuthMiddleware(AUTH_OPTS);
  app.use("/job-runs", auth, createJobRunRouter({ runStore }));
  return app;
}

function createInstanceRunApp(runStore) {
  const app = express();
  const auth = createPublicAuthMiddleware(AUTH_OPTS);
  app.use("/job-instances", auth, createInstanceRunRouter({ runStore }));
  return app;
}

describe("GET /job-runs/:runId", () => {
  it("returns 401 without auth", async () => {
    const app = createRunApp({ getRun: vi.fn() });
    const res = await request(app).get("/job-runs/run-1");
    expect(res.status).toBe(401);
  });

  it("returns the run document without runtimeExecution", async () => {
    const run = sampleRun();
    const runStore = { getRun: vi.fn(async () => run) };
    const app = createRunApp(runStore);
    const res = await request(app).get("/job-runs/run-1").set("authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe("run-1");
    expect(res.body.runtimeExecution).toBeUndefined();
    expect(runStore.getRun).toHaveBeenCalledWith("run-1");
  });

  it("returns 404 when run does not exist", async () => {
    const runStore = { getRun: vi.fn(async () => null) };
    const app = createRunApp(runStore);
    const res = await request(app).get("/job-runs/missing").set("authorization", "Bearer t");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("run not found");
  });
});

describe("GET /job-instances/:instanceId/runs", () => {
  it("returns 401 without auth", async () => {
    const app = createInstanceRunApp({ listRunsForInstance: vi.fn() });
    const res = await request(app).get("/job-instances/inst-1/runs");
    expect(res.status).toBe(401);
  });

  it("returns items list without runtimeExecution", async () => {
    const runs = [sampleRun(), sampleRun({ runId: "run-2" })];
    const runStore = { listRunsForInstance: vi.fn(async () => runs) };
    const app = createInstanceRunApp(runStore);
    const res = await request(app).get("/job-instances/inst-1/runs").set("authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].runtimeExecution).toBeUndefined();
    expect(runStore.listRunsForInstance).toHaveBeenCalledWith({ instanceId: "inst-1", limit: 50, state: undefined });
  });

  it("returns empty list when no runs exist", async () => {
    const runStore = { listRunsForInstance: vi.fn(async () => []) };
    const app = createInstanceRunApp(runStore);
    const res = await request(app).get("/job-instances/inst-1/runs").set("authorization", "Bearer t");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("passes limit and state query params to store", async () => {
    const runStore = { listRunsForInstance: vi.fn(async () => []) };
    const app = createInstanceRunApp(runStore);
    await request(app).get("/job-instances/inst-1/runs?limit=10&state=FAILED").set("authorization", "Bearer t");
    expect(runStore.listRunsForInstance).toHaveBeenCalledWith({ instanceId: "inst-1", limit: 10, state: "FAILED" });
  });
});
