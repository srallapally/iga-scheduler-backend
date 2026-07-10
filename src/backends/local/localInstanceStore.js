// InstanceStore-compatible class backed by SQLite.
// Interface is identical to src/stores/instanceStore.js so it drops in transparently.

const JSON_COLS_INSTANCE = new Set(["definition_parameter_schema", "schedule", "parameters"]);

function toRow(doc) {
  const row = {
    instance_id: doc.instanceId,
    tenant_id: doc.tenantId ?? null,
    definition_id: doc.definitionId,
    definition_version: doc.definitionVersion ?? null,
    definition_parameter_schema: doc.definitionParameterSchema ?? [],
    enabled: doc.enabled ? 1 : 0,
    state: doc.state,
    schedule: doc.schedule ?? null,
    next_fire_at: doc.nextFireAt ?? null,
    last_fire_at: doc.lastFireAt ?? null,
    parameters: doc.parameters ?? {},
    created_at: doc.createdAt,
    updated_at: doc.updatedAt
  };
  for (const col of JSON_COLS_INSTANCE) {
    if (row[col] !== null && row[col] !== undefined) {
      row[col] = JSON.stringify(row[col]);
    }
  }
  return row;
}

function fromRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  for (const col of JSON_COLS_INSTANCE) {
    if (parsed[col] != null) {
      try { parsed[col] = JSON.parse(parsed[col]); } catch { /* leave as-is */ }
    }
  }
  return {
    instanceId: parsed.instance_id,
    tenantId: parsed.tenant_id,
    definitionId: parsed.definition_id,
    definitionVersion: parsed.definition_version,
    definitionParameterSchema: parsed.definition_parameter_schema,
    enabled: parsed.enabled === 1 || parsed.enabled === true,
    state: parsed.state,
    schedule: parsed.schedule,
    nextFireAt: parsed.next_fire_at,
    lastFireAt: parsed.last_fire_at,
    parameters: parsed.parameters,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at
  };
}

export class LocalInstanceStore {
  constructor({ db }) {
    if (!db) throw new Error("db is required");
    this.db = db;
  }

  async createInstance(document) {
    const row = toRow(document);
    const cols = Object.keys(row);
    const updateCols = cols.filter((c) => c !== "instance_id");
    const updateClause = updateCols.map((c) => `${c} = excluded.${c}`).join(", ");
    const result = this.db.prepare(
      `INSERT INTO job_instances (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
       ON CONFLICT (instance_id) DO UPDATE SET ${updateClause}
       WHERE job_instances.state = 'DELETED'`
    ).run(...cols.map((c) => row[c]));
    if (result.changes === 0) {
      const err = new Error("instance already exists");
      err.statusCode = 409;
      throw err;
    }
    return document;
  }

  async getInstance(instanceId) {
    const row = this.db.prepare("SELECT * FROM job_instances WHERE instance_id = ?").get(instanceId);
    return fromRow(row ?? null);
  }

  async updateInstance(instanceId, doc) {
    const row = toRow(doc);
    const cols = Object.keys(row).filter((c) => c !== "instance_id");
    const setClause = cols.map((col) => `${col} = ?`).join(", ");
    const result = this.db.prepare(
      `UPDATE job_instances SET ${setClause} WHERE instance_id = ?`
    ).run(...cols.map((c) => row[c]), instanceId);
    if (result.changes === 0) {
      const err = new Error("instance not found");
      err.statusCode = 404;
      throw err;
    }
    const updated = this.db.prepare("SELECT * FROM job_instances WHERE instance_id = ?").get(instanceId);
    return fromRow(updated);
  }

  async listInstancesForDefinition(definitionId) {
    const rows = this.db.prepare(
      "SELECT * FROM job_instances WHERE definition_id = ? ORDER BY updated_at DESC"
    ).all(definitionId);
    return rows.map(fromRow);
  }

  // client is ignored — SQLite is single-writer; surrounding BEGIN from LocalPool serialises
  async claimDueInstances(_client, { nowIso, batchSize }) {
    const rows = this.db.prepare(
      `SELECT * FROM job_instances
       WHERE enabled = 1 AND state = 'ACTIVE' AND next_fire_at <= ?
       ORDER BY next_fire_at LIMIT ?`
    ).all(nowIso, batchSize);
    return rows.map(fromRow);
  }

  async advanceInstance(_client, { instanceId, lastFireAt, nextFireAt, nowIso }) {
    this.db.prepare(
      `UPDATE job_instances SET last_fire_at = ?, next_fire_at = ?, updated_at = ? WHERE instance_id = ?`
    ).run(lastFireAt, nextFireAt, nowIso, instanceId);
  }
}
