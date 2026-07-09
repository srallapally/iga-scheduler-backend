import { randomUUID } from "crypto";
import { createEsClient } from "../clients/esClient.js";
import { getConfig } from "../config/index.js";
import { IgaClient } from "../iga/igaClient.js";
import { TokenManager } from "../iga/tokenManager.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export class RuntimeIgaProxyService {
  constructor({
    esClient = createEsClient(),
    runStore = null,
    runsIndex = null,
    auditIndex = null,
    igaClient = null,
    enabled = parseBoolean(process.env.RUNTIME_IGA_PROXY_ENABLED, true),
    maxRequestBytes = Number(process.env.RUNTIME_IGA_REQUEST_MAX_BYTES || 262144),
    maxResponseBytes = Number(process.env.RUNTIME_IGA_RESPONSE_MAX_BYTES || 1048576),
    auditEnabled = true,
    auditActor = "scheduler-runtime-iga-proxy",
    logger = console,
    now = () => new Date()
  } = {}) {
    this.esClient = esClient;
    this.runStore = runStore;
    this._runsIndex = runsIndex;
    this._auditIndex = auditIndex;
    this._igaClient = igaClient;
    this.enabled = enabled;
    this.maxRequestBytes = maxRequestBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.auditEnabled = auditEnabled;
    this.auditActor = auditActor;
    this.logger = logger;
    this.now = now;
  }

  get igaClient() {
    if (!this._igaClient) {
      const tokenManager = new TokenManager({
        tokenEndpoint: process.env.IGA_TOKEN_ENDPOINT,
        clientId: process.env.IGA_CLIENT_ID,
        clientSecret: process.env.IGA_CLIENT_SECRET,
        scope: process.env.IGA_TOKEN_SCOPE,
        refreshSkewSeconds: Number(process.env.IGA_TOKEN_REFRESH_SKEW_SECONDS || 60)
      });
      this._igaClient = new IgaClient({ baseUrl: process.env.IGA_BASE_URL, tokenManager });
    }
    return this._igaClient;
  }

  get runsIndex() {
    if (!this._runsIndex) this._runsIndex = getConfig().runsIndex;
    return this._runsIndex;
  }

  get auditIndex() {
    if (!this._auditIndex) this._auditIndex = getConfig().auditIndex;
    return this._auditIndex;
  }

  async request({ runId, method, path, body, principal }) {
    if (!this.enabled) throw this.badRequest("RUNTIME_IGA_PROXY_DISABLED", "runtime IGA proxy is disabled", 403);
    if (!runId || typeof runId !== "string") throw this.badRequest("RUN_ID_REQUIRED", "runId is required");

    const normalizedMethod = this.normalizeMethod(method);
    const normalizedPath = this.normalizePath(path);
    this.validateRequestSize(body);

    const run = await this.getRun(runId);
    if (!run) throw this.badRequest("RUN_NOT_FOUND", "run not found", 404);
    if (run.state !== "RUNNING") throw this.badRequest("RUN_NOT_RUNNING", `run ${runId} is ${run.state}; IGA requests are only allowed while RUNNING`, 409);

    const startedAt = this.now().toISOString();
    await this.emitAuditEvent({
      eventType: "runtime.iga.request.started",
      outcome: "started",
      runId,
      run,
      principal,
      createdAt: startedAt,
      details: { method: normalizedMethod, path: normalizedPath }
    });

    try {
      const result = await this.igaClient.request(normalizedMethod, normalizedPath, body);
      this.validateResponseSize(result);
      const endedAt = this.now().toISOString();
      await this.emitAuditEvent({
        eventType: "runtime.iga.request.succeeded",
        outcome: "success",
        runId,
        run,
        principal,
        createdAt: endedAt,
        details: { method: normalizedMethod, path: normalizedPath }
      });
      return { ok: true, method: normalizedMethod, path: normalizedPath, result };
    } catch (error) {
      const endedAt = this.now().toISOString();
      await this.emitAuditEvent({
        eventType: "runtime.iga.request.failed",
        outcome: "failure",
        runId,
        run,
        principal,
        createdAt: endedAt,
        error,
        details: { method: normalizedMethod, path: normalizedPath }
      });
      throw error;
    }
  }

  normalizeMethod(method) {
    const normalizedMethod = String(method || "").toUpperCase();
    if (!ALLOWED_METHODS.has(normalizedMethod)) {
      throw this.badRequest("IGA_METHOD_NOT_ALLOWED", "method must be one of GET, POST, PUT, PATCH, DELETE");
    }
    return normalizedMethod;
  }

  normalizePath(path) {
    if (!path || typeof path !== "string") throw this.badRequest("IGA_PATH_REQUIRED", "path is required");
    if (!path.startsWith("/")) throw this.badRequest("IGA_PATH_INVALID", "path must start with /");
    if (path.startsWith("//")) throw this.badRequest("IGA_PATH_INVALID", "path must not start with //");
    if (/^https?:\/\//i.test(path)) throw this.badRequest("IGA_PATH_INVALID", "path must be relative, not an absolute URL");
    return path;
  }

  validateRequestSize(body) {
    if (body === undefined || body === null) return;
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bytes > this.maxRequestBytes) throw this.badRequest("IGA_REQUEST_TOO_LARGE", "IGA request body exceeds configured size limit", 413);
  }

  validateResponseSize(result) {
    const bytes = Buffer.byteLength(JSON.stringify(result || {}), "utf8");
    if (bytes > this.maxResponseBytes) throw this.badRequest("IGA_RESPONSE_TOO_LARGE", "IGA response exceeds configured size limit", 502);
  }

  async getRun(runId) {
    if (this.runStore) return this.runStore.getRun(runId);
    try {
      const response = await this.esClient.get({ index: this.runsIndex, id: runId });
      return response._source;
    } catch (error) {
      if (error.meta?.statusCode === 404 || error.statusCode === 404) return null;
      throw error;
    }
  }

  badRequest(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  async emitAuditEvent({ eventType, outcome, runId, run, principal, createdAt, error, details = {} }) {
    if (!this.auditEnabled || typeof this.esClient.create !== "function") return;
    const event = {
      eventId: randomUUID(),
      eventType,
      outcome,
      actor: this.auditActor,
      principal,
      runId,
      createdAt: createdAt || this.now().toISOString(),
      details
    };
    if (run) {
      event.jobDefinitionId = run.definitionId;
      event.jobInstanceId = run.instanceId;
    }
    if (error) {
      event.errorCode = error.code;
      event.errorMessage = error.message;
    }
    try {
      await this.esClient.create({ index: this.auditIndex, id: event.eventId, document: event, refresh: true });
    } catch (auditError) {
      this.logger.warn?.("runtime IGA proxy audit emit failed", { error: auditError.message, eventType, runId });
    }
  }
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}
