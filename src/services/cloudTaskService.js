import { createHash } from "crypto";
import { CloudTasksClient } from "@google-cloud/tasks";

function normalizeBaseUrl(value, envName) {
  if (!value || typeof value !== "string") throw new Error(`${envName} is required`);
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error(`${envName} is required`);
  return normalized;
}

export class CloudTaskService {
  constructor(options = {}) {
    const {
      client = new CloudTasksClient(),
      projectId = process.env.GCP_PROJECT_ID,
      location = process.env.GCP_REGION || process.env.CLOUD_TASKS_LOCATION || "us-central1",
      queue = process.env.CLOUD_TASKS_QUEUE,
      workerBaseUrl = process.env.WORKER_BASE_URL,
      workerInvokerServiceAccountEmail = process.env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
    } = options;
    const workerOidcAudience = Object.prototype.hasOwnProperty.call(options, "workerOidcAudience")
      ? options.workerOidcAudience
      : process.env.WORKER_OIDC_AUDIENCE;

    if (!projectId) throw new Error("GCP_PROJECT_ID is required");
    if (!location) throw new Error("GCP_REGION or CLOUD_TASKS_LOCATION is required");
    if (!queue) throw new Error("CLOUD_TASKS_QUEUE is required");
    if (!workerInvokerServiceAccountEmail) throw new Error("WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL is required");

    const normalizedWorkerBaseUrl = normalizeBaseUrl(workerBaseUrl, "WORKER_BASE_URL");
    const normalizedWorkerOidcAudience = normalizeBaseUrl(
      workerOidcAudience === undefined || workerOidcAudience === null ? normalizedWorkerBaseUrl : workerOidcAudience,
      "WORKER_OIDC_AUDIENCE"
    );

    this.client = client;
    this.projectId = projectId;
    this.location = location;
    this.queue = queue;
    this.workerBaseUrl = normalizedWorkerBaseUrl;
    this.workerInvokerServiceAccountEmail = workerInvokerServiceAccountEmail;
    this.workerOidcAudience = normalizedWorkerOidcAudience;
  }

  queuePath() {
    return this.client.queuePath(this.projectId, this.location, this.queue);
  }

  buildRunExecutionUrl(runId) {
    if (!runId || typeof runId !== "string") throw new Error("runId is required");
    return `${this.workerBaseUrl}/internal/job-runs/${encodeURIComponent(runId)}/execute`;
  }

  buildTaskName({ parent, runId, attempt, dispatchId } = {}) {
    if (!parent || typeof parent !== "string") throw new Error("parent is required");
    if (!runId || typeof runId !== "string") throw new Error("runId is required");
    const identity = [runId, attempt === undefined ? "" : String(attempt), dispatchId || ""].join(":");
    const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
    return `${parent}/tasks/run-${digest}`;
  }

  buildTask({ runId, attempt, dispatchId, parent = this.queuePath() }) {
    if (!runId || typeof runId !== "string") throw new Error("runId is required");
    const payload = { runId, attempt, dispatchId };
    const httpRequest = {
      httpMethod: "POST",
      url: this.buildRunExecutionUrl(runId),
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(payload)).toString("base64")
    };
    httpRequest.oidcToken = {
      serviceAccountEmail: this.workerInvokerServiceAccountEmail,
      audience: this.workerOidcAudience
    };
    return { name: this.buildTaskName({ parent, runId, attempt, dispatchId }), httpRequest };
  }

  async enqueueRun({ runId, attempt, dispatchId } = {}) {
    const parent = this.queuePath();
    const task = this.buildTask({ runId, attempt, dispatchId, parent });
    const [response] = await this.client.createTask({ parent, task });
    return { name: response.name, runId, attempt, dispatchId, targetUrl: task.httpRequest.url };
  }
}
