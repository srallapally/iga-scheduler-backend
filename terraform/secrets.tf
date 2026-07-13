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

# No google_secret_manager_secret_version for iga_client_secret, es_api_key, or
# github_token — all three values are set out-of-band (`gcloud secrets versions add
# <secret-id> --data-file=-`) after apply. Terraform manages the secret shells and IAM
# only. github_token is a GitHub Personal Access Token with repo read access, used by
# cicd.tf's Cloud Build connection to authenticate to GitHub.
