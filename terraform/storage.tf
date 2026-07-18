resource "google_storage_bucket" "job_zip" {
  project                     = var.project_id
  name                        = var.job_zip_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = var.storage_force_destroy

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
    }
    action {
      type = "Delete"
    }
  }
}
