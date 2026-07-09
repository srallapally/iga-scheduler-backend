import { createEsClient } from "../clients/esClient.js";
import { createStorageClient } from "../clients/gcsClient.js";
import { getConfig } from "../config/index.js";
import { sha256 } from "../utils/hash.js";
import { validateZipBuffer } from "../utils/zipValidation.js";
import { createJobDefinitionSchema, patchJobDefinitionSchema } from "../validation/jobDefinitionSchema.js";

export class JobDefinitionService {
  constructor({ esClient = createEsClient(), storage = createStorageClient(), config = getConfig() } = {}) {
    this.es = esClient;
    this.storage = storage;
    this.config = config;
    this.bucket = storage.bucket(config.jobZipBucket);
    this.index = config.definitionsIndex;
  }

  async createDefinition({ metadata, artifactBuffer }) {
    const parsed = createJobDefinitionSchema.parse(metadata);
    const now = new Date().toISOString();
    const digest = sha256(artifactBuffer);

    const zipInfo = await validateZipBuffer(artifactBuffer, {
      entrypoint: parsed.entrypoint,
      runtime: parsed.runtime,
      wrapperVersion: parsed.wrapperVersion
    });

    const version = 1;
    const approvedPath = `approved/${parsed.definitionId}/${digest}/job.zip`;
    const approvedFile = this.bucket.file(approvedPath);

    await approvedFile.save(artifactBuffer, {
      contentType: "application/zip",
      resumable: false,
      metadata: {
        metadata: {
          definitionId: parsed.definitionId,
          sha256: digest
        }
      }
    });

    let metadataResult;

    try {
      [metadataResult] = await approvedFile.getMetadata();

      const doc = {
        ...parsed,
        version,
        state: "ACTIVE",
        enabled: true,
        jobZip: {
          uri: `gs://${this.config.jobZipBucket}/${approvedPath}`,
          sha256: digest,
          generation: metadataResult.generation
        },
        validation: {
          fileCount: zipInfo.fileCount,
          uncompressedBytes: zipInfo.uncompressedBytes,
          validatedAt: now
        },
        createdAt: now,
        updatedAt: now
      };

      await this.es.create({
        index: this.index,
        id: parsed.definitionId,
        document: doc,
        refresh: true
      });

      return doc;
    } catch (error) {
      await this.deleteUploadedArtifact(approvedFile);
      throw error;
    }
  }

  async deleteUploadedArtifact(file) {
    try {
      await file.delete({ ignoreNotFound: true });
    } catch {
      // Best-effort cleanup only. Preserve the original create failure.
    }
  }

  async listDefinitions({ size = 100, includeDeleted = false } = {}) {
    const response = await this.es.search({
      index: this.index,
      size,
      sort: [{ updatedAt: { order: "desc" } }],
      query: includeDeleted
        ? { match_all: {} }
        : {
          bool: {
            filter: [
              { term: { state: "ACTIVE" } }
            ]
          }
        }
    });

    return response.hits.hits.map((hit) => hit._source);
  }

  async getDefinition(definitionId) {
    try {
      const response = await this.es.get({
        index: this.index,
        id: definitionId
      });
      return response._source;
    } catch (error) {
      if (error.meta?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async patchDefinition(definitionId, patch) {
    const parsed = patchJobDefinitionSchema.parse(patch);
    const now = new Date().toISOString();

    await this.es.update({
      index: this.index,
      id: definitionId,
      doc: {
        ...parsed,
        updatedAt: now
      },
      refresh: true
    });

    return this.getDefinition(definitionId);
  }

  async deleteDefinition(definitionId) {
    await this.es.update({
      index: this.index,
      id: definitionId,
      doc: {
        state: "DELETED",
        enabled: false,
        updatedAt: new Date().toISOString()
      },
      refresh: true
    });

    return this.getDefinition(definitionId);
  }
}
