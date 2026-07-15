# Architecture

## High-level overview

```
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │  Google Cloud Platform                                                          │
  │                                                                                 │
  │   ┌──────────────────────────────────────┐   ┌────────────────────────────┐    │
  │   │  Cloud Run — iga-scheduler           │   │  Cloud Run — iga-scheduler │    │
  │   │                                      │   │            -worker         │    │
  │   │  ┌─────────────────────────────┐     │   │                            │    │
  │   │  │  Public REST API            │◄────┼───┼── Operator (Bearer JWT)    │    │
  │   │  │  /job-definitions           │     │   │                            │    │
  │   │  │  /job-instances             │     │   │  ┌──────────────────────┐  │    │
  │   │  │  /job-runs                  │     │   │  │  Job Executor        │  │    │
  │   │  └─────────────────────────────┘     │   │  │  Node 22 / Py 3.11   │  │    │
  │   │                                      │   │  │  subprocess isolated │  │    │
  │   │  ┌─────────────────────────────┐     │   │  └──────────┬───────────┘  │    │
  │   │  │  Tick + Dispatcher          │─────┼───┼─POST /exec  │              │    │
  │   │  │  cron tick every minute     │     │   │             │ spawn        │    │
  │   │  │  dispatch poll every 5s     │     │   │         job subprocess     │    │
  │   │  └─────────────────────────────┘     │   │             │              │    │
  │   │          ▲                           │   └─────────────┼──────────────┘    │
  │   │          │ OIDC every minute         │                 │                   │
  │   │   Cloud Scheduler (cron)             │                 │ OIDC              │
  │   │                                      │◄────────────────┘ /complete         │
  │   └──────────┬───────────────────────────┘  /internal/runtime/iga/request      │
  │              │                                                                  │
  │              │  read/write                                                      │
  │    ┌─────────▼──────────────────────────────────────────────────────────┐      │
  │    │  Data stores                                                        │      │
  │    │                                                                     │      │
  │    │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │      │
  │    │  │  Cloud SQL PG 15 │  │  Elasticsearch   │  │  Cloud Storage   │  │      │
  │    │  │  job_instances   │  │  definitions     │  │  job ZIP         │  │      │
  │    │  │  job_runs        │  │  audit events    │  │  artifacts       │  │      │
  │    │  └──────────────────┘  └──────────────────┘  └──────────────────┘  │      │
  │    │                                                                     │      │
  │    │  ┌──────────────────┐                                               │      │
  │    │  │  Secret Manager  │  IGA_CLIENT_ID · IGA_CLIENT_SECRET            │      │
  │    │  │                  │  DB_PASSWORD · ES_API_KEY                     │      │
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

## System overview

```
  Operator ──Bearer JWT──►┌──────────────────────────────────────────────────────┐
                          │  Cloud Run — iga-scheduler                           │
  IGA platform ──JWKS───►│                                                      │
                          │  ┌────────────────────────────────────────────────┐  │
                          │  │  publicAuth middleware  (JWT verify via JWKS)  │  │
                          │  └────────────────────────────┬───────────────────┘  │
                          │                               │ valid                │
                          │  ┌────────────────────────────▼───────────────────┐  │
                          │  │  Public REST API                               │  │
                          │  │  POST /job-definitions    ──────────────────────┼──┼──► GCS (store ZIP)
                          │  │  GET  /job-definitions    ──────────────────────┼──┼──► ES  (definitions)
                          │  │  POST /job-instances      ──────────────────────┼──┼──► PG  (instances)
                          │  │  GET  /job-runs           ──────────────────────┼──┼──► PG  (runs)
                          │  └────────────────────────────────────────────────┘  │
                          │                                                      │
  Cloud Scheduler ──OIDC─►│  POST /internal/scheduler/tick                      │
  (every minute)          │    └─► SchedulerTickService                         │
                          │          SELECT FOR UPDATE due instances  ───────────┼──► PG
                          │          INSERT QUEUED run rows           ───────────┼──► PG
                          │          advance nextFireAt               ───────────┼──► PG
                          │                                                      │
                          │  RunDispatcher  (poll every 5 s)                    │
                          │    └─► listQueuedRunIds                  ───────────┼──► PG
                          │    └─► WorkerRunService                             │
                          │          claimRun (optimistic UPDATE)    ───────────┼──► PG
                          │          validateArtifactTrust                      │
                          │          resolveParameters                ───────────┼──► Secret Manager
                          │          GET definition                  ───────────┼──► ES
                          │          POST /execute (OIDC)            ───────────┼──────────────────┐
                          │                                                      │                  │
                          │  POST /internal/job-runs/:runId/complete ◄──────────┼──────────────────┤
                          │    └─► markSucceeded / markFailed        ───────────┼──► PG            │
                          │    └─► audit event                       ───────────┼──► ES            │
                          │                                                      │                  │
                          │  POST /internal/runtime/iga/request      ◄──────────┼──────────────────┤
                          │    └─► verify run is RUNNING             ───────────┼──► PG            │
                          │    └─► proxy to IGA platform             ───────────┼──► IGA platform  │
                          └──────────────────────────────────────────────────────┘                  │
                                                                                                    │
                          ┌─────────────────────────────────────────────────────┐                  │
                          │  Cloud Run — iga-scheduler-worker                   │◄─────────────────┘
                          │                                                     │
                          │  POST /execute  (scheduler OIDC)                   │
                          │    └─► WorkerRunService                            │
                          │          claimRun              ────────────────────┼──► PG
                          │          GET definition        ────────────────────┼──► ES
                          │          download ZIP          ────────────────────┼──► GCS
                          │          verify SHA-256                            │
                          │          resolveParameters     ────────────────────┼──► Secret Manager
                          │    └─► JobRuntimeExecutor                          │
                          │          safeZipExtract                            │
                          │          spawn node / python3.11                   │
                          │                │                                   │
                          │          job subprocess (user code)                │
                          │                │                                   │
                          │                ├── POST /complete ──────────────────┼──► scheduler /complete
                          │                └── POST /iga/request ───────────────┼──► scheduler IGA proxy
                          └─────────────────────────────────────────────────────┘
```

## Data stores

| Store | Contents | Technology |
|---|---|---|
| Cloud SQL (PG 15) | `job_instances`, `job_runs` — schedule state and run queue | Cloud SQL |
| Elasticsearch | `scheduler_definitions_v1`, `scheduler_audit_v1` | Elastic Cloud |
| Cloud Storage | Approved job ZIP artifacts (`approved/<id>/<sha256>/job.zip`) | GCS |
| Secret Manager | `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET`, `DB_PASSWORD`, `ES_API_KEY` | GCP Secret Manager |

## Run state machine

```
  tick / run-now
       │
       ▼
  ┌─────────┐   dispatcher claims run     ┌─────────┐
  │ QUEUED  │ ──(optimistic UPDATE)──────► │ RUNNING │
  └─────────┘                             └────┬────┘
       ▲                                       │
       │ redrive                    ┌──────────┼──────────┐
       │                            │          │          │
  ┌────┴──────┐             exitCode=0   operator    exitCode≠0
  │ FAILED /  │                  │       cancel        or timeout
  │ CANCELLED │             ┌────▼────┐      │       ┌──────────┐
  └───────────┘             │SUCCEEDED│  ┌───▼─────┐ │  FAILED  │
                            └─────────┘  │CANCELLING│ └──────────┘
                                         └────┬─────┘
                                              │ process exits
                                         ┌────▼─────┐
                                         │CANCELLED │
                                         └──────────┘
```

## Request flows

### Tick → dispatch

1. Cloud Scheduler fires `POST /internal/scheduler/tick` every minute (OIDC-authenticated).
2. `SchedulerTickService` opens a Postgres transaction, selects all instances where `next_fire_at ≤ now` with `SELECT FOR UPDATE SKIP LOCKED`, inserts a `QUEUED` run row for each, advances `next_fire_at`, and commits.
3. `RunDispatcher` (running in the scheduler process) polls `job_runs` for `QUEUED` rows every 5 seconds.
4. `WorkerRunService` claims each run with an optimistic `UPDATE … WHERE state = 'QUEUED'`, validates the artifact trust chain (APPROVED + CLEAN scan + SHA-256/generation match), resolves `sensitive` parameters from Secret Manager, then POSTs to the worker service's `/execute` endpoint with a GCP OIDC token.

### Worker execution

5. The worker service receives `POST /execute`, claims the run in Postgres, downloads the job ZIP from GCS, verifies SHA-256, extracts it, and spawns the entrypoint as a child process (`node` or `python3.11`).
6. The job subprocess can proxy calls to the IGA platform via `POST /internal/runtime/iga/request` — the scheduler verifies the calling run is RUNNING before forwarding.
7. On completion the subprocess (or the worker service on timeout) calls `POST /internal/job-runs/:runId/complete`. The scheduler updates the run to `SUCCEEDED` or `FAILED` and emits an audit event to Elasticsearch.

## CI/CD pipeline

```
  GitHub push to main
          │
          ▼
  Cloud Build (cloudbuild.yaml)
  │
  ├── Step 0 ── terraform output → tf-outputs.json
  │             (SA emails, DB conn name, VPC connector, bucket name)
  │
  ├── Steps 1–2 ── docker build
  │                ├── runtime-containers/worker/Dockerfile  → worker image
  │                └── Dockerfile (root)                    → scheduler image
  │
  ├── Steps 3–4 ── docker push both images to Artifact Registry
  │
  ├── Steps 5–6 ── run Postgres migrations
  │                ├── fetch DB password from Secret Manager
  │                ├── start Cloud SQL Auth Proxy (sidecar)
  │                └── npm run migrate:up  (node-pg-migrate)
  │
  └── Steps 7–8 ── gcloud run deploy
                   ├── iga-scheduler-worker  (worker image + env)
                   └── iga-scheduler         (scheduler image + env + secrets)
```
