import { randomUUID } from "crypto";
import express from "express";
import { ZodError } from "zod";
import { JobInstanceService } from "../services/jobInstanceService.js";

// Mounted at /job-definitions/:definitionId/instances
export function createJobInstanceCollectionRouter({ service = new JobInstanceService() } = {}) {
  const router = express.Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    try {
      const items = await service.listInstancesForDefinition(req.params.definitionId);
      res.json({ items });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/", async (req, res) => {
    try {
      const instance = await service.createInstance(req.params.definitionId, req.body);
      res.status(201).json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

// Mounted at /job-instances
export function createJobInstanceRouter({ service = new JobInstanceService(), runStore } = {}) {
  const router = express.Router();

  router.get("/:instanceId", async (req, res) => {
    try {
      const instance = await service.getInstance(req.params.instanceId);
      if (!instance) {
        return res.status(404).json({ error: "instance not found" });
      }
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.patch("/:instanceId", async (req, res) => {
    try {
      const instance = await service.patchInstance(req.params.instanceId, req.body);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:instanceId/pause", async (req, res) => {
    try {
      const instance = await service.pauseInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:instanceId/resume", async (req, res) => {
    try {
      const instance = await service.resumeInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/:instanceId", async (req, res) => {
    try {
      const instance = await service.deleteInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/:instanceId/run-now", async (req, res) => {
    try {
      if (!runStore) return res.status(503).json({ error: "runStore not available" });
      const instance = await service.getInstance(req.params.instanceId);
      if (!instance) return res.status(404).json({ error: "instance not found" });
      if (instance.state === "DELETED") return res.status(409).json({ error: "instance is deleted" });
      const nowIso = new Date().toISOString();
      const runId = `${instance.instanceId}:manual:${randomUUID()}`;
      const run = {
        runId,
        tenantId: instance.tenantId ?? null,
        definitionId: instance.definitionId,
        definitionVersion: instance.definitionVersion,
        instanceId: instance.instanceId,
        scheduledFireTime: nowIso,
        state: "QUEUED",
        attempt: 1,
        params: instance.parameters ?? {},
        createdAt: nowIso,
        updatedAt: nowIso,
        startedAt: null,
        endedAt: null,
        heartbeatAt: null,
        status: { phase: "queued", message: "Run queued by run-now" },
        feedback: {},
        result: null,
        error: null
      };
      await runStore.createRun(run);
      res.status(201).json({ runId, state: "QUEUED", instanceId: instance.instanceId });
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

function handleError(res, error) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: "validation failed",
      details: error.issues
    });
  }

  if (error.statusCode) {
    return res.status(error.statusCode).json({
      error: error.message
    });
  }

  if (error.meta?.statusCode === 409) {
    return res.status(409).json({ error: "instance already exists" });
  }

  if (error.meta?.statusCode === 404) {
    return res.status(404).json({ error: "not found" });
  }

  return res.status(500).json({
    error: "internal error",
    message: error.message
  });
}
