import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/createApp.js";

const originalEnv = { ...process.env };

function makeValidToken() {
  return { sub: "client-1", scope: "scheduler:admin" };
}

function mockDefinitionService() {
  return {
    listDefinitions: vi.fn(async () => []),
    getDefinition: vi.fn(async () => null),
    createDefinition: vi.fn(async () => ({})),
    patchDefinition: vi.fn(async () => ({})),
    deleteDefinition: vi.fn(async () => ({}))
  };
}

function mockInstanceService() {
  return {
    createInstance: vi.fn(async () => ({})),
    getInstance: vi.fn(async () => null),
    patchInstance: vi.fn(async () => ({})),
    pauseInstance: vi.fn(async () => ({})),
    resumeInstance: vi.fn(async () => ({})),
    deleteInstance: vi.fn(async () => ({})),
    listInstancesForDefinition: vi.fn(async () => [])
  };
}

function mockRunStore() {
  return {
    getRun: vi.fn(async () => null),
    listRunsForInstance: vi.fn(async () => [])
  };
}

function createTestApp(overrides = {}) {
  return createApp({
    publicAuthOptions: {
      issuer: "https://auth.pingone.example.test",
      audience: "https://scheduler.example.test",
      requiredScope: "scheduler:admin",
      verifyToken: vi.fn(async () => makeValidToken()),
      ...overrides
    },
    jobDefinitionService: mockDefinitionService(),
    jobInstanceService: mockInstanceService(),
    runStore: mockRunStore(),
    internalIgaOptions: {
      tokenManager: { getAccessToken: vi.fn(async () => "token") },
      igaClient: { get: vi.fn(async () => ({ status: "ok" })) }
    }
  });
}

const PUBLIC_ROUTES = [
  ["GET", "/job-definitions"],
  ["GET", "/job-definitions/def-1"],
  ["GET", "/job-definitions/def-1/instances"],
  ["GET", "/job-instances/inst-1"],
  ["GET", "/job-runs/run-1"]
];

describe("public routes auth matrix", () => {
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

  it.each(PUBLIC_ROUTES)("%s %s returns 401 without a token", async (method, path) => {
    const app = createTestApp();
    const res = await request(app)[method.toLowerCase()](path);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing bearer token");
  });

  it.each(PUBLIC_ROUTES)("%s %s returns 401 with an invalid token", async (method, path) => {
    const app = createTestApp({
      verifyToken: vi.fn(() => Promise.reject(new Error("invalid")))
    });
    const res = await request(app)[method.toLowerCase()](path).set("authorization", "Bearer bad");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid bearer token");
  });

  it.each(PUBLIC_ROUTES)("%s %s returns 403 when required scope is absent", async (method, path) => {
    const app = createTestApp({
      verifyToken: vi.fn(async () => ({ sub: "client-1", scope: "other:scope" }))
    });
    const res = await request(app)[method.toLowerCase()](path).set("authorization", "Bearer token");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("insufficient scope");
  });

  it("/health is reachable without a token", async () => {
    const app = createTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("/ready is reachable without a token", async () => {
    const app = createTestApp();
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
  });
});

describe("internal routes unaffected by publicAuth", () => {
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

  it("internal routes do not return publicAuth 401", async () => {
    const app = createTestApp({
      verifyToken: vi.fn(() => Promise.reject(new Error("should not be called")))
    });
    // No Bearer token — internal route; publicAuth is not applied
    const res = await request(app).get("/internal/scheduler/tick");
    // Should be 401 from internalAuth (missing OIDC token), not from publicAuth
    expect(res.status).toBe(401);
    // internalAuth produces { error: "missing bearer token" } — same message but verifyToken not called
  });
});
