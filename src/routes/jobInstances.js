import express from "express";
import { ZodError } from "zod";
import { JobInstanceService } from "../services/jobInstanceService.js";

export function createJobInstanceRouter({ service = new JobInstanceService() } = {}) {
  const router = express.Router();

  router.post("/job-definitions/:definitionId/instances", async (req, res) => {
    try {
      const instance = await service.createInstance(req.params.definitionId, req.body);
      res.status(201).json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/job-definitions/:definitionId/instances", async (req, res) => {
    try {
      const items = await service.listInstancesForDefinition(req.params.definitionId);
      res.json({ items });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/job-instances/:instanceId", async (req, res) => {
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

  router.patch("/job-instances/:instanceId", async (req, res) => {
    try {
      const instance = await service.patchInstance(req.params.instanceId, req.body);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/job-instances/:instanceId/pause", async (req, res) => {
    try {
      const instance = await service.pauseInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/job-instances/:instanceId/resume", async (req, res) => {
    try {
      const instance = await service.resumeInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/job-instances/:instanceId", async (req, res) => {
    try {
      const instance = await service.deleteInstance(req.params.instanceId);
      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/job-instances/:instanceId/run-now", async (_req, res) => {
    res.status(501).json({
      error: "run-now is deferred to Phase 5"
    });
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
