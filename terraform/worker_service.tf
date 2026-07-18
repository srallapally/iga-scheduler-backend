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

    # This is Cloud Run's per-request timeout, NOT a graceful-shutdown/drain
    # grace period. Cloud Run's actual SIGTERM-to-SIGKILL window on scale-in/
    # deploy is a short, platform-controlled interval that this setting does
    # not extend (AVL-1). The worker's only HTTP route left is /health (AVL-1
    # residual: dispatch and cancel are pull-based now, not pushed over
    # HTTP — see pollLoop.js), which responds immediately, so this setting
    # has little practical effect either way; kept high mainly so it never
    # becomes the reason a slow-starting health probe gets cut off.
    timeout = "${var.worker_max_drain_seconds}s"

    # Fixed warm pool, not elastic autoscaling (AVL-1 residual): the worker
    # polls Postgres for work rather than receiving pushed HTTP requests, so
    # Cloud Run's request-based autoscaling signal never fires here. Both
    # bounds are pinned to the same variable on purpose.
    scaling {
      min_instance_count = var.worker_pool_size
      max_instance_count = var.worker_pool_size
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
