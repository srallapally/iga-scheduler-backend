import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";

export function createWorkerApp({
  executor,
  authMiddleware,
  workerUrl = process.env.RUNTIME_WORKER_URL,
  workerInvokerServiceAccount = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL,
  maxDrainMs = (Number(process.env.WORKER_MAX_TIMEOUT_SECONDS || 1800) + 30) * 1000
} = {}) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const auth = authMiddleware ?? createInternalAuthMiddleware({
    expectedAudience: workerUrl,
    expectedServiceAccountEmail: workerInvokerServiceAccount
  });

  const activeExecutions = new Set();

  function track(promise) {
    activeExecutions.add(promise);
    promise.finally(() => activeExecutions.delete(promise));
  }

  function drain() {
    if (activeExecutions.size === 0) return Promise.resolve();
    return Promise.race([
      Promise.allSettled([...activeExecutions]),
      new Promise((resolve) => setTimeout(resolve, maxDrainMs))
    ]);
  }

  app.post("/execute", auth, (req, res) => {
    const { runId, execution, context } = req.body || {};
    if (!runId || typeof runId !== "string") {
      return res.status(400).json({ error: "runId is required" });
    }
    if (!execution?.definition) {
      return res.status(400).json({ error: "execution.definition is required" });
    }
    if (!context || typeof context !== "object") {
      return res.status(400).json({ error: "context is required" });
    }

    res.status(202).json({ status: "accepted", runId });

    const promise = executor.execute({ runId, run: { runId }, execution, context })
      .catch((err) => {
        console.error(`[worker] execution failed for run ${runId}:`, err.message);
      });
    track(promise);
  });

  app.drain = drain;
  app.activeExecutions = activeExecutions;

  return app;
}
