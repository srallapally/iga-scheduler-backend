import express from "express";
import { ZodError } from "zod";
import { uploadJobDefinition } from "../middleware/upload.js";
import { JobDefinitionService } from "../services/jobDefinitionService.js";

export function createJobDefinitionRouter({ service = new JobDefinitionService() } = {}) {
  const router = express.Router();

  router.post("/", uploadJobDefinition, async (req, res) => {
    try {
      if (!req.file?.buffer) {
        return res.status(400).json({ error: "artifact zip is required" });
      }

      if (!req.body.metadata) {
        return res.status(400).json({ error: "metadata field is required" });
      }

      const metadata = typeof req.body.metadata === "string"
        ? JSON.parse(req.body.metadata)
        : req.body.metadata;

      const definition = await service.createDefinition({
        metadata,
        artifactBuffer: req.file.buffer
      });

      res.status(201).json(definition);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/", async (req, res) => {
    const definitions = await service.listDefinitions({
      includeDeleted: req.query.includeDeleted === "true"
    });
    res.json({ items: definitions });
  });

  router.get("/:definitionId", async (req, res) => {
    const definition = await service.getDefinition(req.params.definitionId);
    if (!definition) {
      return res.status(404).json({ error: "definition not found" });
    }
    res.json(definition);
  });

  router.patch("/:definitionId", async (req, res) => {
    try {
      const definition = await service.patchDefinition(req.params.definitionId, req.body);
      res.json(definition);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.delete("/:definitionId", async (req, res) => {
    try {
      const definition = await service.deleteDefinition(req.params.definitionId);
      res.json(definition);
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}

function handleError(res, error) {
  if (error instanceof SyntaxError) {
    return res.status(400).json({ error: "invalid JSON metadata" });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: "validation failed",
      details: error.issues
    });
  }

  if (error.meta?.statusCode === 409) {
    return res.status(409).json({ error: "definition already exists" });
  }

  if (error.meta?.statusCode === 404) {
    return res.status(404).json({ error: "definition not found" });
  }

  return res.status(500).json({
    error: "internal error",
    message: error.message
  });
}
