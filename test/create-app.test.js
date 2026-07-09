import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/createApp.js";

const originalEnv = { ...process.env };

const TEST_PUBLIC_AUTH = {
  issuer: "https://auth.example.test",
  audience: "https://scheduler.example.test",
  verifyToken: vi.fn(async () => ({ sub: "client-1" }))
};

const MOCK_DEFINITION_SERVICE = {
  listDefinitions: vi.fn(async () => []),
  getDefinition: vi.fn(async () => null),
  createDefinition: vi.fn(async () => ({})),
  patchDefinition: vi.fn(async () => ({})),
  deleteDefinition: vi.fn(async () => ({}))
};

const MOCK_INSTANCE_SERVICE = {
  createInstance: vi.fn(async () => ({})),
  getInstance: vi.fn(async () => null),
  patchInstance: vi.fn(async () => ({})),
  pauseInstance: vi.fn(async () => ({})),
  resumeInstance: vi.fn(async () => ({})),
  deleteInstance: vi.fn(async () => ({})),
  listInstancesForDefinition: vi.fn(async () => [])
};

function createTestApp(options = {}) {
  return createApp({
    publicAuthOptions: TEST_PUBLIC_AUTH,
    jobDefinitionService: MOCK_DEFINITION_SERVICE,
    jobInstanceService: MOCK_INSTANCE_SERVICE,
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
