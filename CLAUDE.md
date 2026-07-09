# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ACTIVE MIGRATION — read this first
Locked decisions and plan sequence: @plans/claude-code-plan-0-index.md
The repo is mid-replatform: run/instance coordination is moving from Elasticsearch to Cloud SQL Postgres, and the public API is being secured with PingOne OAuth. The plan set lives in `plans/`; `plans/claude-code-plan-0-index.md` records the locked decisions and sequence.

**Status (update this line when a plan completes):**
- [x] Plan 1 — PG foundation
- [x] Plan 2 — Run lifecycle on PG
- [x] Plan 3 — Instances, tick, dispatch poller
- [x] Plan 4 — Deletion pass
- [x] Plan 5 — Public API auth (PingOne)

**Session rules:**
- Execute exactly one plan per session, per its Stop Condition and Definition of Done. Do not start work from later plans.
- Do not re-litigate the locked decisions in the index (Postgres-as-queue with no pg-boss; instances in PG; definitions and audit stay in ES; Cloud SQL default with AlloyDB switchable).
- Run `npm test` before declaring any step done.

**Invariants (hold across all plans):**
- All SQL is portable Postgres — no AlloyDB-only features, ever. The engine switch exists only in `src/clients/pgClient.js`; no other file may import a connector or read `DB_ENGINE`.
- Do not delete pre-existing dead code (`IsolatedRuntimeLauncher`, `internalWorkerPlaceholder.js`, `middleware/cloudSchedulerInvocation.js`, `routes/`, `bin/www`, `public/`) — plans delete only what they orphan. Plan 4 lists the standing inventory.
- Audit events keep their current ES emit path and event schema.
- The run state machine and route response shapes do not change (the one sanctioned exception is plan 2 step 2.3, the `completeRun` success-judgment fix).

**Staleness note:** the Architecture, Auth, and Config sections below describe the pre-migration state. Where they conflict with the active plan file, the plan wins. Update the affected sections of this file as each plan completes (plan 1 adds the migrate scripts to Commands; plans 4–5 rewrite the Architecture, Auth, and Config sections).

## Commands

```bash
npm start          # start the server (node src/app.js)
npm run dev        # same as start
npm test           # run all tests once (vitest run)
npx vitest run test/some.test.js   # run a single test file
```

There is no build step — the app runs as ESM directly via Node 22.

## Architecture

This is a **GCP-hosted job scheduling backend** (Express 5, ESM, Node 22). It manages job definitions, cron-scheduled instances, and individual runs. All persistent state lives in Elasticsearch; job artifact zips are stored in GCP Cloud Storage.

### Request flow

```
HTTP Routes (src/routes/)
    → Services (src/services/)
    → Clients (src/clients/)   ← ES, GCS, Cloud Tasks, Cloud Run
```

`src/createApp.js` is the Express app factory — used by both `src/app.js` (production entry) and tests. `src/index.js` exports the `SchedulerJob` base class, which is the SDK surface for job authors.

### Core services

- **`SchedulerTickService`** — triggered by GCP Cloud Scheduler every minute; finds instances where `nextFireAt <= now`, creates run documents in ES, enqueues via Cloud Tasks, and advances `nextFireAt`.
- **`WorkerRunService`** — claims a queued run (optimistic lock via ES script update), verifies the artifact trust chain (APPROVED + CLEAN scan + SHA-256/generation match), resolves `sensitive` parameters from Secret Manager, then dispatches via `JobRuntimeExecutor` (local child process) or `CloudRunJobRuntimeLauncher` (isolated Cloud Run Job).
- **`JobDefinitionService`** — validates and stores zip artifacts to GCS + ES. Zip contract: `manifest.json` with `entrypoint`/`runtime`/`wrapperVersion`, no symlinks/path traversal/credential files, ≤200 files, ≤10 MB compressed, ≤50 MB uncompressed.
- **`JobInstanceService`** — manages cron schedules tied to definitions; validates params against the definition's Zod schema.
- **`RunControlService`** — retry, cancel, redrive. Uses ES `_seq_no`/`_primary_term` for optimistic concurrency.
- **`RuntimeIgaProxyService`** — proxies HTTP calls from a running job to the IGA API, after verifying the calling run is in RUNNING state.

### Run state machine

`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLING → CANCELLED`

Redrive creates a new run document with `runId` appended as `:redrive:<uuid>`.

### Auth

Internal routes (`/internal/**`) are protected by `internalAuth` middleware that verifies a Google OIDC bearer token (audience + service account email). The completion endpoint accepts either `RUNTIME_BROKER_URL` or `WORKER_OIDC_AUDIENCE` as valid audiences.

### Config

All configuration is via environment variables — no `.env` files are committed. `src/config/` exports `getConfig()`, which throws on first use if required vars are missing.

**Always required:** `GCP_PROJECT_ID`, `JOB_ZIP_BUCKET`, `ES_ENDPOINT`, `ES_API_KEY`

**Required in production** (enforced at startup): `WORKER_OIDC_AUDIENCE`, `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL`, `SCHEDULER_OIDC_AUDIENCE`, `SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL`, `WORKER_EXECUTION_MODE=isolated`, `RUNTIME_CLOUD_RUN_JOB_NAME`, `RUNTIME_SERVICE_ACCOUNT_EMAIL`, `RUNTIME_BROKER_URL`, `IGA_TOKEN_ENDPOINT`, `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET`, `IGA_BASE_URL`

### Infrastructure

`terraform/` provisions GCP Cloud Scheduler (the cron tick) and associated IAM. Run `terraform init/plan/apply` from that directory; see `terraform/README.md` for required variables.