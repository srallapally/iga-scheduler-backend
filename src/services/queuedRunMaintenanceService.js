import { getConfig } from "../config/index.js";

const DEFAULT_MAX_QUEUED_AGE_SECONDS = 60 * 60;

export class QueuedRunMaintenanceService {
  constructor({ esClient, cloudTaskService, now = () => new Date(), config = getConfig(), runsIndex = config.runsIndex } = {}) {
    if (!esClient) throw new Error("esClient is required");
    if (!cloudTaskService) throw new Error("cloudTaskService is required");
    this.esClient = esClient;
    this.cloudTaskService = cloudTaskService;
    this.now = now;
    this.runsIndex = runsIndex;
  }

  async reconcileQueuedRuns({ maxAgeSeconds = DEFAULT_MAX_QUEUED_AGE_SECONDS, batchSize = 100, redriveRecent = false, dryRun = false } = {}) {
    if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error("maxAgeSeconds must be a positive number");
    if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("batchSize must be a positive integer");
    const now = this.now();
    const cutoff = new Date(now.getTime() - maxAgeSeconds * 1000).toISOString();
    const queuedRuns = await this.findQueuedRuns({ batchSize });
    const summary = { status: "ok", checked: queuedRuns.length, expired: 0, redriven: 0, skippedRecent: 0, failed: 0, dryRun, redriveRecent };
    for (const run of queuedRuns) {
      const isStale = run.createdAt <= cutoff;
      if (isStale) {
        if (!dryRun) await this.expireRun({ run, nowIso: now.toISOString() });
        summary.expired += 1;
        continue;
      }
      if (!redriveRecent) { summary.skippedRecent += 1; continue; }
      if (!dryRun) {
        try { await this.cloudTaskService.enqueueRun({ runId: run.runId }); summary.redriven += 1; } catch { summary.failed += 1; }
      }
    }
    return summary;
  }

  async findQueuedRuns({ batchSize }) {
    const response = await this.esClient.search({ index: this.runsIndex, size: batchSize, query: { bool: { filter: [{ term: { state: "QUEUED" } }] } } });
    return (response.hits?.hits || []).map((hit) => ({ _id: hit._id, ...hit._source }));
  }

  async expireRun({ run, nowIso }) {
    await this.esClient.update({ index: this.runsIndex, id: run.runId, doc: { state: "FAILED", endedAt: nowIso, error: { code: "QUEUED_RUN_EXPIRED", message: "Queued run expired before worker execution", retry: { retryable: false, classification: "NON_RETRYABLE", reason: "queued_run_expired" } } }, refresh: true });
  }
}
