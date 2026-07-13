resource "google_project_service" "run" {
  project            = var.project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_cloud_run_v2_service" "worker" {
  project  = var.project_id
  name     = var.worker_service_name
  location = var.region

  template {
    service_account = google_service_account.runtime.email

    # Give the SIGTERM handler time to drain active job subprocesses before
    # Cloud Run terminates the instance. Set to worker_max_drain_seconds, which
    # should equal (WORKER_MAX_TIMEOUT_SECONDS + 30) * 1000 ms from workerApp.js.
    timeout = "${var.worker_max_drain_seconds}s"

    scaling {
      min_instance_count = var.worker_service_min_instances
      max_instance_count = 10
    }

    containers {
      image = var.worker_placeholder_image

      resources {
        limits = {
          cpu    = var.worker_service_cpu
          memory = var.worker_service_memory
        }
        # CPU always allocated — prevents scale-to-zero and eliminates cold starts
        # for subsequent requests after the first.
        cpu_idle = false
      }

      env {
        name  = "WORKER_EXECUTION_MODE"
        value = "local"
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.run]
}
