output "scheduler_tick_job_name" {
  description = "Cloud Scheduler job name for the scheduler tick. Empty string on first deploy before cloud_run_service_url is set."
  value       = length(google_cloud_scheduler_job.scheduler_tick) > 0 ? google_cloud_scheduler_job.scheduler_tick[0].name : ""
}

output "scheduler_tick_job_id" {
  description = "Fully qualified Cloud Scheduler job ID. Empty string on first deploy before cloud_run_service_url is set."
  value       = length(google_cloud_scheduler_job.scheduler_tick) > 0 ? google_cloud_scheduler_job.scheduler_tick[0].id : ""
}

output "scheduler_tick_url" {
  description = "Internal scheduler tick URL called by Cloud Scheduler. Empty string on first deploy."
  value       = local.scheduler_tick_url
}

output "scheduler_tick_invoker_email" {
  description = "Service account email used by Cloud Scheduler for OIDC invocation."
  value       = google_service_account.scheduler_tick_invoker.email
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

output "worker_pool_size" {
  description = "Single source of truth for the worker's fixed warm-pool size -- cloudbuild.yaml reads this and applies it to both --min-instances and --max-instances on every deploy (AVL-1 residual)."
  value       = var.worker_pool_size
}
