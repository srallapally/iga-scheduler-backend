variable "project_id" {
  description = "Google Cloud project ID that owns the scheduler and Cloud Run service."
  type        = string

  validation {
    condition     = length(trimspace(var.project_id)) > 0
    error_message = "project_id must not be empty."
  }
}

variable "region" {
  description = "Google Cloud region for Cloud Scheduler and Cloud Run."
  type        = string
  default     = "us-central1"

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

variable "cloud_run_service_name" {
  description = "Existing Cloud Run service name to grant scheduler invocation access to."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", var.cloud_run_service_name))
    error_message = "cloud_run_service_name must be a valid Cloud Run service name."
  }
}

variable "cloud_run_service_url" {
  description = "Base URL of the existing Cloud Run service, without a trailing slash. Used as the OIDC audience. Set to \"\" on first apply before the service exists."
  type        = string
  default     = ""

  validation {
    condition     = var.cloud_run_service_url == "" || can(regex("^https://[^/]+/?$", var.cloud_run_service_url))
    error_message = "cloud_run_service_url must be a base HTTPS URL without a path, for example https://iga-scheduler-abc-uc.a.run.app."
  }
}

variable "scheduler_job_name" {
  description = "Cloud Scheduler job name for the internal scheduler tick."
  type        = string
  default     = "iga-scheduler-tick"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9-]{0,499}$", var.scheduler_job_name))
    error_message = "scheduler_job_name must start with a letter and contain only letters, numbers, and hyphens."
  }
}

variable "scheduler_schedule" {
  description = "Cron schedule for invoking the scheduler tick route."
  type        = string
  default     = "* * * * *"

  validation {
    condition     = length(trimspace(var.scheduler_schedule)) > 0
    error_message = "scheduler_schedule must not be empty."
  }
}

variable "scheduler_time_zone" {
  description = "Time zone used to interpret scheduler_schedule."
  type        = string
  default     = "UTC"

  validation {
    condition     = length(trimspace(var.scheduler_time_zone)) > 0
    error_message = "scheduler_time_zone must not be empty."
  }
}

variable "scheduler_attempt_deadline" {
  description = "Deadline for a single scheduler tick HTTP attempt."
  type        = string
  default     = "30s"

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?s$", var.scheduler_attempt_deadline))
    error_message = "scheduler_attempt_deadline must be a duration in seconds ending with s, for example 30s."
  }
}

variable "scheduler_paused" {
  description = "Whether to create the Cloud Scheduler job in a paused state."
  type        = bool
  default     = false
}

variable "scheduler_tick_service_account_id" {
  description = "Service account ID used by Cloud Scheduler to invoke the internal tick route."
  type        = string
  default     = "iga-scheduler-tick-invoker"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{4,28}[a-z0-9])$", var.scheduler_tick_service_account_id))
    error_message = "scheduler_tick_service_account_id must be 6-30 characters, start with a lowercase letter, and contain only lowercase letters, numbers, and hyphens."
  }
}

variable "scheduler_tick_body" {
  description = "JSON body sent by Cloud Scheduler to the internal tick route."
  type        = any
  default     = {}
}

variable "vpc_name" {
  type    = string
  default = "iga-scheduler-vpc"
}

variable "vpc_connector_name" {
  type    = string
  default = "iga-scheduler-connector"
}

variable "vpc_connector_cidr" {
  description = "Must not overlap the Private Service Access range (10.x.0.0/16 reserved separately)."
  type        = string
  default     = "10.8.0.0/28"
}

variable "db_instance_name" {
  type    = string
  default = "iga-scheduler-db"
}

variable "db_version" {
  type    = string
  default = "POSTGRES_15"
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-8192"
}

variable "db_name" {
  type    = string
  default = "iga_scheduler"
}

variable "db_user" {
  type    = string
  default = "iga_scheduler_app"
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "tf_state_bucket_name" {
  description = "GCS bucket holding this root's remote state (versions.tf backend config). Needed here only to grant the deployer SA read access to it — Terraform can't manage IAM on the bucket that stores its own state as a resource inside that same state, so this is a plain string, not a resource reference."
  type        = string
}

variable "job_zip_bucket_name" {
  type    = string
  default = "iga-scheduler-job-zips"
}

variable "artifact_registry_repo_id" {
  type    = string
  default = "iga-scheduler"
}

variable "scheduler_service_account_id" {
  type    = string
  default = "iga-scheduler-service"
}

variable "runtime_service_account_id" {
  type    = string
  default = "iga-scheduler-runtime"
}

variable "deployer_service_account_id" {
  type    = string
  default = "iga-scheduler-deployer"
}

variable "worker_service_name" {
  type    = string
  default = "iga-scheduler-worker"
}

variable "worker_service_min_instances" {
  description = "Minimum number of worker service instances. Set to at least 1 to prevent scale-to-zero and eliminate cold starts."
  type        = number
  default     = 1
}

variable "worker_max_drain_seconds" {
  description = "Cloud Run shutdown timeout for the worker service. Must be >= WORKER_MAX_TIMEOUT_SECONDS + 30 to allow in-flight job subprocesses to finish before SIGKILL. Matches workerApp.js maxDrainMs = (WORKER_MAX_TIMEOUT_SECONDS + 30) * 1000."
  type        = number
  default     = 1860
}

variable "worker_service_cpu" {
  type    = string
  default = "1"
}

variable "worker_service_memory" {
  type    = string
  default = "512Mi"
}

variable "worker_placeholder_image" {
  description = "Placeholder image for the worker service on first terraform apply, before Cloud Build has pushed a real image. lifecycle.ignore_changes prevents subsequent applies from reverting a real image to this placeholder."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "github_owner" {
  type    = string
  default = "srallapally"
}

variable "github_repo_name" {
  type    = string
  default = "iga-scheduler-backend"
}

variable "github_app_installation_id" {
  description = "From installing the 'Google Cloud Build' GitHub App on the repo (github.com/apps/google-cloud-build) — a one-time manual step. Not knowable until that step happens, no sensible default."
  type        = string
}

variable "scheduler_service_url" {
  description = "Set to empty on first apply. After the first pipeline run creates the scheduler service, capture its URL and re-apply — same bootstrap pattern the existing cloud_run_service_url variable already uses."
  type        = string
  default     = ""
}

variable "worker_service_url" {
  description = "Set to empty on first apply. After the first pipeline run deploys the worker service, capture its URL and re-apply — feeds _RUNTIME_WORKER_URL in the CI trigger's substitutions block."
  type        = string
  default     = ""
}

variable "scheduler_service_name" {
  type    = string
  default = "iga-scheduler"
}

# ── Externally-sourced config (Elasticsearch, the IGA platform, PingOne) ────────
# No defaults — Terraform can't know these, and a silent default would be worse
# than a required-variable error at plan time.

variable "es_endpoint" {
  type = string
}

variable "iga_token_endpoint" {
  type = string
}

variable "iga_base_url" {
  type = string
}

variable "public_api_issuer" {
  type = string
}

variable "public_api_audience" {
  type = string
}
