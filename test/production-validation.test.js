import { describe, expect, it } from "vitest";
import { validateProductionStartupConfig } from "../src/config/productionValidation.js";

function productionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    GCP_PROJECT_ID: "iga-scheduler",
    JOB_ZIP_BUCKET: "job-bucket",
    ES_ENDPOINT: "https://es.example.test",
    ES_API_KEY: "es-key",
    WORKER_OIDC_AUDIENCE: "https://worker.example.test",
    WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL: "worker-invoker@iga-scheduler.iam.gserviceaccount.com",
    SCHEDULER_OIDC_AUDIENCE: "https://scheduler.example.test",
    SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL: "scheduler-invoker@iga-scheduler.iam.gserviceaccount.com",
    WORKER_EXECUTION_MODE: "isolated",
    RUNTIME_CLOUD_RUN_JOB_NAME: "iga-runtime-job",
    RUNTIME_SERVICE_ACCOUNT_EMAIL: "iga-runtime@iga-scheduler.iam.gserviceaccount.com",
    RUNTIME_BROKER_URL: "https://worker.example.test/internal/runtime-broker",
    IGA_TOKEN_ENDPOINT: "https://iga.example.test/oauth2/token",
    IGA_CLIENT_ID: "iga-client-id",
    IGA_CLIENT_SECRET: "iga-client-secret",
    IGA_BASE_URL: "https://iga.example.test",
    DB_ENGINE: "cloud-sql",
    DB_INSTANCE_CONNECTION_NAME: "iga-scheduler:us-central1:scheduler-db",
    DB_USER: "scheduler",
    DB_NAME: "scheduler",
    ...overrides
  };
}

describe("validateProductionStartupConfig", () => {
  it("skips non-production environments", () => {
    expect(validateProductionStartupConfig({ env: { NODE_ENV: "test" } })).toEqual({ status: "skipped", reason: "not_production" });
  });

  it("accepts isolated production runtime configuration", () => {
    expect(validateProductionStartupConfig({ env: productionEnv() })).toEqual({ status: "ok" });
  });

  it("rejects local production execution", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ WORKER_EXECUTION_MODE: "local" }) })).toThrow("WORKER_EXECUTION_MODE must be isolated in production");
  });

  it("rejects missing runtime job configuration", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ RUNTIME_CLOUD_RUN_JOB_NAME: "" }) })).toThrow("Missing required production environment variables: RUNTIME_CLOUD_RUN_JOB_NAME");
  });

  it("rejects missing IGA configuration", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ IGA_TOKEN_ENDPOINT: "" }) })).toThrow("Missing required production environment variables: IGA_TOKEN_ENDPOINT");
  });

  it("rejects attestation-only runtime isolation flag", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ WORKER_RUNTIME_ISOLATION: "gvisor" }) })).toThrow("WORKER_RUNTIME_ISOLATION is not a production isolation control");
  });

  it("rejects runtime service account reuse", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ RUNTIME_SERVICE_ACCOUNT_EMAIL: "worker-invoker@iga-scheduler.iam.gserviceaccount.com" }) })).toThrow("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the worker invoker service account");
  });
});
