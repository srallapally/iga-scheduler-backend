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

function createService({ esClient, storageMock }) {
  return new JobDefinitionService({
    esClient,
    storage: storageMock.storage,
    config: {
      jobZipBucket: "job-bucket",
      definitionsIndex: "scheduler_definitions_v1"
    }
  });
}

describe("JobDefinitionService", () => {
  it("validates artifact before writing to GCS", async () => {
    const storageMock = createStorageMock();
    const esClient = {
      create: vi.fn(async () => ({ result: "created" }))
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
      create: vi.fn(async () => ({ result: "created" }))
    };
    const service = createService({ esClient, storageMock });

    const doc = await service.createDefinition({
      metadata: metadata(),
      artifactBuffer: await createZipBuffer()
    });

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
      })
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
      })
    };
    const service = createService({ esClient, storageMock });

    await expect(service.createDefinition({
      metadata: metadata(),
      artifactBuffer: await createZipBuffer()
    })).rejects.toThrow("es unavailable");

    expect(storageMock.file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });
});
