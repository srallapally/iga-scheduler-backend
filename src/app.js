import { pathToFileURL } from "node:url";
import { createPgPool } from "./clients/pgClient.js";
import { createEsClient } from "./clients/esClient.js";
import { validateProductionStartupConfig } from "./config/productionValidation.js";
import { createApp } from "./createApp.js";
import { InstanceStore } from "./stores/instanceStore.js";
import { RunStore } from "./stores/runStore.js";
import { JobDefinitionService } from "./services/jobDefinitionService.js";
import { JobInstanceService } from "./services/jobInstanceService.js";
import { RunControlService } from "./services/runControlService.js";
import { StaleRunSweeper } from "./services/staleRunSweeper.js";
import { SchedulerTickService } from "./services/schedulerTickService.js";

export { createApp } from "./createApp.js";

// Dispatch is pull-based (AVL-1 residual): the worker service polls and
// claims runs itself (src/workers/pollLoop.js), so the scheduler no longer
// pushes over HTTP and needs no WorkerRunService/isolated launcher of its
// own. RunControlService.cancelRuntimeExecution is a no-op without a
// runtimeLauncher configured -- cancellation is now pull-based too (the
// owning worker polls for CANCELLING and self-cancels). See
// docs/adr/0019-pull-worker-execution-model.md.
export async function startApplication({ pool: injectedPool } = {}) {
  validateProductionStartupConfig();

  const executionMode = process.env.WORKER_EXECUTION_MODE || "local";

  const pool = injectedPool || await createPgPool();
  const esClient = createEsClient();
  const runStore = new RunStore({ pool });
  const instanceStore = new InstanceStore({ pool });

  const jobInstanceService = new JobInstanceService({ instanceStore });
  const jobDefinitionService = new JobDefinitionService({ instanceStore });
  const runControlService = new RunControlService({ runStore });
  // jobDefinitionService lets tick snapshot artifact/definition metadata onto
  // each run row, so dispatch never has to call ES itself (AVL-2).
  const tickService = new SchedulerTickService({ instanceStore, runStore, pool, definitionService: jobDefinitionService });

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
    runtimeServiceAccountConfigured: Boolean(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL),
    runtimeBrokerConfigured: Boolean(process.env.RUNTIME_BROKER_URL)
  };

  const app = createApp({
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

  sweeper.start();

  process.on("SIGTERM", () => {
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
