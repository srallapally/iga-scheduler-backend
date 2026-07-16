import { pathToFileURL } from "node:url";
import { createPgPool } from "../clients/pgClient.js";
import { validateWorkerStartupConfig } from "../config/productionValidation.js";
import { JobRuntimeExecutor } from "../services/jobRuntimeExecutor.js";
import { classifyWorkerError } from "../services/retryClassifier.js";
import { RunStore } from "../stores/runStore.js";
import { createWorkerApp } from "./workerApp.js";

export async function startWorker() {
  validateWorkerStartupConfig();
  const pool = await createPgPool();
  const runStore = new RunStore({ pool });
  const executor = new JobRuntimeExecutor();

  async function onExecutionError({ runId, error }) {
    const retryClassification = classifyWorkerError(error);
    const serialized = { code: error.code, message: error.message };
    if (retryClassification) serialized.retry = retryClassification;
    await runStore.markFailed({
      runId,
      endedAt: new Date().toISOString(),
      error: serialized,
      status: { phase: "failed", message: error.message || "Worker execution failed" }
    });
  }

  const app = createWorkerApp({ executor, onExecutionError });
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, () => {
    console.log(`IGA job worker listening on port ${port}`);
  });

  process.on("SIGTERM", () => {
    console.log("[worker] SIGTERM received — draining active executions");
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
