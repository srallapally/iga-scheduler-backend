import express from "express";

export function createJobRunRouter({ runStore } = {}) {
  const router = express.Router();

  router.get("/:runId", async (req, res) => {
    if (!runStore) return res.status(503).json({ error: "runStore not available" });
    const run = await runStore.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: "run not found" });
    res.json(toPublicRun(run));
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
