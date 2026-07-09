// RunStore-compatible class backed by SQLite.
// Interface is identical to src/stores/runStore.js so it drops in transparently.

const JSON_COLS = new Set(["params", "status", "result", "error", "runtime_execution"]);

function toRow(doc) {
  const row = {
    run_id: doc.runId,
    tenant_id: doc.tenantId ?? null,
    instance_id: doc.instanceId,
    definition_id: doc.definitionId,
    definition_version: doc.definitionVersion ?? null,
    scheduled_fire_time: doc.scheduledFireTime ?? null,
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
    updated_at: doc.updatedAt ?? doc.createdAt
  };
  // Serialise JSON columns
  for (const col of JSON_COLS) {
    if (row[col] !== null && row[col] !== undefined) {
      row[col] = JSON.stringify(row[col]);
    }
  }
  return row;
}

function fromRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  for (const col of JSON_COLS) {
    if (parsed[col] != null) {
      try { parsed[col] = JSON.parse(parsed[col]); } catch { /* leave as-is */ }
    }
  }
  return {
    runId: parsed.run_id,
    tenantId: parsed.tenant_id,
    instanceId: parsed.instance_id,
    definitionId: parsed.definition_id,
    definitionVersion: parsed.definition_version,
    scheduledFireTime: parsed.scheduled_fire_time,
    state: parsed.state,
    attempt: parsed.attempt,
    dispatchId: parsed.dispatch_id,
    params: parsed.params,
    status: parsed.status,
    result: parsed.result,
    error: parsed.error,
    runtimeExecution: parsed.runtime_execution,
    parentRunId: parsed.parent_run_id,
    redriveOfRunId: parsed.redrive_of_run_id,
    cancelRequestedAt: parsed.cancel_requested_at,
    cancelledAt: parsed.cancelled_at,
    cancelledBy: parsed.cancelled_by,
    cancelReason: parsed.cancel_reason,
    createdAt: parsed.created_at,
    startedAt: parsed.started_at,
    endedAt: parsed.ended_at,
    heartbeatAt: parsed.heartbeat_at,
    updatedAt: parsed.updated_at
  };
}

export class LocalRunStore {
  constructor({ db }) {
    if (!db) throw new Error("db is required");
    this.db = db;
  }

  async getRun(runId) {
    const row = this.db.prepare("SELECT * FROM job_runs WHERE run_id = ?").get(runId);
    return fromRow(row ?? null);
  }

  async createRun(document) {
    return this._insertRun(document);
  }

  async createRunTx(_client, document) {
    // SQLite is single-writer; ignore the client, use db directly
    return this._insertRun(document);
  }

  _insertRun(document) {
    const row = toRow(document);
    const cols = Object.keys(row);
    const placeholders = cols.map(() => "?").join(", ");
    const result = this.db.prepare(
      `INSERT INTO job_runs (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (run_id) DO NOTHING`
    ).run(...cols.map((c) => row[c]));
    return { created: result.changes === 1 };
  }

  async claimRun({ runId, startedAt, status }) {
    const statusJson = status ? JSON.stringify(status) : JSON.stringify({ phase: "running", message: "Run claimed by worker" });
    const result = this.db.prepare(
      `UPDATE job_runs SET state='RUNNING', started_at=?, heartbeat_at=?, status=?, updated_at=?
       WHERE run_id=? AND state='QUEUED'`
    ).run(startedAt, startedAt, statusJson, startedAt, runId);
    if (result.changes > 0) return { claimed: true };
    const exists = this.db.prepare("SELECT 1 FROM job_runs WHERE run_id=?").get(runId);
    return exists ? { claimed: false } : { claimed: false, missing: true };
  }

  async recordRuntimeExecution({ runId, runtimeExecution, startedAt, status }) {
    const statusJson = status ? JSON.stringify(status) : JSON.stringify({ phase: "dispatched", message: "Run dispatched to isolated runtime" });
    const result = this.db.prepare(
      `UPDATE job_runs SET runtime_execution=?, heartbeat_at=?, status=?, updated_at=?
       WHERE run_id=? AND state='RUNNING'`
    ).run(JSON.stringify(runtimeExecution), startedAt, statusJson, startedAt, runId);
    return result.changes > 0;
  }

  async markSucceeded({ runId, endedAt, result, status }) {
    const statusJson = status ? JSON.stringify(status) : JSON.stringify({ phase: "succeeded", message: "Run completed successfully" });
    const r = this.db.prepare(
      `UPDATE job_runs SET state='SUCCEEDED', ended_at=?, heartbeat_at=?, status=?, result=?, error=NULL, updated_at=?
       WHERE run_id=? AND state='RUNNING'`
    ).run(endedAt, endedAt, statusJson, result != null ? JSON.stringify(result) : null, endedAt, runId);
    return r.changes > 0;
  }

  async markFailed({ runId, endedAt, error, status }) {
    const statusJson = status ? JSON.stringify(status) : JSON.stringify({ phase: "failed", message: "Run failed in worker runtime executor" });
    const r = this.db.prepare(
      `UPDATE job_runs SET state='FAILED', ended_at=?, heartbeat_at=?, status=?, error=?, updated_at=?
       WHERE run_id=? AND state='RUNNING'`
    ).run(endedAt, endedAt, statusJson, error != null ? JSON.stringify(error) : null, endedAt, runId);
    return r.changes > 0;
  }

  async transition({ runId, fromStates, set }) {
    const setCols = Object.keys(set);
    const setClause = setCols.map((col) => `${camel2snake(col)} = ?`).join(", ");
    const placeholders = [...setCols.map((c) => {
      const v = set[c];
      return v != null && typeof v === "object" ? JSON.stringify(v) : v;
    }), runId, ...fromStates];
    const r = this.db.prepare(
      `UPDATE job_runs SET ${setClause}, updated_at = datetime('now')
       WHERE run_id = ? AND state IN (${fromStates.map(() => "?").join(", ")})`
    ).run(...placeholders);
    if (r.changes === 0) return null;
    const row = this.db.prepare("SELECT * FROM job_runs WHERE run_id = ?").get(runId);
    return fromRow(row);
  }

  async listQueuedRunIds({ limit = 100 } = {}) {
    const rows = this.db.prepare(
      "SELECT run_id FROM job_runs WHERE state='QUEUED' ORDER BY created_at LIMIT ?"
    ).all(limit);
    return rows.map((r) => r.run_id);
  }

  async listRunsForInstance({ instanceId, limit = 50, state } = {}) {
    if (state) {
      const rows = this.db.prepare(
        "SELECT * FROM job_runs WHERE instance_id=? AND state=? ORDER BY created_at DESC LIMIT ?"
      ).all(instanceId, state, limit);
      return rows.map(fromRow);
    }
    const rows = this.db.prepare(
      "SELECT * FROM job_runs WHERE instance_id=? ORDER BY created_at DESC LIMIT ?"
    ).all(instanceId, limit);
    return rows.map(fromRow);
  }
}

function camel2snake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
