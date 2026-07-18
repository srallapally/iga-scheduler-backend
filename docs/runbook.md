 and# IGA Scheduler — Operator Runbook

This service runs in two modes controlled by `APP_MODE`:

| Mode | Command | Backing store | Auth |
|---|---|---|---|
| `local` | `npm run start:local` | SQLite + local filesystem | Real PingOne JWT |
| `production` | `npm run start:prod` | Cloud SQL + ES + GCS | Real PingOne JWT |

`npm start` reads `APP_MODE` from the environment (defaults to `production`).

---

## Local mode (development / smoke-testing)

Local mode requires no GCP account, no Elasticsearch, and no Postgres.
PingOne OAuth is fully active — you need a real PingOne environment and a valid token to call the public API.

### 1. Copy and fill the env file

```bash
cp .env.example .env
```

Edit `.env`. The only vars required in local mode are:

```
APP_MODE=local
PUBLIC_API_ISSUER=https://auth.pingone.com/<env-id>/as
PUBLIC_API_AUDIENCE=https://iga-scheduler.example.com
WORKER_OIDC_AUDIENCE=https://iga-scheduler.example.com
WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL=iga-worker@<project>.iam.gserviceaccount.com
SCHEDULER_OIDC_AUDIENCE=https://iga-scheduler.example.com
SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL=iga-scheduler-tick@<project>.iam.gserviceaccount.com
```

### 2. Bootstrap (creates the SQLite DB)

```bash
node -r dotenv/config scripts/bootstrap.js
# or if you load .env another way:
APP_MODE=local npm run bootstrap
```

Output: `[local] SQLite DB ready at .local-data/scheduler.db`

### 3. Start

```bash
APP_MODE=local npm run start:local
```

Or simply `npm start` if `APP_MODE=local` is in your environment.

### 4. Obtain a PingOne token

```bash
TOKEN=$(curl -s -X POST "$PUBLIC_API_ISSUER/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=<id>&client_secret=<secret>&audience=$PUBLIC_API_AUDIENCE" \
  | jq -r .access_token)
```

### 5. Quick smoke-test

```bash
# Health (no auth required)
curl http://localhost:3000/health

# List definitions (auth required)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/job-definitions

# Upload a definition
curl -X POST http://localhost:3000/job-definitions \
  -H "Authorization: Bearer $TOKEN" \
  -F artifact=@my-job.zip \
  -F 'metadata={"definitionId":"my-job","name":"My Job","runtime":"javascript","runtimeVersion":"22","wrapperVersion":"1.0.0","entrypoint":"index.js"}'
```

Artifacts are stored under `.local-data/artifacts/` and the SQLite DB is at `.local-data/scheduler.db`.

---

## Production mode

### Prerequisites

| Resource | Notes |
|---|---|
| GCP project | Cloud Run, Cloud SQL, GCS, Cloud Scheduler, Secret Manager APIs enabled |
| Cloud SQL (Postgres 15+) | Regional HA recommended; see Cloud SQL section below |
| Elasticsearch cluster | Elastic Cloud or self-hosted; API key with `indices:admin/create`, `indices:data/write` |
| GCS bucket | For job artifact zips |
| PingOne environment | Client credentials application; see PingOne section below |
| Cloud Run service | The scheduler deployed as a Cloud Run service |

### 1. GCP IAM setup

Create four service accounts and bind the minimum required roles:

```bash
PROJECT=<your-project-id>

# Scheduler tick invoker — calls /internal/scheduler/tick
gcloud iam service-accounts create iga-scheduler-tick \
  --display-name "IGA Scheduler tick invoker" --project $PROJECT

# Worker invoker — calls /internal/worker/*
gcloud iam service-accounts create iga-worker \
  --display-name "IGA Worker invoker" --project $PROJECT

# Job runtime — executes job artifacts via Cloud Run Job
gcloud iam service-accounts create iga-runtime \
  --display-name "IGA Job runtime" --project $PROJECT

# App service account — the Cloud Run service identity
gcloud iam service-accounts create iga-scheduler-app \
  --display-name "IGA Scheduler app" --project $PROJECT
```

Bind roles to the app service account:

```bash
SA=iga-scheduler-app@$PROJECT.iam.gserviceaccount.com

# Cloud SQL
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client"

# GCS
gcloud storage buckets add-iam-policy-binding gs://<bucket> \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"

# Secret Manager
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
# This grants project-wide secretAccessor, so $SA can physically read the
# platform secrets below (DB_PASSWORD, IGA_CLIENT_ID/SECRET, ES_API_KEY,
# GitHub token) in addition to job-parameter secrets. The app layer refuses
# any sensitive job parameter that references those platform secrets or a
# secret outside the SECRET_PARAM_PREFIX namespace (see .env.example), but
# that is a soft control — the scoped-SA hardening (job-parameter secrets
# only) is a tracked follow-on, not done here.
#
# Create job-parameter secrets with the SECRET_PARAM_PREFIX (default
# job-param-), e.g.:
#   gcloud secrets create job-param-salesforce-api-key --project=$PROJECT

# Cloud Run Jobs (to launch job runtime)
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/run.developer"
```

Allow the tick and worker invokers to call Cloud Run:

```bash
CLOUD_RUN_SERVICE=iga-scheduler
REGION=us-central1

gcloud run services add-iam-policy-binding $CLOUD_RUN_SERVICE \
  --region=$REGION --project=$PROJECT \
  --member="serviceAccount:iga-scheduler-tick@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

gcloud run services add-iam-policy-binding $CLOUD_RUN_SERVICE \
  --region=$REGION --project=$PROJECT \
  --member="serviceAccount:iga-worker@$PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

### 2. Cloud SQL setup

```bash
INSTANCE=iga-scheduler-db
REGION=us-central1

# Create instance (adjust tier/flags as needed)
gcloud sql instances create $INSTANCE \
  --database-version=POSTGRES_15 \
  --tier=db-g1-small \
  --region=$REGION \
  --availability-type=REGIONAL \
  --project=$PROJECT

# Create database
gcloud sql databases create iga_scheduler \
  --instance=$INSTANCE --project=$PROJECT

# Create app user (use IAM auth in production; password shown for clarity)
gcloud sql users create iga_scheduler_app \
  --instance=$INSTANCE --project=$PROJECT

# Get connection name for DB_INSTANCE_CONNECTION_NAME
gcloud sql instances describe $INSTANCE \
  --project=$PROJECT --format="value(connectionName)"
```

### 3. Run Postgres migrations

Set DB env vars, then:

```bash
DB_ENGINE=cloud-sql \
DB_INSTANCE_CONNECTION_NAME=<project>:<region>:<instance> \
DB_USER=iga_scheduler_app \
DB_NAME=iga_scheduler \
npm run migrate:up
```

Or via the unified bootstrap script:

```bash
APP_MODE=production \
DB_ENGINE=cloud-sql \
DB_INSTANCE_CONNECTION_NAME=<project>:<region>:<instance> \
DB_USER=iga_scheduler_app \
DB_NAME=iga_scheduler \
ES_ENDPOINT=https://... \
ES_API_KEY=... \
npm run bootstrap
```

Bootstrap is idempotent — safe to re-run; existing tables and indices are left unchanged.

### 4. Elasticsearch index setup

```bash
ES_ENDPOINT=https://my-cluster.es.io:9243 \
ES_API_KEY=<key> \
GCP_PROJECT_ID=<project> \
JOB_ZIP_BUCKET=<bucket> \
npm run bootstrap:es
```

Two indices are created if they don't already exist: `scheduler_definitions_v1` and `scheduler_audit_v1`.

### 5. PingOne configuration

In your PingOne environment:

1. Create a new **Application** → type **Worker** (machine-to-machine, client credentials grant).
2. Note the **Client ID**, **Client Secret**, **Environment ID**.
3. The issuer URL is `https://auth.pingone.com/<env-id>/as`.
4. The JWKS URL is `https://auth.pingone.com/<env-id>/as/jwks` (used automatically if you only set `PUBLIC_API_ISSUER`).
5. Set `PUBLIC_API_AUDIENCE` to the value configured in the PingOne application's resource/audience field — must match exactly what PingOne puts in the `aud` claim.
6. Optionally add a custom scope (e.g. `scheduler:manage`) and set `PUBLIC_API_REQUIRED_SCOPE`.

Env vars to set on the Cloud Run service:

```
PUBLIC_API_ISSUER=https://auth.pingone.com/<env-id>/as
PUBLIC_API_AUDIENCE=https://iga-scheduler.example.com
```

### 6. Copy and fill the env file for production

```bash
cp .env.example .env.production
# Edit all PRODUCTION MODE vars; remove LOCAL MODE section
```

Deploy to Cloud Run with these as environment variables (use Cloud Run's `--set-env-vars` or Secret Manager mounts — never commit secrets).

### 7. Provision GCP infrastructure (Terraform)

The `terraform/` directory provisions the **complete** GCP stack: VPC, Cloud SQL, GCS, Artifact Registry, Secret Manager, Cloud Run worker service, Cloud Scheduler tick job, all service accounts + IAM bindings, and the Cloud Build CI/CD trigger.

See `terraform/README.md` for the full variable reference. The minimum required variables with no defaults are:

```
project_id, cloud_run_service_name, cloud_run_service_url,
tf_state_bucket_name, github_app_installation_id,
es_endpoint, iga_token_endpoint, iga_client_id, iga_base_url,
public_api_issuer, public_api_audience
```

Copy and fill the example vars file, then apply:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars

terraform init \
  -backend-config="bucket=<tf-state-bucket>" \
  -backend-config="prefix=iga-scheduler"

terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

> **First deploy?** `cloud_run_service_url` and `scheduler_service_url` should be left empty (`""`) on the first apply — the Cloud Run services don't exist yet. After the first `cloudbuild.yaml` run creates them, retrieve the assigned URLs and re-apply with the real values. See `README.md` → "First deploy" for the full bootstrap loop.

### 8. Verify

```bash
# Health check
curl https://<cloud-run-host>/health

# Trigger a manual tick
gcloud scheduler jobs run iga-scheduler-tick \
  --project=$PROJECT --location=$REGION

# Bootstrap is idempotent — re-run anytime to verify all indices/tables exist
APP_MODE=production ... npm run bootstrap -- --dry-run
```

---

## npm script reference

| Script | What it does |
|---|---|
| `npm start` | Start using `APP_MODE` env var (default: production) |
| `npm run start:local` | Force local mode (SQLite) |
| `npm run start:prod` | Force production mode (Cloud SQL + ES) |
| `npm run bootstrap` | Idempotent setup for current mode (ES indices + PG migrations, or SQLite) |
| `npm run bootstrap -- --dry-run` | Print what bootstrap would do, no writes |
| `npm run bootstrap -- --es-only` | ES indices only |
| `npm run bootstrap -- --pg-only` | Postgres migrations only |
| `npm run migrate:up` | Run pending Postgres migrations directly |
| `npm run migrate:down` | Roll back one Postgres migration |
| `npm test` | Run all tests |

---

## Troubleshooting

**`Missing required environment variables`** — Check that all vars listed in `.env.example` for your mode are set. Run `npm run bootstrap -- --dry-run` to confirm connectivity vars are present.

**`PUBLIC_API_ISSUER is required`** — This is needed in both local and production mode. The publicAuth middleware starts on first request.

**`invalid bearer token` (401)** — Verify `PUBLIC_API_ISSUER` and `PUBLIC_API_AUDIENCE` exactly match the PingOne application settings. The `aud` claim in the token must equal `PUBLIC_API_AUDIENCE`.

**Tick creates no runs** — Check `GET /health` for `runtimeJobConfigured` / `runtimeBrokerConfigured`. Confirm instances exist with `next_fire_at` in the past. Trigger a manual tick via Cloud Scheduler or `POST /internal/scheduler/tick` with a valid scheduler OIDC token.

**Cloud SQL connection refused** — Confirm `DB_INSTANCE_CONNECTION_NAME` is correct and the app service account has `roles/cloudsql.client`. For AlloyDB via proxy, use `DB_ENGINE=direct` with `DATABASE_URL` pointing to the proxy sidecar.
