export class RunStore {
  constructor({ pool }) {
    if (!pool) throw new Error("pool is required");
    this.pool = pool;
  }

  async getRun(runId) {
    const { rows } = await this.pool.query("SELECT * FROM job_runs WHERE run_id = $1", [runId]);
    return rows.length ? rowToDocument(rows[0]) : null;
  }

  async createRun(document) {
    const row = documentToRow(document);
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const { rowCount } = await this.pool.query(
      `INSERT INTO job_runs (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT (run_id) DO NOTHING`,
      cols.map((c) => row[c])
    );
    return { created: rowCount === 1 };
  }

  async claimRun({ runId, startedAt, status }) {
    const { rows } = await this.pool.query(
      `UPDATE job_runs
         SET state = 'RUNNING', started_at = $2, heartbeat_at = $2, status = $3, updated_at = $2
       WHERE run_id = $1 AND state = 'QUEUED'
       RETURNING run_id`,
      [runId, startedAt, status ?? { phase: "running", message: "Run claimed by worker" }]
    );
    if (rows.length) return { claimed: true };
    const exists = await this.pool.query("SELECT 1 FROM job_runs WHERE run_id = $1", [runId]);
    return exists.rows.length ? { claimed: false } : { claimed: false, missing: true };
  }

  async recordRuntimeExecution({ runId, runtimeExecution, startedAt, status }) {
    const { rows } = await this.pool.query(
      `UPDATE job_runs
         SET runtime_execution = $2, heartbeat_at = $3, status = $4, updated_at = $3
       WHERE run_id = $1 AND state = 'RUNNING'
       RETURNING run_id`,
      [runId, runtimeExecution, startedAt, status ?? { phase: "dispatched", message: "Run dispatched to isolated runtime" }]
    );
    return rows.length > 0;
  }

  async markSucceeded({ runId, endedAt, result, status }) {
    const { rows } = await this.pool.query(
      `UPDATE job_runs
         SET state = 'SUCCEEDED', ended_at = $2, heartbeat_at = $2,
             status = $3, result = $4, error = NULL, updated_at = $2
       WHERE run_id = $1 AND state = 'RUNNING'
       RETURNING run_id`,
      [runId, endedAt, status ?? { phase: "succeeded", message: "Run completed successfully" }, result ?? null]
    );
    return rows.length > 0;
  }

  async markFailed({ runId, endedAt, error, status }) {
    const { rows } = await this.pool.query(
      `UPDATE job_runs
         SET state = 'FAILED', ended_at = $2, heartbeat_at = $2,
             status = $3, error = $4, updated_at = $2
       WHERE run_id = $1 AND state = 'RUNNING'
       RETURNING run_id`,
      [runId, endedAt, status ?? { phase: "failed", message: "Run failed in worker runtime executor" }, error ?? null]
    );
    return rows.length > 0;
  }

  async transition({ runId, fromStates, set }) {
    const setCols = Object.keys(set);
    const setClause = setCols.map((col, i) => `${camel2snake(col)} = $${i + 3}`).join(", ");
    const vals = [runId, fromStates, ...setCols.map((c) => set[c])];
    const { rows } = await this.pool.query(
      `UPDATE job_runs SET ${setClause}, updated_at = now()
       WHERE run_id = $1 AND state = ANY($2)
       RETURNING *`,
      vals
    );
    return rows.length ? rowToDocument(rows[0]) : null;
  }

  async createRunTx(client, document) {
    const row = documentToRow(document);
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const { rowCount } = await client.query(
      `INSERT INTO job_runs (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT (run_id) DO NOTHING`,
      cols.map((c) => row[c])
    );
    return { created: rowCount === 1 };
  }

  async listStaleRunningIds({ thresholdMs, limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT run_id FROM job_runs
       WHERE state = 'RUNNING'
         AND started_at < now() - ($1 * interval '1 millisecond')
       ORDER BY started_at
       LIMIT $2`,
      [thresholdMs, limit]
    );
    return rows.map((r) => r.run_id);
  }

  async listStaleCancellingIds({ thresholdMs, limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT run_id FROM job_runs
       WHERE state = 'CANCELLING'
         AND started_at < now() - ($1 * interval '1 millisecond')
       ORDER BY started_at
       LIMIT $2`,
      [thresholdMs, limit]
    );
    return rows.map((r) => r.run_id);
  }

  async markCancelled({ runId, endedAt, error, status } = {}) {
    const { rows } = await this.pool.query(
      `UPDATE job_runs
         SET state = 'CANCELLED', ended_at = $2, heartbeat_at = $2,
             status = $3, error = $4, updated_at = $2
       WHERE run_id = $1 AND state = 'CANCELLING'
       RETURNING run_id`,
      [runId, endedAt, status ?? { phase: "cancelled", message: "Run force-cancelled by stale sweeper" }, error ?? null]
    );
    return rows.length > 0;
  }

  async listQueuedRunIds({ limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      "SELECT run_id FROM job_runs WHERE state = 'QUEUED' ORDER BY created_at LIMIT $1",
      [limit]
    );
    return rows.map((r) => r.run_id);
  }

  async listRunsForInstance({ instanceId, limit = 50, state } = {}) {
    if (state) {
      const { rows } = await this.pool.query(
        "SELECT * FROM job_runs WHERE instance_id = $1 AND state = $2 ORDER BY created_at DESC LIMIT $3",
        [instanceId, state, limit]
      );
      return rows.map(rowToDocument);
    }
    const { rows } = await this.pool.query(
      "SELECT * FROM job_runs WHERE instance_id = $1 ORDER BY created_at DESC LIMIT $2",
      [instanceId, limit]
    );
    return rows.map(rowToDocument);
  }
}

// ---------------------------------------------------------------------------
// Column ↔ document mapping
// ---------------------------------------------------------------------------

const TIMESTAMP_COLS = new Set([
  "next_fire_at", "last_fire_at", "scheduled_fire_time",
  "cancel_requested_at", "cancelled_at",
  "created_at", "started_at", "ended_at", "heartbeat_at", "updated_at"
]);

function rowToDocument(row) {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    scheduledFireTime: toIso(row.scheduled_fire_time),
    state: row.state,
    attempt: row.attempt,
    dispatchId: row.dispatch_id,
    params: row.params,
    status: row.status,
    result: row.result,
    error: row.error,
    runtimeExecution: row.runtime_execution,
    parentRunId: row.parent_run_id,
    redriveOfRunId: row.redrive_of_run_id,
    cancelRequestedAt: toIso(row.cancel_requested_at),
    cancelledAt: toIso(row.cancelled_at),
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    heartbeatAt: toIso(row.heartbeat_at),
    updatedAt: toIso(row.updated_at)
  };
}

function documentToRow(doc) {
  return {
    run_id: doc.runId,
    tenant_id: doc.tenantId ?? null,
    instance_id: doc.instanceId,
    definition_id: doc.definitionId,
    definition_version: doc.definitionVersion ?? null,
    scheduled_fire_time: doc.scheduledFireTime,
    state: doc.state,
    attempt: doc.attempt ?? 1,
    dispatch_id: doc.dispatchId ?? null,
    params: doc.params ?? {},
    status: doc.status ?? null,
    result: doc.result ?? null,
    error: doc.error ?? null,
    runtime_execution: doc.runtimeExecution ?? null,
    parent_run_id: doc.parentRunId ?? null,
    redrive_of_run_id: doc.redriveOfRunId ?? null,
    cancel_requested_at: doc.cancelRequestedAt ?? null,
    cancelled_at: doc.cancelledAt ?? null,
    cancelled_by: doc.cancelledBy ?? null,
    cancel_reason: doc.cancelReason ?? null,
    created_at: doc.createdAt,
    started_at: doc.startedAt ?? null,
    ended_at: doc.endedAt ?? null,
    heartbeat_at: doc.heartbeatAt ?? null,
    updated_at: doc.updatedAt
  };
}

function toIso(val) {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}

// camelCase → snake_case for the transition() set builder
function camel2snake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
