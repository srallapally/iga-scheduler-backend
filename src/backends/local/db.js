import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import path from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  instance_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  definition_version INTEGER,
  scheduled_fire_time TEXT,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  dispatch_id TEXT,
  params TEXT,
  status TEXT,
  result TEXT,
  error TEXT,
  runtime_execution TEXT,
  parent_run_id TEXT,
  redrive_of_run_id TEXT,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_instances (
  instance_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  definition_id TEXT NOT NULL,
  definition_version INTEGER,
  definition_parameter_schema TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  schedule TEXT,
  next_fire_at TEXT,
  last_fire_at TEXT,
  parameters TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_definitions (
  definition_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  state TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  run_id TEXT,
  data TEXT,
  created_at TEXT NOT NULL
);
`;

export function createLocalDb(dataDir = process.env.LOCAL_DATA_DIR || ".local-data") {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
  db.exec(SCHEMA);
  return db;
}
