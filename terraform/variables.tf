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
  description = "Base URL of the existing Cloud Run service, without a trailing slash. Used as the OIDC audience."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+/?$", var.cloud_run_service_url))
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

variable "worker_task_invoker_service_account_id" {
  description = "Service account ID used in Cloud Tasks OIDC tokens when invoking the worker route."
  type        = string
  default     = "iga-scheduler-worker-invoker"

  validation {
    condition     = can(regex("^[a-z]([a-z0-9-]{4,28}[a-z0-9])$", var.worker_task_invoker_service_account_id))
    error_message = "worker_task_invoker_service_account_id must be 6-30 characters, start with a lowercase letter, and contain only lowercase letters, numbers, and hyphens."
  }
}

variable "scheduler_tick_body" {
  description = "JSON body sent by Cloud Scheduler to the internal tick route."
  type        = any
  default     = {}
}
