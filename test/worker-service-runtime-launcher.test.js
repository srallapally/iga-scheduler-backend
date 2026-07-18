import { describe, expect, it, vi } from "vitest";
import { WorkerServiceRuntimeLauncher } from "../src/services/workerServiceRuntimeLauncher.js";

function buildFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const WORKER_URL = "https://worker.example.com";
const SERVICE_ACCOUNT = "sa@project.iam.gserviceaccount.com";
const TOKEN = buildFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

const EXECUTION = { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js" } };
const CONTEXT = { runId: "run-1", params: {} };

function makeFetch(overrides = {}) {
  return vi.fn(async (url) => {
    if (String(url).includes("metadata.google.internal")) {
      return { ok: true, status: 200, text: async () => TOKEN, ...overrides.metadata };
    }
    return { ok: true, status: 202, text: async () => "", json: async () => ({ status: "killed" }), ...overrides.worker };
  });
}

describe("WorkerServiceRuntimeLauncher", () => {
  it("throws when workerUrl is missing", () => {
    expect(() => new WorkerServiceRuntimeLauncher({ workerUrl: "", runtimeServiceAccount: SERVICE_ACCOUNT }))
      .toThrow("RUNTIME_WORKER_URL is required");
  });

  it("throws when runtimeServiceAccount is missing", () => {
    expect(() => new WorkerServiceRuntimeLauncher({ workerUrl: WORKER_URL, runtimeServiceAccount: "" }))
      .toThrow("RUNTIME_SERVICE_ACCOUNT_EMAIL is required");
  });

  it("POSTs to worker /execute and returns correct shape", async () => {
    const fetchImpl = makeFetch();
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL,
      runtimeServiceAccount: SERVICE_ACCOUNT,
      fetchImpl,
      now: () => new Date("2026-07-12T10:00:00.000Z")
    });

    const result = await launcher.launchExecution({ runId: "run-1", execution: EXECUTION, context: CONTEXT });

    expect(result).toEqual({
      backend: "worker-service",
      workerUrl: WORKER_URL,
      runtimeServiceAccount: SERVICE_ACCOUNT,
      launchedAt: "2026-07-12T10:00:00.000Z"
    });

    const workerCall = fetchImpl.mock.calls.find(c => String(c[0]).includes("/execute"));
    expect(workerCall[0]).toBe(`${WORKER_URL}/execute`);
    const body = JSON.parse(workerCall[1].body);
    expect(body).toEqual({ runId: "run-1", execution: EXECUTION, context: CONTEXT });
    expect(workerCall[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("forwards dispatchId in the /execute POST body (COR-1)", async () => {
    const fetchImpl = makeFetch();
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL,
      runtimeServiceAccount: SERVICE_ACCOUNT,
      fetchImpl,
      now: () => new Date("2026-07-12T10:00:00.000Z")
    });

    await launcher.launchExecution({ runId: "run-1", dispatchId: "dispatch-abc", execution: EXECUTION, context: CONTEXT });

    const workerCall = fetchImpl.mock.calls.find(c => String(c[0]).includes("/execute"));
    const body = JSON.parse(workerCall[1].body);
    expect(body).toEqual({ runId: "run-1", dispatchId: "dispatch-abc", execution: EXECUTION, context: CONTEXT });
  });

  it("fetches OIDC token from metadata server with correct audience", async () => {
    const fetchImpl = makeFetch();
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });
    await launcher.launchExecution({ runId: "run-1", execution: EXECUTION, context: CONTEXT });
    const metaCall = fetchImpl.mock.calls.find(c => String(c[0]).includes("metadata.google.internal"));
    expect(metaCall[0]).toContain(encodeURIComponent(WORKER_URL));
    expect(metaCall[1].headers["Metadata-Flavor"]).toBe("Google");
  });

  it("caches OIDC token across calls", async () => {
    const fetchImpl = makeFetch();
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });
    await launcher.launchExecution({ runId: "run-1", execution: EXECUTION, context: CONTEXT });
    await launcher.launchExecution({ runId: "run-2", execution: EXECUTION, context: CONTEXT });
    const metaCalls = fetchImpl.mock.calls.filter(c => String(c[0]).includes("metadata.google.internal"));
    expect(metaCalls).toHaveLength(1);
  });

  it("retries once on 401 from worker", async () => {
    const token2 = buildFakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    let metaCallCount = 0;
    let workerCallCount = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("metadata.google.internal")) {
        metaCallCount++;
        return { ok: true, status: 200, text: async () => metaCallCount === 1 ? TOKEN : token2 };
      }
      workerCallCount++;
      if (workerCallCount === 1) return { ok: false, status: 401, text: async () => "" };
      return { ok: true, status: 202, text: async () => "" };
    });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });
    await launcher.launchExecution({ runId: "run-1", execution: EXECUTION, context: CONTEXT });
    expect(workerCallCount).toBe(2);
    expect(metaCallCount).toBe(2);
  });

  it("throws on non-2xx response from worker", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("metadata.google.internal")) return { ok: true, status: 200, text: async () => TOKEN };
      return { ok: false, status: 503, text: async () => "service unavailable" };
    });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });
    await expect(launcher.launchExecution({ runId: "run-1", execution: EXECUTION, context: CONTEXT }))
      .rejects.toThrow("HTTP 503");
  });

  it("getStatus returns unsupported", async () => {
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl: makeFetch()
    });
    expect(await launcher.getStatus()).toEqual({ status: "unsupported" });
  });

  it("cancel POSTs to worker /cancel/:runId and returns the worker's response (COR-2)", async () => {
    const fetchImpl = makeFetch({ worker: { json: async () => ({ status: "killed" }) } });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });

    const result = await launcher.cancel({ runId: "run-1" });

    expect(result).toEqual({ status: "killed" });
    const cancelCall = fetchImpl.mock.calls.find(c => String(c[0]).includes("/cancel/"));
    expect(cancelCall[0]).toBe(`${WORKER_URL}/cancel/run-1`);
    expect(cancelCall[1].method).toBe("POST");
    expect(cancelCall[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("cancel returns not_found when the worker has no tracked execution for the run", async () => {
    const fetchImpl = makeFetch({ worker: { json: async () => ({ status: "not_found" }) } });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });

    expect(await launcher.cancel({ runId: "run-1" })).toEqual({ status: "not_found" });
  });

  it("cancel retries once on 401 with a fresh token", async () => {
    let workerCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("metadata.google.internal")) return { ok: true, status: 200, text: async () => TOKEN };
      workerCalls++;
      if (workerCalls === 1) return { ok: false, status: 401, text: async () => "expired" };
      return { ok: true, status: 202, json: async () => ({ status: "killed" }) };
    });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });

    const result = await launcher.cancel({ runId: "run-1" });
    expect(result).toEqual({ status: "killed" });
    expect(workerCalls).toBe(2);
  });

  it("cancel throws on a non-ok, non-401 response", async () => {
    const fetchImpl = makeFetch({ worker: { ok: false, status: 503, text: async () => "unavailable" } });
    const launcher = new WorkerServiceRuntimeLauncher({
      workerUrl: WORKER_URL, runtimeServiceAccount: SERVICE_ACCOUNT, fetchImpl
    });

    await expect(launcher.cancel({ runId: "run-1" })).rejects.toThrow("HTTP 503");
  });
});
