export class InstanceStore {
  constructor({ pool }) {
    if (!pool) throw new Error("pool is required");
    this.pool = pool;
  }

  async createInstance(document) {
    const row = documentToRow(document);
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const { rowCount } = await this.pool.query(
      `INSERT INTO job_instances (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT (instance_id) DO NOTHING`,
      cols.map((c) => row[c])
    );
    if (rowCount === 0) {
      const err = new Error("instance already exists");
      err.statusCode = 409;
      throw err;
    }
    return document;
  }

  async getInstance(instanceId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM job_instances WHERE instance_id = $1",
      [instanceId]
    );
    return rows.length ? rowToDocument(rows[0]) : null;
  }

  async updateInstance(instanceId, doc) {
    const row = documentToRow(doc);
    const cols = Object.keys(row).filter((c) => c !== "instance_id");
    const setClause = cols.map((col, i) => `${col} = $${i + 2}`).join(", ");
    const vals = [instanceId, ...cols.map((c) => row[c])];
    const { rows } = await this.pool.query(
      `UPDATE job_instances SET ${setClause} WHERE instance_id = $1 RETURNING *`,
      vals
    );
    if (!rows.length) {
      const err = new Error("instance not found");
      err.statusCode = 404;
      throw err;
    }
    return rowToDocument(rows[0]);
  }

  async listInstancesForDefinition(definitionId) {
    const { rows } = await this.pool.query(
      "SELECT * FROM job_instances WHERE definition_id = $1 ORDER BY updated_at DESC",
      [definitionId]
    );
    return rows.map(rowToDocument);
  }

  async claimDueInstances(client, { nowIso, batchSize, forUpdate = true }) {
    const lock = forUpdate ? "FOR UPDATE SKIP LOCKED" : "";
    const { rows } = await client.query(
      `SELECT * FROM job_instances
       WHERE enabled AND state = 'ACTIVE' AND next_fire_at <= $1
       ORDER BY next_fire_at
       LIMIT $2
       ${lock}`,
      [nowIso, batchSize]
    );
    return rows.map(rowToDocument);
  }

  async advanceInstance(client, { instanceId, lastFireAt, nextFireAt, nowIso }) {
    await client.query(
      `UPDATE job_instances
         SET last_fire_at = $2, next_fire_at = $3, updated_at = $4
       WHERE instance_id = $1`,
      [instanceId, lastFireAt, nextFireAt, nowIso]
    );
  }
}

// ---------------------------------------------------------------------------
// Column ↔ document mapping
// ---------------------------------------------------------------------------

function rowToDocument(row) {
  return {
    instanceId: row.instance_id,
    tenantId: row.tenant_id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    definitionParameterSchema: row.definition_parameter_schema,
    enabled: row.enabled,
    state: row.state,
    schedule: row.schedule,
    nextFireAt: toIso(row.next_fire_at),
    lastFireAt: toIso(row.last_fire_at),
    parameters: row.parameters,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function documentToRow(doc) {
  return {
    instance_id: doc.instanceId,
    tenant_id: doc.tenantId ?? null,
    definition_id: doc.definitionId,
    definition_version: doc.definitionVersion,
    definition_parameter_schema: doc.definitionParameterSchema ?? [],
    enabled: doc.enabled,
    state: doc.state,
    schedule: doc.schedule,
    next_fire_at: doc.nextFireAt ?? null,
    last_fire_at: doc.lastFireAt ?? null,
    parameters: doc.parameters ?? {},
    created_at: doc.createdAt,
    updated_at: doc.updatedAt
  };
}

function toIso(val) {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return val;
}
