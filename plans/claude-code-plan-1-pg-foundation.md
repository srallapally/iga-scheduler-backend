# Claude Code Plan 1: Postgres Foundation

## Context

The scheduler currently uses Elasticsearch for all state. This plan adds the Postgres layer that plans 2–4 build on: dependencies, schema migrations, an engine-selectable connection factory (Cloud SQL connector, or direct `DATABASE_URL` — the AlloyDB and local-dev path), and config/validation. No existing behavior changes in this plan — the new code is inert until plan 2 wires it in.

## Assumptions

- Node 22, ESM, existing repo layout as reviewed.
- `node-pg-migrate` for migrations; plain `pg` Pool for access. No ORM, no query builder.
- The Cloud SQL connector is imported dynamically only when `DB_ENGINE=cloud-sql`. AlloyDB has no Node connector; it is reached via `DB_ENGINE=direct` + the AlloyDB Auth Proxy sidecar (or private IP).
- Local development and tests use `DB_ENGINE=direct` with `DATABASE_URL` against a local Postgres (Docker or testcontainers).
- All SQL is portable Postgres — nothing AlloyDB-only, ever. This is the compatibility invariant that makes `DB_ENGINE` an honest switch.

## Out of Scope

- Any change to WorkerRunService, tick, routes, or ES usage (plans 2–4).
- Terraform / provisioning execution. Cloud SQL and AlloyDB setup are documented operator steps.
- Tenant enforcement (columns exist as nullable placeholders to avoid a later migration; nothing reads them).

## Stop Condition

Stop when all steps are complete, `npm test` passes, and `npm run migrate:up` applies cleanly against a local Postgres. Do not run docker, gcloud, or deployment commands.

---

## Step 1.1 — Dependencies and scripts

**File:** `package.json`

Add dependencies: `pg`, `node-pg-migrate`, `@google-cloud/cloud-sql-connector`.

> There is **no** AlloyDB Node.js connector — AlloyDB language connectors exist for Java, Python, and Go only, and the Cloud SQL connector does not support AlloyDB. AlloyDB connectivity for Node is via the AlloyDB Auth Proxy (sidecar) or direct private-IP TCP, both of which are plain `pg` connections (`DB_ENGINE=direct`).

Add scripts:

```json
"migrate:up": "node-pg-migrate up --migrations-dir migrations",
"migrate:down": "node-pg-migrate down --migrations-dir migrations"
```

### Acceptance criteria
- `npm install` succeeds; no existing dependency versions change.

## Step 1.2 — Migration 001: instances and runs

**File:** `migrations/001_scheduler_core.sql` (use node-pg-migrate's SQL-file support)

```sql
-- migrations/001_scheduler_core.sql
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
```

Notes:
- Column set mirrors the current ES run document (including RunControlService's cancel/redrive fields) so plan 2 is a persistence swap, not a model redesign.
- `run_id` stays the deterministic `tenantId:instanceId:scheduledFireTime` string; the PK is the dedup mechanism (`ON CONFLICT DO NOTHING` in the tick).

### Acceptance criteria
- `npm run migrate:up` against a fresh local Postgres creates both tables and indexes; `migrate:down` reverses cleanly.

## Step 1.3 — Engine-selectable connection factory

**File:** `src/clients/pgClient.js`

```js
// src/clients/pgClient.js
import pg from "pg";

const ENGINES = new Set(["cloud-sql", "direct"]);

export async function createPgPool({ env = process.env } = {}) {
  const engine = env.DB_ENGINE || "direct";
  if (!ENGINES.has(engine)) throw new Error(`unsupported DB_ENGINE: ${engine}`);

  if (engine === "direct") {
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required when DB_ENGINE=direct");
    return new pg.Pool({ connectionString: env.DATABASE_URL });
  }

  const { Connector } = await import("@google-cloud/cloud-sql-connector");
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: required(env, "DB_INSTANCE_CONNECTION_NAME"),
    ipType: env.DB_IP_TYPE || "PRIVATE"
  });
  return new pg.Pool({
    ...clientOpts,
    user: required(env, "DB_USER"),
    database: required(env, "DB_NAME"),
    password: env.DB_PASSWORD
  });
}

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is required for DB_ENGINE=${env.DB_ENGINE}`);
  return env[name];
}
```

This factory is the **entire** engine switch. No file downstream of it may import the connector or read `DB_ENGINE`.

**AlloyDB path:** `DB_ENGINE=direct` with `DATABASE_URL` pointing at the AlloyDB Auth Proxy (deployed as a Cloud Run sidecar, listening on localhost) or at the instance's private IP. Record this in ADR 0004 and the operator notes; no application code differs between Cloud SQL and AlloyDB beyond the factory branch.

> Verify the exact export name of `@google-cloud/cloud-sql-connector` against the installed version before finalizing (documented API is `Connector`).

### Acceptance criteria
- `createPgPool` with `DB_ENGINE=direct` and `DATABASE_URL` returns a working Pool (integration test against local PG).
- Unknown engine throws. Missing per-engine vars throw with the var name in the message.
- The Cloud SQL connector is only imported when `DB_ENGINE=cloud-sql` (unit test: `direct` path resolves with the connector package mocked to throw on import).

## Step 1.4 — Config and production validation

**Files:** `src/config/index.js`, `src/config/productionValidation.js`

- `getConfig()`: add `dbEngine` (default `direct`). Do not remove `runsIndex`/`instancesIndex` yet (plan 4).
- `validateProductionStartupConfig()`: require `DB_ENGINE` in production and the matching connection vars: `cloud-sql` → `DB_INSTANCE_CONNECTION_NAME` + `DB_USER` + `DB_NAME`; `direct` → `DATABASE_URL`. Reject production `DB_ENGINE=direct` unless `DB_ALLOW_DIRECT=true` — this is the documented setting for AlloyDB (auth-proxy sidecar) and other proxy-based deployments.

### Acceptance criteria
- Production validation fails with a named-variable error for each missing pairing; passes with a complete `cloud-sql` set and with `direct` + `DB_ALLOW_DIRECT=true` + `DATABASE_URL` (the AlloyDB deployment shape).
- Non-production behavior unchanged.

## Step 1.5 — ADR documents

**Files:** `docs/adr/0004-postgres-run-coordination.md`, `docs/adr/0005-public-api-auth-pingone.md`

- **0004:** decision (Cloud SQL regional HA; AlloyDB switchable — no Node connector exists, so the AlloyDB path is `DB_ENGINE=direct` + Auth Proxy sidecar; portable-SQL invariant), D1 outcome (Postgres-as-queue, direct on `job_runs`, no pg-boss — record the rationale), D2 outcome (instances in PG), unchanged run state machine, ES demotion to definitions+audit, and the consequence inventory (what plans 2–4 delete).
- **0005:** PingOne as AS, client-credentials only, JWKS validation, single coarse scope to start, tenant scoping explicitly deferred with the runs-read-path concern named.

### Acceptance criteria
- Both ADRs exist, state decision/context/consequences, and match the locked decisions verbatim (no drift).

## Step 1.6 — Test infrastructure

**Files:** `test/helpers/pg.js`, `test/pgClient.test.js`, `vitest.config.js` (if needed)

- Helper that provisions a schema-per-test-file database (or truncates between tests) against `TEST_DATABASE_URL`, applies migrations programmatically via node-pg-migrate's API.
- Tests for Steps 1.2–1.4 acceptance criteria.
- Document in the repo README-equivalent (or plan notes) that integration tests require a local Postgres: `docker run -e POSTGRES_PASSWORD=... -p 5432:5432 postgres:16` (documented, not executed by Claude Code).

### Acceptance criteria
- `npm test` passes with `TEST_DATABASE_URL` set; PG-dependent tests skip with a clear message when it is not set (so the suite still runs in environments without PG).

---

## Definition of Done

- Dependencies, migrations, factory, config, ADRs, and tests exist as specified.
- `npm run migrate:up` / `migrate:down` round-trips on local Postgres.
- No existing runtime behavior changed: the app never calls `createPgPool` yet.
- No SQL outside `migrations/`; no connector import outside `pgClient.js`.
- `npm test` green.
