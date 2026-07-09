import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";
import { RuntimeIgaProxyService } from "../services/runtimeIgaProxyService.js";

export function createInternalRuntimeIgaRouter(options = {}) {
  const router = express.Router();
  const authMiddleware = options.authMiddleware || createInternalAuthMiddleware(options.auth || {
    expectedAudience: process.env.RUNTIME_BROKER_URL || process.env.WORKER_OIDC_AUDIENCE || process.env.WORKER_BASE_URL,
    expectedServiceAccountEmail: process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL || process.env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
  });
  let service = options.service;

  function getService() {
    if (!service) service = new RuntimeIgaProxyService(options.serviceOptions || {});
    return service;
  }

  router.use(authMiddleware);

  router.post("/request", async (req, res, next) => {
    try {
      const result = await getService().request({
        runId: req.body?.runId,
        method: req.body?.method,
        path: req.body?.path,
        body: req.body?.body,
        principal: req.internalAuth?.principal
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
