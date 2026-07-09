// Local development entry point.
// Replaces all cloud dependencies (ES, GCS, Postgres, Secret Manager) with SQLite +
// local filesystem equivalents. PingOne OAuth is kept intact.
// Never calls getConfig() or validateProductionStartupConfig().

import { pathToFileURL } from "node:url";
import { createApp } from "./createApp.js";
import { createLocalDb } from "./backends/local/db.js";
import { LocalPool } from "./backends/local/localPool.js";
import { LocalRunStore } from "./backends/local/localRunStore.js";
import { LocalInstanceStore } from "./backends/local/localInstanceStore.js";
import { LocalDefinitionService } from "./backends/local/localDefinitionService.js";
import { LocalWorkerRunService } from "./backends/local/localWorkerRunService.js";
import { LocalParameterResolver } from "./backends/local/localParameterResolver.js";
import { JobInstanceService } from "./services/jobInstanceService.js";
import { SchedulerTickService } from "./services/schedulerTickService.js";
import { RunDispatcher } from "./services/runDispatcher.js";

export async function startLocalApplication() {
  const DATA_DIR = process.env.LOCAL_DATA_DIR || ".local-data";

  const db = createLocalDb(DATA_DIR);
  const pool = new LocalPool(db);
  const runStore = new LocalRunStore({ db });
  const instanceStore = new LocalInstanceStore({ db });
  const localDefinitionService = new LocalDefinitionService({ db, dataDir: DATA_DIR });

  const workerRunService = new LocalWorkerRunService({
    localDefinitionService,
    dataDir: DATA_DIR,
    runStore,
    parameterResolver: new LocalParameterResolver()
  });

  // JobInstanceService needs getActiveDefinition to look up a definition.
  // Proxy its esClient.get() to localDefinitionService so no ES is needed.
  const localEsShim = {
    get: async ({ id }) => {
      const def = await localDefinitionService.getDefinition(id);
      if (!def) throw Object.assign(new Error("not found"), { meta: { statusCode: 404 } });
      return { _source: def };
    }
  };
  const jobInstanceService = new JobInstanceService({
    instanceStore,
    esClient: localEsShim,
    definitionsIndex: "__local__"
  });

  const tickService = new SchedulerTickService({ instanceStore, runStore, pool });
  const dispatcher = new RunDispatcher({
    runStore,
    workerRunService,
    intervalMs: parseInt(process.env.DISPATCH_POLL_INTERVAL_MS || "5000", 10),
    batchSize: parseInt(process.env.DISPATCH_POLL_BATCH_SIZE || "10", 10)
  });

  const app = createApp({
    workerRunService,
    runStore,
    jobDefinitionService: localDefinitionService,
    jobInstanceService,
    publicAuthOptions: {
      issuer: process.env.PUBLIC_API_ISSUER,
      audience: process.env.PUBLIC_API_AUDIENCE,
      requiredScope: process.env.PUBLIC_API_REQUIRED_SCOPE
    },
    readiness: { status: "ok", environment: "local", executionMode: "local", backend: "sqlite" },
    internalSchedulerOptions: { service: tickService }
  });

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`[local] IGA scheduler listening on port ${port} — data: ${DATA_DIR}`);
  });

  dispatcher.start();

  process.on("SIGTERM", () => {
    dispatcher.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalApplication().catch((err) => {
    console.error("Failed to start local application:", err);
    process.exit(1);
  });
}
