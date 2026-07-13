import { pathToFileURL } from "node:url";
import { createPgPool } from "./clients/pgClient.js";
import { validateProductionStartupConfig } from "./config/productionValidation.js";
import { createApp } from "./createApp.js";
import { InstanceStore } from "./stores/instanceStore.js";
import { RunStore } from "./stores/runStore.js";
import { WorkerServiceRuntimeLauncher } from "./services/workerServiceRuntimeLauncher.js";
import { JobInstanceService } from "./services/jobInstanceService.js";
import { RunDispatcher } from "./services/runDispatcher.js";
import { SchedulerTickService } from "./services/schedulerTickService.js";
import { WorkerRunService } from "./services/workerRunService.js";

export { createApp } from "./createApp.js";

export async function startApplication({ pool: injectedPool } = {}) {
  validateProductionStartupConfig();

  const executionMode = process.env.WORKER_EXECUTION_MODE || "local";
  const isolatedRuntimeLauncher = executionMode === "isolated"
    ? new WorkerServiceRuntimeLauncher({
        workerUrl: process.env.RUNTIME_WORKER_URL,
        runtimeServiceAccount: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL
      })
    : null;

  const pool = injectedPool || await createPgPool();
  const runStore = new RunStore({ pool });
  const instanceStore = new InstanceStore({ pool });

  const workerRunService = new WorkerRunService({
    executionMode,
    isolatedRuntimeLauncher,
    runStore
  });

  const jobInstanceService = new JobInstanceService({ instanceStore });
  const tickService = new SchedulerTickService({ instanceStore, runStore, pool });
  const dispatcher = new RunDispatcher({
    runStore,
    workerRunService,
    intervalMs: parseInt(process.env.DISPATCH_POLL_INTERVAL_MS || "5000", 10),
    batchSize: parseInt(process.env.DISPATCH_POLL_BATCH_SIZE || "10", 10)
  });

  const readiness = {
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    executionMode,
    dbEngine: process.env.DB_ENGINE || "direct",
    runtimeWorkerConfigured: Boolean(process.env.RUNTIME_WORKER_URL),
    runtimeServiceAccountConfigured: Boolean(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL),
    runtimeBrokerConfigured: Boolean(process.env.RUNTIME_BROKER_URL)
  };

  const app = createApp({
    workerRunService,
    readiness,
    runStore,
    jobInstanceService,
    internalSchedulerOptions: { service: tickService }
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`IGA scheduler API listening on port ${port}`);
  });

  dispatcher.start();

  process.on("SIGTERM", () => {
    dispatcher.stop();
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
