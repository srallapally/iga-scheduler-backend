import express from "express";

export function createInternalWorkerPlaceholderRouter() {
  const router = express.Router();

  router.post("/:runId/execute", async (req, res) => {
    const runId = decodeURIComponent(req.params.runId);

    if (!runId) {
      return res.status(400).json({
        error: "runId is required"
      });
    }

    return res.status(202).json({
      status: "accepted",
      runId,
      message: "Worker execution is deferred to Phase 6"
    });
  });

  return router;
}
