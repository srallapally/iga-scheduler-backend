# IGA Scheduler Backend

A GCP-hosted job scheduling backend. Manages job definitions, cron-scheduled instances, and individual job runs. The public API is secured with PingOne or PingOne Advanced Identity Cloud (AIC) OAuth (client credentials + JWKS). Internal endpoints use Google OIDC.

Supports **JavaScript (Node 22)** and **Python (3.11 / 3.12)** job runtimes.

## Modes

| Mode | Command | Storage | Use |
|---|---|---|---|
| `local` | `npm run start:local` | SQLite + local filesystem | Development, smoke-testing |
| `production` | `npm run start:prod` | Cloud SQL Postgres + Elasticsearch + GCS | Production |

`npm start` reads `APP_MODE` from the environment (default: `production`).

PingOne / AIC OAuth is active in both modes — you need a real PingOne or AIC environment and a valid token to call the public API.

## Quick start (local mode)

```bash
# 1. Install dependencies
npm install

# 2. (Python jobs only) Install the Python SDK and its requests dependency once
pip install sdk/python/

# 3. Create .env.local and fill in the auth vars
cp .env.example .env.local
# Set APP_MODE=local and the PUBLIC_API_* / WORKER_* / SCHEDULER_* vars

# 4. (Optional) Run preflight — checks auth vars and JWKS endpoint
npm run preflight       # loads .env.local automatically

# 5. Bootstrap (creates SQLite DB)
npm run bootstrap       # loads .env.local automatically

# 6. Start
npm run start:local     # loads .env.local automatically
```

`start:local`, `bootstrap`, and `preflight` all load `.env.local` automatically via Node's `--env-file-if-exists` flag (Node 22+).

## Architecture

```
HTTP Routes (src/routes/)
    → Services (src/services/)
    → Stores / Clients (src/stores/, src/clients/)
         → Cloud SQL Postgres  (run + instance state)
         → Elasticsearch       (job definitions + audit)
         → GCS                 (job artifact ZIPs)
```

Dispatch is **pull-based**, not pushed: the scheduler only ticks (creates `QUEUED` runs on a cron); the worker service polls Postgres directly, claims runs atomically, executes them in-process, and writes its own completion back to Postgres — there is no scheduler→worker HTTP hop. See `docs/architecture.md` for the full request-flow diagrams.

`src/createApp.js` is the Express app factory used by both `src/app.js` (production) and tests.  
`src/index.js` exports `SchedulerJob` — the base class for JavaScript job authors.  
`sdk/python/` exports the equivalent Python SDK (`iga_scheduler` package).

### Core concepts

- **Job definition** — a versioned ZIP artifact (manifest + entrypoint) stored in GCS and indexed in ES. Parameters are validated against a Zod schema declared in the zip.
- **Job instance** — a cron schedule bound to a definition, with parameter values. Stored in Postgres.
- **Run** — a single execution of a job instance. Created by the tick, executed by a worker.

### Run state machine

```
QUEUED → RUNNING → SUCCEEDED
                 → FAILED
                 → CANCELLING → CANCELLED
```

Redrive creates a new run with `runId` appended as `:redrive:<uuid>`.

### Tick

`SchedulerTickService` fires every minute (triggered by GCP Cloud Scheduler). It finds instances where `nextFireAt <= now`, creates `QUEUED` run rows in Postgres (snapshotting each due instance's definition/artifact metadata onto the row so the worker never needs Elasticsearch on its dispatch path), and advances `nextFireAt` — all in one transaction. The scheduler does not push runs to the worker; that's the worker's own job.

### Worker service (`iga-job-worker`)

A fixed-size warm pool of Cloud Run Service instances (`--min-instances` and `--max-instances` both set to the same `worker_pool_size` — a poll loop has no inbound-request signal for Cloud Run to autoscale on, so the pool is sized deliberately rather than elastically). Each instance runs its own poll loop (`src/workers/pollLoop.js`) that atomically claims a batch of `QUEUED` runs directly from Postgres (`FOR UPDATE SKIP LOCKED`, minting a fresh fencing token per claim) and executes them in-process via `WorkerRunService`/`JobRuntimeExecutor` — ZIP extraction, SDK injection, and child process spawn for both JavaScript and Python jobs, under a configurable per-instance concurrency cap. Artifact ZIPs are downloaded from GCS and their SHA-256 verified against the pinned GCS object generation at claim time. The worker also runs a heartbeat loop that refreshes each owned run's liveness and self-cancels the subprocess (SIGTERM → SIGKILL) if an operator requests cancellation — again with no inbound HTTP call. The worker's only inbound HTTP route is `/health`.

## Project structure

```
src/
├── main.js                   Universal entry — reads APP_MODE, delegates to app.js or app.local.js
├── createApp.js              Express app factory
├── app.js                    Production startup
├── app.local.js              Local startup (SQLite, no GCP/ES)
├── index.js                  SDK export (SchedulerJob)
├── backends/local/           SQLite-backed implementations for local mode
├── clients/                  ES, GCS, Cloud SQL, Secret Manager clients
├── config/                   Config loader + production validation
├── elasticsearch/            Index mapping definitions
├── iga/                      IGA API client + token manager
├── middleware/               publicAuth (PingOne/AIC), internalAuth (Google OIDC)
├── routes/                   Express routers (public + internal)
├── runtime/                  JS JobContext, parameters, result model
├── sdk/                      scheduler-sdk.js injected into JS job child processes
├── services/                 Tick, worker run execution, run control, IGA proxy
├── stores/                   Postgres run + instance stores
├── utils/                    Cron, hashing, ZIP validation, run IDs
├── validation/               Zod schemas for request payloads
└── workers/                  workerApp.js (health check only) + pollLoop.js
│                             (claim/execute/heartbeat/cancel) — the
│                             iga-job-worker Cloud Run Service
sdk/python/                   Python SDK (iga_scheduler package)
├── iga_scheduler/            Package source: SchedulerJob, context, iga_client, run_job
├── tests/                    pytest tests
└── pyproject.toml
runtime-containers/
└── worker/Dockerfile         Single worker image: Node 22 + Python 3.11/3.12 + sdk/python
migrations/                   SQL migrations (node-pg-migrate)
scripts/
├── bootstrap.js              Idempotent local/dev bootstrap
└── prod/
    ├── preflight.js          Pre-deploy connectivity + config validation (7 checks)
    ├── bootstrap-prod.js     Production bootstrap (PG migrations + ES indices)
    ├── deploy.sh             Full deploy: terraform apply → preflight → bootstrap
    └── teardown.js           Destroy prod resources
terraform/                    Full GCP infrastructure (VPC, Cloud SQL, GCS, Artifact Registry,
│                             Secret Manager, service accounts, worker service, Cloud Scheduler,
│                             Cloud Build trigger)
cloudbuild.yaml               CI/CD: builds worker image + scheduler image, deploys both
examples/
├── js/                       JavaScript job examples
└── python/                   Python job examples
```

## npm scripts

| Script | Purpose |
|---|---|
| `npm start` | Start (reads `APP_MODE`, default `production`) |
| `npm run start:local` | Force local mode |
| `npm run start:prod` | Force production mode |
| `npm test` | Run all tests (`vitest run`) |
| `npm run bootstrap` | Idempotent local bootstrap |
| `npm run preflight` | Pre-deploy validation (local: auth vars + JWKS; production: 7 checks) |
| `npm run bootstrap:prod` | Production bootstrap |
| `npm run bootstrap:prod:dry-run` | Dry-run production bootstrap |
| `npm run migrate:up` | Apply pending PG migrations |
| `npm run migrate:down` | Roll back latest PG migration |

## Environment variables

Use `.env.local` for local mode and set vars directly in the environment (or a secrets manager) for production. Never commit either file.

| File | Mode | Loaded by |
|---|---|---|
| `.env.local` | local | `npm run start:local`, `bootstrap`, `preflight` (auto, via `--env-file-if-exists`) |
| `.env` | any | must be loaded manually (e.g. `node --env-file .env ...`) |

Copy `.env.example` as a starting point.

**Required in all modes:**

| Variable | Purpose |
|---|---|
| `PUBLIC_API_ISSUER` | OAuth AS issuer — see **Choosing an authorization server** below |
| `PUBLIC_API_AUDIENCE` | Expected JWT audience |
| `WORKER_OIDC_AUDIENCE` | Audience for `/internal/job-runs/*` (retry/cancel/redrive control routes) |
| `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL` | Service account allowed to invoke those control routes |
| `SCHEDULER_OIDC_AUDIENCE` | Audience for `/internal/scheduler/*` calls |
| `SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL` | Service account allowed to invoke tick endpoint |

**Additional required in production mode:**

| Variable | Purpose |
|---|---|
| `GCP_PROJECT_ID` | GCP project |
| `JOB_ZIP_BUCKET` | GCS bucket for job artifact ZIPs |
| `ES_ENDPOINT` | Elasticsearch cluster URL |
| `ES_API_KEY` | Elasticsearch API key |
| `DB_ENGINE` | `cloud-sql` or `direct` |
| `DB_INSTANCE_CONNECTION_NAME` | Cloud SQL connection name (if `cloud-sql`) |
| `DB_USER` | Postgres user (if `cloud-sql`) |
| `DB_NAME` | Postgres database name (if `cloud-sql`) |
| `DATABASE_URL` | Postgres URL (if `direct`) |
| `WORKER_EXECUTION_MODE` | Must be `isolated` in production |
| `RUNTIME_SERVICE_ACCOUNT_EMAIL` | Service account running the worker service |
| `RUNTIME_BROKER_URL` | Scheduler service URL — the IGA proxy the worker's job subprocesses call back to (`/internal/runtime/iga/request`) |
| `IGA_TOKEN_ENDPOINT` | IGA OAuth token endpoint |
| `IGA_CLIENT_ID` | IGA client ID |
| `IGA_CLIENT_SECRET` | IGA client secret (or Secret Manager reference `projects/...`) |
| `IGA_BASE_URL` | IGA API base URL |
| `PUBLIC_API_ALGORITHMS` | Optional, comma-separated JWT algorithm allowlist (default `RS256,ES256,PS256` — covers both PingOne and AIC) |

Dispatch is pull-based: the worker polls Postgres directly and has no `/execute` endpoint, so there's no `RUNTIME_WORKER_URL`/worker-invoker-audience pair to configure for that path. `GCP_PROJECT_ID`, `JOB_ZIP_BUCKET`, `ES_ENDPOINT`, and `ES_API_KEY` must be set on **both** the scheduler and worker Cloud Run services — the worker needs Elasticsearch access itself now, as a fallback for the rare run whose definition wasn't snapshotted at tick time.

**Optional Python binary overrides (local dev):**

| Variable | Purpose |
|---|---|
| `PYTHON311_BIN` | Full path to `python3.11` if not on `PATH` (e.g. pyenv) |
| `PYTHON312_BIN` | Full path to `python3.12` if not on `PATH` |

## Choosing an authorization server

Set `PUBLIC_API_ISSUER` to the issuer URL of whichever product your organization has licensed. The middleware auto-discovers the JWKS URL via OIDC discovery (`<issuer>/.well-known/openid-configuration`).

**PingOne (classic)**

```
PUBLIC_API_ISSUER=https://auth.pingone.com/<env-id>/as
```

**PingOne Advanced Identity Cloud (AIC)**

```
PUBLIC_API_ISSUER=https://<tenant>.forgeblocks.com/am/oauth2/<realm>
```

For example, for the `alpha` realm:
```
PUBLIC_API_ISSUER=https://openam-example.forgeblocks.com/am/oauth2/alpha
```

Set `PUBLIC_API_JWKS_URL` only if you need to point at a non-standard JWKS endpoint — discovery is then skipped entirely.

## Production bootstrap

`preflight.js` validates all required vars and probes live connectivity without writing anything. In production mode it runs 7 checks: env vars, Elasticsearch, Postgres, GCS bucket, worker service health, Secret Manager, and JWKS endpoint. In local mode it checks only auth vars and JWKS.

```bash
npm run preflight
# or pass ES/GCP creds as flags:
node scripts/prod/preflight.js \
  --es-endpoint https://my-cluster.es.io:9243 \
  --es-api-key  <key> \
  --gcp-project my-project
```

Then seed Postgres migrations and Elasticsearch indices:

```bash
npm run bootstrap:prod
# or dry-run to see what would change:
npm run bootstrap:prod:dry-run
```

## Infrastructure

All GCP infrastructure is managed by Terraform in `terraform/`. Resources include:

- **Networking** — VPC, Private Service Access peering, Serverless VPC Access connector (for scheduler/worker → Cloud SQL)
- **Cloud SQL** — PostgreSQL, regional HA, private IP
- **GCS** — job artifact ZIP bucket with versioning and `public_access_prevention = "enforced"`
- **Artifact Registry** — Docker repository for the worker service image
- **Secret Manager** — `iga-scheduler-{db-password,iga-client-secret,es-api-key,github-token}`
- **Service accounts** — `scheduler-service`, `runtime` (worker), `deployer` (CI/CD)
- **Worker service** — `iga-job-worker` Cloud Run Service, a fixed warm pool: `--min-instances` and `--max-instances` are both set to `worker_pool_size` (a poll loop has no inbound-request signal for Cloud Run to autoscale on, so the pool is sized deliberately rather than elastically; peak capacity is `worker_pool_size × WORKER_MAX_CONCURRENCY`)
- **Cloud Scheduler** — minute-tick trigger for `SchedulerTickService`
- **Cloud Build** — GitHub trigger on push to `main`, running `cloudbuild.yaml`

### First deploy

```bash
# 1. Provision infrastructure
cd terraform
terraform init -backend-config="bucket=<your-tfstate-bucket>" -backend-config="prefix=iga-scheduler"
terraform apply

# 2. Set secret values out-of-band (Terraform creates the secret shells; values are yours to supply)
echo -n "<iga-client-secret>" | gcloud secrets versions add iga-scheduler-iga-client-secret --data-file=-
echo -n "<es-api-key>"        | gcloud secrets versions add iga-scheduler-es-api-key        --data-file=-
echo -n "<github-pat>"        | gcloud secrets versions add iga-scheduler-github-token       --data-file=-

# 3. Trigger the first build manually (before the Cloud Build trigger has a real image)
gcloud builds submit --config=cloudbuild.yaml .

# 4. Capture service URLs and re-apply to wire the self-referential substitutions
# (set _SERVICE_URL and _RUNTIME_WORKER_URL in the Cloud Build trigger, then re-apply)
terraform apply
```

For subsequent deploys, push to `main` — the Cloud Build trigger runs automatically.

The coordinating script `scripts/prod/deploy.sh` sequences `terraform apply → preflight → bootstrap:prod` for operator-driven releases.

## Writing a job

### JavaScript

```js
import { SchedulerJob } from 'iga-scheduler';

export default class MyJob extends SchedulerJob {
  async execute(context) {
    const target = context.param.requiredString('target');
    const result = await context.igaClient.execute('POST', '/some/endpoint', { target });
    return { processed: result.count };
  }
}
```

### Python

```python
from iga_scheduler import SchedulerJob, run_job

class MyJob(SchedulerJob):
    def execute(self, context):
        target = context["param"].required_string("target")
        result = context["iga_client"].execute("POST", "/some/endpoint", {"target": target})
        return {"processed": result["count"]}

run_job(MyJob)
```

### Manifest

Every job ZIP must include a `manifest.json` at the root:

```json
{
  "entrypoint": "job.js",
  "runtime": "javascript",
  "wrapperVersion": "1"
}
```

For Python jobs use `"runtime": "python"` and set `"runtimeVersion": "python311"` or `"python312"` on the job definition.

See `examples/js/` and `examples/python/` for complete samples.

## Tests

```bash
npm test                          # all JS tests (vitest run)
npx vitest run test/some.test.js  # single JS test file
python3 -m pytest sdk/python/     # Python SDK tests
```

No build step — the app runs as ESM directly under Node 22.

### End-to-end local testing for Python jobs

In `APP_MODE=local` the scheduler spawns job subprocesses directly via `JobRuntimeExecutor` — no separate worker service is involved. This means you can test a Python job end-to-end with just the scheduler running locally.

**Prerequisites**

```bash
# Install the Python SDK and any libraries your job uses
pip install sdk/python/ numpy scipy pandas scikit-learn python-dateutil

# Ensure python3.11 is on PATH, or set PYTHON311_BIN to the full path
python3.11 --version
```

**`.env.local` additions for Python jobs**

```bash
# DirectIgaClient reads these from the child process environment
IGA_BASE_URL=https://<tenant>.forgeblocks.com/am
IGA_TOKEN_ENDPOINT=https://<tenant>.forgeblocks.com/am/oauth2/alpha/access_token
IGA_CLIENT_ID=<your-client-id>
IGA_CLIENT_SECRET=<your-client-secret>
```

**Run the scheduler, then register and execute the job**

```bash
# Terminal 1
npm run start:local

# Terminal 2 — zip, register, and run (example: alpha-users-ml-job)
cd examples/python/alpha-users-ml-job
zip -j alpha-users-ml.zip manifest.json job.py
cd ../../..

# Create the job definition — metadata + artifact zip in one multipart upload
curl -s -X POST http://localhost:3000/job-definitions \
  -H "Authorization: Bearer <token>" \
  -F 'metadata={
    "definitionId": "alpha-users-ml",
    "name": "Alpha Users ML Anomaly Detection",
    "runtime": "python",
    "runtimeVersion": "python311",
    "entrypoint": "job.py",
    "parameters": [
      { "name": "pageSize",      "type": "string", "required": true },
      { "name": "contamination", "type": "string", "required": true },
      { "name": "fields",        "type": "string", "required": false }
    ]
  };type=application/json' \
  -F "artifact=@examples/python/alpha-users-ml-job/alpha-users-ml.zip;type=application/zip"

# Create a cron instance for the definition
curl -s -X POST http://localhost:3000/job-definitions/alpha-users-ml/instances \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceId": "alpha-users-ml-nightly",
    "schedule": { "type": "cron", "expression": "0 2 * * *", "timezone": "UTC" },
    "parameters": {
      "pageSize":      { "type": "string", "value": "50" },
      "contamination": { "type": "string", "value": "0.05" }
    }
  }'

# Trigger it immediately instead of waiting for the cron schedule
curl -s -X POST http://localhost:3000/job-instances/alpha-users-ml-nightly/run-now \
  -H "Authorization: Bearer <token>"
```

Poll the run status to see results:

```bash
curl -s http://localhost:3000/job-runs/<runId> \
  -H "Authorization: Bearer <token>" | jq .result
```

**Faster iteration options**

- **Unit-test ML logic without AIC**: call `build_feature_matrix` and `run_anomaly_detection` directly with synthetic data — no scheduler or network needed.
- **Test AIC connectivity directly**: set `IGA_SCHEDULER_CONTEXT_FILE`, `IGA_SCHEDULER_RUN_ID`, and the IGA env vars, then run `python3.11 examples/python/alpha-users-ml-job/job.py` directly. `PYTHONPATH` must include `sdk/python/`.

## Further reading

- `docs/architecture.md` — full request-flow diagrams (tick, pull-worker claim/execute/heartbeat, IGA proxy, CI/CD)
- `docs/runbook.md` — full operator runbook (local dev, production deploy, troubleshooting)
- `docs/adr/` — architecture decisions, one per significant change (Postgres-as-queue, PingOne auth, pull-worker execution model, and more)
- `docs/bug-log.md` — the project's security/correctness/availability review log — what's been found, fixed, and why some items were closed as won't-fix
- `terraform/README.md` — Terraform variables reference
