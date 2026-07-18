#!/usr/bin/env bash
# Usage: source scripts/prod/set-env.sh && bash scripts/prod/deploy.sh [--force]
#
# Deploys the full iga-scheduler production environment in order:
#   Step 0  — Enable required GCP APIs
#   Step 1  — Terraform init
#   Step 2  — Pre-probe: record which resources already exist in GCP
#   Step 3  — Import pre-existing resources into Terraform state
#   Step 4  — Seed github_token secret (Cloud Build connection prerequisite)
#   Step 5  — Terraform apply           (skipped if all resources exist and no --force)
#   Step 6  — Post-probe: verify each resource exists; fail on any missing
#   Step 7  — Write deploy-manifest.json
#   Step 8  — Seed app secrets (shells created by Terraform in step 5)
#   Step 9  — Preflight checks + ES index bootstrap  (skipped if nothing to do)
#   Step 10 — Cloud Build: build and deploy services (skipped if nothing to do)
#   Step 11 — Post-deploy smoke test                 (skipped if nothing to do)
#
# --force  Force Terraform apply even when all GCP infrastructure already exists.
#          Use this to apply Terraform config changes or rotate secrets.
#          Cloud Build (step 10) and the smoke test (step 11) always run
#          regardless of --force.
#
# Without --force: steps 5–8 (Terraform apply, post-probe, manifest, secret seeding)
# are skipped when the pre-probe shows every tracked resource already exists.
# Steps 3–4 (imports, github token sync) and steps 9–11 (preflight, Cloud Build,
# smoke test) always run.
#
# Required environment variables — set via scripts/prod/set-env.sh:
#   GCP_PROJECT_ID, JOB_ZIP_BUCKET, TF_STATE_BUCKET
#   ES_ENDPOINT, ES_API_KEY
#   DB_ENGINE
#   WORKER_EXECUTION_MODE, RUNTIME_WORKER_URL, RUNTIME_SERVICE_ACCOUNT_EMAIL
#   RUNTIME_BROKER_URL
#   IGA_TOKEN_ENDPOINT, IGA_CLIENT_ID, IGA_CLIENT_SECRET, IGA_BASE_URL
#   PUBLIC_API_ISSUER, PUBLIC_API_AUDIENCE
#   WORKER_OIDC_AUDIENCE, WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
#   SCHEDULER_OIDC_AUDIENCE, SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
#   GITHUB_PAT  — GitHub Personal Access Token (repo read) for Cloud Build connection
set -euo pipefail

# ── Parse flags — strip --force before passing remaining args to terraform ────
FORCE=false
TF_EXTRA_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    FORCE=true
  else
    TF_EXTRA_ARGS+=("$arg")
  fi
done

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

# ── Validate GITHUB_PAT against the GitHub API before doing any work ─────────
# Catches expired/invalid tokens at the start rather than deep inside Terraform.
echo "Validating GITHUB_PAT..."
GH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${GITHUB_PAT}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/user")
if [[ "$GH_STATUS" != "200" ]]; then
  echo "ERROR: GITHUB_PAT is invalid or expired (GitHub API returned HTTP ${GH_STATUS})." >&2
  echo "       Generate a new classic PAT at https://github.com/settings/tokens (repo scope)" >&2
  echo "       and set it in GITHUB_PAT before re-running." >&2
  exit 1
fi
echo "  GITHUB_PAT is valid."

# Prevent Terraform from erroring on unsupported OTEL protocol values
unset OTEL_TRACES_EXPORTER OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${GCP_PROJECT_ID}"
REGION="us-central1"
DEPLOY_MANIFEST="${REPO_ROOT}/deploy-manifest.json"
DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
DEPLOY_STATUS="in_progress"

# ── Probe / manifest helpers ──────────────────────────────────────────────────

# gcp_probe: run a gcloud command (caller must include --format="value(...)"),
# return 0 if output is non-empty (resource exists), 1 otherwise.
gcp_probe() {
  local out
  out=$("$@" 2>/dev/null) && [[ -n "$out" ]]
}

# api_probe: check whether a GCP API is enabled.
api_probe() {
  gcloud services list \
    --project="$PROJECT" \
    --filter="config.name=$1" \
    --format="value(config.name)" 2>/dev/null | grep -q .
}

# Parallel arrays tracking every resource: name, type, pre-state, post-state.
# Using parallel arrays (not associative) for bash 3 compatibility.
RES_KEYS=()
RES_TYPES=()
RES_PRE=()    # "exists" | "absent"
RES_POST=()   # "exists" | "absent" | "pending"

# register_resource: probe GCP now (pre-state) and enqueue for post-probe.
# Usage: register_resource <key> <type> <gcloud-probe-cmd...>
register_resource() {
  local key="$1" type="$2"
  shift 2
  RES_KEYS+=("$key")
  RES_TYPES+=("$type")
  if gcp_probe "$@"; then
    RES_PRE+=("exists")
  else
    RES_PRE+=("absent")
  fi
  RES_POST+=("pending")
}

# post_probe_resource: update post-state for a key after apply.
# Usage: post_probe_resource <key> <gcloud-probe-cmd...>
post_probe_resource() {
  local key="$1"
  shift
  local i
  for i in "${!RES_KEYS[@]}"; do
    if [[ "${RES_KEYS[$i]}" == "$key" ]]; then
      if gcp_probe "$@"; then
        RES_POST[$i]="exists"
      else
        RES_POST[$i]="absent"
      fi
      return
    fi
  done
  echo "  [warn] post_probe_resource: key '$key' not registered" >&2
}

# write_manifest: write deploy-manifest.json from current tracked state.
write_manifest() {
  local i comma action
  local total="${#RES_KEYS[@]}"
  {
    printf '{\n'
    printf '  "schemaVersion": 2,\n'
    printf '  "deployedAt": "%s",\n' "$DEPLOYED_AT"
    printf '  "status": "%s",\n' "$DEPLOY_STATUS"
    printf '  "gcpProjectId": "%s",\n' "$PROJECT"
    printf '  "region": "%s",\n' "$REGION"
    printf '  "resources": [\n'
    for i in "${!RES_KEYS[@]}"; do
      local pre="${RES_PRE[$i]}" post="${RES_POST[$i]}"
      if   [[ "$pre"  == "exists" ]];                           then action="already_existed"
      elif [[ "$post" == "exists" ]];                           then action="created"
      elif [[ "$post" == "pending" && "$pre" == "absent" ]];    then action="not_reached"
      else                                                           action="failed"
      fi
      comma=","
      [[ $i -eq $((total - 1)) ]] && comma=""
      printf '    {"name": "%s", "type": "%s", "action": "%s", "preState": "%s", "postState": "%s"}%s\n' \
        "${RES_KEYS[$i]}" "${RES_TYPES[$i]}" "$action" "$pre" "$post" "$comma"
    done
    printf '  ]\n'
    printf '}\n'
  } > "$DEPLOY_MANIFEST"
  echo "  manifest written → deploy-manifest.json"
}

# on_exit: always write manifest so partial failures are captured.
on_exit() {
  local rc=$?
  [[ $rc -ne 0 ]] && DEPLOY_STATUS="failed"
  write_manifest
}
trap on_exit EXIT

# seed_secret_if_empty: add a secret version only if none exist.
seed_secret_if_empty() {
  local secret_id="$1" value="$2"
  local count
  count=$(gcloud secrets versions list "$secret_id" \
    --project="$PROJECT" --filter="state=ENABLED" --format="value(name)" 2>/dev/null \
    | wc -l | tr -d ' ' || echo 0)
  if [[ "$count" -gt 0 ]]; then
    echo "  [secret] $secret_id already has a version — skipping"
  else
    echo "  [secret] seeding $secret_id"
    echo -n "$value" | gcloud secrets versions add "$secret_id" \
      --data-file=- --project="$PROJECT"
  fi
}

# sync_github_token: always sync $GITHUB_PAT into the secret.
# Reads the latest enabled version and compares — adds a new version only if
# the stored value differs from $GITHUB_PAT. This ensures Cloud Build always
# uses the same PAT that passed the upfront GitHub API validation.
sync_github_token() {
  local secret_id="iga-scheduler-github-token"
  local latest_version
  latest_version=$(gcloud secrets versions list "$secret_id" \
    --project="$PROJECT" --filter="state=ENABLED" \
    --sort-by="~createTime" --limit=1 \
    --format="value(name)" 2>/dev/null || true)

  if [[ -n "$latest_version" ]]; then
    local stored
    stored=$(gcloud secrets versions access "$latest_version" \
      --project="$PROJECT" 2>/dev/null || true)
    if [[ "$stored" == "$GITHUB_PAT" ]]; then
      echo "  [secret] $secret_id is up to date — skipping"
      return 0
    fi
    echo "  [secret] $secret_id value changed — adding new version"
  else
    echo "  [secret] $secret_id has no versions — seeding"
  fi

  echo -n "$GITHUB_PAT" | gcloud secrets versions add "$secret_id" \
    --data-file=- --project="$PROJECT"
}

# tf_import_if_missing: import into state only if it exists in GCP and is absent from state.
# Usage: tf_import_if_missing <tf-address> <tf-id> <gcloud-probe-cmd...>
tf_import_if_missing() {
  local address="$1" id="$2"
  shift 2
  if ! gcp_probe "$@"; then
    echo "  [import] $address not found in GCP — skipping"
    return 0
  fi
  if terraform state show "$address" &>/dev/null; then
    echo "  [import] $address already in state — skipping"
  else
    echo "  [import] importing $address"
    terraform import -input=false "$address" "$id"
  fi
}

# ── Step 0: Enable required GCP APIs ─────────────────────────────────────────
echo ""
echo "=== Step 0: Enabling required GCP APIs ==="

REQUIRED_APIS=(
  compute.googleapis.com
  secretmanager.googleapis.com
  sqladmin.googleapis.com
  run.googleapis.com
  vpcaccess.googleapis.com
  servicenetworking.googleapis.com
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  cloudscheduler.googleapis.com
)

for api in "${REQUIRED_APIS[@]}"; do
  if api_probe "$api"; then
    echo "  [ok]  $api already enabled"
  else
    echo "  [..] enabling $api"
    gcloud services enable "$api" --project="$PROJECT" --quiet
    if api_probe "$api"; then
      echo "  [ok]  $api enabled"
    else
      echo "ERROR: failed to enable $api" >&2
      exit 1
    fi
  fi
done

# ── Step 1: Terraform init ────────────────────────────────────────────────────
echo ""
echo "=== Step 1: Terraform init ==="
cd "$REPO_ROOT/terraform"
terraform init -input=false -migrate-state -force-copy \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=iga-scheduler"

# ── Step 2: Pre-probe — record which resources already exist ──────────────────
echo ""
echo "=== Step 2: Pre-probe (recording existing resources) ==="

register_resource "vpc:iga-scheduler-vpc" "compute_network" \
  gcloud compute networks describe "iga-scheduler-vpc" \
  --project="$PROJECT" --format="value(name)"

register_resource "subnet:iga-scheduler-vpc-connector-subnet" "compute_subnetwork" \
  gcloud compute networks subnets describe "iga-scheduler-vpc-connector-subnet" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

register_resource "psa_range:iga-scheduler-vpc-psa-range" "compute_global_address" \
  gcloud compute addresses describe "iga-scheduler-vpc-psa-range" \
  --global --project="$PROJECT" --format="value(name)"

register_resource "vpc_connector:iga-scheduler-connector" "vpc_access_connector" \
  gcloud compute networks vpc-access connectors describe "iga-scheduler-connector" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

register_resource "bucket:${JOB_ZIP_BUCKET}" "storage_bucket" \
  gcloud storage buckets describe "gs://${JOB_ZIP_BUCKET}" \
  --project="$PROJECT" --format="value(name)"

register_resource "ar_repo:iga-scheduler" "artifact_registry_repository" \
  gcloud artifacts repositories describe "iga-scheduler" \
  --location="$REGION" --project="$PROJECT" --format="value(name)"

register_resource "sql_instance:iga-scheduler-db" "cloud_sql_instance" \
  gcloud sql instances describe "iga-scheduler-db" \
  --project="$PROJECT" --format="value(name)"

for sa in iga-scheduler-service iga-scheduler-runtime iga-scheduler-deployer iga-scheduler-tick-invoker; do
  register_resource "sa:${sa}" "service_account" \
    gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" \
    --project="$PROJECT" --format="value(email)"
done

for secret in iga-scheduler-db-password iga-scheduler-iga-client-id \
              iga-scheduler-iga-client-secret iga-scheduler-es-api-key \
              iga-scheduler-github-token; do
  register_resource "secret:${secret}" "secret_manager_secret" \
    gcloud secrets describe "$secret" \
    --project="$PROJECT" --format="value(name)"
done

register_resource "cb_connection:iga-scheduler-github" "cloudbuild_connection" \
  gcloud builds connections describe "iga-scheduler-github" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

register_resource "cb_trigger:iga-scheduler-deploy" "cloudbuild_trigger" \
  gcloud builds triggers describe "iga-scheduler-deploy" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

register_resource "worker_service:iga-scheduler-worker" "cloud_run_service" \
  gcloud run services describe "iga-scheduler-worker" \
  --region="$REGION" --project="$PROJECT" --format="value(metadata.name)"

# Print pre-probe summary
ABSENT_COUNT=0
for i in "${!RES_KEYS[@]}"; do
  if [[ "${RES_PRE[$i]}" == "absent" ]]; then
    echo "  [absent]  ${RES_KEYS[$i]} — will be created"
    ABSENT_COUNT=$((ABSENT_COUNT + 1))
  else
    echo "  [exists]  ${RES_KEYS[$i]}"
  fi
done
echo "  ${ABSENT_COUNT} resource(s) to create."

# ── Step 3: Import pre-existing resources into Terraform state ────────────────
# Every importable Terraform resource is covered here. tf_import_if_missing first
# probes GCP — if the resource doesn't exist it skips silently (first deploy),
# if it exists but isn't in state it imports it (re-run after state loss).
# IAM member resources are not imported: Terraform applies them idempotently.
echo ""
echo "=== Step 3: Importing pre-existing resources ==="

# ── Networking ────────────────────────────────────────────────────────────────
tf_import_if_missing \
  "google_compute_network.main" \
  "projects/${PROJECT}/global/networks/iga-scheduler-vpc" \
  gcloud compute networks describe "iga-scheduler-vpc" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_compute_subnetwork.connector" \
  "projects/${PROJECT}/regions/${REGION}/subnetworks/iga-scheduler-vpc-connector-subnet" \
  gcloud compute networks subnets describe "iga-scheduler-vpc-connector-subnet" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_compute_global_address.private_service_range" \
  "projects/${PROJECT}/global/addresses/iga-scheduler-vpc-psa-range" \
  gcloud compute addresses describe "iga-scheduler-vpc-psa-range" \
  --global --project="$PROJECT" --format="value(name)"

# Service networking connection import ID: {network_self_link}:{service}
if gcp_probe gcloud compute networks describe "iga-scheduler-vpc" \
    --project="$PROJECT" --format="value(selfLink)"; then
  VPC_SELF_LINK=$(gcloud compute networks describe "iga-scheduler-vpc" \
    --project="$PROJECT" --format="value(selfLink)" 2>/dev/null)
  if gcloud services vpc-peerings list \
      --service=servicenetworking.googleapis.com \
      --network="iga-scheduler-vpc" \
      --project="$PROJECT" --format="value(name)" 2>/dev/null | grep -q .; then
    if ! terraform state show "google_service_networking_connection.private_service_access" &>/dev/null; then
      echo "  [import] importing google_service_networking_connection.private_service_access"
      terraform import -input=false \
        "google_service_networking_connection.private_service_access" \
        "${VPC_SELF_LINK}:servicenetworking.googleapis.com"
    else
      echo "  [import] google_service_networking_connection.private_service_access already in state — skipping"
    fi
  else
    echo "  [import] google_service_networking_connection.private_service_access not found in GCP — skipping"
  fi
fi

tf_import_if_missing \
  "google_vpc_access_connector.scheduler" \
  "projects/${PROJECT}/locations/${REGION}/connectors/iga-scheduler-connector" \
  gcloud compute networks vpc-access connectors describe "iga-scheduler-connector" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

# ── Storage ───────────────────────────────────────────────────────────────────
tf_import_if_missing \
  "google_storage_bucket.job_zip" \
  "${PROJECT}/${JOB_ZIP_BUCKET}" \
  gcloud storage buckets describe "gs://${JOB_ZIP_BUCKET}" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_artifact_registry_repository.runtime_images" \
  "projects/${PROJECT}/locations/${REGION}/repositories/iga-scheduler" \
  gcloud artifacts repositories describe "iga-scheduler" \
  --location="$REGION" --project="$PROJECT" --format="value(name)"

# ── Cloud SQL ─────────────────────────────────────────────────────────────────
tf_import_if_missing \
  "google_sql_database_instance.main" \
  "${PROJECT}/iga-scheduler-db" \
  gcloud sql instances describe "iga-scheduler-db" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_sql_database.app" \
  "${PROJECT}/iga-scheduler-db/iga_scheduler" \
  gcloud sql databases describe "iga_scheduler" \
  --instance="iga-scheduler-db" --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_sql_user.app" \
  "${PROJECT}/iga-scheduler-db//iga_scheduler_app" \
  gcloud sql users describe "iga_scheduler_app" \
  --instance="iga-scheduler-db" --project="$PROJECT" --format="value(name)"

# ── Service accounts ──────────────────────────────────────────────────────────
tf_import_if_missing \
  "google_service_account.scheduler_service" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-service@${PROJECT}.iam.gserviceaccount.com" \
  gcloud iam service-accounts describe "iga-scheduler-service@${PROJECT}.iam.gserviceaccount.com" \
  --project="$PROJECT" --format="value(email)"

tf_import_if_missing \
  "google_service_account.runtime" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-runtime@${PROJECT}.iam.gserviceaccount.com" \
  gcloud iam service-accounts describe "iga-scheduler-runtime@${PROJECT}.iam.gserviceaccount.com" \
  --project="$PROJECT" --format="value(email)"

tf_import_if_missing \
  "google_service_account.deployer" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-deployer@${PROJECT}.iam.gserviceaccount.com" \
  gcloud iam service-accounts describe "iga-scheduler-deployer@${PROJECT}.iam.gserviceaccount.com" \
  --project="$PROJECT" --format="value(email)"

tf_import_if_missing \
  "google_service_account.scheduler_tick_invoker" \
  "projects/${PROJECT}/serviceAccounts/iga-scheduler-tick-invoker@${PROJECT}.iam.gserviceaccount.com" \
  gcloud iam service-accounts describe "iga-scheduler-tick-invoker@${PROJECT}.iam.gserviceaccount.com" \
  --project="$PROJECT" --format="value(email)"

# ── Secrets ───────────────────────────────────────────────────────────────────
# Terraform resource names match secrets.tf: db_password, iga_client_id, etc.
tf_import_if_missing \
  "google_secret_manager_secret.db_password" \
  "projects/${PROJECT}/secrets/iga-scheduler-db-password" \
  gcloud secrets describe "iga-scheduler-db-password" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_secret_manager_secret.iga_client_id" \
  "projects/${PROJECT}/secrets/iga-scheduler-iga-client-id" \
  gcloud secrets describe "iga-scheduler-iga-client-id" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_secret_manager_secret.iga_client_secret" \
  "projects/${PROJECT}/secrets/iga-scheduler-iga-client-secret" \
  gcloud secrets describe "iga-scheduler-iga-client-secret" \
  --project="$PROJECT" --format="value(name)"

tf_import_if_missing \
  "google_secret_manager_secret.es_api_key" \
  "projects/${PROJECT}/secrets/iga-scheduler-es-api-key" \
  gcloud secrets describe "iga-scheduler-es-api-key" \
  --project="$PROJECT" --format="value(name)"
# github_token is imported in step 4 after its shell is guaranteed to exist.

# ── Cloud Run worker service ──────────────────────────────────────────────────
tf_import_if_missing \
  "google_cloud_run_v2_service.worker" \
  "projects/${PROJECT}/locations/${REGION}/services/iga-scheduler-worker" \
  gcloud run services describe "iga-scheduler-worker" \
  --region="$REGION" --project="$PROJECT" --format="value(metadata.name)"

# ── Cloud Scheduler job ───────────────────────────────────────────────────────
tf_import_if_missing \
  "google_cloud_scheduler_job.scheduler_tick[0]" \
  "projects/${PROJECT}/locations/${REGION}/jobs/iga-scheduler-tick" \
  gcloud scheduler jobs describe "iga-scheduler-tick" \
  --location="$REGION" --project="$PROJECT" --format="value(name)"

# ── CI/CD (Cloud Build connection, repository, trigger) ───────────────────────
tf_import_if_missing \
  "google_cloudbuildv2_connection.github" \
  "projects/${PROJECT}/locations/${REGION}/connections/iga-scheduler-github" \
  gcloud builds connections describe "iga-scheduler-github" \
  --region="$REGION" --project="$PROJECT" --format="value(name)"

# Repository import needs the full resource name
if gcp_probe gcloud builds connections describe "iga-scheduler-github" \
    --region="$REGION" --project="$PROJECT" --format="value(name)"; then
  REPO_FULL=$(gcloud builds repositories describe "iga-scheduler-backend" \
    --connection="iga-scheduler-github" \
    --region="$REGION" --project="$PROJECT" \
    --format="value(name)" 2>/dev/null || true)
  if [[ -n "$REPO_FULL" ]]; then
    if ! terraform state show "google_cloudbuildv2_repository.scheduler" &>/dev/null; then
      echo "  [import] importing google_cloudbuildv2_repository.scheduler"
      terraform import -input=false "google_cloudbuildv2_repository.scheduler" "$REPO_FULL"
    else
      echo "  [import] google_cloudbuildv2_repository.scheduler already in state — skipping"
    fi
  else
    echo "  [import] google_cloudbuildv2_repository.scheduler not found in GCP — skipping"
  fi
fi

# Cloud Build trigger import needs the trigger ID (not name)
TRIGGER_ID=$(gcloud builds triggers describe "iga-scheduler-deploy" \
  --region="$REGION" --project="$PROJECT" \
  --format="value(id)" 2>/dev/null || true)
if [[ -n "$TRIGGER_ID" ]]; then
  if ! terraform state show "google_cloudbuild_trigger.on_push_main" &>/dev/null; then
    echo "  [import] importing google_cloudbuild_trigger.on_push_main"
    terraform import -input=false \
      "google_cloudbuild_trigger.on_push_main" \
      "projects/${PROJECT}/locations/${REGION}/triggers/${TRIGGER_ID}"
  else
    echo "  [import] google_cloudbuild_trigger.on_push_main already in state — skipping"
  fi
else
  echo "  [import] google_cloudbuild_trigger.on_push_main not found in GCP — skipping"
fi

# ── Step 4: Seed github_token before Terraform (Cloud Build connection needs it) ─
echo ""
echo "=== Step 4: Seeding github_token secret ==="
# The secret shell may have been created manually before Terraform runs (it needs a
# version before Terraform can create the Cloud Build connection). If it already exists
# in GCP but not in state, import it so Terraform apply doesn't error with 409.
if ! gcloud secrets describe "iga-scheduler-github-token" --project="$PROJECT" &>/dev/null; then
  echo "  [..] creating secret shell iga-scheduler-github-token"
  gcloud secrets create "iga-scheduler-github-token" \
    --project="$PROJECT" --replication-policy="automatic" --quiet
fi
sync_github_token
tf_import_if_missing \
  "google_secret_manager_secret.github_token" \
  "projects/${PROJECT}/secrets/iga-scheduler-github-token" \
  gcloud secrets describe "iga-scheduler-github-token" \
  --project="$PROJECT" --format="value(name)"

# ── Skip gate (Terraform only) ────────────────────────────────────────────────
# If every tracked resource already exists in GCP and --force was not passed,
# skip Terraform apply (steps 5–8) but still run Cloud Build and smoke test
# (steps 9–11) so the deployed image is always kept current.
SKIP_TERRAFORM=false
if [[ "$ABSENT_COUNT" -eq 0 && "$FORCE" != "true" ]]; then
  SKIP_TERRAFORM=true
  echo ""
  echo "  All infrastructure resources already exist — skipping Terraform apply."
  echo "  Use --force to re-apply Terraform changes."
fi

if [[ "$SKIP_TERRAFORM" == "true" ]]; then
  # Populate post-states from pre-states (everything already exists).
  for i in "${!RES_KEYS[@]}"; do
    RES_POST[$i]="${RES_PRE[$i]}"
  done
else
  # ── Step 5: Terraform apply ─────────────────────────────────────────────────
  echo ""
  echo "=== Step 5: Terraform apply ==="
  # Probe whether the iga-scheduler Cloud Run service exists before apply.
  # The two IAM member resources (scheduler_tick_invoker, runtime_invoker) reference
  # this service; passing scheduler_service_exists=false when it's absent prevents
  # Terraform from trying to set IAM on a non-existent service.
  SCHEDULER_SERVICE_EXISTS="false"
  if gcp_probe gcloud run services describe "iga-scheduler" \
      --region="$REGION" --project="$PROJECT" --format="value(metadata.name)"; then
    SCHEDULER_SERVICE_EXISTS="true"
  fi
  echo "  scheduler_service_exists=${SCHEDULER_SERVICE_EXISTS}"
  terraform apply -input=false -auto-approve \
    -var="scheduler_service_exists=${SCHEDULER_SERVICE_EXISTS}" \
    "${TF_EXTRA_ARGS[@]}"

  # ── Step 6: Post-probe — verify every resource now exists ───────────────────
  echo ""
  echo "=== Step 6: Post-probe (verifying resources were created) ==="

  post_probe_resource "vpc:iga-scheduler-vpc" \
    gcloud compute networks describe "iga-scheduler-vpc" \
    --project="$PROJECT" --format="value(name)"

  post_probe_resource "subnet:iga-scheduler-vpc-connector-subnet" \
    gcloud compute networks subnets describe "iga-scheduler-vpc-connector-subnet" \
    --region="$REGION" --project="$PROJECT" --format="value(name)"

  post_probe_resource "psa_range:iga-scheduler-vpc-psa-range" \
    gcloud compute addresses describe "iga-scheduler-vpc-psa-range" \
    --global --project="$PROJECT" --format="value(name)"

  post_probe_resource "vpc_connector:iga-scheduler-connector" \
    gcloud compute networks vpc-access connectors describe "iga-scheduler-connector" \
    --region="$REGION" --project="$PROJECT" --format="value(name)"

  post_probe_resource "bucket:${JOB_ZIP_BUCKET}" \
    gcloud storage buckets describe "gs://${JOB_ZIP_BUCKET}" \
    --project="$PROJECT" --format="value(name)"

  post_probe_resource "ar_repo:iga-scheduler" \
    gcloud artifacts repositories describe "iga-scheduler" \
    --location="$REGION" --project="$PROJECT" --format="value(name)"

  post_probe_resource "sql_instance:iga-scheduler-db" \
    gcloud sql instances describe "iga-scheduler-db" \
    --project="$PROJECT" --format="value(name)"

  for sa in iga-scheduler-service iga-scheduler-runtime iga-scheduler-deployer iga-scheduler-tick-invoker; do
    post_probe_resource "sa:${sa}" \
      gcloud iam service-accounts describe "${sa}@${PROJECT}.iam.gserviceaccount.com" \
      --project="$PROJECT" --format="value(email)"
  done

  for secret in iga-scheduler-db-password iga-scheduler-iga-client-id \
                iga-scheduler-iga-client-secret iga-scheduler-es-api-key \
                iga-scheduler-github-token; do
    post_probe_resource "secret:${secret}" \
      gcloud secrets describe "$secret" \
      --project="$PROJECT" --format="value(name)"
  done

  post_probe_resource "cb_connection:iga-scheduler-github" \
    gcloud builds connections describe "iga-scheduler-github" \
    --region="$REGION" --project="$PROJECT" --format="value(name)"

  post_probe_resource "cb_trigger:iga-scheduler-deploy" \
    gcloud builds triggers describe "iga-scheduler-deploy" \
    --region="$REGION" --project="$PROJECT" --format="value(name)"

  post_probe_resource "worker_service:iga-scheduler-worker" \
    gcloud run services describe "iga-scheduler-worker" \
    --region="$REGION" --project="$PROJECT" --format="value(metadata.name)"

  # Validate: fail if any resource that should exist is still absent.
  FAILURES=0
  for i in "${!RES_KEYS[@]}"; do
    key="${RES_KEYS[$i]}"
    pre="${RES_PRE[$i]}"
    post="${RES_POST[$i]}"
    if [[ "$post" == "exists" ]]; then
      if [[ "$pre" == "absent" ]]; then
        echo "  [created]  $key"
      else
        echo "  [ok]       $key (already existed)"
      fi
    elif [[ "$post" == "absent" ]]; then
      echo "  [FAILED]   $key — not found after apply" >&2
      FAILURES=$((FAILURES + 1))
    fi
  done

  if [[ $FAILURES -gt 0 ]]; then
    echo ""
    echo "ERROR: ${FAILURES} resource(s) missing after apply — see above." >&2
    exit 1
  fi

  # ── Step 7: Write deploy manifest ───────────────────────────────────────────
  echo ""
  echo "=== Step 7: Writing deploy manifest ==="
  DEPLOY_STATUS="succeeded"
  write_manifest

  # ── Step 8: Seed app secrets (shells created in step 5) ─────────────────────
  echo ""
  echo "=== Step 8: Seeding app secrets ==="
  seed_secret_if_empty "iga-scheduler-iga-client-id"     "$IGA_CLIENT_ID"
  seed_secret_if_empty "iga-scheduler-iga-client-secret" "$IGA_CLIENT_SECRET"
  seed_secret_if_empty "iga-scheduler-es-api-key"        "$ES_API_KEY"
fi

# ── Step 9: Preflight checks + ES index bootstrap ─────────────────────────────
echo ""
echo "=== Step 9: Preflight + ES bootstrap ==="
cd "$REPO_ROOT"
npm run preflight
# PG migrations run inside Cloud Build (Cloud SQL is private-IP, unreachable locally).
node scripts/prod/bootstrap-prod.js --skip-preflight --es-only

# ── Step 10: Cloud Build — build and deploy services ──────────────────────────
echo ""
echo "=== Step 10: Cloud Build — build and deploy services ==="

# Use real service URLs if known; fall back to placeholder on first deploy.
# After first deploy, update set-env.sh with the real URLs and re-run.
SCHEDULER_URL="${RUNTIME_BROKER_URL:-https://placeholder}"
WORKER_URL="${RUNTIME_WORKER_URL:-https://placeholder}"

gcloud builds submit \
  --config=cloudbuild.yaml \
  --project="${PROJECT}" \
  --substitutions="SHORT_SHA=$(git rev-parse --short HEAD),\
_TF_STATE_BUCKET=${TF_STATE_BUCKET},\
_ES_ENDPOINT=${ES_ENDPOINT},\
_IGA_TOKEN_ENDPOINT=${IGA_TOKEN_ENDPOINT},\
_IGA_BASE_URL=${IGA_BASE_URL},\
_PUBLIC_API_ISSUER=${PUBLIC_API_ISSUER},\
_PUBLIC_API_AUDIENCE=${PUBLIC_API_AUDIENCE},\
_SERVICE_URL=${SCHEDULER_URL},\
_RUNTIME_WORKER_URL=${WORKER_URL}"

echo ""
echo "=== Deploy complete ==="
echo ""
ACTUAL_SCHEDULER_URL=$(gcloud run services describe iga-scheduler \
  --region="${REGION}" --project="${PROJECT}" --format='value(status.url)' 2>/dev/null || echo "")
ACTUAL_WORKER_URL=$(gcloud run services describe iga-scheduler-worker \
  --region="${REGION}" --project="${PROJECT}" --format='value(status.url)' 2>/dev/null || echo "")
echo "Scheduler URL: ${ACTUAL_SCHEDULER_URL}"
echo "Worker URL:    ${ACTUAL_WORKER_URL}"

if [[ "${SCHEDULER_URL}" == "https://placeholder" && -n "${ACTUAL_SCHEDULER_URL}" ]]; then
  echo ""
  echo "First deploy complete. Update scripts/prod/set-env.sh:"
  echo "  RUNTIME_BROKER_URL=\"${ACTUAL_SCHEDULER_URL}\""
  echo "  RUNTIME_WORKER_URL=\"${ACTUAL_WORKER_URL}\""
  echo "  WORKER_OIDC_AUDIENCE=\"${ACTUAL_SCHEDULER_URL}\""
  echo "  SCHEDULER_OIDC_AUDIENCE=\"${ACTUAL_SCHEDULER_URL}\""
  echo "Then update terraform/terraform.tfvars:"
  echo "  cloud_run_service_url = \"${ACTUAL_SCHEDULER_URL}\""
  echo "  worker_service_url    = \"${ACTUAL_WORKER_URL}\""
  echo "Then re-run: bash scripts/prod/deploy.sh"
  echo ""
  echo "Skipping post-deploy smoke test — re-run deploy.sh after updating URLs."
  exit 0
fi

# ── Step 11: Post-deploy smoke test ───────────────────────────────────────────
echo ""
echo "=== Step 11: Post-deploy smoke test ==="
cd "$REPO_ROOT"
# Export the resolved scheduler URL so post-deploy.sh uses the live service,
# even if set-env.sh still holds a stale value.
export RUNTIME_BROKER_URL="${ACTUAL_SCHEDULER_URL}"
bash scripts/prod/post-deploy.sh
