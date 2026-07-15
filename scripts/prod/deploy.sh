#!/usr/bin/env bash
# Usage: bash scripts/prod/deploy.sh [terraform flags]
#
# Required environment variables (source these before running):
#   GCP_PROJECT_ID, JOB_ZIP_BUCKET
#   ES_ENDPOINT, ES_API_KEY
#   DB_ENGINE, DB_INSTANCE_CONNECTION_NAME, DB_USER, DB_NAME  (or DATABASE_URL for DB_ENGINE=direct)
#   WORKER_EXECUTION_MODE, RUNTIME_WORKER_URL, RUNTIME_SERVICE_ACCOUNT_EMAIL
#   RUNTIME_BROKER_URL
#   IGA_TOKEN_ENDPOINT, IGA_CLIENT_ID, IGA_CLIENT_SECRET, IGA_BASE_URL
#   PUBLIC_API_ISSUER, PUBLIC_API_AUDIENCE
#   WORKER_OIDC_AUDIENCE, WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
#   SCHEDULER_OIDC_AUDIENCE, SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
#
# Terraform variables are read from terraform/terraform.tfvars or passed as
# extra flags: e.g. -var="project_id=my-project"
set -euo pipefail

REQUIRED_VARS=(
  GCP_PROJECT_ID JOB_ZIP_BUCKET
  ES_ENDPOINT ES_API_KEY
  DB_ENGINE
  WORKER_EXECUTION_MODE RUNTIME_WORKER_URL RUNTIME_SERVICE_ACCOUNT_EMAIL
  RUNTIME_BROKER_URL
  IGA_TOKEN_ENDPOINT IGA_CLIENT_ID IGA_CLIENT_SECRET IGA_BASE_URL
  PUBLIC_API_ISSUER PUBLIC_API_AUDIENCE
  WORKER_OIDC_AUDIENCE WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL
  SCHEDULER_OIDC_AUDIENCE SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL
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

cd "$(dirname "$0")/../../terraform"
terraform init -input=false
terraform apply -input=false "$@"

cd ..
echo ""
echo "Terraform apply complete. If cicd.tf's trigger is already set up, pushing to"
echo "main now deploys automatically. For a manual/one-off run instead (also needed on"
echo "the very first deploy, before the worker service has a real image):"
echo "  gcloud builds submit --config=cloudbuild.yaml ."
echo ""

npm run preflight
npm run bootstrap:prod
