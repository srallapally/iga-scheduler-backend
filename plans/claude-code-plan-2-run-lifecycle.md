# Claude Code Plan 2: Run Lifecycle on Postgres

## Context

Runs currently live in `scheduler_runs_v1` with Painless conditional-script transitions (WorkerRunService) and `if_seq_no`/`if_primary_term` optimistic updates (RunControlService). This plan moves the run system of record to the `job_runs` table via a new `runStore`, preserving every external contract: route response shapes, the run state machine, audit event schema (audit stays in ES), and retry classification.

The claim architecture is preserved: `claimRun({ runId })` remains a by-id conditional transition, so the `/execute` route and manual dispatch semantics don't change. Plan 3 adds the poller that feeds it.

## Assumptions

- Plan 1 is complete.
- `startApplication()` creates one Pool via `createPgPool()` and injects it; services never create their own pools.
- Timestamps: services keep generating ISO strings via `this.now()` and pass them as parameters (pg maps to timestamptz); row→document mapping converts back to ISO strings so response shapes are byte-compatible with today.
- Audit emission (`emitAuditEvent`) is untouched — still best-effort ES writes.
- Runs created before this plan (in ES) are abandoned — greenfield cutover per the master plan. **Flag if live data must survive.**

## Out of Scope

- Tick, instances, dispatch poller (plan 3). Until plan 3, run creation still happens via the ES-based tick — meaning plans 2 and 3 should be merged into one deploy in practice; plan 2 must still leave `npm test` green on its own.
- Deleting ES code (plan 4). ES run methods are unwired, not yet removed.
- Public API (plan 5).

## Stop Condition

Stop when all steps are complete and `npm test` passes, including the concurrency-race tests. No docker/gcloud/deploy commands.

---

## Step 2.1 — `runStore`

**File:** `src/stores/runStore.js`

One class, constructor takes `{ pool }`. All state transitions are single conditional `UPDATE ... RETURNING` statements; a returned row means the transition won, zero rows means it lost — the direct replacement for the Painless `noop` pattern.

Required methods and their SQL contracts:

```js
// src/stores/runStore.js — contracts (implement with parameterized queries)

// getRun(runId) -> run document or null
//   SELECT * FROM job_runs WHERE run_id = $1

// createRun(document) -> { created: boolean }
//   INSERT INTO job_runs (...) VALUES (...) ON CONFLICT (run_id) DO NOTHING
//   created = rowCount === 1

// claimRun({ runId, startedAt, status }) -> { claimed: boolean, missing?: boolean }
//   UPDATE job_runs SET state='RUNNING', started_at=$2, heartbeat_at=$2,
//     status=$3, updated_at=$2
//   WHERE run_id=$1 AND state='QUEUED' RETURNING run_id
//   zero rows: SELECT 1 to distinguish missing (missing: true) from lost race

// recordRuntimeExecution({ runId, runtimeExecution, startedAt, status }) -> boolean
//   UPDATE ... WHERE run_id=$1 AND state='RUNNING' RETURNING run_id

// markSucceeded({ runId, endedAt, result, status }) -> boolean
//   UPDATE job_runs SET state='SUCCEEDED', ended_at=$2, heartbeat_at=$2,
//     status=$3, result=$4, error=NULL, updated_at=$2
//   WHERE run_id=$1 AND state='RUNNING' RETURNING run_id

// markFailed({ runId, endedAt, error, status }) -> boolean
//   symmetric to markSucceeded with state='FAILED', error=$4

// transition({ runId, fromStates, set }) -> updated run document or null
//   generic guarded UPDATE for RunControlService:
//   UPDATE job_runs SET <set columns>, updated_at=now()
//   WHERE run_id=$1 AND state = ANY($2) RETURNING *

// listQueuedRunIds({ limit }) -> [runId]          (used by plan 3's poller)
//   SELECT run_id FROM job_runs WHERE state='QUEUED' ORDER BY created_at LIMIT $1

// rowToDocument(row): snake_case -> the exact camelCase document shape services use
//   today (runId, definitionId, scheduledFireTime as ISO string, etc.)
```

### Acceptance criteria
- Every method above implemented with parameterized SQL only (no string interpolation of values).
- `rowToDocument` round-trips a fully-populated run: timestamps come back as ISO strings, JSONB fields as objects, matching the current ES `_source` shape field-for-field.
- Integration test: two concurrent `claimRun` calls on the same QUEUED run → exactly one `claimed: true`.
- `claimRun` on a missing run returns `{ claimed: false, missing: true }`; on a RUNNING run returns `{ claimed: false }` without `missing`.

## Step 2.2 — Rewire `WorkerRunService`

**File:** `src/services/workerRunService.js`

- Constructor: add `runStore` (required); keep `esClient` — it is now used **only** for `emitAuditEvent` and `getDefinition`.
- Replace bodies of `getRun`, `claimRun`, `recordRuntimeExecution`, `markSucceeded`, `markFailed` with `runStore` calls. Delete the Painless scripts, the `refresh: true` options, and the ES 404-normalization in `getRun` (the store returns null).
- All orchestration (`executeRun`, `dispatchRun`, `claimQueuedRun`, `executeRunLocallyInternal`, `completeRun`, metadata building, trust gate, audit shapes, `skippedResult`) is unchanged line-for-line except the persistence calls.

### Acceptance criteria
- No `this.esClient.update`, `script:`, or `refresh: true` remain in the file; `this.esClient` appears only in `emitAuditEvent` and `getDefinition`.
- Existing behavior contracts hold (unit tests with a stubbed runStore): dispatch path emits the same audit sequence; lost claim → skipped result; failure path classifies and marks FAILED.

## Step 2.3 — `completeRun` success-judgment fix (explicit behavioral change)

**File:** `src/services/workerRunService.js`

Current line treats `exitCode: 0` as success even when a non-null `error` payload is present:

```js
const succeeded = completion.exitCode === 0 || completion.status === "completed" || completion.status === "succeeded";
```

Change to require the absence of an error payload:

```js
const succeeded = !completion.error &&
  (completion.exitCode === 0 || completion.status === "completed" || completion.status === "succeeded");
```

This is the semantics specified in the python-jobs v2 plan and is a behavior change, isolated to this step so it can be dropped independently if not wanted.

### Acceptance criteria
- `completeRun({ runId, exitCode: 0, error: { code: "RUNTIME_CONTAINER_FAILURE", ... } })` marks the run FAILED.
- `completeRun({ runId, exitCode: 0 })` still marks SUCCEEDED.

## Step 2.4 — Rewire `RunControlService`

**File:** `src/services/runControlService.js`

- Constructor: replace `esClient` with `runStore`; drop `cloudTaskService` from retry/redrive **enqueue** calls — with Postgres-as-queue, setting `state='QUEUED'` *is* enqueueing; the poller picks it up. Keep the `enqueue` request flag accepted-and-ignored for API compatibility, or return `enqueued: true` when state was set (choose the latter; document it).
- `retryRun`: single `transition({ runId, fromStates: ['FAILED'], set: {...} })`. Zero rows → re-read to produce the 404-vs-409 error, preserving today's status codes.
- `cancelRun`: same pattern for each branch (`QUEUED→CANCELLED`, `RUNNING→CANCELLING` + launcher cancel).
- `redriveRun`: `runStore.createRun` for the `:redrive:` document.
- Delete `requireRunWithVersion`, `updateRunWithVersion`, and all seq_no/primary_term handling.

### Acceptance criteria
- Same HTTP status semantics as today: 404 unknown run, 409 illegal transition, idempotent responses for repeat cancel.
- Concurrency test: two concurrent `retryRun` calls → one succeeds, one gets 409.
- No `if_seq_no` / `if_primary_term` anywhere in `src/`.

## Step 2.5 — `RuntimeIgaProxyService` run check onto PG

**File:** `src/services/runtimeIgaProxyService.js`

- Constructor accepts `runStore`; `getRun` delegates to it. `esClient` remains for audit emission only.

### Acceptance criteria
- Proxy still rejects non-RUNNING runs with 409 and unknown runs with 404 (tests with stubbed store).

## Step 2.6 — Wiring in `startApplication()` and `createApp`

**Files:** `src/app.js`, `src/createApp.js`, routers as needed

- `startApplication()`: `const pool = await createPgPool(); const runStore = new RunStore({ pool });` inject into `WorkerRunService`, and thread `runStore` through router options so `internalWorker.js` / `internalRuntimeIga.js` lazy constructions receive it instead of building ES-backed defaults.
- Extend `/ready` payload with `dbEngine` and a `SELECT 1` connectivity check result.
- SIGTERM: `pool.end()` after `server.close()`.

### Acceptance criteria
- App boots with `DB_ENGINE=direct` + local PG; `/ready` reports the engine and db ok.
- No service constructs its own Pool; grep for `createPgPool` shows exactly two call sites (app.js, tests).

## Step 2.7 — Tests

**Files:** `test/runStore.test.js`, `test/workerRunService.test.js`, `test/runControlService.test.js`

- Store integration tests per Step 2.1 criteria (real PG via plan 1 helper).
- Service unit tests with stubbed store covering the transition matrix: claim races, complete-on-not-RUNNING → 202 skipped, `completeRun` success/failure judgment incl. Step 2.3, retry/cancel/redrive legal and illegal transitions.

---

## Definition of Done

- Run state reads/writes go exclusively through `runStore`; ES touches runs nowhere in the live path.
- Route response shapes and status codes unchanged (except Step 2.3's intended fix).
- Race tests prove single-winner claim and single-winner retry.
- `npm test` green.
