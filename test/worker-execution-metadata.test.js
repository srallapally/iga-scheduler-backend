import { describe, expect, it } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

function run(overrides = {}) {
  return {
    runId: "run-1",
    definitionId: "risk-score",
    definitionVersion: 1,
    state: "RUNNING",
    ...overrides
  };
}

function definition(overrides = {}) {
  return {
    definitionId: "risk-score",
    version: 1,
    state: "ACTIVE",
    enabled: true,
    runtime: "javascript",
    runtimeVersion: "nodejs22",
    wrapperVersion: "1.0.0",
    entrypoint: "index.js",
    timeoutSeconds: 1800,
    jobZip: {
      uri: "gs://bucket/approved/risk-score/1/hash/job.zip",
      sha256: "hash",
      generation: "123",
      approval: { status: "APPROVED", sha256: "hash", generation: "123", approvedAt: "2024-01-01T00:00:00.000Z" },
      scan: { status: "CLEAN", sha256: "hash", scannedAt: "2024-01-01T00:00:00.000Z" }
    },
    ...overrides
  };
}

function serviceWithDefinition(definitionDocument) {
  return new WorkerRunService({
    esClient: {
      get: async () => ({ _source: definitionDocument }),
      update: async () => ({ result: "updated" })
    }
  });
}

describe("worker execution metadata", () => {
  it("builds definition and artifact metadata", async () => {
    const service = serviceWithDefinition(definition());

    const metadata = await service.buildExecutionMetadata({ run: run() });

    expect(metadata).toEqual({
      definition: {
        definitionId: "risk-score",
        version: 1,
        runtime: "javascript",
        runtimeVersion: "nodejs22",
        wrapperVersion: "1.0.0",
        entrypoint: "index.js",
        timeoutSeconds: 1800
      },
      artifact: {
        uri: "gs://bucket/approved/risk-score/1/hash/job.zip",
        sha256: "hash",
        generation: "123",
        approval: { status: "APPROVED", sha256: "hash", generation: "123", approvedAt: "2024-01-01T00:00:00.000Z" },
        scan: { status: "CLEAN", sha256: "hash", scannedAt: "2024-01-01T00:00:00.000Z" }
      }
    });
  });

  it("rejects inactive definitions", async () => {
    const service = serviceWithDefinition(definition({ enabled: false }));

    await expect(service.buildExecutionMetadata({ run: run() })).rejects.toMatchObject({
      code: "DEFINITION_NOT_ACTIVE"
    });
  });

  it("rejects version mismatch", async () => {
    const service = serviceWithDefinition(definition({ version: 2 }));

    await expect(service.buildExecutionMetadata({ run: run() })).rejects.toMatchObject({
      code: "DEFINITION_VERSION_MISMATCH"
    });
  });

  it("rejects missing artifact metadata", async () => {
    const service = serviceWithDefinition(definition({ jobZip: {} }));

    await expect(service.buildExecutionMetadata({ run: run() })).rejects.toMatchObject({
      code: "DEFINITION_ARTIFACT_MISSING"
    });
  });
});
