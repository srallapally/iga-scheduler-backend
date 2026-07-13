output "scheduler_tick_job_name" {
  description = "Cloud Scheduler job name for the scheduler tick."
  value       = google_cloud_scheduler_job.scheduler_tick.name
}

output "scheduler_tick_job_id" {
  description = "Fully qualified Cloud Scheduler job ID."
  value       = google_cloud_scheduler_job.scheduler_tick.id
}

output "scheduler_tick_url" {
  description = "Internal scheduler tick URL called by Cloud Scheduler."
  value       = local.scheduler_tick_url
}

output "scheduler_tick_invoker_email" {
  description = "Service account email used by Cloud Scheduler for OIDC invocation."
  value       = google_service_account.scheduler_tick_invoker.email
}

output "worker_task_invoker_email" {
  description = "Service account email used by Cloud Tasks for OIDC worker invocation."
  value       = google_service_account.worker_task_invoker.email
}

output "worker_oidc_audience" {
  description = "OIDC audience to configure on Cloud Tasks worker requests."
  value       = local.cloud_run_service_url
}

output "db_instance_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "vpc_connector_id" {
  value = google_vpc_access_connector.scheduler.id
}

output "runtime_service_account_email" {
  value = google_service_account.runtime.email
}

output "scheduler_service_account_email" {
  value = google_service_account.scheduler_service.email
}

output "deployer_service_account_email" {
  value = google_service_account.deployer.email
}

output "artifact_registry_repo_url" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.runtime_images.repository_id}"
}

output "job_zip_bucket_name" {
  value = google_storage_bucket.job_zip.name
}

output "worker_service_name" {
  value = google_cloud_run_v2_service.worker.name
}
