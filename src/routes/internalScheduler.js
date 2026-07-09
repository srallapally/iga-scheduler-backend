import express from "express";
import { createEsClient } from "../clients/esClient.js";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";
import { CloudTaskService } from "../services/cloudTaskService.js";
import { QueuedRunMaintenanceService } from "../services/queuedRunMaintenanceService.js";
import { SchedulerTickService } from "../services/schedulerTickService.js";

export function createInternalSchedulerRouter({ service, queuedRunMaintenanceService, authMiddleware, auth } = {}) {
  const router = express.Router();
  const resolvedAuth = auth || {
    expectedAudience: process.env.SCHEDULER_OIDC_AUDIENCE,
    expectedServiceAccountEmail: process.env.SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
  };
  const requireInternalAuth = authMiddleware || createSchedulerAuthMiddleware(resolvedAuth);
  let tickService = service;
  let queuedRunService = queuedRunMaintenanceService;

  router.use(requireInternalAuth);

  router.post("/tick", async (req, res) => {
    try { const result = await getTickService().tick(buildTickOptions(req.body)); return res.json(result); } catch (error) { return res.status(500).json({ error: "scheduler tick failed", message: error.message }); }
  });

  router.post("/queued-runs/reconcile", async (req, res) => {
    try { const result = await getQueuedRunMaintenanceService().reconcileQueuedRuns(buildQueuedRunMaintenanceOptions(req.body)); return res.json(result); } catch (error) { return res.status(500).json({ error: "queued run reconciliation failed", message: error.message }); }
  });

  function getTickService() { if (!tickService) tickService = createSchedulerTickService(); return tickService; }
  function getQueuedRunMaintenanceService() { if (!queuedRunService) queuedRunService = createQueuedRunMaintenanceService(); return queuedRunService; }
  return router;
}

function createSchedulerAuthMiddleware(auth) {
  if (!auth.expectedAudience) throw new Error("expectedAudience is required");
  if (!auth.expectedServiceAccountEmail) throw new Error("expectedServiceAccountEmail is required");
  return createInternalAuthMiddleware(auth);
}

function createSchedulerTickService() { return new SchedulerTickService({ esClient: createEsClient(), cloudTaskService: new CloudTaskService() }); }
function createQueuedRunMaintenanceService() { return new QueuedRunMaintenanceService({ esClient: createEsClient(), cloudTaskService: new CloudTaskService() }); }
function buildTickOptions(body = {}) { return { dryRun: body.dryRun === true, enqueue: body.enqueue === undefined ? true : body.enqueue === true, batchSize: body.batchSize }; }
function buildQueuedRunMaintenanceOptions(body = {}) { return { dryRun: body.dryRun === true, redriveRecent: body.redriveRecent === true, maxAgeSeconds: body.maxAgeSeconds, batchSize: body.batchSize }; }
