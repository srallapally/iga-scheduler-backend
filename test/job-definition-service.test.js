import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { describe, expect, it, vi } from "vitest";
import { JobDefinitionService } from "../src/services/jobDefinitionService.js";

const execFileAsync = promisify(execFile);

function metadata(overrides = {}) {
  return {
    definitionId: "risk-score",
    name: "Risk Score",
    runtime: "javascript",
    runtimeVersion: "nodejs22",
    wrapperVersion: "1.0.0",
    entrypoint: "index.js",
    parameters: [],
    timeoutSeconds: 300,
    ...overrides
  };
}

async function createZipBuffer({ manifestEntrypoint = "index.js", includeEntrypoint = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iga-definition-src-"));
  const zipPath = path.join(os.tmpdir(), `iga-definition-${Date.now()}-${Math.random()}.zip`);

  try {
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
      runtime: "javascript",
      wrapperVersion: "1.0.0",
      entrypoint: manifestEntrypoint
    }));

    if (includeEntrypoint) {
      await fs.writeFile(path.join(dir, "index.js"), "console.log('ok');");
    }

    await execFileAsync("zip", ["-qry", zipPath, "."], { cwd: dir });
    return await fs.readFile(zipPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(zipPath, { force: true });
  }
}

function createStorageMock({ generation = "123" } = {}) {
  const file = {
    save: vi.fn(async () => {}),
    getMetadata: vi.fn(async () => [{ generation }]),
    delete: vi.fn(async () => {})
  };
  const bucket = {
    file: vi.fn(() => file)
  };
  const storage = {
    bucket: vi.fn(() => bucket)
  };

  return {
    storage,
    bucket,
    file
  };
}

function createService({ esClient, storageMock, instanceStore }) {
  return new JobDefinitionService({
    esClient,
    storage: storageMock.storage,
    config: {
      jobZipBucket: "job-bucket",
      definitionsIndex: "scheduler_definitions_v1"
    },
    instanceStore
  });
}

function createInstanceStoreMock(instances = []) {
  return {
    listInstancesForDefinition: vi.fn(async () => instances)
  };
}

function notFoundGet() {
  return vi.fn(async () => {
    const error = new Error("not found");
    error.meta = { statusCode: 404 };
    throw error;
  });
}

describe("JobDefinitionService", () => {
  it("validates artifact before writing to GCS", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      create: vi.fn(async () => ({ result: "created" })),
      get: notFoundGet()
    };
    const service = createService({ esClient, storageMock });

    await expect(service.createDefinition({
      metadata: metadata({ entrypoint: "missing.js" }),
      artifactBuffer: await createZipBuffer({ manifestEntrypoint: "missing.js", includeEntrypoint: false })
    })).rejects.toThrow("Zip must contain entrypoint: missing.js");

    expect(storageMock.bucket.file).not.toHaveBeenCalled();
    expect(storageMock.file.save).not.toHaveBeenCalled();
    expect(esClient.create).not.toHaveBeenCalled();
  });

  it("writes only the approved artifact path after validation", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      create: vi.fn(async () => ({ result: "created" })),
      get: notFoundGet()
    };
    const service = createService({ esClient, storageMock });

    const doc = await service.createDefinition({
      metadata: metadata(),
      artifactBuffer: await createZipBuffer()
    });

    expect(doc.version).toBe(1);
    expect(storageMock.bucket.file).toHaveBeenCalledTimes(1);
    expect(storageMock.bucket.file.mock.calls[0][0]).toMatch(/^approved\/risk-score\//);
    expect(storageMock.bucket.file.mock.calls[0][0]).not.toContain("quarantine");
    expect(storageMock.bucket.file.mock.calls[0][0]).not.toMatch(/^approved\/risk-score\/1\//);
    expect(storageMock.file.save).toHaveBeenCalledTimes(1);
    expect(doc.jobZip.uri).toMatch(/^gs:\/\/job-bucket\/approved\/risk-score\//);
    expect(doc.jobZip.uri).not.toMatch(/^gs:\/\/job-bucket\/approved\/risk-score\/1\//);
  });

  it("deletes uploaded approved artifact when ES create fails", async () => {
    const storageMock = createStorageMock();
    const conflict = new Error("version conflict");
    conflict.meta = { statusCode: 409 };
    const esClient = {
      create: vi.fn(async () => {
        throw conflict;
      }),
      get: notFoundGet()
    };
    const service = createService({ esClient, storageMock });

    await expect(service.createDefinition({
      metadata: metadata(),
      artifactBuffer: await createZipBuffer()
    })).rejects.toThrow("version conflict");

    expect(storageMock.file.save).toHaveBeenCalledTimes(1);
    expect(storageMock.file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("preserves ES create failure when cleanup fails", async () => {
    const storageMock = createStorageMock();
    storageMock.file.delete.mockRejectedValue(new Error("cleanup failed"));
    const createFailure = new Error("es unavailable");
    const esClient = {
      create: vi.fn(async () => {
        throw createFailure;
      }),
      get: notFoundGet()
    };
    const service = createService({ esClient, storageMock });

    await expect(service.createDefinition({
      metadata: metadata(),
      artifactBuffer: await createZipBuffer()
    })).rejects.toThrow("es unavailable");

    expect(storageMock.file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});

describe("JobDefinitionService — version increments on re-upload (COR-3)", () => {
  it("assigns version 1 on the first upload of a definitionId", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      create: vi.fn(async () => ({ result: "created" })),
      get: notFoundGet()
    };
    const service = createService({ esClient, storageMock });

    const doc = await service.createDefinition({ metadata: metadata(), artifactBuffer: await createZipBuffer() });

    expect(doc.version).toBe(1);
    expect(esClient.create).toHaveBeenCalledTimes(1);
  });

  it("increments the version on re-upload of an existing definitionId", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      index: vi.fn(async () => ({ result: "updated" })),
      get: vi.fn(async () => ({ _source: { definitionId: "risk-score", version: 1, state: "ACTIVE" } }))
    };
    const service = createService({ esClient, storageMock });

    const doc = await service.createDefinition({ metadata: metadata(), artifactBuffer: await createZipBuffer() });

    expect(doc.version).toBe(2);
    expect(esClient.index).toHaveBeenCalledTimes(1);
    expect(esClient.index.mock.calls[0][0]).toMatchObject({ id: "risk-score" });
  });

  it("increments the version on re-upload of a soft-deleted definitionId", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      index: vi.fn(async () => ({ result: "updated" })),
      get: vi.fn(async () => ({ _source: { definitionId: "risk-score", version: 3, state: "DELETED", enabled: false } }))
    };
    const service = createService({ esClient, storageMock });

    const doc = await service.createDefinition({ metadata: metadata(), artifactBuffer: await createZipBuffer() });

    expect(doc.version).toBe(4);
    expect(doc.state).toBe("ACTIVE");
    expect(doc.enabled).toBe(true);
  });
});

describe("JobDefinitionService — deleteDefinition cascade (COR-7)", () => {
  it("refuses to delete a definition with an active, enabled instance referencing it", async () => {
    const storageMock = createStorageMock();
    const esClient = { update: vi.fn(async () => ({ result: "updated" })) };
    const instanceStore = createInstanceStoreMock([
      { instanceId: "risk-score-prod-hourly", definitionId: "risk-score", enabled: true, state: "ACTIVE" }
    ]);
    const service = createService({ esClient, storageMock, instanceStore });

    await expect(service.deleteDefinition("risk-score")).rejects.toMatchObject({
      code: "DEFINITION_HAS_ACTIVE_INSTANCES",
      statusCode: 409
    });

    expect(instanceStore.listInstancesForDefinition).toHaveBeenCalledWith("risk-score");
    expect(esClient.update).not.toHaveBeenCalled();
  });

  it("allows delete when all referencing instances are paused/disabled", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      update: vi.fn(async () => ({ result: "updated" })),
      get: vi.fn(async () => ({ _source: { definitionId: "risk-score", state: "DELETED" } }))
    };
    const instanceStore = createInstanceStoreMock([
      { instanceId: "risk-score-prod-hourly", definitionId: "risk-score", enabled: false, state: "PAUSED" }
    ]);
    const service = createService({ esClient, storageMock, instanceStore });

    const result = await service.deleteDefinition("risk-score");

    expect(esClient.update).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("DELETED");
  });

  it("allows delete when no instances reference the definition", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      update: vi.fn(async () => ({ result: "updated" })),
      get: vi.fn(async () => ({ _source: { definitionId: "risk-score", state: "DELETED" } }))
    };
    const instanceStore = createInstanceStoreMock([]);
    const service = createService({ esClient, storageMock, instanceStore });

    await service.deleteDefinition("risk-score");

    expect(esClient.update).toHaveBeenCalledTimes(1);
  });

  it("skips the cascade check entirely when no instanceStore is configured (back-compat)", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      update: vi.fn(async () => ({ result: "updated" })),
      get: vi.fn(async () => ({ _source: { definitionId: "risk-score", state: "DELETED" } }))
    };
    const service = createService({ esClient, storageMock });

    await service.deleteDefinition("risk-score");

    expect(esClient.update).toHaveBeenCalledTimes(1);
  });
});
