import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../src/workers/workerApp.js";

function makeExecutor(resolveWith = { status: "completed" }, delayMs = 0) {
  return {
    execute: vi.fn(() =>
      delayMs > 0
        ? new Promise((resolve) => setTimeout(() => resolve(resolveWith), delayMs))
        : Promise.resolve(resolveWith)
    )
  };
}

const noopAuth = (_req, _res, next) => next();

const VALID_BODY = {
  runId: "run-1",
  execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js" } },
  context: { runId: "run-1", params: {} }
};

describe("POST /execute", () => {
  it("returns 202 immediately", async () => {
    const executor = makeExecutor();
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    const res = await request(app).post("/execute").send(VALID_BODY);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "accepted", runId: "run-1" });
  });

  it("calls executor.execute with correct args", async () => {
    const executor = makeExecutor();
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    await request(app).post("/execute").send(VALID_BODY);
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      execution: VALID_BODY.execution,
      context: VALID_BODY.context
    }));
  });

  it("returns 400 when runId is missing", async () => {
    const app = createWorkerApp({ executor: makeExecutor(), authMiddleware: noopAuth });
    const res = await request(app).post("/execute").send({ execution: VALID_BODY.execution, context: {} });
    expect(res.status).toBe(400);
  });

  it("returns 400 when execution.definition is missing", async () => {
    const app = createWorkerApp({ executor: makeExecutor(), authMiddleware: noopAuth });
    const res = await request(app).post("/execute").send({ runId: "run-1", execution: {}, context: {} });
    expect(res.status).toBe(400);
  });

  it("returns 400 when context is missing", async () => {
    const app = createWorkerApp({ executor: makeExecutor(), authMiddleware: noopAuth });
    const res = await request(app).post("/execute").send({ runId: "run-1", execution: VALID_BODY.execution });
    expect(res.status).toBe(400);
  });

  it("does not crash the process when executor rejects", async () => {
    const executor = { execute: vi.fn(() => Promise.reject(new Error("boom"))) };
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    const res = await request(app).post("/execute").send(VALID_BODY);
    expect(res.status).toBe(202);
    // Give the background promise time to reject
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
  });

  it("calls onExecutionSuccess with runId and result when executor resolves", async () => {
    const result = { status: "completed", exitCode: 0 };
    const executor = makeExecutor(result);
    const onExecutionSuccess = vi.fn(async () => {});
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionSuccess });
    await request(app).post("/execute").send(VALID_BODY);
    await vi.waitFor(() => expect(onExecutionSuccess).toHaveBeenCalledOnce());
    expect(onExecutionSuccess).toHaveBeenCalledWith({ runId: "run-1", result });
  });

  it("does not crash when onExecutionSuccess itself throws", async () => {
    const executor = makeExecutor();
    const onExecutionSuccess = vi.fn(async () => { throw new Error("success callback failed"); });
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionSuccess });
    const res = await request(app).post("/execute").send(VALID_BODY);
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(onExecutionSuccess).toHaveBeenCalledOnce());
  });

  it("calls onExecutionError with runId and error when executor rejects", async () => {
    const err = new Error("execution boom");
    err.code = "RUNTIME_PROCESS_FAILED";
    const executor = { execute: vi.fn(() => Promise.reject(err)) };
    const onExecutionError = vi.fn(async () => {});
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionError });
    await request(app).post("/execute").send(VALID_BODY);
    await vi.waitFor(() => expect(onExecutionError).toHaveBeenCalledOnce());
    expect(onExecutionError).toHaveBeenCalledWith({ runId: "run-1", error: err });
  });

  it("threads dispatchId through to onExecutionSuccess (COR-1)", async () => {
    const result = { status: "completed", exitCode: 0 };
    const executor = makeExecutor(result);
    const onExecutionSuccess = vi.fn(async () => {});
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionSuccess });
    await request(app).post("/execute").send({ ...VALID_BODY, dispatchId: "dispatch-abc" });
    await vi.waitFor(() => expect(onExecutionSuccess).toHaveBeenCalledOnce());
    expect(onExecutionSuccess).toHaveBeenCalledWith({ runId: "run-1", dispatchId: "dispatch-abc", result });
  });

  it("threads dispatchId through to onExecutionError (COR-1)", async () => {
    const err = new Error("execution boom");
    const executor = { execute: vi.fn(() => Promise.reject(err)) };
    const onExecutionError = vi.fn(async () => {});
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionError });
    await request(app).post("/execute").send({ ...VALID_BODY, dispatchId: "dispatch-abc" });
    await vi.waitFor(() => expect(onExecutionError).toHaveBeenCalledOnce());
    expect(onExecutionError).toHaveBeenCalledWith({ runId: "run-1", dispatchId: "dispatch-abc", error: err });
  });

  it("does not crash when onExecutionError itself throws", async () => {
    const executor = { execute: vi.fn(() => Promise.reject(new Error("boom"))) };
    const onExecutionError = vi.fn(async () => { throw new Error("callback failed"); });
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, onExecutionError });
    const res = await request(app).post("/execute").send(VALID_BODY);
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(onExecutionError).toHaveBeenCalledOnce());
  });
});

describe("GET /health", () => {
  it("returns 200 without auth", async () => {
    const app = createWorkerApp({ executor: makeExecutor(), authMiddleware: noopAuth });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("drain", () => {
  it("resolves immediately when no active executions", async () => {
    const app = createWorkerApp({ executor: makeExecutor(), authMiddleware: noopAuth });
    await expect(app.drain()).resolves.toBeUndefined();
  });

  it("waits for active executions to finish", async () => {
    const executor = makeExecutor({ status: "completed" }, 50);
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    await request(app).post("/execute").send(VALID_BODY);
    // one execution is now active
    expect(app.activeExecutions.size).toBe(1);
    await app.drain();
    expect(app.activeExecutions.size).toBe(0);
  });

  it("resolves after maxDrainMs even if executions are still running", async () => {
    const executor = makeExecutor({ status: "completed" }, 10_000);
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, maxDrainMs: 50 });
    await request(app).post("/execute").send(VALID_BODY);
    const start = Date.now();
    await app.drain();
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("auth middleware wiring", () => {
  it("calls internalAuth when no override provided and rejects missing token", async () => {
    const app = createWorkerApp({
      executor: makeExecutor(),
      workerUrl: "https://worker.example.com",
      workerInvokerServiceAccount: "sa@project.iam.gserviceaccount.com"
    });
    const res = await request(app).post("/execute").send(VALID_BODY);
    expect(res.status).toBe(401);
  });
});
