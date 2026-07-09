import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  createApp: vi.fn(),
  validateProductionStartupConfig: vi.fn()
}));

vi.mock("../src/createApp.js", () => ({ createApp: mocks.createApp }));
vi.mock("../src/config/productionValidation.js", () => ({ validateProductionStartupConfig: mocks.validateProductionStartupConfig }));

const originalEnv = { ...process.env };

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    GCP_PROJECT_ID: "iga-scheduler",
    JOB_ZIP_BUCKET: "iga-job-zips",
    ES_ENDPOINT: "https://example.es",
    ES_API_KEY: "dummy",
    WORKER_OIDC_AUDIENCE: "https://worker.example",
    WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL: "worker-invoker@example.iam.gserviceaccount.com",
    SCHEDULER_OIDC_AUDIENCE: "https://scheduler.example",
    SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL: "scheduler-invoker@example.iam.gserviceaccount.com",
    WORKER_EXECUTION_MODE: "isolated",
    RUNTIME_CLOUD_RUN_JOB_NAME: "iga-runtime-job",
    RUNTIME_SERVICE_ACCOUNT_EMAIL: "iga-runtime@example.iam.gserviceaccount.com",
    RUNTIME_BROKER_URL: "https://worker.example/internal/runtime-broker",
    ...overrides
  };
}

describe("startApplication", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createApp.mockReset();
    mocks.listen.mockReset();
    mocks.validateProductionStartupConfig.mockReset();
    mocks.validateProductionStartupConfig.mockReturnValue({ status: "ok" });
    mocks.createApp.mockReturnValue({ listen: mocks.listen });
    process.env = { ...originalEnv, ...productionEnv() };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validates before creating the app or binding a listener", async () => {
    const calls = [];
    mocks.validateProductionStartupConfig.mockImplementation(() => {
      calls.push("validate");
      return { status: "ok" };
    });
    mocks.createApp.mockImplementation((options) => {
      calls.push("createApp");
      return { listen: mocks.listen };
    });
    mocks.listen.mockImplementation(() => {
      calls.push("listen");
      return { close: vi.fn() };
    });

    const { startApplication } = await import("../src/app.js");

    startApplication();

    expect(calls).toEqual(["validate", "createApp", "listen"]);
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      workerRunService: expect.any(Object),
      readiness: expect.objectContaining({
        environment: "production",
        executionMode: "isolated",
        runtimeJobConfigured: true,
        runtimeServiceAccountConfigured: true,
        runtimeBrokerConfigured: true
      })
    }));
  });

  it("does not bind a listener when validation fails", async () => {
    mocks.validateProductionStartupConfig.mockImplementation(() => {
      throw new Error("WORKER_EXECUTION_MODE must be isolated in production");
    });

    const { startApplication } = await import("../src/app.js");

    expect(() => startApplication()).toThrow("WORKER_EXECUTION_MODE must be isolated in production");
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });
});
