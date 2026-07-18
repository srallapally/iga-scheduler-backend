import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createInternalRuntimeIgaRouter } from "../src/routes/internalRuntimeIga.js";

function allowRuntimeAuth(req, _res, next) {
  req.internalAuth = { principal: "scheduler-worker@iga-scheduler.iam.gserviceaccount.com" };
  next();
}

function createTestApp(service, authMiddleware = allowRuntimeAuth) {
  const app = express();
  app.use(express.json());
  app.use("/internal/runtime/iga", createInternalRuntimeIgaRouter({ service, authMiddleware }));
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  });
  return app;
}

describe("internal runtime IGA route", () => {
  it("forwards runtime IGA requests to the proxy service", async () => {
    const service = {
      request: vi.fn(async () => ({ ok: true, method: "GET", path: "/iga/governance/applications", result: { items: [] } }))
    };

    const response = await request(createTestApp(service))
      .post("/internal/runtime/iga/request")
      .send({ runId: "run-1", dispatchId: "dispatch-abc", method: "GET", path: "/iga/governance/applications" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, method: "GET", path: "/iga/governance/applications", result: { items: [] } });
    expect(service.request).toHaveBeenCalledWith({
      runId: "run-1",
      dispatchId: "dispatch-abc",
      method: "GET",
      path: "/iga/governance/applications",
      body: undefined,
      principal: "scheduler-worker@iga-scheduler.iam.gserviceaccount.com"
    });
  });

  it("rejects anonymous runtime IGA requests when auth middleware denies", async () => {
    const service = { request: vi.fn() };
    const authMiddleware = (_req, res) => res.status(401).json({ error: "missing bearer token" });

    const response = await request(createTestApp(service, authMiddleware))
      .post("/internal/runtime/iga/request")
      .send({ runId: "run-1", method: "GET", path: "/iga/governance/applications" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "missing bearer token" });
    expect(service.request).not.toHaveBeenCalled();
  });

  it("returns proxy validation errors", async () => {
    const error = new Error("path must start with /");
    error.code = "IGA_PATH_INVALID";
    error.statusCode = 400;
    const service = { request: vi.fn(async () => { throw error; }) };

    const response = await request(createTestApp(service))
      .post("/internal/runtime/iga/request")
      .send({ runId: "run-1", method: "GET", path: "bad" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "path must start with /", code: "IGA_PATH_INVALID" });
  });
});
