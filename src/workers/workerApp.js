import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";

export function createWorkerApp({
  executor,
  authMiddleware,
  workerUrl = process.env.RUNTIME_WORKER_URL,
  workerInvokerServiceAccount = process.env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL,
  maxDrainMs = (Number(process.env.WORKER_MAX_TIMEOUT_SECONDS || 1800) + 30) * 1000,
  // The push-based dispatch model (AVL-1) has no queue of its own — every
  // /execute call spawns a subprocess immediately. This is the only guard
  // against unbounded concurrent job subprocesses on one worker instance.
  maxConcurrency = Number(process.env.WORKER_MAX_CONCURRENCY || 10),
  onExecutionError = null,
  onExecutionSuccess = null
} = {}) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // On first deploy RUNTIME_WORKER_URL is unknown, so workerUrl is empty.
  // Use a passthrough so the service starts and /health responds, allowing
  // Cloud Run to assign a URL. Second deploy wires in the real URL and enforces auth.
  const auth = authMiddleware ?? (workerUrl
    ? createInternalAuthMiddleware({
        expectedAudience: workerUrl,
        expectedServiceAccountEmail: workerInvokerServiceAccount
      })
    : (_req, _res, next) => next());

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
    const { runId, dispatchId, execution, context } = req.body || {};
    if (!runId || typeof runId !== "string") {
      return res.status(400).json({ error: "runId is required" });
    }
    if (!execution?.definition) {
      return res.status(400).json({ error: "execution.definition is required" });
    }
    if (!context || typeof context !== "object") {
      return res.status(400).json({ error: "context is required" });
    }
    if (activeExecutions.size >= maxConcurrency) {
      return res.status(503).json({ error: "worker is at max concurrency", retryable: true });
    }

    res.status(202).json({ status: "accepted", runId });

    const promise = executor.execute({ runId, dispatchId, run: { runId }, execution, context })
      .then(async (result) => {
        if (onExecutionSuccess) {
          try {
            await onExecutionSuccess({ runId, dispatchId, result });
          } catch (callbackErr) {
            console.error(`[worker] onExecutionSuccess callback failed for run ${runId}:`, callbackErr.message);
          }
        }
      })
      .catch(async (err) => {
        console.error(`[worker] execution failed for run ${runId}:`, err.message);
        if (onExecutionError) {
          try {
            await onExecutionError({ runId, dispatchId, error: err });
          } catch (callbackErr) {
            console.error(`[worker] onExecutionError callback failed for run ${runId}:`, callbackErr.message);
          }
        }
      });
    track(promise);
  });

  // Signals the worker to terminate a tracked run's subprocess (COR-2).
  app.post("/cancel/:runId", auth, (req, res) => {
    const { runId } = req.params;
    if (!runId) return res.status(400).json({ error: "runId is required" });
    const result = executor.cancel ? executor.cancel(runId) : { status: "not_found" };
    res.status(202).json({ runId, ...result });
  });

  app.drain = drain;
  app.activeExecutions = activeExecutions;

  return app;
}
