import express from "express";
import { RunControlService } from "../services/runControlService.js";

export function createJobRunRouter({ runStore, runControlService } = {}) {
  const router = express.Router();

  let _rcs;
  function getRcs() {
    if (runControlService) return runControlService;
    if (!runStore) return null;
    if (!_rcs) _rcs = new RunControlService({ runStore });
    return _rcs;
  }

  router.get("/:runId", async (req, res) => {
    if (!runStore) return res.status(503).json({ error: "runStore not available" });
    const run = await runStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "run not found" });
    res.json(toPublicRun(run));
  });

  router.post("/:runId/cancel", async (req, res, next) => {
    const rcs = getRcs();
    if (!rcs) return res.status(503).json({ error: "runStore not available" });
    try {
      const result = await rcs.cancelRun({
        runId: req.params.runId,
        reason: req.body?.reason,
        cancelledBy: req.publicAuth?.clientId || "admin-ui",
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Mounted at /job-instances — serves /job-instances/:instanceId/runs
export function createInstanceRunRouter({ runStore } = {}) {
  const router = express.Router();

  router.get("/:instanceId/runs", async (req, res) => {
    if (!runStore) return res.status(503).json({ error: "runStore not available" });
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    const state = req.query.state || undefined;
    const items = await runStore.listRunsForInstance({ instanceId: req.params.instanceId, limit, state });
    res.json({ items: items.map(toPublicRun) });
  });

  return router;
}

// runtimeExecution is broker-internal launch metadata — omitted from public responses
function toPublicRun(run) {
  const { runtimeExecution: _omit, ...rest } = run;
  return rest;
}
