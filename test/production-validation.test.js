import { describe, expect, it } from "vitest";
import { validateProductionStartupConfig, validateWorkerStartupConfig } from "../src/config/productionValidation.js";

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
    PUBLIC_API_ISSUER: "https://auth.pingone.example.com/env1/as",
    PUBLIC_API_AUDIENCE: "https://scheduler.example.com",
    ...overrides
  };
}

function workerProductionEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    GCP_PROJECT_ID: "iga-scheduler",
    RUNTIME_SERVICE_ACCOUNT_EMAIL: "iga-runtime@iga-scheduler.iam.gserviceaccount.com",
    RUNTIME_BROKER_URL: "https://scheduler.example.test",
    JOB_ZIP_BUCKET: "job-bucket",
    ES_ENDPOINT: "https://es.example.test",
    ES_API_KEY: "es-key",
    WORKER_REQUIRE_RUNTIME_ISOLATION: "false",
    ...overrides
  };
}

describe("validateWorkerStartupConfig", () => {
  it("skips non-production environments", () => {
    expect(validateWorkerStartupConfig({ env: { NODE_ENV: "test" } })).toEqual({ status: "skipped", reason: "not_production" });
  });

  it("accepts a fully configured worker", () => {
    expect(validateWorkerStartupConfig({ env: workerProductionEnv() })).toEqual({ status: "ok" });
  });

  it.each([
    "GCP_PROJECT_ID",
    "RUNTIME_SERVICE_ACCOUNT_EMAIL",
    "RUNTIME_BROKER_URL",
    "JOB_ZIP_BUCKET",
    "ES_ENDPOINT",
    "ES_API_KEY"
  ])("rejects missing %s", (varName) => {
    expect(() => validateWorkerStartupConfig({ env: workerProductionEnv({ [varName]: "" }) }))
      .toThrow(`Missing required worker environment variables: ${varName}`);
  });

  it("accepts config without RUNTIME_WORKER_URL/WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL — no inbound dispatch/cancel traffic to authenticate (AVL-1 residual)", () => {
    const env = workerProductionEnv();
    expect(validateWorkerStartupConfig({ env })).toEqual({ status: "ok" });
  });

  it("accepts config without direct IGA credentials — worker reaches IGA only through the broker", () => {
    const env = workerProductionEnv();
    delete env.IGA_TOKEN_ENDPOINT;
    delete env.IGA_CLIENT_ID;
    delete env.IGA_CLIENT_SECRET;
    delete env.IGA_BASE_URL;
    expect(validateWorkerStartupConfig({ env })).toEqual({ status: "ok" });
  });

  it("rejects WORKER_REQUIRE_RUNTIME_ISOLATION not set to false", () => {
    expect(() => validateWorkerStartupConfig({ env: workerProductionEnv({ WORKER_REQUIRE_RUNTIME_ISOLATION: undefined }) }))
      .toThrow("WORKER_REQUIRE_RUNTIME_ISOLATION must be set to 'false'");
  });

  it("rejects WORKER_REQUIRE_RUNTIME_ISOLATION=true", () => {
    expect(() => validateWorkerStartupConfig({ env: workerProductionEnv({ WORKER_REQUIRE_RUNTIME_ISOLATION: "true" }) }))
      .toThrow("WORKER_REQUIRE_RUNTIME_ISOLATION must be set to 'false'");
  });
});

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

  it("accepts config without RUNTIME_WORKER_URL — the scheduler no longer pushes dispatch/cancel over HTTP (AVL-1 residual); WORKER_OIDC_AUDIENCE/WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL are still required (they gate this router's own retry/cancel/redrive auth, unrelated to the removed push path)", () => {
    expect(validateProductionStartupConfig({ env: productionEnv() })).toEqual({ status: "ok" });
  });

  it("rejects missing IGA configuration", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ IGA_TOKEN_ENDPOINT: "" }) })).toThrow("Missing required production environment variables: IGA_TOKEN_ENDPOINT");
  });

  it("rejects attestation-only runtime isolation flag", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ WORKER_RUNTIME_ISOLATION: "gvisor" }) })).toThrow("WORKER_RUNTIME_ISOLATION is not a production isolation control");
  });

  it("rejects runtime service account reuse with the worker invoker", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ RUNTIME_SERVICE_ACCOUNT_EMAIL: "worker-invoker@iga-scheduler.iam.gserviceaccount.com" }) })).toThrow("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the worker invoker service account");
  });

  it("rejects runtime service account reuse with the scheduler invoker", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ RUNTIME_SERVICE_ACCOUNT_EMAIL: "scheduler-invoker@iga-scheduler.iam.gserviceaccount.com" }) })).toThrow("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the scheduler invoker service account");
  });

  it("rejects missing PUBLIC_API_ISSUER", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ PUBLIC_API_ISSUER: "" }) })).toThrow("Missing required production environment variables: PUBLIC_API_ISSUER");
  });

  it("rejects missing PUBLIC_API_AUDIENCE", () => {
    expect(() => validateProductionStartupConfig({ env: productionEnv({ PUBLIC_API_AUDIENCE: "" }) })).toThrow("Missing required production environment variables: PUBLIC_API_AUDIENCE");
  });
});
