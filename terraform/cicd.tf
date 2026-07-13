resource "google_project_service" "cloudbuild" {
  project            = var.project_id
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

resource "google_cloudbuildv2_connection" "github" {
  project  = var.project_id
  location = var.region
  name     = "iga-scheduler-github"

  github_config {
    app_installation_id = var.github_app_installation_id
    authorizer_credential {
      oauth_token_secret_version = "${google_secret_manager_secret.github_token.id}/versions/latest"
    }
  }

  depends_on = [google_project_service.cloudbuild]
}

resource "google_cloudbuildv2_repository" "scheduler" {
  project           = var.project_id
  location          = var.region
  name              = var.github_repo_name
  parent_connection = google_cloudbuildv2_connection.github.name
  remote_uri        = "https://github.com/${var.github_owner}/${var.github_repo_name}.git"
}

resource "google_cloudbuild_trigger" "on_push_main" {
  project  = var.project_id
  location = var.region
  name     = "iga-scheduler-deploy"

  repository_event_config {
    repository = google_cloudbuildv2_repository.scheduler.id
    push {
      branch = "^main$"
    }
  }

  filename        = "cloudbuild.yaml"
  service_account = google_service_account.deployer.id

  substitutions = {
    _REGION                 = var.region
    _REPO                   = var.artifact_registry_repo_id
    _SCHEDULER_SERVICE_NAME = var.scheduler_service_name
    _WORKER_SERVICE_NAME    = var.worker_service_name
    _TF_STATE_BUCKET        = var.tf_state_bucket_name
    _ES_ENDPOINT            = var.es_endpoint
    _IGA_TOKEN_ENDPOINT     = var.iga_token_endpoint
    _IGA_CLIENT_ID          = var.iga_client_id
    _IGA_BASE_URL           = var.iga_base_url
    _PUBLIC_API_ISSUER      = var.public_api_issuer
    _PUBLIC_API_AUDIENCE    = var.public_api_audience
    _SERVICE_URL            = var.scheduler_service_url
    _RUNTIME_WORKER_URL     = var.worker_service_url
  }
}
