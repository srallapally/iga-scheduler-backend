// pg-pool-shaped adapter over SQLite so SchedulerTickService works without modification.
// SQLite is single-writer — the surrounding BEGIN/COMMIT provides serialisation equivalent
// to Postgres FOR UPDATE SKIP LOCKED at the transaction level.

const CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK TO SAVEPOINT|ROLLBACK TO|RELEASE SAVEPOINT|ROLLBACK|SAVEPOINT)\b/i;

export function execSqlite(db, sql, params = []) {
  const trimmed = sql.trim();

  if (CONTROL_RE.test(trimmed)) {
    db.exec(trimmed);
    return { rows: [], rowCount: 0 };
  }

  const upper = trimmed.toUpperCase();
  const stmt = db.prepare(trimmed);

  if (upper.startsWith("SELECT")) {
    const rows = stmt.all(...params);
    return { rows, rowCount: rows.length };
  }

  const result = stmt.run(...params);
  return { rows: [], rowCount: result.changes ?? 0 };
}

class LocalClient {
  constructor(db) {
    this.db = db;
  }

  async query(sql, params = []) {
    return execSqlite(this.db, sql, params);
  }

  release() {}
}

export class LocalPool {
  constructor(db) {
    this.db = db;
  }

  async query(sql, params = []) {
    return execSqlite(this.db, sql, params);
  }

  async connect() {
    return new LocalClient(this.db);
  }

  async end() {}
}
