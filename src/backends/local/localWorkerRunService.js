import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { sha256 } from "../../utils/hash.js";
import { validateZipBuffer } from "../../utils/zipValidation.js";
import { WorkerRunService } from "../../services/workerRunService.js";

function noopEsClient() {
  return {
    create: async () => {},
    get: async () => { throw Object.assign(new Error("local mode — no ES"), { meta: { statusCode: 404 } }); },
    search: async () => ({ hits: { hits: [] } }),
    update: async () => {}
  };
}

function noopStorage() {
  return {
    bucket: () => ({
      file: () => ({
        download: async () => { throw new Error("local mode — no GCS"); },
        save: async () => {},
        delete: async () => {},
        getMetadata: async () => [{}]
      })
    })
  };
}

export class LocalWorkerRunService extends WorkerRunService {
  constructor({ localDefinitionService, dataDir = ".local-data", runStore, parameterResolver, ...rest }) {
    super({
      esClient: noopEsClient(),
      storage: noopStorage(),
      runStore,
      parameterResolver,
      executionMode: "local",
      ...rest
    });
    this.localDefinitionService = localDefinitionService;
    this.dataDir = dataDir;
  }

  async getDefinition(definitionId) {
    return this.localDefinitionService.getDefinition(definitionId);
  }

  async verifyApprovedArtifact({ execution }) {
    const uri = execution.artifact.uri;
    if (!uri.startsWith("local://")) {
      throw this.executionMetadataError("ARTIFACT_URI_INVALID", `expected local:// URI, got: ${uri}`);
    }
    const filePath = uri.slice("local://".length);
    let buffer;
    try {
      buffer = readFileSync(filePath);
    } catch (error) {
      throw this.executionMetadataError("ARTIFACT_DOWNLOAD_FAILED", `local artifact read failed for ${filePath}: ${error.message}`, { cause: error });
    }
    const actualSha256 = sha256(buffer);
    if (actualSha256 !== execution.artifact.sha256) {
      throw this.executionMetadataError("ARTIFACT_SHA256_MISMATCH", `local artifact sha256 mismatch for ${filePath}`);
    }
    let zipInfo;
    try {
      zipInfo = await validateZipBuffer(buffer, {
        entrypoint: execution.definition.entrypoint,
        runtime: execution.definition.runtime,
        wrapperVersion: execution.definition.wrapperVersion
      });
    } catch (error) {
      throw this.executionMetadataError("ARTIFACT_ZIP_INVALID", error.message, { cause: error, retryable: false });
    }
    return { sha256: actualSha256, generation: execution.artifact.generation, fileCount: zipInfo.fileCount, uncompressedBytes: zipInfo.uncompressedBytes, buffer };
  }

  async emitAuditEvent(event) {
    this.logger.debug?.("audit", event);
    try {
      this.localDefinitionService.db.prepare(
        "INSERT OR IGNORE INTO audit_events (id, event_type, run_id, data, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(
        randomUUID(),
        event.eventType ?? null,
        event.runId ?? null,
        JSON.stringify(event),
        new Date().toISOString()
      );
    } catch {
      // Audit failures are non-fatal, same as the production ES path
    }
  }
}
