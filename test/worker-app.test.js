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

  it("threads dispatchId through to executor.execute (SEC-7)", async () => {
    const executor = makeExecutor();
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    await request(app).post("/execute").send({ ...VALID_BODY, dispatchId: "dispatch-abc" });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      dispatchId: "dispatch-abc"
    }));
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

describe("POST /execute — concurrency cap (AVL-1)", () => {
  it("rejects a new execution retryably once maxConcurrency is reached", async () => {
    const executor = makeExecutor({ status: "completed" }, 50);
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, maxConcurrency: 1 });

    const first = await request(app).post("/execute").send({ ...VALID_BODY, runId: "run-1" });
    expect(first.status).toBe(202);

    const second = await request(app).post("/execute").send({ ...VALID_BODY, runId: "run-2" });
    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: "worker is at max concurrency", retryable: true });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts a new execution once a prior one has finished and freed a slot", async () => {
    const executor = makeExecutor({ status: "completed" }, 20);
    const app = createWorkerApp({ executor, authMiddleware: noopAuth, maxConcurrency: 1 });

    const first = await request(app).post("/execute").send({ ...VALID_BODY, runId: "run-1" });
    expect(first.status).toBe(202);

    await vi.waitFor(() => expect(app.activeExecutions.size).toBe(0));

    const second = await request(app).post("/execute").send({ ...VALID_BODY, runId: "run-2" });
    expect(second.status).toBe(202);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("defaults to a concurrency of 10 when WORKER_MAX_CONCURRENCY is unset", async () => {
    const executor = makeExecutor({ status: "completed" }, 50);
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post("/execute").send({ ...VALID_BODY, runId: `run-${i}` });
      expect(res.status).toBe(202);
    }
    const eleventh = await request(app).post("/execute").send({ ...VALID_BODY, runId: "run-10" });
    expect(eleventh.status).toBe(503);
  });
});

describe("POST /cancel/:runId (COR-2)", () => {
  it("delegates to executor.cancel and returns its result", async () => {
    const executor = { ...makeExecutor(), cancel: vi.fn(() => ({ status: "killed" })) };
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    const res = await request(app).post("/cancel/run-1");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-1", status: "killed" });
    expect(executor.cancel).toHaveBeenCalledWith("run-1");
  });

  it("returns not_found when the executor has no tracked execution for the run", async () => {
    const executor = { ...makeExecutor(), cancel: vi.fn(() => ({ status: "not_found" })) };
    const app = createWorkerApp({ executor, authMiddleware: noopAuth });
    const res = await request(app).post("/cancel/unknown-run");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "unknown-run", status: "not_found" });
  });

  it("is gated by the auth middleware", async () => {
    const executor = { ...makeExecutor(), cancel: vi.fn(() => ({ status: "killed" })) };
    const denyAuth = (_req, res) => res.status(401).json({ error: "missing bearer token" });
    const app = createWorkerApp({ executor, authMiddleware: denyAuth });
    const res = await request(app).post("/cancel/run-1");
    expect(res.status).toBe(401);
    expect(executor.cancel).not.toHaveBeenCalled();
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
