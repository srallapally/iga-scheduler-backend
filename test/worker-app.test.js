import { describe, expect, it } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/workers/workerApp.js";

describe("GET /health", () => {
  it("returns 200 without auth", async () => {
    const app = createWorkerApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /execute (removed, AVL-1 residual — pull-worker)", () => {
  it("404s: dispatch is pull-based now, not pushed over HTTP", async () => {
    const app = createWorkerApp();
    const res = await request(app).post("/execute").send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /cancel/:runId (removed, AVL-1 residual — pull-worker)", () => {
  it("404s: cancellation is pull-based now, not pushed over HTTP", async () => {
    const app = createWorkerApp();
    const res = await request(app).post("/cancel/run-1");
    expect(res.status).toBe(404);
  });
});

describe("drain", () => {
  it("resolves immediately when no active executions", async () => {
    const app = createWorkerApp();
    await expect(app.drain()).resolves.toBeUndefined();
  });

  it("waits for active executions to finish", async () => {
    const app = createWorkerApp();
    let resolveExecution;
    const promise = new Promise((resolve) => { resolveExecution = resolve; });
    app.activeExecutions.add(promise);
    expect(app.activeExecutions.size).toBe(1);

    const drainPromise = app.drain();
    resolveExecution();
    await drainPromise;
  });

  it("resolves after maxDrainMs even if executions are still running", async () => {
    const app = createWorkerApp({ maxDrainMs: 50 });
    app.activeExecutions.add(new Promise(() => {}));
    const start = Date.now();
    await app.drain();
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
