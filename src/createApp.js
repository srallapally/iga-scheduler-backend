import crypto from "crypto";
import path from "path";
import express from "express";
import { createJobDefinitionRouter } from "./routes/jobDefinitions.js";
import { createJobInstanceCollectionRouter, createJobInstanceRouter } from "./routes/jobInstances.js";
import { createJobRunRouter, createInstanceRunRouter } from "./routes/jobRuns.js";
import { createInternalIgaRouter } from "./routes/internalIga.js";
import { createInternalRuntimeIgaRouter } from "./routes/internalRuntimeIga.js";
import { createInternalSchedulerRouter } from "./routes/internalScheduler.js";
import { createInternalWorkerRouter } from "./routes/internalWorker.js";
import { createPublicAuthMiddleware } from "./middleware/publicAuth.js";

export function createApp({ workerRunService, runStore, esClient, jobInstanceService, jobDefinitionService, runControlService, readiness = createDefaultReadiness(), publicAuthOptions, internalIgaOptions = {}, internalRuntimeIgaOptions = {}, internalSchedulerOptions = {}, internalWorkerOptions = {} } = {}) {
  const app = express();
  const cachedReadiness = { ...readiness };

  const publicAuth = publicAuthOptions
    ? createPublicAuthMiddleware(publicAuthOptions)
    : createPublicAuthMiddleware();

  app.use(assignRequestId);
  app.use(express.json({ limit: "1mb" }));
  app.use("/internal/iga", createInternalIgaRouter(internalIgaOptions));
  app.use("/internal/runtime/iga", createInternalRuntimeIgaRouter({ ...(runStore ? { serviceOptions: { runStore } } : {}), ...internalRuntimeIgaOptions }));
  app.use("/internal/scheduler", createInternalSchedulerRouter(internalSchedulerOptions));
  app.use("/internal/job-runs", createInternalWorkerRouter({ ...internalWorkerOptions, ...(workerRunService ? { service: workerRunService } : {}), ...(runControlService ? { runControlService } : (runStore ? { runControl: { runStore } } : {})) }));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/ready", async (_req, res) => {
    if (esClient) {
      try {
        await esClient.ping();
      } catch {
        return res.status(503).json({ ...cachedReadiness, status: "unavailable", esConnected: false });
      }
      return res.json({ ...cachedReadiness, esConnected: true });
    }
    res.json(cachedReadiness);
  });

  const instanceOpts = jobInstanceService ? { service: jobInstanceService } : {};
  const runOpts = runStore ? { runStore } : {};
  app.use("/job-definitions", publicAuth, createJobDefinitionRouter(jobDefinitionService ? { service: jobDefinitionService } : {}));
  app.use("/job-definitions/:definitionId/instances", publicAuth, createJobInstanceCollectionRouter(instanceOpts));
  app.use("/job-instances", publicAuth, createJobInstanceRouter({ ...instanceOpts, ...runOpts }));
  app.use("/job-instances", publicAuth, createInstanceRunRouter(runOpts));
  app.use("/job-runs", publicAuth, createJobRunRouter({ ...runOpts, ...(runControlService ? { runControlService } : {}) }));

  if (process.env.UI_DIST_PATH) {
    app.use(express.static(process.env.UI_DIST_PATH));
    app.get("*", (_req, res) => res.sendFile(path.join(process.env.UI_DIST_PATH, "index.html")));
  }

  app.use(globalErrorHandler);

  return app;
}

function createDefaultReadiness() {
  const executionMode = process.env.WORKER_EXECUTION_MODE || "local";

  return {
    status: "ok",
    environment: process.env.NODE_ENV || "development",
    executionMode,
    runtimeJobConfigured: Boolean(process.env.RUNTIME_CLOUD_RUN_JOB_NAME),
    runtimeServiceAccountConfigured: Boolean(process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL),
    runtimeBrokerConfigured: Boolean(process.env.RUNTIME_BROKER_URL)
  };
}

function assignRequestId(req, res, next) {
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  req.requestId = requestId;
  res.set("x-request-id", requestId);
  next();
}

function globalErrorHandler(error, req, res, _next) {
  const statusCode = error.statusCode || error.meta?.statusCode || 500;
  const safeStatusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;

  res.status(safeStatusCode).json({
    error: safeStatusCode >= 500 ? "internal error" : error.message,
    requestId: req.requestId
  });
}
