# Claude Code Plan 7: Worker Service Packaging and CI/CD

## Context

No GCP deployment work has been done yet — there is no Dockerfile in this repo, no
`cloudbuild.yaml`, and no worker service container source anywhere. This is greenfield
packaging.

This plan supersedes `~/Downloads/claude-code-plan-7.md`. That plan was written against
the Cloud Run Jobs architecture: it specified two separate job runtime containers
(`runtime-containers/js/runtime-worker.js`, `runtime-containers/python/runtime-worker.py`)
each responsible for GCS download, artifact verification, subprocess spawn, and
completion callback. Every bit of that logic now lives in the scheduler service codebase:

| Downloads plan 7 concern | Where it lives now |
|---|---|
| GCS download + SHA256 verify | `JobRuntimeExecutor.resolveArtifactBuffer` (plan 6 Step 6.1) |
| ZIP extract + entrypoint spawn | `JobRuntimeExecutor.execute` + `safeZipExtract` |
| Completion callback | `WorkerRunService` → `RunStore.markSucceeded/Failed` |
| HTTP server receiving dispatch | `workerApp.js` |
| SDK delivery | JS: `scheduler-sdk.js` copied by executor; Python: `PYTHONPATH` to `sdk/python/` |

There is no independent-deployment use case for the runtime logic — it runs inside the
`iga-job-worker` Cloud Run Service alongside the worker HTTP layer. Both Node.js and
Python (after plan 6) execute as child processes of the same service instance. There is
no `runtime-containers/` directory; the worker service is packaged as a single image.

The scheduler service itself (`src/app.js`) continues to deploy separately via the same
`pack build` Buildpacks approach — no Dockerfile, no change to the existing `.gcloudignore`
or `engines.node` convention. Both services are deployed from a single `cloudbuild.yaml`
pipeline.

Depends on plan 6 (`claude-code-plan-6-python-parity.md`) for Python SDK and the
`sdk/python/` package that gets pip-installed in the worker image. Independent of plan 8
(Terraform) for writing files, but `cloudbuild.yaml`'s Step 0 reads Terraform outputs,
so plan 8 must have run at least once before the pipeline can execute end-to-end.

## Assumptions

- **Single worker image** containing Node 22 + Python 3.11 + Python 3.12 + pip-installed
  `sdk/python/`. `JobRuntimeExecutor` selects the interpreter per job (`/usr/bin/python3.11`
  or `/usr/bin/python3.12` for Python; `process.execPath` for Node).
- **Repo-root build context** for the worker Dockerfile (`docker build -f
  runtime-containers/worker/Dockerfile .`) so it can `COPY sdk/python` by relative path.
  `runtime-containers/worker/` is the conventional location to keep Dockerfile and any
  build-local files separate from the main service source.
- **`cloudbuild.yaml` builds two images**: the worker service (Docker) and the scheduler
  service (Buildpacks `pack build`). It deploys both with `gcloud run deploy` — not
  `gcloud run jobs deploy`, which is the deleted Cloud Run Jobs API.
- Step 0 reads live Terraform outputs from the remote state bucket so that SA emails,
  DB connection name, VPC connector ID, and bucket name are never hand-copied into the
  YAML. Requires `deployer` SA to have `roles/storage.objectViewer` on the state bucket
  (plan 8 Step 8.7's `deployer_state_read`).
- The worker service deploy does **not** receive `--vpc-connector`. It calls GCS (public
  Google API) and the scheduler service (public Cloud Run URL) — no private network
  needed. Only the scheduler service gets `--vpc-connector` (to reach Cloud SQL's
  private IP).
- Both services deploy as the same runtime service account (`RUNTIME_SERVICE_ACCOUNT_EMAIL`
  from Terraform output `runtime_service_account_email`). The scheduler service also
  specifies its own dedicated SA (`scheduler_service_account_email`).
- `RUNTIME_WORKER_URL` (the worker service's Cloud Run URL) is self-referential for the
  scheduler service deploy step — the URL doesn't exist until the worker service is
  deployed. Handled identically to `_SERVICE_URL`: empty on first pipeline run, set via
  the trigger substitution after the worker service is first deployed.

## Out of Scope

- Running `docker build`, `gcloud builds submit`, `gcloud run deploy`, or any other
  command. All files are written and structurally reviewed only.
- Terraform / IaC (plan 8).
- Unit tests for `workerApp.js` / `jobRuntimeExecutor.js` — those live in the main test
  suite (already present).

## Stop Condition

`runtime-containers/worker/Dockerfile` and `runtime-containers/worker/package.json`
exist and are internally consistent. `cloudbuild.yaml` exists at the repo root and is
internally consistent with the env var contracts `productionValidation.js` and
`workerApp.js` require. `npm test` still green (no scheduler-service source touched by
this plan). No `docker`/`gcloud` commands executed.

---

## Step 7.1 — `runtime-containers/worker/Dockerfile`

**File:** `runtime-containers/worker/Dockerfile` (new)

```dockerfile
# Build from repo root: docker build -f runtime-containers/worker/Dockerfile .
FROM node:22-slim

# Install Python 3.11 and 3.12 for job execution parity (plan 6).
# python3-pip provides pip for sdk/python installation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3.11 python3.12 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies for the worker service.
COPY runtime-containers/worker/package.json runtime-containers/worker/package-lock.json* ./
RUN npm ci --omit=dev

# Install the Python SDK so Python jobs can import iga_scheduler without
# relying on PYTHONPATH (PYTHONPATH is set as a fallback for local dev).
COPY sdk/python /build/sdk
RUN pip install --no-cache-dir /build/sdk

# Copy the scheduler service source that the worker depends on.
# The worker entry point is src/workers/app.js; it imports from src/services/
# and src/clients/ — copy the whole src tree rather than cherry-picking.
COPY src ./src

USER node
ENV NODE_ENV=production
CMD ["node", "src/workers/app.js"]
```

`runtime-containers/worker/package.json` lists only the dependencies the worker service
imports that are not already in the root `package.json` (if the root `node_modules` is
available via `COPY`, list only the delta; if building in isolation, list the full set).
The cleanest approach for this single-image design: share the root `package.json` and
copy `node_modules` from the root install. If the root `npm ci` is used during the
build, `package.json` in `runtime-containers/worker/` is not needed — the Dockerfile
`COPY package.json package-lock.json* ./` + `npm ci` pattern from the Downloads plan
is the right shape when the worker has its own dep tree; here, since all deps are already
in the root `package.json`, copy the root lockfiles instead:

```dockerfile
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
```

This avoids maintaining a parallel dep list that can drift from the root.

### Acceptance criteria

- `COPY sdk/python /build/sdk` + `pip install` makes `from iga_scheduler import ...`
  work inside the container without `PYTHONPATH`.
- Python 3.11 and 3.12 are both available at `/usr/bin/python3.11` and
  `/usr/bin/python3.12` — the exact paths `PYTHON_BINARY_PATHS` in `jobRuntimeExecutor.js`
  (plan 6 Step 6.1) references.
- `CMD` starts the worker service, not the scheduler service.
- No `runtime-containers/js/` or `runtime-containers/python/` directories — the
  Downloads plan 7 layout is not used.

## Step 7.2 — `cloudbuild.yaml`

**File:** `cloudbuild.yaml` (repo root, new)

```yaml
substitutions:
  _REGION: us-central1
  _REPO: iga-scheduler
  _SCHEDULER_SERVICE_NAME: iga-scheduler
  _WORKER_SERVICE_NAME: iga-scheduler-worker
  _TF_STATE_BUCKET: ""   # GCS bucket for terraform/versions.tf backend — set per trigger;
                          # can't come from terraform output (it's needed to read state)
  _ES_ENDPOINT: ""        # ES cluster URL — external, not Terraform-managed
  _IGA_TOKEN_ENDPOINT: "" # IGA platform OAuth token endpoint — external
  _IGA_CLIENT_ID: ""      # IGA platform OAuth client ID — external
  _IGA_BASE_URL: ""       # IGA platform base URL — external
  _PUBLIC_API_ISSUER: ""  # PingOne issuer URL — external
  _PUBLIC_API_AUDIENCE: "" # PingOne-registered resource identifier — external
  _SERVICE_URL: ""        # scheduler service Cloud Run URL — empty on first deploy
  _RUNTIME_WORKER_URL: "" # worker service Cloud Run URL — empty on first deploy

serviceAccount: projects/${PROJECT_ID}/serviceAccounts/iga-scheduler-deployer@${PROJECT_ID}.iam.gserviceaccount.com
options:
  logging: CLOUD_LOGGING_ONLY

steps:
  # ── 0. Read live Terraform outputs ─────────────────────────────────────────
  # Single source of truth for everything Terraform manages: SA emails,
  # DB connection name, VPC connector ID, bucket name, worker service name.
  # Any Terraform re-apply that renames a resource is automatically picked up
  # by the next build — nothing in this file needs a matching edit.
  - name: hashicorp/terraform:1.7
    entrypoint: sh
    args:
      - -c
      - |
        set -eu
        cd terraform
        terraform init -input=false \
          -backend-config="bucket=${_TF_STATE_BUCKET}" \
          -backend-config="prefix=iga-scheduler"
        terraform output -json > /workspace/tf-outputs.json

  # ── Worker service image ────────────────────────────────────────────────────
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - -f
      - runtime-containers/worker/Dockerfile
      - -t
      - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-worker:$SHORT_SHA
      - .

  # ── Scheduler service image (Buildpacks, no Dockerfile) ─────────────────────
  - name: gcr.io/k8s-skaffold/pack
    entrypoint: pack
    args:
      - build
      - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-service:$SHORT_SHA
      - --builder=gcr.io/buildpacks/builder:google-22
      - --path=.
      - --publish

  - name: gcr.io/cloud-builders/docker
    args: ["push", "${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-worker:$SHORT_SHA"]
  # No separate push for scheduler image — pack's --publish already pushed it.

  # ── Deploy worker service ────────────────────────────────────────────────────
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: bash
    args:
      - -c
      - |
        set -euo pipefail
        OUT=/workspace/tf-outputs.json
        RUNTIME_SA=$(jq -r '.runtime_service_account_email.value' "$OUT")
        WORKER_NAME=$(jq -r '.worker_service_name.value' "$OUT")
        JOB_ZIP_BUCKET=$(jq -r '.job_zip_bucket_name.value' "$OUT")

        gcloud run deploy "$WORKER_NAME" \
          --image=${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-worker:$SHORT_SHA \
          --region=${_REGION} \
          --service-account="$RUNTIME_SA" \
          --min-instances=1 \
          --no-cpu-throttling \
          --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${_REGION},WORKER_EXECUTION_MODE=local,JOB_ZIP_BUCKET=$JOB_ZIP_BUCKET,RUNTIME_BROKER_URL=${_SERVICE_URL},IGA_TOKEN_ENDPOINT=${_IGA_TOKEN_ENDPOINT},IGA_CLIENT_ID=${_IGA_CLIENT_ID},IGA_BASE_URL=${_IGA_BASE_URL},RUNTIME_WORKER_URL=${_RUNTIME_WORKER_URL},RUNTIME_SERVICE_ACCOUNT_EMAIL=$RUNTIME_SA" \
          --set-secrets="IGA_CLIENT_SECRET=iga-scheduler-iga-client-secret:latest"

  # ── Deploy scheduler service ─────────────────────────────────────────────────
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: bash
    args:
      - -c
      - |
        set -euo pipefail
        OUT=/workspace/tf-outputs.json
        SCHEDULER_SA=$(jq -r '.scheduler_service_account_email.value' "$OUT")
        RUNTIME_SA=$(jq -r '.runtime_service_account_email.value' "$OUT")
        WORKER_INVOKER_SA=$(jq -r '.worker_task_invoker_email.value' "$OUT")
        SCHEDULER_TICK_SA=$(jq -r '.scheduler_tick_invoker_email.value' "$OUT")
        DB_CONN=$(jq -r '.db_instance_connection_name.value' "$OUT")
        VPC_CONNECTOR=$(jq -r '.vpc_connector_id.value' "$OUT")
        JOB_ZIP_BUCKET=$(jq -r '.job_zip_bucket_name.value' "$OUT")
        WORKER_NAME=$(jq -r '.worker_service_name.value' "$OUT")

        gcloud run deploy ${_SCHEDULER_SERVICE_NAME} \
          --image=${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-service:$SHORT_SHA \
          --region=${_REGION} \
          --vpc-connector="$VPC_CONNECTOR" \
          --vpc-egress=private-ranges-only \
          --service-account="$SCHEDULER_SA" \
          --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${_REGION},JOB_ZIP_BUCKET=$JOB_ZIP_BUCKET,ES_ENDPOINT=${_ES_ENDPOINT},WORKER_OIDC_AUDIENCE=${_SERVICE_URL},WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL=$WORKER_INVOKER_SA,SCHEDULER_OIDC_AUDIENCE=${_SERVICE_URL},SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL=$SCHEDULER_TICK_SA,WORKER_EXECUTION_MODE=isolated,RUNTIME_WORKER_URL=${_RUNTIME_WORKER_URL},RUNTIME_SERVICE_ACCOUNT_EMAIL=$RUNTIME_SA,RUNTIME_BROKER_URL=${_SERVICE_URL},IGA_TOKEN_ENDPOINT=${_IGA_TOKEN_ENDPOINT},IGA_CLIENT_ID=${_IGA_CLIENT_ID},IGA_BASE_URL=${_IGA_BASE_URL},PUBLIC_API_ISSUER=${_PUBLIC_API_ISSUER},PUBLIC_API_AUDIENCE=${_PUBLIC_API_AUDIENCE},DB_ENGINE=cloud-sql,DB_INSTANCE_CONNECTION_NAME=$DB_CONN,DB_USER=iga_scheduler_app,DB_NAME=iga_scheduler" \
          --set-secrets="ES_API_KEY=iga-scheduler-es-api-key:latest,IGA_CLIENT_SECRET=iga-scheduler-iga-client-secret:latest,DB_PASSWORD=iga-scheduler-db-password:latest"

images:
  - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-worker:$SHORT_SHA
  - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/${_REPO}/iga-scheduler-service:$SHORT_SHA
```

### Env var classification

| Var | Service | Source |
|---|---|---|
| `NODE_ENV`, `WORKER_EXECUTION_MODE`, `DB_ENGINE`, `DB_USER`, `DB_NAME` | scheduler | Literal |
| `WORKER_EXECUTION_MODE=local` | worker | Literal — worker is its own executor |
| `RUNTIME_SA`, `WORKER_INVOKER_SA`, `SCHEDULER_TICK_SA`, `DB_CONN`, `VPC_CONNECTOR`, `JOB_ZIP_BUCKET`, `WORKER_NAME` | scheduler | Step 0 Terraform output |
| `RUNTIME_SA`, `JOB_ZIP_BUCKET`, `WORKER_NAME` | worker | Step 0 Terraform output |
| `ES_ENDPOINT`, `IGA_TOKEN_ENDPOINT`, `IGA_CLIENT_ID`, `IGA_BASE_URL`, `PUBLIC_API_ISSUER`, `PUBLIC_API_AUDIENCE` | scheduler | Substitution — genuinely external to GCP |
| `IGA_TOKEN_ENDPOINT`, `IGA_CLIENT_ID`, `IGA_BASE_URL` | worker | Substitution — needed by `DirectIgaClient` fallback |
| `_SERVICE_URL` → `RUNTIME_BROKER_URL`, `WORKER_OIDC_AUDIENCE`, `SCHEDULER_OIDC_AUDIENCE` | scheduler | Substitution — self-referential, see bootstrap note |
| `_RUNTIME_WORKER_URL` → `RUNTIME_WORKER_URL` | scheduler + worker | Substitution — self-referential, see bootstrap note |
| `ES_API_KEY`, `IGA_CLIENT_SECRET`, `DB_PASSWORD` | scheduler | `--set-secrets` — never in logs or env vars |
| `IGA_CLIENT_SECRET` | worker | `--set-secrets` — needed by `DirectIgaClient` |

**Bootstrap note (two self-referential URLs, same pattern as existing `terraform/scheduler.tf`):**

1. `_SERVICE_URL` (scheduler service's own URL) — cannot be known before the service
   exists. First deploy: leave empty. Capture the assigned URL after the first pipeline
   run, set it as the trigger's `_SERVICE_URL` substitution, redeploy once. Cloud Run
   URLs are stable across redeploys.
2. `_RUNTIME_WORKER_URL` (worker service's Cloud Run URL) — same pattern. First deploy:
   leave empty. Capture after first run, set `_RUNTIME_WORKER_URL`, redeploy. After this
   one-time bootstrap, both URLs are stable indefinitely.

**`DB_PASSWORD` gap:** `pgClient.js` reads `DB_PASSWORD` unconditionally for
`DB_ENGINE=cloud-sql`, but `productionValidation.js` doesn't require it. It is provided
via `--set-secrets` here (`DB_PASSWORD=iga-scheduler-db-password:latest`), closing the
runtime gap without touching application validation.

**`jq` availability:** `gcr.io/google.com/cloudsdktool/cloud-sdk` commonly includes `jq`
but this is not guaranteed. If Step 0's consumers fail with `jq: not found`, add
`apt-get install -y jq` as the first line of each `bash -c` block.

### Acceptance criteria

- No `gcloud run jobs deploy` step — Cloud Run Jobs is the deleted architecture.
- Worker service deploy does not include `--vpc-connector`.
- Scheduler service deploy includes `--vpc-connector` and `--vpc-egress=private-ranges-only`.
- `RUNTIME_WORKER_URL` is set on the scheduler service (so `WorkerServiceRuntimeLauncher`
  knows where to POST) and on the worker service itself (so `workerApp.js`'s
  `createInternalAuthMiddleware` can validate the `audience` claim on incoming requests).
- Every var in `productionValidation.js`'s required list is covered by exactly one row
  in the table above.
- `serviceAccount:` field matches plan 8's `deployer` SA — without it, the build runs
  as Cloud Build's default SA, which has none of the IAM plan 8 Step 8.7 granted.
- `pack`'s `--publish` flag pushes the scheduler image directly; no separate push step
  for it.

---

# Definition of Done

```
- runtime-containers/worker/Dockerfile exists. Installs Node 22, Python 3.11,
  Python 3.12, and pip-installs sdk/python/. CMD starts src/workers/app.js.
- No runtime-containers/js/ or runtime-containers/python/ directories (the deleted
  Cloud Run Jobs container layout is not used).
- cloudbuild.yaml builds iga-scheduler-worker (Docker) and iga-scheduler-service
  (Buildpacks pack build) and deploys both with gcloud run deploy.
- No gcloud run jobs deploy step anywhere.
- Worker deploy: no --vpc-connector, WORKER_EXECUTION_MODE=local, min-instances=1,
  no-cpu-throttling.
- Scheduler deploy: --vpc-connector, --vpc-egress=private-ranges-only,
  WORKER_EXECUTION_MODE=isolated, RUNTIME_WORKER_URL from _RUNTIME_WORKER_URL.
- Step 0 reads terraform output -json; all SA emails, DB connection name,
  VPC connector ID, and bucket name come from there, not from hand-copied substitutions.
- DB_PASSWORD supplied via --set-secrets on the scheduler deploy step.
- Bootstrap sequence documented: _SERVICE_URL and _RUNTIME_WORKER_URL are empty on
  first deploy; set and redeploy once after the services are created.
- npm test still green (no scheduler-service source touched by this plan).
- No docker/gcloud commands actually executed during this session.
```
