-- up migration

CREATE TABLE job_instances (
  instance_id                 text PRIMARY KEY,
  tenant_id                   text,
  definition_id               text NOT NULL,
  definition_version          integer NOT NULL,
  definition_parameter_schema jsonb NOT NULL DEFAULT '[]',
  enabled                     boolean NOT NULL,
  state                       text NOT NULL,
  schedule                    jsonb NOT NULL,
  next_fire_at                timestamptz,
  last_fire_at                timestamptz,
  parameters                  jsonb NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL
);

CREATE INDEX idx_job_instances_due
  ON job_instances (next_fire_at)
  WHERE enabled AND state = 'ACTIVE';

CREATE TABLE job_runs (
  run_id              text PRIMARY KEY,
  tenant_id           text,
  instance_id         text NOT NULL,
  definition_id       text NOT NULL,
  definition_version  integer,
  scheduled_fire_time timestamptz NOT NULL,
  state               text NOT NULL,
  attempt             integer NOT NULL DEFAULT 1,
  dispatch_id         text,
  params              jsonb NOT NULL DEFAULT '{}',
  status              jsonb,
  result              jsonb,
  error               jsonb,
  runtime_execution   jsonb,
  parent_run_id       text,
  redrive_of_run_id   text,
  cancel_requested_at timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        text,
  cancel_reason       text,
  created_at          timestamptz NOT NULL,
  started_at          timestamptz,
  ended_at            timestamptz,
  heartbeat_at        timestamptz,
  updated_at          timestamptz NOT NULL
);

CREATE INDEX idx_job_runs_queued   ON job_runs (created_at) WHERE state = 'QUEUED';
CREATE INDEX idx_job_runs_instance ON job_runs (instance_id, created_at DESC);

-- down migration

DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS job_instances;
