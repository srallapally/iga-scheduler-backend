# Claude Code Plan 3: Instances on Postgres, Transactional Tick, Dispatch Poller

## Context

With runs on Postgres (plan 2), this plan completes D1/D2: instances move to `job_instances`, the tick becomes a single transaction, and a dispatch poller replaces Cloud Tasks as the mechanism that turns QUEUED rows into executions. After this plan, Cloud Tasks is unreferenced (deleted in plan 4) and the broker requires min-instances ≥ 1.

**D1 refinement (recorded in ADR 0004):** no pg-boss. `job_runs` is the queue; the poller claims work with the same conditional-UPDATE primitive as everything else. There is no second job table and therefore nothing to reconcile.

## Assumptions

- Plans 1–2 complete. In practice plans 2 and 3 ship as one deploy (plan 2 alone leaves run-creation on the ES tick); they are separate Claude Code sessions, not separate releases.
- Cloud Scheduler continues to invoke `POST /internal/scheduler/tick` on its existing cadence with unchanged auth. The tick creates runs; it no longer dispatches anything.
- Poll interval default 5 s (`DISPATCH_POLL_INTERVAL_MS`), batch default 10 (`DISPATCH_POLL_BATCH_SIZE`). Dispatch is fire-and-forget Cloud Run Job launches, so a small single-poller loop is sufficient; multiple broker replicas polling concurrently are safe (losers of the claim race no-op).
- `run-now` remains 501 (unchanged scope).

## Out of Scope

- Deleting `cloudTaskService.js` / `queuedRunMaintenanceService.js` and ES mappings (plan 4).
- Stale-RUNNING detection (pre-existing gap, unchanged).
- Instance data migration from ES (greenfield cutover — flag if wrong).

## Stop Condition

All steps complete, `npm test` green including tick-concurrency tests. No docker/gcloud/deploy commands.

---

## Step 3.1 — `instanceStore`

**File:** `src/stores/instanceStore.js`

Constructor `{ pool }`. Methods:

```js
// src/stores/instanceStore.js — contracts

// createInstance(document)         INSERT; unique-violation -> statusCode 409 error
// getInstance(instanceId)          SELECT ... -> document or null
// updateInstance(instanceId, doc)  full-document UPDATE (matches today's patch semantics,
//                                  which read-modify-write the whole doc)
// listInstancesForDefinition(definitionId)   SELECT ... ORDER BY updated_at DESC
// rowToDocument(row)               snake_case -> today's camelCase instance shape

// claimDueInstances(client, { nowIso, batchSize })   — used inside the tick transaction:
//   SELECT * FROM job_instances
//   WHERE enabled AND state='ACTIVE' AND next_fire_at <= $1
//   ORDER BY next_fire_at
//   LIMIT $2
//   FOR UPDATE SKIP LOCKED

// advanceInstance(client, { instanceId, lastFireAt, nextFireAt, nowIso })
//   UPDATE job_instances SET last_fire_at=$2, next_fire_at=$3, updated_at=$4
//   WHERE instance_id=$1
```

`claimDueInstances`/`advanceInstance` take an explicit `client` (transaction participant); the CRUD methods use the pool.

### Acceptance criteria
- Duplicate `createInstance` surfaces `statusCode: 409` (route already maps this).
- `claimDueInstances` in two concurrent transactions returns disjoint sets (SKIP LOCKED test).
- `rowToDocument` matches today's instance response shape, including `definitionParameterSchema`.

## Step 3.2 — `JobInstanceService` onto the store

**File:** `src/services/jobInstanceService.js`

- Replace `esClient` with `instanceStore` (definitions lookup keeps ES via the existing `definitionsIndex` path — cross-store read-only, acceptable per ADR 0004).
- `createInstance`, `patchInstance`, `pauseInstance`, `resumeInstance`, `deleteInstance`, `getInstance` become store calls. Parameter-validation logic (`validateParametersAgainstDefinition`, `validateParameterValue`) unchanged.
- `getInstance` returning null must produce the route's existing 404 (today ES throws; adjust the route/service boundary minimally — the route already handles a null return).

### Acceptance criteria
- All instance routes behave identically (status codes, response shapes) against a stubbed store; existing zod validation untouched.

## Step 3.3 — Transactional tick

**File:** `src/services/schedulerTickService.js`

Rewrite `tick` as: one transaction per batch —

1. `BEGIN`
2. `claimDueInstances(client, { nowIso, batchSize })`
3. Per instance: build the run document (unchanged shape, `state='QUEUED'`), `INSERT ... ON CONFLICT (run_id) DO NOTHING` via `runStore.createRun(client, doc)` (add a client-accepting variant), compute next fire via the existing cron logic, `advanceInstance(client, ...)`
4. `COMMIT`

Summary object keeps its shape (`checked`, `createdRuns`, `duplicates`, `advanced`, `dryRun`); `enqueued` and `failed` are reported as 0 with the fields retained for response compatibility, or dropped — pick retained, note it. `dryRun` runs the SELECT without `FOR UPDATE` and skips writes.

Delete: `isConflict`, the duplicate/advance recovery branch, `markRunDispatchFailed`, the `cloudTaskService` constructor dependency, and the per-instance `es.create`/`es.update` calls.

Cron computation (`computeNextFireAt`, `getCronExpression`) unchanged.

### Acceptance criteria
- Two concurrent `tick()` calls over the same due instances create each run exactly once and advance each instance exactly once (integration test).
- An instance whose cron expression fails to parse aborts only its own row's processing, not the batch (wrap per-instance work; on error, record in a `failed` counter and continue — matches today's per-instance isolation intent).
- Tick response shape unchanged.
- `internalScheduler.js` no longer constructs `CloudTaskService` for the tick path.

## Step 3.4 — Dispatch poller

**File:** `src/services/runDispatcher.js`

```js
// src/services/runDispatcher.js — contract
// constructor({ runStore, workerRunService, intervalMs, batchSize, logger })
// start(): setInterval loop; each pass:
//   const runIds = await runStore.listQueuedRunIds({ limit: batchSize });
//   for (const runId of runIds) {
//     try { await workerRunService.executeRun({ runId }); }
//     catch (error) { logger.warn("dispatch failed", { runId, error: error.message }); }
//   }
//   // executeRun claims internally; a concurrently-claimed run yields a skipped
//   // result, not an error. Failures are already marked FAILED by executeRun's
//   // own error path — the poller never manages run state itself.
// stop(): clearInterval; await in-flight pass (guard with an isRunning flag,
//   skip overlapping passes)
```

Wire in `startApplication()`: construct after `workerRunService`, `start()` after `listen`, `stop()` in SIGTERM before `pool.end()`. Env: `DISPATCH_POLL_INTERVAL_MS`, `DISPATCH_POLL_BATCH_SIZE`. Add both to production validation as optional-with-defaults; document min-instances=1 as an operator deployment note in the ADR/README.

`POST /internal/job-runs/:runId/execute` remains as the manual/operator dispatch escape hatch, unchanged auth.

### Acceptance criteria
- Poller test with fake timers: QUEUED run present → `executeRun` invoked once; overlapping pass skipped while previous pass in flight; `stop()` halts cleanly.
- A run whose `executeRun` throws is not retried by the poller loop itself (state is FAILED; the queued-index predicate excludes it).
- App boot/shutdown order verified: no dispatch after SIGTERM begins.

## Step 3.5 — Tests

**Files:** `test/instanceStore.test.js`, `test/schedulerTickService.test.js`, `test/runDispatcher.test.js`, plus one end-to-end local-mode test

- E2E (integration, `WORKER_EXECUTION_MODE=local`, PG-backed): create definition (ES stubbed or test double), create instance, force `next_fire_at` past, `tick()`, poller pass, assert run reaches SUCCEEDED with a trivial artifact — **requires seeding `jobZip.approval`/`jobZip.scan` on the test definition to pass the trust gate** (see index caveats).

---

## Definition of Done

- Instances and tick are fully PG-backed; the only ES reads in the tick/instance path are definition lookups.
- No live code path references `CloudTaskService` (file still present; deleted in plan 4).
- Concurrency tests prove: disjoint due-instance claims, exactly-once run creation, single-winner dispatch.
- `npm test` green.
