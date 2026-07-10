# IGA Scheduler Terraform

This Terraform root provisions the Phase 5 Cloud Scheduler tick invocation path.

It assumes the Cloud Run service already exists. This root manages only:

- Cloud Scheduler API enablement
- Dedicated scheduler tick invoker service account
- Cloud Run `roles/run.invoker` IAM binding for that service account
- Cloud Scheduler HTTP job targeting `/internal/scheduler/tick`
- OIDC configuration for authenticated Cloud Run invocation
- `x-iga-scheduler-source: cloud-scheduler` contract header

## Required variables

```hcl
project_id             = "<gcp-project-id>"
region                 = "us-central1"
cloud_run_service_name = "iga-scheduler"
cloud_run_service_url  = "https://<cloud-run-service-host>"
```

`cloud_run_service_url` must be the base service URL without `/internal/scheduler/tick`. Terraform trims a trailing slash if one is supplied.

## Example

```bash
cd terraform
terraform init
terraform fmt
terraform validate
terraform plan \
  -var='project_id=<gcp-project-id>' \
  -var='region=us-central1' \
  -var='cloud_run_service_name=iga-scheduler' \
  -var='cloud_run_service_url=https://<cloud-run-service-host>'
```

Apply after reviewing the plan:

```bash
terraform apply \
  -var='project_id=<gcp-project-id>' \
  -var='region=us-central1' \
  -var='cloud_run_service_name=iga-scheduler' \
  -var='cloud_run_service_url=https://<cloud-run-service-host>'
```

## Verify

```bash
gcloud scheduler jobs describe iga-scheduler-tick \
  --project=<gcp-project-id> \
  --location=us-central1
```

Trigger manually after deploy:

```bash
gcloud scheduler jobs run iga-scheduler-tick \
  --project=<gcp-project-id> \
  --location=us-central1
```

## Notes

The app-level `x-iga-scheduler-source` header is a non-secret invocation marker. The production authentication boundary is Cloud Run IAM plus the OIDC token minted for the dedicated scheduler service account.
