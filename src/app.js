import { pathToFileURL } from "node:url";
import { createCloudRunJobsClient } from "./clients/cloudRunJobsClient.js";
import { createPgPool } from "./clients/pgClient.js";
import { validateProductionStartupConfig } from "./config/productionValidation.js";
import { createApp } from "./createApp.js";
import { RunStore } from "./stores/runStore.js";
import { CloudRunJobRuntimeLauncher } from "./services/cloudRunJobRuntimeLauncher.js";
import { WorkerRunService } from "./services/workerRunService.js";

export { createApp } from "./createApp.js";

export async function startApplication({ pool: injectedPool } = {}) {
  validateProductionStartupConfig();

  const executionMode = process.env.WORKER_EXECUTION_MODE || "local";
  const isolatedRuntimeLauncher = executionMode === "isolated"
    ? new CloudRunJobRuntimeLauncher({
        jobsClient: createCloudRunJobsClient(),
        jobName: process.env.RUNTIME_CLOUD_RUN_JOB_NAME,
        brokerUrl: process.env.RUNTIME_BROKER_URL,
        runtimeServiceAccount: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL
      })
    : null;

  const pool = injectedPool || await createPgPool();
  const runStore = new RunStore({ pool });

  const workerRunService = new WorkerRunService({
    executionMode,
    isolatedRuntimeLauncher,
    runStore
  });

  const readiness = {
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    executionMode,
    dbEngine: process.env.DB_ENGINE || "direct",
    runtimeJobConfigured: Boolean(process.env.RUNTIME_CLOUD_RUN_JOB_NAME),
    runtimeServiceAccountConfigured: Boolean(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL),
    runtimeBrokerConfigured: Boolean(process.env.RUNTIME_BROKER_URL)
  };

  const app = createApp({ workerRunService, readiness, runStore });
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`IGA scheduler API listening on port ${port}`);
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApplication().catch((err) => {
    console.error("Failed to start application:", err);
    process.exit(1);
  });
}
