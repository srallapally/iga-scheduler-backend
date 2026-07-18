import express from "express";

// Minimal HTTP surface for the pull-worker (AVL-1 residual). Cloud Run
// requires the container to listen on $PORT for liveness/readiness, so
// /health remains -- but no dispatch or cancel traffic flows over HTTP
// anymore (the poll loop in pollLoop.js claims and executes runs directly
// against Postgres). `activeExecutions`/`drain()` stay: the poll loop tracks
// each in-flight execution's promise into `activeExecutions`, and `drain()`
// is what SIGTERM handling awaits before exiting.
export function createWorkerApp({
  maxDrainMs = (Number(process.env.WORKER_MAX_TIMEOUT_SECONDS || 1800) + 30) * 1000
} = {}) {
  const app = express();

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const activeExecutions = new Set();

  function drain() {
    if (activeExecutions.size === 0) return Promise.resolve();
    return Promise.race([
      Promise.allSettled([...activeExecutions]),
      new Promise((resolve) => setTimeout(resolve, maxDrainMs))
    ]);
  }

  app.activeExecutions = activeExecutions;
  app.drain = drain;

  return app;
}
