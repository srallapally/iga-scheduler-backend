import { CronExpressionParser } from "cron-parser";
import { getConfig } from "../config/index.js";
import { buildRunId } from "../utils/runId.js";

export class SchedulerTickService {
  constructor({ esClient, cloudTaskService, now = () => new Date(), batchSize = 100, config = getConfig(), indices = { instances: config.instancesIndex, runs: config.runsIndex } } = {}) {
    if (!esClient) throw new Error("esClient is required");
    if (!cloudTaskService) throw new Error("cloudTaskService is required");
    this.esClient = esClient;
    this.cloudTaskService = cloudTaskService;
    this.now = now;
    this.batchSize = batchSize;
    this.indices = indices;
  }

  async tick({ dryRun = false, enqueue = true, batchSize = this.batchSize } = {}) {
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const instances = await this.findDueInstances({ nowIso, batchSize });
    const summary = { status: "ok", checked: instances.length, createdRuns: 0, duplicates: 0, enqueued: 0, advanced: 0, failed: 0, dryRun, enqueue };

    for (const instance of instances) {
      const result = await this.processInstance({ instance, nowIso, dryRun, enqueue });
      summary.createdRuns += result.createdRuns;
      summary.duplicates += result.duplicates;
      summary.enqueued += result.enqueued;
      summary.advanced += result.advanced;
      summary.failed += result.failed;
    }

    return summary;
  }

  async findDueInstances({ nowIso, batchSize }) {
    const response = await this.esClient.search({ index: this.indices.instances, size: batchSize, sort: [{ nextFireAt: { order: "asc" } }], query: { bool: { filter: [{ term: { enabled: true } }, { term: { state: "ACTIVE" } }, { range: { nextFireAt: { lte: nowIso } } }] } } });
    return (response.hits?.hits || []).map((hit) => ({ _id: hit._id, ...hit._source }));
  }

  async processInstance({ instance, nowIso, dryRun, enqueue }) {
    const scheduledFireTime = instance.nextFireAt;
    const runId = buildRunId({ tenantId: instance.tenantId, instanceId: instance.instanceId, scheduledFireTime });
    const runDocument = this.buildRunDocument({ runId, instance, scheduledFireTime, nowIso });
    const result = { createdRuns: 0, duplicates: 0, enqueued: 0, advanced: 0, failed: 0 };

    if (!dryRun) {
      try {
        await this.esClient.create({ index: this.indices.runs, id: runId, document: runDocument, refresh: true });
        result.createdRuns = 1;
      } catch (error) {
        if (this.isConflict(error)) {
          result.duplicates = 1;
          await this.advanceInstance({ instance, scheduledFireTime, nowIso });
          result.advanced = 1;
          return result;
        }
        throw error;
      }

      if (enqueue) {
        try {
          await this.cloudTaskService.enqueueRun({ runId });
          result.enqueued = 1;
        } catch (error) {
          result.failed = 1;
          await this.markRunDispatchFailed({ runId, error, nowIso });
          return result;
        }
      }

      await this.advanceInstance({ instance, scheduledFireTime, nowIso });
      result.advanced = 1;
    }

    return result;
  }

  buildRunDocument({ runId, instance, scheduledFireTime, nowIso }) {
    return {
      runId,
      tenantId: instance.tenantId,
      definitionId: instance.definitionId,
      definitionVersion: instance.definitionVersion,
      instanceId: instance.instanceId,
      scheduledFireTime,
      state: "QUEUED",
      attempt: 1,
      params: instance.params || instance.parameters || {},
      createdAt: nowIso,
      startedAt: null,
      endedAt: null,
      heartbeatAt: null,
      status: { phase: "queued", message: "Run queued by scheduler tick" },
      feedback: {},
      result: null,
      error: null
    };
  }

  async advanceInstance({ instance, scheduledFireTime, nowIso }) {
    const nextFireAt = this.computeNextFireAt({ expression: this.getCronExpression(instance.schedule), timezone: instance.schedule?.timezone, scheduledFireTime });
    await this.esClient.update({ index: this.indices.instances, id: instance.instanceId, doc: { lastFireAt: scheduledFireTime, nextFireAt, updatedAt: nowIso }, refresh: true });
  }

  getCronExpression(schedule) { return schedule?.expression || schedule?.cron; }

  computeNextFireAt({ expression, timezone, scheduledFireTime }) {
    if (!expression) throw new Error("instance schedule expression is required");
    const interval = CronExpressionParser.parse(expression, { currentDate: new Date(scheduledFireTime), tz: timezone || "UTC" });
    return interval.next().toDate().toISOString();
  }

  async markRunDispatchFailed({ runId, error, nowIso }) {
    await this.esClient.update({ index: this.indices.runs, id: runId, doc: { state: "FAILED", endedAt: nowIso, error: { code: "DISPATCH_FAILED", message: error.message } }, refresh: true });
  }

  isConflict(error) { return error?.meta?.statusCode === 409 || error?.statusCode === 409; }
}
