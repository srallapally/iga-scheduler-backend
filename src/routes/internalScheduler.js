import express from "express";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";

export function createInternalSchedulerRouter({ service, authMiddleware, auth } = {}) {
  const router = express.Router();
  const resolvedAuth = auth || {
    expectedAudience: process.env.SCHEDULER_OIDC_AUDIENCE,
    expectedServiceAccountEmail: process.env.SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
  };
  const requireInternalAuth = authMiddleware || createSchedulerAuthMiddleware(resolvedAuth);
  let tickService = service;

  router.use(requireInternalAuth);

  router.post("/tick", async (req, res) => {
    try { const result = await getTickService().tick(buildTickOptions(req.body)); return res.json(result); } catch (error) { return res.status(500).json({ error: "scheduler tick failed", message: error.message }); }
  });

  function getTickService() {
    if (!tickService) throw new Error("SchedulerTickService must be injected via service option");
    return tickService;
  }

  return router;
}

function createSchedulerAuthMiddleware(auth) {
  if (!auth.expectedAudience) throw new Error("expectedAudience is required");
  if (!auth.expectedServiceAccountEmail) throw new Error("expectedServiceAccountEmail is required");
  return createInternalAuthMiddleware(auth);
}

function buildTickOptions(body = {}) { return { dryRun: body.dryRun === true, enqueue: body.enqueue === undefined ? true : body.enqueue === true, batchSize: body.batchSize }; }
