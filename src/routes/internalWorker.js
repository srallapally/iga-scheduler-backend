import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";
import { RunControlService } from "../services/runControlService.js";

// POST /:runId/execute (manual force-dispatch over the scheduler->worker
// push path) was removed here (AVL-1 residual): the worker's own poll loop
// is the only thing that executes a run now, and the scheduler has no
// in-process way to drive execution itself. See
// docs/adr/0019-pull-worker-execution-model.md.
export function createInternalWorkerRouter(options = {}) {
  let runControlService = options.runControlService;
  const authMiddleware = options.authMiddleware || createInternalAuthMiddleware(options.auth || {});
  const router = express.Router();

  router.use(authMiddleware);

  router.post("/:runId/retry", async (req, res, next) => {
    try { const result = await getRunControlService().retryRun({ runId: decodeURIComponent(req.params.runId), enqueue: req.body?.enqueue !== false }); res.status(202).json(result); } catch (error) { next(error); }
  });

  router.post("/:runId/cancel", async (req, res, next) => {
    try { const result = await getRunControlService().cancelRun({ runId: decodeURIComponent(req.params.runId), reason: req.body?.reason }); res.status(202).json(result); } catch (error) { next(error); }
  });

  router.post("/:runId/redrive", async (req, res, next) => {
    try { const result = await getRunControlService().redriveRun({ runId: decodeURIComponent(req.params.runId), enqueue: req.body?.enqueue !== false }); res.status(202).json(result); } catch (error) { next(error); }
  });

  router.use((error, _req, res, _next) => {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ error: error.message });
  });

  function getRunControlService() {
    if (!runControlService) runControlService = new RunControlService(options.runControl || {});
    return runControlService;
  }

  return router;
}
