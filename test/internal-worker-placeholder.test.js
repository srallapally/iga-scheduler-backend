import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createInternalWorkerRouter } from "../src/routes/internalWorker.js";

function allowAuth(_req, _res, next) { next(); }
function createTestApp(options = {}) { const app = express(); app.use(express.json()); app.use("/internal/job-runs", createInternalWorkerRouter({ runControlService: options.runControlService, authMiddleware: options.authMiddleware || allowAuth })); return app; }

describe("internal worker route", () => {
  it("rejects anonymous requests when auth middleware denies", async () => { const runControlService = { retryRun: vi.fn() }; const authMiddleware = (_req, res) => res.status(401).json({ error: "missing bearer token" }); const response = await request(createTestApp({ runControlService, authMiddleware })).post("/internal/job-runs/run-1/retry").send({}); expect(response.status).toBe(401); expect(response.body).toEqual({ error: "missing bearer token" }); expect(runControlService.retryRun).not.toHaveBeenCalled(); });

  it("no longer exposes /execute (AVL-1 residual: dispatch is pull-based, not pushed)", async () => { const response = await request(createTestApp()).post("/internal/job-runs/run-1/execute").send({}); expect(response.status).toBe(404); });

  it("routes retry requests to run control service", async () => { const runControlService = { retryRun: vi.fn(async () => ({ status: "queued", action: "retry", runId: "run-1", state: "QUEUED", attempt: 2, enqueued: false })) }; const response = await request(createTestApp({ runControlService })).post("/internal/job-runs/run-1/retry").send({ enqueue: false }); expect(response.status).toBe(202); expect(response.body).toEqual({ status: "queued", action: "retry", runId: "run-1", state: "QUEUED", attempt: 2, enqueued: false }); expect(runControlService.retryRun).toHaveBeenCalledWith({ runId: "run-1", enqueue: false }); });
  it("routes cancel requests to run control service", async () => { const runControlService = { cancelRun: vi.fn(async () => ({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED" })) }; const response = await request(createTestApp({ runControlService })).post("/internal/job-runs/run-1/cancel").send({ reason: "operator requested" }); expect(response.status).toBe(202); expect(response.body).toEqual({ status: "cancelled", action: "cancel", runId: "run-1", state: "CANCELLED" }); expect(runControlService.cancelRun).toHaveBeenCalledWith({ runId: "run-1", reason: "operator requested" }); });
  it("routes re-drive requests to run control service", async () => { const runControlService = { redriveRun: vi.fn(async () => ({ status: "queued", action: "redrive", sourceRunId: "run-1", runId: "run-2", state: "QUEUED", attempt: 1, enqueued: true })) }; const response = await request(createTestApp({ runControlService })).post("/internal/job-runs/run-1/redrive").send({}); expect(response.status).toBe(202); expect(response.body).toEqual({ status: "queued", action: "redrive", sourceRunId: "run-1", runId: "run-2", state: "QUEUED", attempt: 1, enqueued: true }); expect(runControlService.redriveRun).toHaveBeenCalledWith({ runId: "run-1", enqueue: true }); });
  it("returns run control service transition errors", async () => { const error = new Error("run run-1 cannot be retried from state RUNNING"); error.statusCode = 409; const runControlService = { retryRun: vi.fn(async () => { throw error; }) }; const response = await request(createTestApp({ runControlService })).post("/internal/job-runs/run-1/retry").send({}); expect(response.status).toBe(409); expect(response.body).toEqual({ error: "run run-1 cannot be retried from state RUNNING" }); });

  it("no longer exposes /complete (SEC-3: removed forgeable completion route)", async () => { const response = await request(createTestApp()).post("/internal/job-runs/run-1/complete").send({}); expect(response.status).toBe(404); });
});
