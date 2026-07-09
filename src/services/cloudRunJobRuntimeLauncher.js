export class CloudRunJobRuntimeLauncher {
  constructor({
    jobsClient,
    projectId = process.env.GCP_PROJECT_ID,
    location = process.env.GCP_REGION || process.env.CLOUD_RUN_JOBS_LOCATION || "us-central1",
    jobName = process.env.RUNTIME_CLOUD_RUN_JOB_NAME,
    brokerUrl = process.env.RUNTIME_BROKER_URL,
    runtimeServiceAccount = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL,
    publicRestEnabled = parseBoolean(process.env.RUNTIME_PUBLIC_REST_ENABLED, true),
    now = () => new Date()
  } = {}) {
    if (!jobsClient) throw new Error("jobsClient is required");
    if (!projectId) throw new Error("GCP_PROJECT_ID is required");
    if (!location) throw new Error("GCP_REGION or CLOUD_RUN_JOBS_LOCATION is required");
    if (!jobName) throw new Error("RUNTIME_CLOUD_RUN_JOB_NAME is required");
    if (!brokerUrl) throw new Error("RUNTIME_BROKER_URL is required");
    if (!runtimeServiceAccount) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL is required");
    this.jobsClient = jobsClient;
    this.projectId = projectId;
    this.location = location;
    this.jobName = jobName;
    this.brokerUrl = brokerUrl.replace(/\/+$/, "");
    this.runtimeServiceAccount = runtimeServiceAccount;
    this.publicRestEnabled = publicRestEnabled;
    this.now = now;
  }

  parentJobPath() {
    return `projects/${this.projectId}/locations/${this.location}/jobs/${this.jobName}`;
  }

  completionUrl(runId) {
    if (!runId || typeof runId !== "string") throw new Error("runId is required");
    return `${this.brokerUrl}/internal/job-runs/${encodeURIComponent(runId)}/complete`;
  }

  async launchExecution({ runId, execution, context }) {
    const completionUrl = this.completionUrl(runId);
    const runtimeContext = {
      ...context,
      publicRest: { enabled: this.publicRestEnabled },
      igaBridge: { mode: "scheduler-proxy", tokenExposed: false, requestPath: "/internal/runtime/iga/request" }
    };
    const request = {
      name: this.parentJobPath(),
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "IGA_RUN_ID", value: runId },
              { name: "IGA_BROKER_URL", value: this.brokerUrl },
              { name: "IGA_COMPLETION_URL", value: completionUrl },
              { name: "IGA_COMPLETION_AUDIENCE", value: this.brokerUrl },
              { name: "IGA_RUNTIME_CONTEXT", value: Buffer.from(JSON.stringify(runtimeContext)).toString("base64") },
              { name: "IGA_ARTIFACT_URI", value: execution.artifact.uri },
              { name: "IGA_ARTIFACT_SHA256", value: execution.artifact.sha256 },
              { name: "IGA_ARTIFACT_GENERATION", value: execution.artifact.generation },
              { name: "RUNTIME_PUBLIC_REST_ENABLED", value: String(this.publicRestEnabled) }
            ]
          }
        ]
      }
    };
    const [operation] = await this.jobsClient.runJob(request);
    const operationName = operation.name || operation.latestResponse?.name;
    return {
      backend: "cloud-run-job",
      jobName: this.parentJobPath(),
      executionId: operationName,
      runtimeServiceAccount: this.runtimeServiceAccount,
      brokerUrl: this.brokerUrl,
      completionUrl,
      publicRestEnabled: this.publicRestEnabled,
      launchedAt: this.now().toISOString()
    };
  }

  async cancel(runtimeExecution) {
    if (!runtimeExecution?.executionId) return { status: "skipped", reason: "missing_execution_id" };
    if (typeof this.jobsClient.cancelOperation === "function") {
      await this.jobsClient.cancelOperation({ name: runtimeExecution.executionId });
      return { status: "cancel_requested", executionId: runtimeExecution.executionId };
    }
    return { status: "unsupported", executionId: runtimeExecution.executionId };
  }

  async getStatus(runtimeExecution) {
    if (!runtimeExecution?.executionId) return { status: "UNKNOWN", reason: "missing_execution_id" };
    if (typeof this.jobsClient.checkRunJobProgress === "function") {
      return this.jobsClient.checkRunJobProgress(runtimeExecution.executionId);
    }
    return { status: "UNKNOWN", executionId: runtimeExecution.executionId };
  }
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}
