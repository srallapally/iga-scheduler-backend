import { pathToFileURL } from "node:url";
import { JobRuntimeExecutor } from "../services/jobRuntimeExecutor.js";
import { createWorkerApp } from "./workerApp.js";

export function startWorker() {
  const executor = new JobRuntimeExecutor();
  const app = createWorkerApp({ executor });
  const port = Number(process.env.PORT || 8080);
  const server = app.listen(port, () => {
    console.log(`IGA job worker listening on port ${port}`);
  });

  process.on("SIGTERM", () => {
    console.log("[worker] SIGTERM received — draining active executions");
    server.close(async () => {
      await app.drain();
      console.log("[worker] drain complete");
      process.exit(0);
    });
  });

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker();
}
