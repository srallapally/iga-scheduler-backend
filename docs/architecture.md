# Architecture

## System overview

```mermaid
flowchart TD
    subgraph Clients["External clients"]
        APICLIENT["API client\n(curl / SDK)"]
        IGAPLATFORM["IGA platform\n(ForgeRock AIC)"]
    end

    subgraph Scheduler["Cloud Run — iga-scheduler"]
        direction TB
        PUBLICAPI["Public API\nGET/POST /job-definitions\nGET/POST /job-instances\nGET /job-runs"]
        PUBLICAUTH["publicAuth middleware\nJWT verify (JWKS)"]
        TICKROUTE["Internal tick route\nPOST /internal/scheduler/tick\n(Cloud Scheduler OIDC)"]
        TICKSVC["SchedulerTickService\nClaim due instances\nCreate QUEUED run rows\nAdvance nextFireAt"]
        DISPATCHPOLLER["RunDispatcher\npoll every 5 s\nlistQueuedRunIds"]
        WORKERSVC["WorkerRunService\nclaimRun (optimistic lock)\nvalidateArtifactTrust\nresolveParameters\nlaunchExecution"]
        COMPLETEROUTE["Internal complete route\nPOST /internal/job-runs/:runId/complete\n(runtime OIDC)"]
        IGAPROXY["IGA proxy\nPOST /internal/runtime/iga/request\n(runtime OIDC)"]
    end

    subgraph Worker["Cloud Run — iga-scheduler-worker"]
        direction TB
        EXECUTEROUTE["POST /execute\n(scheduler OIDC)"]
        WORKERRUNSVC2["WorkerRunService\nclaimRun\nbuildExecutionMetadata\nverifyApprovedArtifact"]
        EXECUTOR["JobRuntimeExecutor\nsafeZipExtract\nspawn node / python3\ncapture stdout/stderr"]
        JOBPROCESS["Job subprocess\n(user code)\nNode 22 or Python 3.11"]
    end

    subgraph Storage["GCP storage"]
        PG[("Cloud SQL PG 15\njob_instances\njob_runs")]
        ES[("Elasticsearch\njob definitions\naudit events")]
        GCS[("Cloud Storage\napproved job ZIPs")]
        SM["Secret Manager\nIGA_CLIENT_ID\nIGA_CLIENT_SECRET\nDB_PASSWORD\nES_API_KEY"]
    end

    subgraph GCPInfra["GCP infrastructure"]
        CLOUDSCHEDULER["Cloud Scheduler\ncron every minute"]
    end

    APICLIENT -->|"Bearer JWT"| PUBLICAUTH
    PUBLICAUTH -->|"valid"| PUBLICAPI
    PUBLICAPI -->|"store definition + ZIP"| ES
    PUBLICAPI -->|"store definition ZIP"| GCS
    PUBLICAPI -->|"read/write instances + runs"| PG

    IGAPLATFORM -->|"JWKS"| PUBLICAUTH

    CLOUDSCHEDULER -->|"OIDC every minute"| TICKROUTE
    TICKROUTE --> TICKSVC
    TICKSVC -->|"SELECT FOR UPDATE\ndue instances"| PG
    TICKSVC -->|"INSERT QUEUED run\nadvance nextFireAt"| PG

    DISPATCHPOLLER -->|"SELECT QUEUED runs"| PG
    DISPATCHPOLLER --> WORKERSVC

    WORKERSVC -->|"UPDATE → RUNNING\noptimistic lock"| PG
    WORKERSVC -->|"GET definition"| ES
    WORKERSVC -->|"POST /execute\nOIDC token"| EXECUTEROUTE

    EXECUTEROUTE --> WORKERRUNSVC2
    WORKERRUNSVC2 -->|"UPDATE → RUNNING"| PG
    WORKERRUNSVC2 -->|"GET definition"| ES
    WORKERRUNSVC2 -->|"download ZIP\nverify SHA-256"| GCS
    WORKERRUNSVC2 --> EXECUTOR
    EXECUTOR -->|"spawn"| JOBPROCESS

    JOBPROCESS -->|"IGA API calls\nvia SDK"| IGAPROXY
    IGAPROXY -->|"verify run is RUNNING"| PG
    IGAPROXY -->|"proxy request\nwith IGA token"| IGAPLATFORM

    JOBPROCESS -->|"POST /complete\nOIDC token"| COMPLETEROUTE
    COMPLETEROUTE -->|"UPDATE → SUCCEEDED/FAILED"| PG
    COMPLETEROUTE -->|"audit event"| ES

    WORKERSVC -->|"read secrets at dispatch"| SM
    WORKERRUNSVC2 -->|"read secrets at dispatch"| SM
```

## Data stores

| Store | Contents | Technology |
|---|---|---|
| Cloud SQL (PG 15) | `job_instances`, `job_runs` — schedule state and run queue | Cloud SQL |
| Elasticsearch | `scheduler_definitions_v1`, `scheduler_audit_v1` | Elastic Cloud |
| Cloud Storage | Approved job ZIP artifacts (`approved/<id>/<sha256>/job.zip`) | GCS |
| Secret Manager | `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET`, `DB_PASSWORD`, `ES_API_KEY` | GCP Secret Manager |

## Run state machine

```mermaid
stateDiagram-v2
    [*] --> QUEUED : tick / run-now
    QUEUED --> RUNNING : dispatcher claims run\n(optimistic UPDATE)
    RUNNING --> SUCCEEDED : job calls /complete\nexitCode=0
    RUNNING --> FAILED : job calls /complete\nexitCode≠0 or timeout
    RUNNING --> CANCELLING : operator cancel
    CANCELLING --> CANCELLED : job process exits
    FAILED --> QUEUED : operator redrive
    CANCELLED --> QUEUED : operator redrive
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

```mermaid
flowchart LR
    GH["GitHub push\nto main"] --> CB["Cloud Build"]
    CB --> TF["Step 0\nterraform output\n→ tf-outputs.json"]
    CB --> BUILD["Steps 1–4\ndocker build + push\nworker + scheduler images"]
    CB --> MIGRATE["Steps 5–6\nCloud SQL Auth Proxy\n+ node-pg-migrate"]
    CB --> DEPLOY["Steps 7–8\ngcloud run deploy\nworker + scheduler"]
```
