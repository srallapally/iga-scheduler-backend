-- up migration

ALTER TABLE job_runs ADD COLUMN execution_metadata jsonb;

-- down migration

ALTER TABLE job_runs DROP COLUMN IF EXISTS execution_metadata;
