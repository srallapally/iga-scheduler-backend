export class IsolatedRuntimeLauncher {
  constructor({
    launch = null,
    cancel = null,
    getStatus = null,
    enabled = process.env.WORKER_RUNTIME_ISOLATION === "sandboxed-cloud-run-job"
  } = {}) {
    this.launch = launch;
    this.cancelExecution = cancel;
    this.getExecutionStatus = getStatus;
    this.enabled = enabled;
  }

  async execute(request) {
    return this.launchExecution(request);
  }

  async launchExecution(request) {
    this.assertConfigured("launch");
    return this.launch(request);
  }

  async cancel(runtimeExecution) {
    this.assertConfigured("cancel");
    return this.cancelExecution(runtimeExecution);
  }

  async getStatus(runtimeExecution) {
    this.assertConfigured("getStatus");
    return this.getExecutionStatus(runtimeExecution);
  }

  assertConfigured(operation) {
    const fn = operation === "launch" ? this.launch : operation === "cancel" ? this.cancelExecution : this.getExecutionStatus;
    if (!this.enabled || typeof fn !== "function") {
      const error = new Error(`isolated runtime launcher ${operation} is not configured`);
      error.code = "RUNTIME_ISOLATION_REQUIRED";
      error.retryable = false;
      throw error;
    }
  }
}
