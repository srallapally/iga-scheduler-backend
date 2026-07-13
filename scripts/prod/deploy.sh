#!/usr/bin/env bash
set -euo pipefail

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
