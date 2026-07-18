resource "google_service_account" "scheduler_service" {
  project      = var.project_id
  account_id   = var.scheduler_service_account_id
  display_name = "IGA Scheduler service identity"
  description  = "Runs the Cloud Run scheduler service. Distinct from the invoker SAs, which only call it."
}

resource "google_service_account" "runtime" {
  project      = var.project_id
  account_id   = var.runtime_service_account_id
  display_name = "IGA Scheduler job runtime identity"
  description  = "Runs the iga-job-worker Cloud Run Service; calls back to /complete and the IGA bridge proxy."
}

resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = var.deployer_service_account_id
  display_name = "IGA Scheduler CI/CD deployer"
  description  = "Used by the Cloud Build pipeline to push images and deploy Cloud Run resources."
}

# ── scheduler_service: Cloud SQL + secrets + GCS + invoke worker ───────────────

resource "google_project_iam_member" "scheduler_service_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.scheduler_service.email}"
}

resource "google_secret_manager_secret_iam_member" "scheduler_service_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler_service.email}"
}

resource "google_secret_manager_secret_iam_member" "scheduler_service_iga_client_id" {
  secret_id = google_secret_manager_secret.iga_client_id.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler_service.email}"
}

resource "google_secret_manager_secret_iam_member" "scheduler_service_iga_secret" {
  secret_id = google_secret_manager_secret.iga_client_secret.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler_service.email}"
}

resource "google_secret_manager_secret_iam_member" "scheduler_service_es_api_key" {
  secret_id = google_secret_manager_secret.es_api_key.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler_service.email}"
}

resource "google_storage_bucket_iam_member" "scheduler_service_gcs" {
  bucket = google_storage_bucket.job_zip.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.scheduler_service.email}"
}

# scheduler_service_invoke_worker (roles/run.invoker, scheduler SA -> worker
# service) removed here: dispatch is pull-based now (AVL-1 residual) -- the
# worker polls Postgres itself instead of the scheduler pushing over HTTP to
# /execute, so no inbound invocation from the scheduler to the worker is
# needed anymore. See docs/adr/0019-pull-worker-execution-model.md.

# ── runtime: secrets + GCS read + callback invocation ─────────────────────────

resource "google_project_iam_member" "runtime_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# The worker service (runtime SA) mounts IGA_CLIENT_SECRET via --set-secrets.
# Cloud Run resolves secret bindings using the service's SA at revision creation.
resource "google_secret_manager_secret_iam_member" "runtime_iga_client_id" {
  secret_id = google_secret_manager_secret.iga_client_id.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_iga_secret" {
  secret_id = google_secret_manager_secret.iga_client_secret.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# JobRuntimeExecutor (running inside the worker service) downloads job ZIP artifacts
# from GCS at dispatch time using Application Default Credentials from this SA.
resource "google_storage_bucket_iam_member" "runtime_gcs_read" {
  bucket = google_storage_bucket.job_zip.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# The job subprocess calls BrokerIgaClient which POSTs to RUNTIME_BROKER_URL
# (the scheduler service's /internal/runtime/iga/request and /complete endpoints).
# Cloud Run to Cloud Run over HTTPS — only roles/run.invoker is needed.
resource "google_cloud_run_service_iam_member" "runtime_invoker" {
  count    = var.scheduler_service_exists ? 1 : 0
  project  = var.project_id
  location = var.region
  service  = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

# Public API access — allow unauthenticated requests to reach the scheduler service.
# Auth is enforced in-app by the PingOne JWT middleware; Cloud Run itself must not
# block requests before they reach the app.
resource "google_cloud_run_service_iam_member" "scheduler_service_public_invoker" {
  count    = var.scheduler_service_exists ? 1 : 0
  project  = var.project_id
  location = var.region
  service  = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── deployer: push images, deploy Cloud Run resources, act-as runtime SA ──────

resource "google_project_iam_member" "deployer_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_secret_manager_secret_iam_member" "deployer_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  project   = var.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.runtime_images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_builds_builder" {
  project = var.project_id
  role    = "roles/cloudbuild.builds.builder"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_actas_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_actas_scheduler_service" {
  service_account_id = google_service_account.scheduler_service.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_state_read" {
  bucket = var.tf_state_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}
