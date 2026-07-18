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
      generation: "123"
    },
    ...overrides
  };
}

function serviceWithDefinition(definitionDocument) {
  return new WorkerRunService({
    esClient: {
      get: async () => ({ _source: definitionDocument }),
      update: async () => ({ result: "updated" })
    },
    definitionsIndex: "scheduler_definitions_v1"
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
        generation: "123"
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

// ---------------------------------------------------------------------------
// Snapshot path (AVL-2): dispatch reads run.executionMetadata, no ES call
// ---------------------------------------------------------------------------

function executionMetadataSnapshot(overrides = {}) {
  return {
    definition: {
      definitionId: "risk-score",
      version: 1,
      runtime: "javascript",
      runtimeVersion: "nodejs22",
      wrapperVersion: "1.0.0",
      entrypoint: "index.js",
      timeoutSeconds: 1800
    },
    definitionEnabled: true,
    definitionState: "ACTIVE",
    artifact: {
      uri: "gs://bucket/approved/risk-score/1/hash/job.zip",
      sha256: "hash",
      generation: "123"
    },
    ...overrides
  };
}

function serviceWithNoEsClient() {
  const esClient = { get: async () => { throw new Error("ES should not be called when a snapshot is present"); } };
  return { service: new WorkerRunService({ esClient, definitionsIndex: "scheduler_definitions_v1" }), esClient };
}

describe("worker execution metadata — snapshot path (AVL-2)", () => {
  it("builds definition and artifact metadata from the snapshot without calling ES", async () => {
    const { service } = serviceWithNoEsClient();

    const metadata = await service.buildExecutionMetadata({ run: run({ executionMetadata: executionMetadataSnapshot() }) });

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
        generation: "123"
      }
    });
  });

  it("rejects a not-found definition from the snapshot", async () => {
    const { service } = serviceWithNoEsClient();
    const snapshot = { definition: null, definitionEnabled: false, definitionState: null, artifact: null };

    await expect(service.buildExecutionMetadata({ run: run({ executionMetadata: snapshot }) })).rejects.toMatchObject({
      code: "DEFINITION_NOT_FOUND"
    });
  });

  it("rejects inactive definitions from the snapshot", async () => {
    const { service } = serviceWithNoEsClient();

    await expect(service.buildExecutionMetadata({ run: run({ executionMetadata: executionMetadataSnapshot({ definitionEnabled: false }) }) })).rejects.toMatchObject({
      code: "DEFINITION_NOT_ACTIVE"
    });
  });

  it("rejects version mismatch from the snapshot", async () => {
    const { service } = serviceWithNoEsClient();
    const snapshot = executionMetadataSnapshot();
    snapshot.definition = { ...snapshot.definition, version: 2 };

    await expect(service.buildExecutionMetadata({ run: run({ executionMetadata: snapshot }) })).rejects.toMatchObject({
      code: "DEFINITION_VERSION_MISMATCH"
    });
  });

  it("rejects missing artifact metadata from the snapshot", async () => {
    const { service } = serviceWithNoEsClient();

    await expect(service.buildExecutionMetadata({ run: run({ executionMetadata: executionMetadataSnapshot({ artifact: null }) }) })).rejects.toMatchObject({
      code: "DEFINITION_ARTIFACT_MISSING"
    });
  });

  it("falls back to a live ES lookup when no snapshot is present (legacy runs, local dev)", async () => {
    const service = serviceWithDefinition(definition());

    const metadata = await service.buildExecutionMetadata({ run: run() });

    expect(metadata.definition.definitionId).toBe("risk-score");
  });
});
