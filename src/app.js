import { pathToFileURL } from "node:url";
import { createPgPool } from "./clients/pgClient.js";
import { createEsClient } from "./clients/esClient.js";
import { validateProductionStartupConfig } from "./config/productionValidation.js";
import { createApp } from "./createApp.js";
import { InstanceStore } from "./stores/instanceStore.js";
import { RunStore } from "./stores/runStore.js";
import { WorkerServiceRuntimeLauncher } from "./services/workerServiceRuntimeLauncher.js";
import { JobDefinitionService } from "./services/jobDefinitionService.js";
import { JobInstanceService } from "./services/jobInstanceService.js";
import { RunDispatcher } from "./services/runDispatcher.js";
import { RunControlService } from "./services/runControlService.js";
import { StaleRunSweeper } from "./services/staleRunSweeper.js";
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
  const esClient = createEsClient();
  const runStore = new RunStore({ pool });
  const instanceStore = new InstanceStore({ pool });

  const workerRunService = new WorkerRunService({
    executionMode,
    isolatedRuntimeLauncher,
    runStore
  });

  const jobInstanceService = new JobInstanceService({ instanceStore });
  const jobDefinitionService = new JobDefinitionService({ instanceStore });
  // Reuses the same launcher instance dispatch uses, so cancellation targets
  // the same worker service (COR-2).
  const runControlService = new RunControlService({ runStore, runtimeLauncher: isolatedRuntimeLauncher });
  // jobDefinitionService lets tick snapshot artifact/definition metadata onto
  // each run row, so dispatch never has to call ES itself (AVL-2).
  const tickService = new SchedulerTickService({ instanceStore, runStore, pool, definitionService: jobDefinitionService });
  const dispatcher = new RunDispatcher({
    runStore,
    workerRunService,
    intervalMs: parseInt(process.env.DISPATCH_POLL_INTERVAL_MS || "5000", 10),
    batchSize: parseInt(process.env.DISPATCH_POLL_BATCH_SIZE || "10", 10)
  });

  const sweeper = new StaleRunSweeper({
    runStore,
    intervalMs: parseInt(process.env.STALE_RUN_SWEEP_INTERVAL_MS || "60000", 10),
    thresholdMs: parseInt(process.env.STALE_RUN_THRESHOLD_MS || String((1800 + 60) * 1000), 10)
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
    esClient,
    jobInstanceService,
    jobDefinitionService,
    runControlService,
    internalSchedulerOptions: { service: tickService }
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`IGA scheduler API listening on port ${port}`);
  });

  dispatcher.start();
  sweeper.start();

  process.on("SIGTERM", () => {
    dispatcher.stop();
    sweeper.stop();
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
