resource "google_storage_bucket" "job_zip" {
  project                     = var.project_id
  name                        = var.job_zip_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  # Defense-in-depth (OPS-1): uniform_bucket_level_access only forces IAM
  # (vs. legacy ACLs) -- it doesn't itself prevent a future IAM grant to
  # allUsers/allAuthenticatedUsers from making job artifact zips public.
  public_access_prevention = "enforced"
  force_destroy            = var.storage_force_destroy

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
