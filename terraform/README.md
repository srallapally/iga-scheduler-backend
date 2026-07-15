# IGA Scheduler Terraform

This Terraform root provisions the **complete GCP infrastructure** for the IGA Scheduler service:

| Module | Resources |
|---|---|
| Networking | VPC, Serverless VPC Access connector, Private Service Access peering |
| Cloud SQL | PostgreSQL 15, regional HA, private IP, app database + user |
| Secret Manager | 4 secrets: `db-password`, `iga-client-secret`, `es-api-key`, `github-token` |
| GCS | Job artifact ZIP bucket |
| Artifact Registry | Docker repository for worker and scheduler images |
| Cloud Run | `iga-scheduler-worker` service (always-on, min 1 instance) |
| Service Accounts | `scheduler-service`, `runtime`, `deployer`, `tick-invoker`, `worker-invoker` + all IAM bindings |
| Cloud Scheduler | Minute-tick job → `/internal/scheduler/tick` (OIDC authenticated) |
| Cloud Build | GitHub v2 connection + push-to-main deploy trigger |

## Required variables

These have no defaults and must be supplied in `terraform.tfvars` or via `-var` flags:

| Variable | Description |
|---|---|
| `project_id` | GCP project ID |
| `cloud_run_service_name` | Scheduler Cloud Run service name (e.g. `iga-scheduler`) |
| `cloud_run_service_url` | Scheduler Cloud Run base URL — set to `""` on first apply; fill in after service is created |
| `tf_state_bucket_name` | GCS bucket holding this root's remote state (needed to grant deployer SA read access) |
| `github_app_installation_id` | Installation ID from the Google Cloud Build GitHub App — one-time manual step |
| `es_endpoint` | Elasticsearch cluster URL (external, not Terraform-managed) |
| `iga_token_endpoint` | IGA platform OAuth token endpoint |
| `iga_client_id` | IGA platform OAuth client ID |
| `iga_base_url` | IGA platform base URL |
| `public_api_issuer` | PingOne issuer URL |
| `public_api_audience` | PingOne-registered resource identifier |

Copy and fill `terraform.tfvars.example`:

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — do not commit it (contains project-specific values)
```

## First apply

See "First deploy" in the top-level `README.md` for the full bootstrap sequence. In short:

1. Apply with `cloud_run_service_url = ""` and `scheduler_service_url = ""` — provisions infra and creates the Cloud Build trigger.
2. Seed out-of-band secrets (IGA client secret, ES API key, GitHub token) via `gcloud secrets versions add`.
3. Run `gcloud builds submit --config=cloudbuild.yaml .` manually to get the initial Cloud Run URLs.
4. Fill in the real URLs and re-apply.

## Example

```bash
cd terraform

# Validate (no backend required)
./validate.sh

# Init with remote state backend
terraform init \
  -backend-config="bucket=<tf-state-bucket>" \
  -backend-config="prefix=iga-scheduler"

terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

## Verify

```bash
# Check the Cloud Scheduler tick job
gcloud scheduler jobs describe iga-scheduler-tick \
  --project=<project-id> \
  --location=us-central1

# Trigger a manual tick
gcloud scheduler jobs run iga-scheduler-tick \
  --project=<project-id> \
  --location=us-central1

# Check Cloud SQL instance
gcloud sql instances describe iga-scheduler-db \
  --project=<project-id>
```

## Notes

- `lifecycle.ignore_changes` on the worker service image prevents re-apply from reverting to the placeholder image after Cloud Build has deployed a real one.
- AlloyDB is switchable: set `DB_ENGINE=direct` + point `DATABASE_URL` at an AlloyDB Auth Proxy sidecar. No Terraform changes needed; the connector switch lives only in `src/clients/pgClient.js`.
- The `db-password` secret version is populated by Terraform. The other three secrets (`iga-client-secret`, `es-api-key`, `github-token`) are shells only — populate them out-of-band: `gcloud secrets versions add <name> --data-file=-`.
