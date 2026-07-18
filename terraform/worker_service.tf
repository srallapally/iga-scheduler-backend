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

      env {
        # Cloud Run container boundary is the isolation layer here.
        # The guard in JobRuntimeExecutor is for local dev only.
        name  = "WORKER_REQUIRE_RUNTIME_ISOLATION"
        value = "false"
      }
    }
  }

  deletion_protection = var.worker_service_deletion_protection

  lifecycle {
    # Cloud Build owns the full template after first deploy: image, env vars,
    # VPC connector annotations, secrets, labels. Ignoring the entire template
    # prevents Terraform from creating a new revision that reverts to the
    # placeholder image whenever other template-level drift is detected.
    ignore_changes = [template]
  }

  depends_on = [google_project_service.run]
}
