import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";
import { RunControlService } from "../services/runControlService.js";
import { WorkerRunService } from "../services/workerRunService.js";

export function createInternalWorkerRouter(options = {}) {
  const service = options.service || new WorkerRunService();
  let runControlService = options.runControlService;
  const authMiddleware = options.authMiddleware || createInternalAuthMiddleware(options.auth || {});
  const router = express.Router();

  router.use(authMiddleware);

  router.post("/:runId/execute", async (req, res, next) => {
    try {
      const runId = decodeURIComponent(req.params.runId);
      if (!runId) { res.status(400).json({ error: "runId is required" }); return; }
      const result = await service.executeRun({ runId });
      const statusCode = result.status === "completed" ? 200 : 202;
      res.status(statusCode).json(result);
    } catch (error) {
      next(error);
    }
  });

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
