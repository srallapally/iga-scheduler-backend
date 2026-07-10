# Terraform validation

Run from the repository root:

```bash
cd terraform
./validate.sh
```

The script runs:

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

Use `terraform.tfvars.example` as the template for local values:

```bash
cp terraform.tfvars.example terraform.tfvars
```

Do not commit real `*.tfvars` files.

Plan after validation:

```bash
terraform plan
```

For one-off command-line variables:

```bash
terraform plan \
  -var='project_id=<gcp-project-id>' \
  -var='region=us-central1' \
  -var='cloud_run_service_name=iga-scheduler' \
  -var='cloud_run_service_url=https://<cloud-run-service-host>'
```
