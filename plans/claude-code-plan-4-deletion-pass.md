# Claude Code Plan 4: Deletion Pass

## Context

Plans 2–3 unwired the ES run/instance machinery and Cloud Tasks. This plan deletes what is now dead, tightens config, and asserts — via grep-level acceptance criteria — that the compensation code this project set out to remove is actually gone. Surgical rule: delete only what plans 2–3 orphaned. Pre-existing dead code (express-generator leftovers, `IsolatedRuntimeLauncher`, `internalWorkerPlaceholder.js`, `cloudSchedulerInvocation.js`) is listed for a separate decision and NOT deleted here.

## Assumptions

- Plans 1–3 complete and merged.
- The `/internal/scheduler/queued-runs/reconcile` endpoint is removed outright: stale-QUEUED runs no longer occur structurally (the poller drains QUEUED within seconds; launch failures are marked FAILED by `executeRun`). If an operator-facing sweep is later wanted, it is a new feature, not a port.
- `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL` / `WORKER_OIDC_AUDIENCE` **stay**: the internal worker routes (`/execute`, `/retry`, `/cancel`, `/redrive`) still authenticate operator/tooling calls with that principal. Only Cloud-Tasks-specific vars go.

## Out of Scope

- Pre-existing dead code (separate keep/kill decision).
- Definitions/audit ES usage — unchanged and permanent per ADR 0004.

## Stop Condition

All steps complete, `npm test` green, and every grep assertion in the Definition of Done holds. No docker/gcloud/deploy commands.

---

## Step 4.1 — Delete files

- `src/services/cloudTaskService.js`
- `src/services/queuedRunMaintenanceService.js`
- Their test files if plans created any interim ones.

### Acceptance criteria
- No import of either module remains anywhere in `src/` or `test/`.

## Step 4.2 — Route and service cleanup

**Files:** `src/routes/internalScheduler.js`, `src/routes/internalWorker.js`

- Remove `POST /queued-runs/reconcile`, `createQueuedRunMaintenanceService`, `buildQueuedRunMaintenanceOptions`, and the `CloudTaskService` import/factory from `internalScheduler.js`.
- `internalWorker.js`: remove any remaining `enqueue` plumbing that plan 2's RunControlService rewrite left accepted-but-dead in options.

### Acceptance criteria
- `POST /internal/scheduler/queued-runs/reconcile` returns 404.
- Tick and worker routes function unchanged.

## Step 4.3 — Elasticsearch mappings and bootstrap

**File:** `src/elasticsearch/schedulerIndexMappings.js`

- Remove the `runs` and `instances` index definitions and their entries in `defaultSchedulerIndexNames` / `getSchedulerIndexPutMappings`.
- **Note:** `package.json` references `scripts/bootstrap-es-indices.js`, which does not exist in the repo. Create it in this step (definitions + audit indices only) so `npm run bootstrap:es` works, or delete the script entry — create it; it is two index-creation calls against the mappings module.

### Acceptance criteria
- Mappings module exports exactly two index definitions: definitions, audit.
- `npm run bootstrap:es` resolves (dry-run test with a stubbed ES client).

## Step 4.4 — Config and env tightening

**Files:** `src/config/index.js`, `src/config/productionValidation.js`

- `getConfig()`: remove `runsIndex`, `instancesIndex`.
- Production validation: remove `CLOUD_TASKS_QUEUE`-related expectations if any exist; confirm required list = ES (endpoint/key/definitions/audit), GCP project/bucket, DB vars (plan 1), worker/scheduler/runtime OIDC vars, IGA vars, `WORKER_EXECUTION_MODE=isolated`, runtime job/SA/broker vars.
- Remove `WORKER_LOCAL_MAX_CONCURRENCY`? No — local mode still exists. Leave.

### Acceptance criteria
- Grep for `runsIndex|instancesIndex|CLOUD_TASKS` in `src/` returns nothing.
- Production validation passes with the documented final env set and fails informatively otherwise (update its tests).

## Step 4.5 — Orphan sweep

- Remove imports/exports/variables orphaned by 4.1–4.4 (e.g., `createEsClient` imports in files that now only take stores, unused `getConfig` destructures).
- Do NOT touch: `IsolatedRuntimeLauncher`, `internalWorkerPlaceholder.js`, `cloudSchedulerInvocation.js`, `routes/`, `bin/www`, `public/`, `SchedulerJob` class SDK. List them in the plan-completion notes as standing dead-code inventory.

### Acceptance criteria
- Lint/`node --check` clean; no unused-import warnings introduced by this change set.

---

## Definition of Done — grep-asserted

All of the following return zero matches in `src/`:

- `painless` / `ctx._source` / `ctx.op`
- `if_seq_no` / `if_primary_term`
- `refresh: true` **except** in `jobDefinitionService.js` and audit emission (definitions/audit legitimately remain ES)
- `CloudTaskService` / `cloudTaskService` / `@google-cloud/tasks`
- `queuedRunMaintenance`
- `runsIndex` / `instancesIndex`

Plus:

- `@google-cloud/tasks` removed from `package.json`.
- `npm test` green; route surface identical to plan 3's end state minus `/queued-runs/reconcile`.
