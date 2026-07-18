# Architecture

## High-level overview

```
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │  Google Cloud Platform                                                          │
  │                                                                                 │
  │   ┌──────────────────────────────────────┐   ┌────────────────────────────┐    │
  │   │  Cloud Run — iga-scheduler           │   │  Cloud Run — iga-scheduler │    │
  │   │  (min-instances=1, always-on)        │   │            -worker         │    │
  │   │                                      │   │  (fixed pool: worker_pool_ │    │
  │   │  ┌─────────────────────────────┐     │   │   size, min=max instances) │    │
  │   │  │  Public REST API            │◄────┼───┼── Operator (Bearer JWT)    │    │
  │   │  │  /job-definitions           │     │   │                            │    │
  │   │  │  /job-instances             │     │   │  ┌──────────────────────┐  │    │
  │   │  │  /job-runs                  │     │   │  │  Poll loop           │  │    │
  │   │  └─────────────────────────────┘     │   │  │  claim (batch) + run │  │    │
  │   │                                      │   │  │  heartbeat + cancel  │  │    │
  │   │  ┌─────────────────────────────┐     │   │  └──────────┬───────────┘  │    │
  │   │  │  Tick                      │     │   │             │ spawn         │    │
  │   │  │  cron tick every minute    │     │   │         job subprocess     │    │
  │   │  └─────────────────────────────┘     │   │             │              │    │
  │   │          ▲                           │   └─────────────┼──────────────┘    │
  │   │          │ OIDC every minute         │                 │                   │
  │   │   Cloud Scheduler (cron)             │                 │ OIDC              │
  │   │                                      │◄────────────────┘                  │
  │   └──────────┬───────────────────────────┘  /internal/runtime/iga/request      │
  │              │                               (bound to the caller's dispatch   │
  │              │  read/write                    attempt, not just runId — SEC-7) │
  │    ┌─────────▼──────────────────────────────────────────────────────────┐      │
  │    │  Data stores                     ▲ poll / claim / heartbeat /       │      │
  │    │                                  │ complete (worker reads/writes    │      │
  │    │                                  │ Postgres directly — no HTTP hop) │      │
  │    │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │      │
  │    │  │  Cloud SQL PG    │  │  Elasticsearch   │  │  Cloud Storage   │  │      │
  │    │  │  job_instances   │  │  definitions     │  │  job ZIP         │  │      │
  │    │  │  job_runs        │  │  audit events    │  │  artifacts       │  │      │
  │    │  └──────────────────┘  └──────────────────┘  └──────────────────┘  │      │
  │    │                                                                     │      │
  │    │  ┌──────────────────┐                                               │      │
  │    │  │  Secret Manager  │  IGA_CLIENT_ID · IGA_CLIENT_SECRET (broker    │      │
  │    │  │                  │  only — never mounted into the worker, SEC-1) │      │
  │    │  │                  │  DB_PASSWORD (fetched at runtime, not mounted,│      │
  │    │  │                  │  SEC-4) · ES_API_KEY                          │      │
  │    │  └──────────────────┘                                               │      │
  │    └─────────────────────────────────────────────────────────────────────┘      │
  └─────────────────────────────────────────────────────────────────────────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │  IGA platform (ForgeRock) │
                              │  Token endpoint · JWKS    │
                              │  IGA REST API             │
                              └───────────────────────────┘
```

The worker has no other inbound HTTP surface besides `/health` (required so Cloud Run can assign it a URL and run liveness/readiness probes) — dispatch and cancellation are both pull-based, not pushed. The scheduler never calls the worker over HTTP at all.

## System overview

```
  Operator ──Bearer JWT──►┌──────────────────────────────────────────────────────┐
                          │  Cloud Run — iga-scheduler                           │
  IGA platform ──JWKS───►│                                                      │
                          │  ┌────────────────────────────────────────────────┐  │
                          │  │  publicAuth middleware (JWT verify via JWKS,   │  │
                          │  │  fixed algorithm allowlist — SEC-5)            │  │
                          │  └────────────────────────────┬───────────────────┘  │
                          │                               │ valid                │
                          │  ┌────────────────────────────▼───────────────────┐  │
                          │  │  Public REST API                               │  │
                          │  │  POST /job-definitions    ──────────────────────┼──┼──► GCS (store ZIP)
                          │  │  GET  /job-definitions    ──────────────────────┼──┼──► ES  (definitions)
                          │  │  POST /job-definitions/:id/instances ───────────┼──┼──► PG  (instances)
                          │  │  POST /job-instances/:id/run-now ───────────────┼──┼──► PG  (runs)
                          │  │  GET  /job-runs           ──────────────────────┼──┼──► PG  (runs)
                          │  └────────────────────────────────────────────────┘  │
                          │                                                      │
  Cloud Scheduler ──OIDC─►│  POST /internal/scheduler/tick                      │
  (every minute)          │    └─► SchedulerTickService                         │
                          │          SELECT FOR UPDATE due instances  ───────────┼──► PG
                          │          INSERT QUEUED run rows           ───────────┼──► PG
                          │          snapshot definition/artifact metadata       │
                          │            onto the run row (AVL-2)         ───────────┼──► ES (once per due instance)
                          │          advance nextFireAt               ───────────┼──► PG
                          │                                                      │
                          │  /internal/job-runs/:runId/{retry,cancel,redrive}   │
                          │    └─► RunControlService                            │
                          │          transition state                ───────────┼──► PG
                          │          (cancel sets CANCELLING; the owning        │
                          │           worker's heartbeat loop self-cancels —     │
                          │           no launcher call from the scheduler)      │
                          │                                                      │
                          │  POST /internal/runtime/iga/request      ◄──────────┼──────────────────┐
                          │    └─► verify run is RUNNING             ───────────┼──► PG            │
                          │    └─► verify dispatchId matches the run's          │                  │
                          │          current claim (SEC-7)            ───────────┼──► PG            │
                          │    └─► proxy to IGA platform             ───────────┼──► IGA platform  │
                          └──────────────────────────────────────────────────────┘                  │
                                                                                                    │
                          ┌─────────────────────────────────────────────────────┐                  │
                          │  Cloud Run — iga-scheduler-worker                   │◄─────────────────┘
                          │  (fixed warm pool — no inbound requests to          │
                          │   autoscale on, so min=max instances)               │
                          │                                                     │
                          │  Poll loop (src/workers/pollLoop.js)                │
                          │    └─► claimNextQueued (FOR UPDATE SKIP LOCKED,     │
                          │          fresh dispatch_id per row)      ────────────┼──► PG
                          │    └─► executeClaimedRun (WorkerRunService,         │
                          │          relocated into this process)               │
                          │          read definition/artifact snapshot,         │
                          │            or fall back to a live ES lookup ────────┼──► ES (rare)
                          │          download + verify artifact:                │
                          │            SHA-256 recompute + GCS generation       │
                          │            pinning (no approval/scan ceremony       │
                          │            — removed, SEC-6)              ────────────┼──► GCS
                          │          resolve sensitive parameters     ────────────┼──► Secret Manager
                          │    └─► JobRuntimeExecutor                          │
                          │          safeZipExtract                            │
                          │          spawn node / python3.11 (memory-capped,   │
                          │            concurrency-capped — AVL-1)              │
                          │                │                                   │
                          │          job subprocess (user code)                │
                          │                │                                   │
                          │                └── POST /iga/request (with its     │
                          │                      own dispatch_id) ─────────────┼──► scheduler IGA proxy
                          │                                                     │
                          │    └─► markSucceeded / markFailed, fenced on        │
                          │          dispatch_id (COR-1)              ────────────┼──► PG (direct write,
                          │    └─► audit event                        ────────────┼──► ES  no HTTP callback)
                          │                                                     │
                          │  Heartbeat loop (per owned RUNNING run)             │
                          │    └─► touchHeartbeat, fenced on dispatch_id ───────┼──► PG
                          │    └─► if flipped to CANCELLING: JobRuntimeExecutor │
                          │          .cancel() directly (SIGTERM→SIGKILL)       │
                          │          — no HTTP hop either way (COR-2)           │
                          └─────────────────────────────────────────────────────┘
```

## Data stores

| Store | Contents | Technology |
|---|---|---|
| Cloud SQL (PG) | `job_instances`, `job_runs` — schedule state and run queue, including `dispatch_id` (per-claim fencing token) and `heartbeat_at` | Cloud SQL |
| Elasticsearch | `scheduler_definitions_v1`, `scheduler_audit_v1` | Elastic Cloud |
| Cloud Storage | Job ZIP artifacts (`approved/<id>/<sha256>/job.zip`), `public_access_prevention = "enforced"` | GCS |
| Secret Manager | `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET` (broker/scheduler only), `DB_PASSWORD` (fetched at connection time, never mounted as an env var), `ES_API_KEY` | GCP Secret Manager |

## Run state machine

```
  tick / run-now
       │
       ▼
  ┌─────────┐   worker's poll loop claims  ┌─────────┐
  │ QUEUED  │ ──(FOR UPDATE SKIP LOCKED)──► │ RUNNING │
  └─────────┘   mints fresh dispatch_id     └────┬────┘
       ▲                                       │
       │ redrive                    ┌──────────┼──────────┐
       │                            │          │          │
  ┌────┴──────┐             exitCode=0   operator    exitCode≠0
  │ FAILED /  │                  │       cancel        or timeout
  │ CANCELLED │             ┌────▼────┐      │       ┌──────────┐
  └───────────┘             │SUCCEEDED│  ┌───▼─────┐ │  FAILED  │
                            └─────────┘  │CANCELLING│ └──────────┘
                                         └────┬─────┘
                                              │ owning worker's heartbeat
                                              │ loop detects it and self-
                                              │ cancels the subprocess
                                         ┌────▼─────┐
                                         │CANCELLED │
                                         └──────────┘
```

Redrive creates a new run with `runId` appended as `:redrive:<uuid>`. Every completion write (`markSucceeded`/`markFailed`) is fenced on the `dispatch_id` minted at claim time, so a ghost subprocess from a superseded attempt (e.g. after a sweeper force-fail + retry) can never clobber the current attempt's outcome.

## Request flows

### Tick → claim

1. Cloud Scheduler fires `POST /internal/scheduler/tick` every minute (OIDC-authenticated).
2. `SchedulerTickService` opens a Postgres transaction, selects all instances where `next_fire_at ≤ now` with `SELECT FOR UPDATE SKIP LOCKED`, inserts a `QUEUED` run row for each — snapshotting the due instance's definition/artifact metadata onto the row so dispatch never needs Elasticsearch on its hot path (AVL-2) — advances `next_fire_at`, and commits.
3. The worker's own poll loop (`src/workers/pollLoop.js`, default ~1s interval) independently and continuously calls `RunStore.claimNextQueued`, which atomically discovers and claims up to its free concurrency slots' worth of `QUEUED` rows in one transaction (`FOR UPDATE SKIP LOCKED`), minting a fresh `dispatch_id` per claimed row. Multiple warm-pool worker instances polling concurrently claim disjoint sets with no coordination needed between them.

### Worker execution

4. For each claimed run, `WorkerRunService.executeClaimedRun` (this class now runs inside the worker process, not the scheduler) reads the definition/artifact metadata — from the tick-time snapshot when present, falling back to a live Elasticsearch lookup otherwise — downloads the job ZIP from GCS, recomputes its SHA-256 against the pinned GCS object generation, resolves any `sensitive` parameters from Secret Manager, then hands off to `JobRuntimeExecutor`, which extracts the ZIP and spawns the entrypoint as a child process (`node` or `python3.x`, under a per-instance concurrency cap and, for Python, a `ulimit -v` memory cap).
5. The job subprocess can proxy calls to the IGA platform via `POST /internal/runtime/iga/request` on the scheduler. The scheduler verifies the calling run is `RUNNING` **and** that the caller's `dispatch_id` matches the run's current claim before forwarding — binding the proxy call to the specific dispatch attempt that spawned it, not just to a `runId` the caller could otherwise forge (SEC-7).
6. On completion, the worker writes `SUCCEEDED`/`FAILED` directly to Postgres (`markSucceeded`/`markFailed`, fenced on `dispatch_id`) and emits an audit event to Elasticsearch — there is no HTTP callback to the scheduler for this; the worker owns its own run's outcome end to end.
7. A separate heartbeat loop, per run the worker currently owns, refreshes `heartbeat_at` (fenced on `dispatch_id`) and checks in the same round trip whether the run has been flipped to `CANCELLING` (via the scheduler's `/internal/job-runs/:runId/cancel` route). If so, the worker calls `JobRuntimeExecutor.cancel()` directly — SIGTERM, then SIGKILL after a grace period — with no HTTP hop in either direction.

## CI/CD pipeline

```
  GitHub push to main
          │
          ▼
  Cloud Build (cloudbuild.yaml)
  │
  ├── Step 0 ── terraform output → tf-outputs.json
  │             (SA emails, DB conn name, VPC connector, bucket name,
  │              worker_pool_size)
  │
  ├── Step 1 ── run test suite (npm ci && npm test) — fails the build
  │             before any image is built, pushed, or deployed (CIP-1)
  │
  ├── Steps 2–3 ── docker build
  │                ├── runtime-containers/worker/Dockerfile  → worker image
  │                └── Dockerfile (root)                    → scheduler image
  │
  ├── Steps 4–5 ── docker push both images to Artifact Registry
  │
  ├── Steps 6–7 ── run Postgres migrations
  │                ├── fetch DB password from Secret Manager
  │                ├── start Cloud SQL Auth Proxy (sidecar)
  │                └── npm run migrate:up  (node-pg-migrate)
  │
  └── Steps 8–9 ── gcloud run deploy
                   ├── iga-scheduler-worker  (worker image + env; --min-instances
                   │                          and --max-instances both set to
                   │                          worker_pool_size — a fixed warm
                   │                          pool, since a poll loop has no
                   │                          inbound-request signal to
                   │                          autoscale on)
                   └── iga-scheduler         (scheduler image + env + secrets;
                                              --min-instances=1, always-on CPU)
```

Both `validateWorkerStartupConfig` and `validateProductionStartupConfig` (`src/config/productionValidation.js`) fail closed: they enforce every production guardrail unless `NODE_ENV` is exactly `"test"` (what the test runner sets), rather than the reverse — so `NODE_ENV` drift on a real deploy now surfaces as a startup failure instead of silently skipping validation (SEC-8).
