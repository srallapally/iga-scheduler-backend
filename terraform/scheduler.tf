locals {
  cloud_run_service_url = trimsuffix(var.cloud_run_service_url, "/")
  scheduler_tick_url    = "${local.cloud_run_service_url}/internal/scheduler/tick"
}

resource "google_project_service" "cloud_scheduler" {
  project            = var.project_id
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

resource "google_service_account" "scheduler_tick_invoker" {
  project      = var.project_id
  account_id   = var.scheduler_tick_service_account_id
  display_name = "IGA Scheduler tick invoker"
  description  = "Invokes the internal scheduler tick endpoint via Cloud Scheduler OIDC."
}

resource "google_service_account" "worker_task_invoker" {
  project      = var.project_id
  account_id   = var.worker_task_invoker_service_account_id
  display_name = "IGA Scheduler worker task invoker"
  description  = "Used in Cloud Tasks OIDC tokens when invoking the internal worker route."
}

resource "google_cloud_run_service_iam_member" "scheduler_tick_invoker" {
  project  = var.project_id
  location = var.region
  service  = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_tick_invoker.email}"
}

resource "google_cloud_run_service_iam_member" "worker_task_invoker" {
  project  = var.project_id
  location = var.region
  service  = var.cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.worker_task_invoker.email}"
}

resource "google_cloud_scheduler_job" "scheduler_tick" {
  project          = var.project_id
  region           = var.region
  name             = var.scheduler_job_name
  description      = "Invokes the IGA Scheduler internal tick endpoint."
  schedule         = var.scheduler_schedule
  time_zone        = var.scheduler_time_zone
  attempt_deadline = var.scheduler_attempt_deadline
  paused           = var.scheduler_paused

  retry_config {
    retry_count          = 1
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
    max_retry_duration   = "300s"
    max_doublings        = 3
  }

  http_target {
    http_method = "POST"
    uri         = local.scheduler_tick_url
    body        = base64encode(jsonencode(var.scheduler_tick_body))

    headers = {
      "Content-Type"           = "application/json"
      "x-iga-scheduler-source" = "cloud-scheduler"
    }

    oidc_token {
      service_account_email = google_service_account.scheduler_tick_invoker.email
      audience              = local.cloud_run_service_url
    }
  }

  depends_on = [
    google_project_service.cloud_scheduler,
    google_cloud_run_service_iam_member.scheduler_tick_invoker
  ]
}
