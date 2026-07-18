#!/usr/bin/env bash
# Tears down the GCP production environment.
#
# Reverses deploy.sh in order:
#   1. Node teardown  — roll back PG migrations + delete ES indices (guided by bootstrap-manifest.json)
#   2. Terraform destroy — removes all GCP resources provisioned by deploy.sh
#
# Usage:
#   source scripts/prod/set-env.sh
#   bash scripts/prod/teardown.sh              # interactive confirmation
#   bash scripts/prod/teardown.sh --dry-run    # print what would happen, no deletes
#   bash scripts/prod/teardown.sh --force      # skip all confirmation prompts (CI use)
#
# Required env vars (set via set-env.sh):
#   GCP_PROJECT_ID, TF_STATE_BUCKET
#   ES_ENDPOINT, ES_API_KEY
#   DB_ENGINE (+ DB_INSTANCE_CONNECTION_NAME/DB_USER/DB_NAME for cloud-sql, or DATABASE_URL for direct)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="us-central1"

DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
  esac
done

# ── Required env var check ────────────────────────────────────────────────────
REQUIRED_VARS=(GCP_PROJECT_ID TF_STATE_BUCKET)
MISSING=()
for v in "${REQUIRED_VARS[@]}"; do
  [[ -z "${!v:-}" ]] && MISSING+=("$v")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: missing required environment variables:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  echo "Run: source scripts/prod/set-env.sh" >&2
  exit 1
fi

# Prevent Terraform from erroring on unsupported OTEL protocol values
unset OTEL_TRACES_EXPORTER OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER 2>/dev/null || true

# ── Confirmation ──────────────────────────────────────────────────────────────
if [[ "$FORCE" != true && "$DRY_RUN" != true ]]; then
  echo ""
  echo "WARNING: This will permanently destroy:"
  echo "  - All GCP resources in project '${GCP_PROJECT_ID}' managed by Terraform"
  echo "  - ES indices and PG migrations tracked in bootstrap-manifest.json"
  echo ""
  read -r -p "Type 'yes' to continue: " answer
  if [[ "$answer" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── Step 1: Node teardown (ES indices + PG migrations) ────────────────────────
echo ""
echo "=== Step 1: ES + PG teardown ==="

MANIFEST="${REPO_ROOT}/bootstrap-manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "  [warn] bootstrap-manifest.json not found — skipping ES/PG teardown"
  echo ""
  echo "  IMPORTANT: if PG migrations were ever applied, the database user"
  echo "  '${DB_USER:-iga_scheduler_app}' still owns the tables and terraform destroy"
  echo "  will fail with 'role cannot be dropped because some objects depend on it'."
  echo ""
  echo "  To fix: connect to the Cloud SQL instance and run:"
  echo "    DROP TABLE IF EXISTS job_runs, job_instances CASCADE;"
  echo "    DELETE FROM pgmigrations;"
  echo "  Then re-run this script."
  if [[ "$FORCE" != true && "$DRY_RUN" != true ]]; then
    read -r -p "  Continue anyway? Type 'yes' to proceed: " answer
    if [[ "$answer" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi
else
  NODE_ARGS="--force"
  [[ "$DRY_RUN" == true ]] && NODE_ARGS="--dry-run"
  node "${REPO_ROOT}/scripts/prod/teardown.js" $NODE_ARGS
fi

# ── Step 2: Terraform destroy ─────────────────────────────────────────────────
echo ""
echo "=== Step 2: Terraform destroy ==="

cd "${REPO_ROOT}/terraform"

terraform init -input=false -migrate-state -force-copy \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="prefix=iga-scheduler"

# These vars unlock the three resources that block destroy by default:
#   - db_deletion_protection=false   : Cloud SQL instance
#   - worker_service_deletion_protection=false : Cloud Run worker service
#   - storage_force_destroy=true     : job-zip GCS bucket (deletes objects inside)
DESTROY_VAR_OVERRIDES=(
  -var="project_id=${GCP_PROJECT_ID}"
  -var="region=${REGION}"
  -var="db_deletion_protection=false"
  -var="worker_service_deletion_protection=false"
  -var="storage_force_destroy=true"
)

VPC_NAME="${VPC_NAME:-iga-scheduler-vpc}"
SCHEDULER_SERVICE_NAME="${SCHEDULER_SERVICE_NAME:-iga-scheduler}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-iga-scheduler-worker}"
VPC_CONNECTOR_NAME="${VPC_CONNECTOR_NAME:-iga-scheduler-connector}"
DB_INSTANCE_NAME="${DB_INSTANCE_NAME:-iga-scheduler-db}"

# ── Inventory: probe each resource once, record what exists ──────────────────
echo "  Probing GCP resources..."

exists_scheduler_service=false
exists_worker_service=false
exists_vpc_connector=false
exists_db_instance=false
exists_vpc_peering=false
exists_vpc_routes=false
vpc_route_names=""

if gcloud run services describe "${SCHEDULER_SERVICE_NAME}" \
    --region="${REGION}" --project="${GCP_PROJECT_ID}" --format="value(name)" \
    &>/dev/null 2>&1; then
  exists_scheduler_service=true
  echo "    [found] Cloud Run service: ${SCHEDULER_SERVICE_NAME}"
fi

if gcloud run services describe "${WORKER_SERVICE_NAME}" \
    --region="${REGION}" --project="${GCP_PROJECT_ID}" --format="value(name)" \
    &>/dev/null 2>&1; then
  exists_worker_service=true
  echo "    [found] Cloud Run service: ${WORKER_SERVICE_NAME}"
fi

if gcloud compute networks vpc-access connectors describe "${VPC_CONNECTOR_NAME}" \
    --region="${REGION}" --project="${GCP_PROJECT_ID}" --format="value(name)" \
    &>/dev/null 2>&1; then
  exists_vpc_connector=true
  echo "    [found] VPC Access Connector: ${VPC_CONNECTOR_NAME}"
fi

if gcloud sql instances describe "${DB_INSTANCE_NAME}" \
    --project="${GCP_PROJECT_ID}" --format="value(name)" \
    &>/dev/null 2>&1; then
  exists_db_instance=true
  echo "    [found] Cloud SQL instance: ${DB_INSTANCE_NAME}"
fi

if gcloud services vpc-peerings list \
    --service=servicenetworking.googleapis.com \
    --network="${VPC_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --format="value(name)" 2>/dev/null | grep -q .; then
  exists_vpc_peering=true
  echo "    [found] Service Networking peering on VPC: ${VPC_NAME}"
fi

vpc_route_names=$(gcloud compute routes list \
  --project="${GCP_PROJECT_ID}" \
  --filter="network=https://www.googleapis.com/compute/v1/projects/${GCP_PROJECT_ID}/global/networks/${VPC_NAME}" \
  --format="value(name)" 2>/dev/null || true)
if [[ -n "${vpc_route_names}" ]]; then
  exists_vpc_routes=true
  echo "    [found] VPC routes on ${VPC_NAME}:"
  echo "${vpc_route_names}" | sed 's/^/      /'
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "  [dry-run] would run: pre-cleanup of found resources, targeted apply (unlock deletion protection), then terraform destroy"
  echo "  [dry-run] resources that would be destroyed:"
  terraform plan -destroy -input=false "${DESTROY_VAR_OVERRIDES[@]}" 2>/dev/null || true
else
  # ── Pre-destroy cleanup: delete in dependency order ───────────────────────
  # Order matters:
  #   Cloud Run services must go before the VPC connector (they hold it)
  #   VPC connector must go before the VPC network
  #   VPC routes must go before the VPC network
  #   Service Networking peering must go before the VPC network
  #   Cloud SQL must go before the peering (it holds the peering open)

  # 1. Cloud SQL instance (holds the Service Networking peering open)
  if [[ "$exists_db_instance" == true ]]; then
    echo "  Deleting Cloud SQL instance: ${DB_INSTANCE_NAME}..."
    gcloud sql instances delete "${DB_INSTANCE_NAME}" \
      --project="${GCP_PROJECT_ID}" --quiet
    terraform state rm google_sql_user.app 2>/dev/null || true
    terraform state rm google_sql_database.app 2>/dev/null || true
    terraform state rm google_sql_database_instance.main 2>/dev/null || true
  fi

  # 2. Cloud Run services (hold the VPC connector)
  if [[ "$exists_scheduler_service" == true ]]; then
    echo "  Deleting Cloud Run service: ${SCHEDULER_SERVICE_NAME}..."
    gcloud run services delete "${SCHEDULER_SERVICE_NAME}" \
      --region="${REGION}" --project="${GCP_PROJECT_ID}" --quiet
  fi
  # Remove IAM member state entries that reference the scheduler service — these
  # are in Terraform state but the service itself is not, so apply errors on them.
  for r in \
    "google_cloud_run_service_iam_member.scheduler_tick_invoker" \
    "google_cloud_run_service_iam_member.runtime_invoker"; do
    terraform state rm "$r" 2>/dev/null || true
  done

  if [[ "$exists_worker_service" == true ]]; then
    echo "  Deleting Cloud Run service: ${WORKER_SERVICE_NAME}..."
    gcloud run services delete "${WORKER_SERVICE_NAME}" \
      --region="${REGION}" --project="${GCP_PROJECT_ID}" --quiet
    terraform state rm google_cloud_run_v2_service.worker 2>/dev/null || true
    terraform state rm "google_cloud_run_v2_service_iam_member.scheduler_service_invoke_worker" 2>/dev/null || true
  fi

  # 3. VPC Access Connector (must be gone before the VPC network is deleted)
  if [[ "$exists_vpc_connector" == true ]]; then
    echo "  Deleting VPC Access Connector: ${VPC_CONNECTOR_NAME}..."
    gcloud compute networks vpc-access connectors delete "${VPC_CONNECTOR_NAME}" \
      --region="${REGION}" --project="${GCP_PROJECT_ID}" --quiet
    terraform state rm google_vpc_access_connector.scheduler 2>/dev/null || true
  fi

  # 4. Service Networking peering (GCP sometimes keeps it after all producer services
  #    are deleted; Terraform's delete call fails with error code 9 in that case)
  if [[ "$exists_vpc_peering" == true ]]; then
    echo "  Deleting Service Networking peering on ${VPC_NAME}..."
    gcloud services vpc-peerings delete \
      --service=servicenetworking.googleapis.com \
      --network="${VPC_NAME}" \
      --project="${GCP_PROJECT_ID}" --quiet 2>/dev/null || true
    terraform state rm google_service_networking_connection.private_service_access 2>/dev/null || true
  fi

  # 5. VPC routes (auto-generated by the VPC connector; not managed by Terraform;
  #    block VPC deletion with "being used by a route/routing")
  if [[ "$exists_vpc_routes" == true ]]; then
    echo "  Deleting VPC routes on ${VPC_NAME}..."
    echo "${vpc_route_names}" | xargs gcloud compute routes delete \
      --project="${GCP_PROJECT_ID}" --quiet 2>/dev/null || true
  fi

  # 6. CI/CD resources require a GitHub token secret version that may not exist.
  #    Remove from state so destroy doesn't try to reach them.
  for r in \
    "google_cloudbuildv2_connection.github" \
    "google_cloudbuildv2_repository.scheduler" \
    "google_cloudbuild_trigger.on_push_main"; do
    terraform state rm "$r" 2>/dev/null || true
  done

  # ── Unlock deletion protection, then destroy remaining Terraform resources ──
  # Only target resources that have deletion_protection or force_destroy flags;
  # everything else is handled by the full destroy that follows.
  echo "  Applying deletion-protection overrides..."
  APPLY_TARGETS=()
  [[ "$exists_db_instance" == false ]] || APPLY_TARGETS+=(-target=google_sql_database_instance.main)
  [[ "$exists_worker_service" == false ]] || APPLY_TARGETS+=(-target=google_cloud_run_v2_service.worker)
  APPLY_TARGETS+=(-target=google_storage_bucket.job_zip)
  terraform apply -auto-approve -input=false "${APPLY_TARGETS[@]}" "${DESTROY_VAR_OVERRIDES[@]}"

  echo "  Running terraform destroy..."
  terraform destroy -auto-approve -input=false "${DESTROY_VAR_OVERRIDES[@]}"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "=== Dry-run complete — no resources were modified ==="
else
  echo "=== Teardown complete ==="
fi
