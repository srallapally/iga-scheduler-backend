data "google_project" "project" {
  project_id = var.project_id
}

resource "google_project_service" "secretmanager" {
  project            = var.project_id
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "iga-scheduler-db-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db_password.result
}

resource "google_secret_manager_secret" "iga_client_id" {
  project   = var.project_id
  secret_id = "iga-scheduler-iga-client-id"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "iga_client_secret" {
  project   = var.project_id
  secret_id = "iga-scheduler-iga-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "es_api_key" {
  project   = var.project_id
  secret_id = "iga-scheduler-es-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret" "github_token" {
  project   = var.project_id
  secret_id = "iga-scheduler-github-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

# The Cloud Build service agent must be able to read github_token when creating
# the GitHub v2 connection. This SA is GCP-managed — it exists once Cloud Build
# API is enabled — so we reference it by project number, not by a created resource.
resource "google_secret_manager_secret_iam_member" "cloudbuild_agent_github_token" {
  secret_id  = google_secret_manager_secret.github_token.secret_id
  project    = var.project_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-cloudbuild.iam.gserviceaccount.com"
  depends_on = [google_project_service.cloudbuild]
}

# No google_secret_manager_secret_version for iga_client_secret, es_api_key, or
# github_token — all three values are set out-of-band (`gcloud secrets versions add
# <secret-id> --data-file=-`) after apply. Terraform manages the secret shells and IAM
# only. github_token is a GitHub Personal Access Token with repo read access, used by
# cicd.tf's Cloud Build connection to authenticate to GitHub.
