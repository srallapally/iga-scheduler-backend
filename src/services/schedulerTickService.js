import { CronExpressionParser } from "cron-parser";
import { buildRunId } from "../utils/runId.js";

export class SchedulerTickService {
  constructor({ instanceStore, runStore, pool, now = () => new Date(), batchSize = 100 } = {}) {
    if (!instanceStore) throw new Error("instanceStore is required");
    if (!runStore) throw new Error("runStore is required");
    if (!pool) throw new Error("pool is required");
    this.instanceStore = instanceStore;
    this.runStore = runStore;
    this.pool = pool;
    this.now = now;
    this.batchSize = batchSize;
  }

  async tick({ dryRun = false, batchSize = this.batchSize } = {}) {
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const summary = { status: "ok", checked: 0, createdRuns: 0, duplicates: 0, enqueued: 0, advanced: 0, failed: 0, dryRun, enqueue: false };

    if (dryRun) {
      const instances = await this.instanceStore.claimDueInstances(this.pool, { nowIso, batchSize, forUpdate: false });
      summary.checked = instances.length;
      return summary;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const instances = await this.instanceStore.claimDueInstances(client, { nowIso, batchSize });
      summary.checked = instances.length;

      for (let i = 0; i < instances.length; i++) {
        const instance = instances[i];
        const sp = `sp_${i}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const scheduledFireTime = instance.nextFireAt;
          // compute next fire first — cron parse errors abort this instance before any writes
          const nextFireAt = this.computeNextFireAt({ expression: this.getCronExpression(instance.schedule), timezone: instance.schedule?.timezone, scheduledFireTime });
          const runId = buildRunId({ tenantId: instance.tenantId, instanceId: instance.instanceId, scheduledFireTime });
          const runDoc = this.buildRunDocument({ runId, instance, scheduledFireTime, nowIso });
          const { created } = await this.runStore.createRunTx(client, runDoc);
          if (created) { summary.createdRuns++; } else { summary.duplicates++; }
          await this.instanceStore.advanceInstance(client, { instanceId: instance.instanceId, lastFireAt: scheduledFireTime, nextFireAt, nowIso });
          summary.advanced++;
          await client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          summary.failed++;
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return summary;
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

  getCronExpression(schedule) { return schedule?.expression || schedule?.cron; }

  computeNextFireAt({ expression, timezone, scheduledFireTime }) {
    if (!expression) throw new Error("instance schedule expression is required");
    const interval = CronExpressionParser.parse(expression, { currentDate: new Date(scheduledFireTime), tz: timezone || "UTC" });
    return interval.next().toDate().toISOString();
  }
}
