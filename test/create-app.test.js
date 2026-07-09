import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/createApp.js";

const originalEnv = { ...process.env };

function createTestApp(options = {}) {
  return createApp({
    internalIgaOptions: {
      tokenManager: { getAccessToken: vi.fn(async () => "token") },
      igaClient: { get: vi.fn(async () => ({ status: "ok" })) }
    },
    ...options
  });
}

describe("createApp", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      WORKER_OIDC_AUDIENCE: "https://worker.example.internal",
      WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
      SCHEDULER_OIDC_AUDIENCE: "https://scheduler.example.internal",
      SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL: "scheduler@example.iam.gserviceaccount.com"
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns injected readiness state without re-reading process.env", async () => {
    const readiness = {
      status: "ok",
      environment: "production",
      executionMode: "isolated",
      runtimeJobConfigured: true,
      runtimeServiceAccountConfigured: true,
      runtimeBrokerConfigured: true
    };

    const app = createTestApp({
      readiness,
      workerRunService: { executeRun: vi.fn() }
    });

    process.env.WORKER_EXECUTION_MODE = "local";
    process.env.RUNTIME_CLOUD_RUN_JOB_NAME = "mutated-after-create";

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(readiness);
  });

  it("keeps /health lightweight", async () => {
    const app = createTestApp({
      workerRunService: { executeRun: vi.fn() }
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("passes the injected workerRunService to the internal worker router", async () => {
    const workerRunService = {
      executeRun: vi.fn(async ({ runId }) => ({ status: "dispatched", runId, state: "RUNNING" }))
    };
    const verifyToken = vi.fn(async () => ({
      aud: "https://worker.example.internal",
      email: "worker@example.iam.gserviceaccount.com"
    }));
    const app = createTestApp({
      workerRunService,
      internalWorkerOptions: {
        auth: {
          expectedAudience: "https://worker.example.internal",
          expectedServiceAccountEmail: "worker@example.iam.gserviceaccount.com",
          verifyToken
        }
      }
    });

    const response = await request(app)
      .post("/internal/job-runs/run-1/execute")
      .set("authorization", "Bearer token-1")
      .send({});

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "dispatched", runId: "run-1", state: "RUNNING" });
    expect(workerRunService.executeRun).toHaveBeenCalledWith({ runId: "run-1" });
  });
});
