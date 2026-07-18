import { pathToFileURL } from "node:url";
import { createPgPool } from "../clients/pgClient.js";
import { validateWorkerStartupConfig } from "../config/productionValidation.js";
import { JobRuntimeExecutor } from "../services/jobRuntimeExecutor.js";
import { WorkerRunService } from "../services/workerRunService.js";
import { RunStore } from "../stores/runStore.js";
import { createWorkerApp } from "./workerApp.js";
import { createPollLoop } from "./pollLoop.js";

export async function startWorker() {
  validateWorkerStartupConfig();
  const pool = await createPgPool();
  const runStore = new RunStore({ pool });
  const executor = new JobRuntimeExecutor();

  // executionMode: "local" means "execute in this process" -- exactly the
  // pull worker's own semantics (AVL-1 residual), not a local-dev-only mode.
  // Completion (markSucceeded/markFailed), retry classification, and audit
  // events are all handled inside WorkerRunService itself; this replaces the
  // old push model's onExecutionSuccess/onExecutionError callbacks entirely.
  // ES access (default esClient/definitionsIndex) is only exercised by
  // buildExecutionMetadata's fallback when a run has no AVL-2
  // execution_metadata snapshot -- rare, but preserved rather than turned
  // into a hard failure. See docs/adr/0019-pull-worker-execution-model.md.
  const workerRunService = new WorkerRunService({ runStore, runtimeExecutor: executor });

  const app = createWorkerApp();
  const pollLoop = createPollLoop({
    runStore,
    workerRunService,
    executor,
    activeExecutions: app.activeExecutions
  });

  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, () => {
    console.log(`IGA job worker listening on port ${port}`);
  });

  pollLoop.start();

  process.on("SIGTERM", () => {
    console.log("[worker] SIGTERM received — stopping poll loop, draining active executions");
    pollLoop.stop();
    server.close(async () => {
      await app.drain();
      await pool.end();
      console.log("[worker] drain complete");
      process.exit(0);
    });
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch((err) => {
    console.error("Failed to start worker:", err);
    process.exit(1);
  });
}
