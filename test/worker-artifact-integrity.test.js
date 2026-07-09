import { describe, expect, it, vi } from "vitest";
import { WorkerRunService } from "../src/services/workerRunService.js";

function createStorageWithBuffer(buffer) {
  const download = vi.fn(async () => [buffer]);
  const file = vi.fn(() => ({ download }));
  const bucket = vi.fn(() => ({ file }));

  return {
    storage: { bucket },
    bucket,
    file,
    download
  };
}

function execution(overrides = {}) {
  return {
    definition: {
      entrypoint: "index.js"
    },
    artifact: {
      uri: "gs://bucket-name/approved/risk-score/1/hash/job.zip",
      sha256: "expected-sha",
      generation: "123"
    },
    ...overrides
  };
}

describe("worker artifact integrity", () => {
  it("parses GCS artifact URIs", () => {
    const service = new WorkerRunService({
      esClient: {},
      storage: {}
    });

    expect(service.parseGcsUri("gs://bucket-name/path/to/job.zip")).toEqual({
      bucketName: "bucket-name",
      objectName: "path/to/job.zip"
    });
  });

  it("rejects invalid GCS artifact URIs", () => {
    const service = new WorkerRunService({
      esClient: {},
      storage: {}
    });

    expect(() => service.parseGcsUri("https://example.com/job.zip")).toThrow(
      "invalid GCS artifact URI"
    );
  });

  it("downloads the pinned generation and rejects sha256 mismatch", async () => {
    const { storage, bucket, file } = createStorageWithBuffer(Buffer.from("tampered"));
    const service = new WorkerRunService({
      esClient: {},
      storage
    });

    await expect(service.verifyApprovedArtifact({ execution: execution() })).rejects.toMatchObject({
      code: "ARTIFACT_SHA256_MISMATCH"
    });

    expect(bucket).toHaveBeenCalledWith("bucket-name");
    expect(file).toHaveBeenCalledWith("approved/risk-score/1/hash/job.zip", {
      generation: "123"
    });
  });
});
