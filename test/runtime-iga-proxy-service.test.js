import { describe, expect, it, vi } from "vitest";
import { RuntimeIgaProxyService } from "../src/services/runtimeIgaProxyService.js";

function createRunStore(run = { runId: "run-1", state: "RUNNING", definitionId: "def-1", instanceId: "inst-1" }) {
  return { getRun: vi.fn(async () => run ? { ...run } : null) };
}

function createEsClient() {
  return { create: vi.fn(async () => ({ result: "created" })) };
}

function createService({ run, igaClient } = {}) {
  const runStore = createRunStore(run);
  const esClient = createEsClient();
  const client = igaClient || { request: vi.fn(async () => ({ ok: true, value: "iga-result" })) };
  return {
    runStore,
    esClient,
    igaClient: client,
    service: new RuntimeIgaProxyService({
      esClient,
      runStore,
      auditIndex: "audit",
      igaClient: client,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      now: () => new Date("2026-06-15T05:00:00.000Z")
    })
  };
}

describe("RuntimeIgaProxyService", () => {
  it("proxies an IGA request for a running run without exposing a token", async () => {
    const { service, igaClient, esClient, runStore } = createService();

    const result = await service.request({
      runId: "run-1",
      method: "get",
      path: "/iga/governance/applications?_pageSize=1",
      principal: "scheduler-worker@iga-scheduler.iam.gserviceaccount.com"
    });

    expect(result).toEqual({
      ok: true,
      method: "GET",
      path: "/iga/governance/applications?_pageSize=1",
      result: { ok: true, value: "iga-result" }
    });
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(JSON.stringify(result)).not.toContain("access-token");
    expect(igaClient.request).toHaveBeenCalledWith("GET", "/iga/governance/applications?_pageSize=1", undefined);
    expect(runStore.getRun).toHaveBeenCalledWith("run-1");
    expect(esClient.create).toHaveBeenCalledTimes(2);
  });

  it("supports write methods through the scheduler-owned IGA client", async () => {
    const { service, igaClient } = createService();

    await service.request({
      runId: "run-1",
      method: "POST",
      path: "/iga/governance/risk-scores/recompute",
      body: { userId: "user-1" }
    });

    expect(igaClient.request).toHaveBeenCalledWith("POST", "/iga/governance/risk-scores/recompute", { userId: "user-1" });
  });

  it("rejects absolute URLs so jobs cannot use the IGA proxy as a generic web proxy", async () => {
    const { service, igaClient } = createService();

    await expect(service.request({
      runId: "run-1",
      method: "GET",
      path: "https://example.com/iga/governance"
    })).rejects.toMatchObject({ code: "IGA_PATH_INVALID", statusCode: 400 });

    expect(igaClient.request).not.toHaveBeenCalled();
  });

  it("rejects IGA calls when the run is not running", async () => {
    const { service, igaClient } = createService({ run: { runId: "run-1", state: "SUCCEEDED" } });

    await expect(service.request({
      runId: "run-1",
      method: "GET",
      path: "/iga/governance/applications"
    })).rejects.toMatchObject({ code: "RUN_NOT_RUNNING", statusCode: 409 });

    expect(igaClient.request).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before calling IGA", async () => {
    const { service, igaClient } = createService();

    await expect(service.request({
      runId: "run-1",
      method: "POST",
      path: "/iga/governance/applications",
      body: { value: "x".repeat(2000) }
    })).rejects.toMatchObject({ code: "IGA_REQUEST_TOO_LARGE", statusCode: 413 });

    expect(igaClient.request).not.toHaveBeenCalled();
  });
});
