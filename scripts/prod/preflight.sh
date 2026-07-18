#!/usr/bin/env bash
# Preflight: probes GCP resources and ES indices in dependency order.
# Reports what exists, what is missing, and what would block deploy.
# Read-only — makes no writes.
#
# Usage:
#   source scripts/prod/set-env.sh
#   bash scripts/prod/preflight.sh
#   bash scripts/prod/preflight.sh --quiet    # suppress [ok] lines, show only warnings/errors
#
# Exit codes:
#   0 — all resources exist or are absent-but-optional
#   1 — one or more blocking resources are missing or misconfigured
#
# Required env vars: GCP_PROJECT_ID
# Optional (enables deeper checks): ES_ENDPOINT, ES_API_KEY
set -euo pipefail

PROJECT="${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
REGION="${REGION:-us-central1}"

QUIET=false
for arg in "$@"; do
  [[ "$arg" == "--quiet" ]] && QUIET=true
done

BLOCKERS=0
WARNINGS=0

# ── Output helpers ────────────────────────────────────────────────────────────
ok()   { [[ "$QUIET" == true ]] || printf "  \033[32m[ok]\033[0m      %-52s %s\n" "$1" "${2:-}"; }
miss() { printf "  \033[33m[missing]\033[0m %-52s %s\n" "$1" "${2:-}"; WARNINGS=$((WARNINGS+1)); }
need() { printf "  \033[31m[NEEDED]\033[0m  %-52s %s\n" "$1" "${2:-}"; BLOCKERS=$((BLOCKERS+1)); }
info() { [[ "$QUIET" == true ]] || printf "  \033[2m%-60s\033[0m\n" "$1"; }
hdr()  { echo ""; echo "── $1"; }

# ── Probe helpers ─────────────────────────────────────────────────────────────

# gcloud_exists: run a describe/list command; return 0 if it prints anything, 1 if not
gcloud_exists() { "$@" --format="value(name)" 2>/dev/null | grep -q .; }

api_enabled() {
  gcloud services list --project="$PROJECT" \
    --filter="config.name=$1" --format="value(config.name)" 2>/dev/null | grep -q .
}

secret_has_version() {
  gcloud secrets versions list "$1" \
    --project="$PROJECT" --filter="state=ENABLED" \
    --format="value(name)" 2>/dev/null | grep -q .
}

# ═════════════════════════════════════════════════════════════════════════════
hdr "1 / 9  GCP APIs"
# ═════════════════════════════════════════════════════════════════════════════

APIS=(
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

for api in "${APIS[@]}"; do
  if api_enabled "$api"; then
    ok "API: $api"
  else
    need "API: $api" "run: gcloud services enable $api --project=$PROJECT"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
hdr "2 / 9  VPC networking  (required before Cloud SQL and VPC connector)"
# ═════════════════════════════════════════════════════════════════════════════

VPC_NAME="iga-scheduler-vpc"
SUBNET_NAME="${VPC_NAME}-connector-subnet"
PSA_RANGE_NAME="${VPC_NAME}-psa-range"
CONNECTOR_NAME="iga-scheduler-connector"

if gcloud_exists gcloud compute networks describe "$VPC_NAME" --project="$PROJECT"; then
  ok "VPC network: $VPC_NAME"
else
  need "VPC network: $VPC_NAME" "created by terraform apply"
fi

if gcloud_exists gcloud compute networks subnets describe "$SUBNET_NAME" \
    --region="$REGION" --project="$PROJECT"; then
  ok "Subnet: $SUBNET_NAME"
else
  miss "Subnet: $SUBNET_NAME" "created by terraform apply"
fi

if gcloud_exists gcloud compute addresses describe "$PSA_RANGE_NAME" \
    --global --project="$PROJECT"; then
  ok "PSA global address: $PSA_RANGE_NAME"
else
  miss "PSA global address: $PSA_RANGE_NAME" "created by terraform apply"
fi

if gcloud services vpc-peerings list \
    --service=servicenetworking.googleapis.com \
    --network="$VPC_NAME" \
    --project="$PROJECT" \
    --format="value(name)" 2>/dev/null | grep -q .; then
  ok "Service Networking peering on $VPC_NAME"
else
  miss "Service Networking peering" "created by terraform apply (requires VPC + PSA range)"
fi

if gcloud_exists gcloud compute networks vpc-access connectors describe "$CONNECTOR_NAME" \
    --region="$REGION" --project="$PROJECT"; then
  ok "VPC Access Connector: $CONNECTOR_NAME"
else
  miss "VPC Access Connector: $CONNECTOR_NAME" "created by terraform apply (requires subnet)"
fi

# ═════════════════════════════════════════════════════════════════════════════
hdr "3 / 9  Storage  (GCS bucket + Artifact Registry)"
# ═════════════════════════════════════════════════════════════════════════════

BUCKET="${JOB_ZIP_BUCKET:-iga-scheduler-job-zips}"
AR_REPO="iga-scheduler"

if gcloud_exists gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT"; then
  ok "GCS bucket: $BUCKET"
else
  need "GCS bucket: $BUCKET" "created by terraform apply"
fi

if gcloud_exists gcloud artifacts repositories describe "$AR_REPO" \
    --location="$REGION" --project="$PROJECT"; then
  ok "Artifact Registry: $AR_REPO"
else
  need "Artifact Registry: $AR_REPO" "created by terraform apply"
fi

# ═════════════════════════════════════════════════════════════════════════════
hdr "4 / 9  Cloud SQL  (required before bootstrap-prod.js runs PG migrations)"
# ═════════════════════════════════════════════════════════════════════════════

DB_INSTANCE="iga-scheduler-db"

if gcloud_exists gcloud sql instances describe "$DB_INSTANCE" --project="$PROJECT"; then
  STATE=$(gcloud sql instances describe "$DB_INSTANCE" \
    --project="$PROJECT" --format="value(state)" 2>/dev/null || echo "UNKNOWN")
  if [[ "$STATE" == "RUNNABLE" ]]; then
    ok "Cloud SQL instance: $DB_INSTANCE ($STATE)"
  else
    miss "Cloud SQL instance: $DB_INSTANCE" "state=$STATE (expected RUNNABLE)"
  fi
else
  need "Cloud SQL instance: $DB_INSTANCE" "created by terraform apply (requires VPC peering)"
fi

# ═════════════════════════════════════════════════════════════════════════════
hdr "5 / 9  Service accounts"
# ═════════════════════════════════════════════════════════════════════════════

SAS=(
  "iga-scheduler-service"
  "iga-scheduler-runtime"
  "iga-scheduler-deployer"
  "iga-scheduler-tick-invoker"
)

for sa in "${SAS[@]}"; do
  if gcloud_exists gcloud iam service-accounts describe \
      "${sa}@${PROJECT}.iam.gserviceaccount.com" --project="$PROJECT"; then
    ok "Service account: $sa"
  else
    need "Service account: $sa" "created by terraform apply"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
hdr "6 / 9  Secret Manager secrets"
# ═════════════════════════════════════════════════════════════════════════════

# Shell = secret resource exists (Terraform manages this)
# Version = a value has been seeded (operator step or deploy.sh)
declare -A SECRET_REQUIRED=(
  ["iga-scheduler-db-password"]="seeded by terraform apply"
  ["iga-scheduler-iga-client-id"]="seeded by deploy.sh step 4b"
  ["iga-scheduler-iga-client-secret"]="seeded by deploy.sh step 4b"
  ["iga-scheduler-es-api-key"]="seeded by deploy.sh step 4b"
  ["iga-scheduler-github-token"]="seeded by deploy.sh step 3 (GITHUB_PAT)"
)

for secret in "${!SECRET_REQUIRED[@]}"; do
  hint="${SECRET_REQUIRED[$secret]}"
  if ! gcloud_exists gcloud secrets describe "$secret" --project="$PROJECT"; then
    need "Secret shell: $secret" "created by terraform apply"
  elif secret_has_version "$secret"; then
    ok "Secret: $secret (shell + version)"
  else
    miss "Secret: $secret" "shell exists but no version — $hint"
  fi
done

# ═════════════════════════════════════════════════════════════════════════════
hdr "7 / 9  Cloud Build CI/CD"
# ═════════════════════════════════════════════════════════════════════════════

CB_CONNECTION="iga-scheduler-github"
CB_TRIGGER="iga-scheduler-deploy"

if gcloud builds connections describe "$CB_CONNECTION" \
    --region="$REGION" --project="$PROJECT" &>/dev/null 2>&1; then
  ok "Cloud Build connection: $CB_CONNECTION"
else
  miss "Cloud Build connection: $CB_CONNECTION" "created by terraform apply (requires github_token version)"
fi

if gcloud builds triggers describe "$CB_TRIGGER" \
    --region="$REGION" --project="$PROJECT" &>/dev/null 2>&1; then
  ok "Cloud Build trigger: $CB_TRIGGER"
else
  miss "Cloud Build trigger: $CB_TRIGGER" "created by terraform apply"
fi

# ═════════════════════════════════════════════════════════════════════════════
hdr "8 / 9  Cloud Run services"
# ═════════════════════════════════════════════════════════════════════════════

WORKER_SERVICE="iga-scheduler-worker"
SCHEDULER_SERVICE="iga-scheduler"

if gcloud_exists gcloud run services describe "$WORKER_SERVICE" \
    --region="$REGION" --project="$PROJECT"; then
  ok "Cloud Run service: $WORKER_SERVICE (managed by Terraform)"
else
  miss "Cloud Run service: $WORKER_SERVICE" "created by terraform apply"
fi

if gcloud_exists gcloud run services describe "$SCHEDULER_SERVICE" \
    --region="$REGION" --project="$PROJECT"; then
  ok "Cloud Run service: $SCHEDULER_SERVICE (deployed by Cloud Build)"
else
  miss "Cloud Run service: $SCHEDULER_SERVICE" "deployed by Cloud Build pipeline"
fi

# ═════════════════════════════════════════════════════════════════════════════
hdr "9 / 9  Elasticsearch indices"
# ═════════════════════════════════════════════════════════════════════════════

if [[ -z "${ES_ENDPOINT:-}" || -z "${ES_API_KEY:-}" ]]; then
  info "skipped — ES_ENDPOINT or ES_API_KEY not set"
else
  ES_INDICES=("iga-scheduler-job-definitions" "iga-scheduler-audit-events")
  for idx in "${ES_INDICES[@]}"; do
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: ApiKey ${ES_API_KEY}" \
      "${ES_ENDPOINT}/${idx}" 2>/dev/null || echo "000")
    if [[ "$HTTP_STATUS" == "200" ]]; then
      ok "ES index: $idx"
    elif [[ "$HTTP_STATUS" == "404" ]]; then
      miss "ES index: $idx" "created by bootstrap-prod.js"
    else
      miss "ES index: $idx" "HTTP $HTTP_STATUS — check ES_ENDPOINT and ES_API_KEY"
    fi
  done
fi

# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo "── Summary"
# ═════════════════════════════════════════════════════════════════════════════

if [[ $BLOCKERS -gt 0 ]]; then
  printf "\033[31m  %d blocker(s)\033[0m — resolve before running deploy.sh\n" "$BLOCKERS"
fi
if [[ $WARNINGS -gt 0 ]]; then
  printf "\033[33m  %d item(s) missing\033[0m — will be created by terraform apply / deploy.sh\n" "$WARNINGS"
fi
if [[ $BLOCKERS -eq 0 && $WARNINGS -eq 0 ]]; then
  printf "\033[32m  all resources present\033[0m\n"
fi

echo ""
exit "$( [[ $BLOCKERS -eq 0 ]] && echo 0 || echo 1 )"
