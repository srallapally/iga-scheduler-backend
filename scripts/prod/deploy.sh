#!/usr/bin/env bash
# Usage: source scripts/prod/set-env.sh && bash scripts/prod/deploy.sh
#
# Idempotent: safe to re-run at any stage. Imports pre-existing GCP resources
# into Terraform state so apply never errors on 409s.
#
# Required environment variables — set via scripts/prod/set-env.sh:
#   GCP_PROJECT_ID, JOB_ZIP_BUCKET, TF_STATE_BUCKET
#   ES_ENDPOINT, ES_API_KEY
#   DB_ENGINE, DB_INSTANCE_CONNECTION_NAME, DB_USER, DB_NAME
#   WORKER_EXECUTION_MODE, RUNTIME_WORKER_URL, RUNTIME_SERVICE_ACCOUNT_EMAIL
#   RUNTIME_BROKER_URL
#   IGA_TOKEN_ENDPOINT, IGA_CLIENT_ID, IGA_CLIENT_SECRET, IGA_BASE_URL
#   PUBLIC_API_ISSUER, PUBLIC_API_AUDIENCE
#   WORKER_OIDC_AUDIENCE, WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
#   SCHEDULER_OIDC_AUDIENCE, SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
#   GITHUB_PAT  — GitHub Personal Access Token (repo read) for Cloud Build connection
set -euo pipefail

# ── Required env var check ────────────────────────────────────────────────────
REQUIRED_VARS=(
  GCP_PROJECT_ID JOB_ZIP_BUCKET TF_STATE_BUCKET
  ES_ENDPOINT ES_API_KEY
  DB_ENGINE
  WORKER_EXECUTION_MODE RUNTIME_WORKER_URL RUNTIME_SERVICE_ACCOUNT_EMAIL
  RUNTIME_BROKER_URL
  IGA_TOKEN_ENDPOINT IGA_CLIENT_ID IGA_CLIENT_SECRET IGA_BASE_URL
  PUBLIC_API_ISSUER PUBLIC_API_AUDIENCE
  WORKER_OIDC_AUDIENCE WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
  SCHEDULER_OIDC_AUDIENCE SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
  GITHUB_PAT
)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!v:-}" ]] && MISSING+=("$v")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: missing required environment variables:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  exit 1
fi

# Prevent Terraform from erroring on unsupported OTEL protocol values
unset OTEL_TRACES_EXPORTER OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${GCP_PROJECT_ID}"
REGION="us-central1"

# ── Helper: import a resource into TF state only if not already tracked ───────
tf_import_if_missing() {
  local address="$1"
  local id="$2"
  if terraform state show "$address" &>/dev/null; then
    echo "  [import] $address already in state — skipping"
  else
    echo "  [import] importing $address"
    terraform import -input=false "$address" "$id"
  fi
}

# ── Helper: seed a Secret Manager secret version if no versions exist ─────────
seed_secret_if_empty() {
  local secret_id="$1"
  local value="$2"
  local count
  count=$(gcloud secrets versions list "$secret_id" \
    --project="$PROJECT" --filter="state=ENABLED" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  if [[ "$count" -gt 0 ]]; then
    echo "  [secret] $secret_id already has a version — skipping"
  else
    echo "  [secret] seeding $secret_id"
    echo -n "$value" | gcloud secrets versions add "$secret_id" \
      --data-file=- --project="$PROJECT"
  fi
}

# ── Step 0: Enable Compute Engine API before Terraform needs it ───────────────
# (networking.tf creates a VPC; Compute must be enabled first)
echo ""
echo "=== Step 0: Enabling required GCP APIs ==="
for api in compute.googleapis.com secretmanager.googleapis.com; do
  gcloud services enable "$api" --project="$PROJECT" --quiet
done

# ── Step 1: Terraform init ────────────────────────────────────────────────────
echo ""
echo "=== Step 1: Terraform init ==="
cd "$REPO_ROOT/terraform"
terraform init -input=false -migrate-state -force-copy \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=iga-scheduler"

# ── Step 2: Import pre-existing resources so apply doesn't get 409s ──────────
echo ""
echo "=== Step 2: Importing pre-existing resources ==="

tf_import_if_missing \
  "google_artifact_registry_repository.runtime_images" \
  "projects/${PROJECT}/locations/${REGION}/repositories/iga-scheduler"

tf_import_if_missing \
  "google_storage_bucket.job_zip" \
  "${PROJECT}/${JOB_ZIP_BUCKET}"

# Import pre-existing Cloud Scheduler service accounts and IAM bindings
# (created by the previous partial apply)
tf_import_if_missing \
  "google_service_account.scheduler_tick_invoker" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-tick-invoker@${PROJECT}.iam.gserviceaccount.com"

tf_import_if_missing \
  "google_service_account.worker_task_invoker" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-worker-invoker@${PROJECT}.iam.gserviceaccount.com"

tf_import_if_missing \
  "google_cloud_run_service_iam_member.scheduler_tick_invoker" \
  "v1/projects/${PROJECT}/locations/${REGION}/services/iga-scheduler/roles/run.invoker/serviceAccount:iga-scheduler-tick-invoker@${PROJECT}.iam.gserviceaccount.com"

tf_import_if_missing \
  "google_cloud_run_service_iam_member.worker_task_invoker" \
  "v1/projects/${PROJECT}/locations/${REGION}/services/iga-scheduler/roles/run.invoker/serviceAccount:iga-scheduler-worker-invoker@${PROJECT}.iam.gserviceaccount.com"

# ── Step 3: Seed github_token before Terraform (Cloud Build connection needs it) ─
echo ""
echo "=== Step 3: Seeding github_token secret ==="
seed_secret_if_empty "iga-scheduler-github-token" "$GITHUB_PAT"

# ── Step 4: Terraform apply ───────────────────────────────────────────────────
echo ""
echo "=== Step 4: Terraform apply ==="
terraform apply -input=false -auto-approve "$@"

# ── Step 4b: Seed remaining secrets (shells created by Terraform apply above) ─
echo ""
echo "=== Step 4b: Seeding app secrets ==="
seed_secret_if_empty "iga-scheduler-iga-client-id"     "$IGA_CLIENT_ID"
seed_secret_if_empty "iga-scheduler-iga-client-secret" "$IGA_CLIENT_SECRET"
seed_secret_if_empty "iga-scheduler-es-api-key"        "$ES_API_KEY"

# ── Step 5: npm preflight + bootstrap ────────────────────────────────────────
echo ""
echo "=== Step 5: Preflight + bootstrap ==="
cd "$REPO_ROOT"
npm run preflight
# Bootstrap ES indices only — PG migrations run inside Cloud Build (Cloud SQL
# is private-IP, not reachable from the operator's local machine).
node scripts/prod/bootstrap-prod.js --skip-preflight --es-only

echo ""
echo "=== Deploy complete ==="
echo ""
echo "First deploy? The Cloud Run services don't have real URLs yet."
echo "Run the initial build to create them:"
echo "  gcloud builds submit --config=cloudbuild.yaml . --project=${PROJECT} \\"
echo "    --substitutions=SHORT_SHA=\$(git rev-parse --short HEAD),_TF_STATE_BUCKET=${TF_STATE_BUCKET}"
echo ""
echo "Then retrieve the URLs and re-run this script:"
echo "  SCHEDULER_URL=\$(gcloud run services describe iga-scheduler --region=${REGION} --project=${PROJECT} --format='value(status.url)')"
echo "  WORKER_URL=\$(gcloud run services describe iga-scheduler-worker --region=${REGION} --project=${PROJECT} --format='value(status.url)')"
echo "  Update terraform/terraform.tfvars: cloud_run_service_url and scripts/prod/set-env.sh: RUNTIME_BROKER_URL, RUNTIME_WORKER_URL"
