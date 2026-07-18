# ADR 0023: Enforce Public Access Prevention on the Job Artifact Bucket

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

The job-zip GCS bucket (`terraform/storage.tf`, `google_storage_bucket.job_zip`) set `uniform_bucket_level_access = true` and object versioning, but not `public_access_prevention`. `uniform_bucket_level_access` only forces access control through IAM rather than legacy per-object ACLs — it does not itself prevent an IAM binding from granting access to `allUsers` or `allAuthenticatedUsers`. Without `public_access_prevention = "enforced"`, a future IAM misconfiguration (an overly broad role grant, a copy-pasted Terraform binding, a manual `gcloud` command) could make job artifact zips — which may contain business logic and, per SEC-2's residual note, could reference sensitive parameters — publicly readable with no platform-level backstop. This is tracked as OPS-1.

---

## Decision

Add `public_access_prevention = "enforced"` to the `google_storage_bucket.job_zip` resource. This is a GCS-platform-level control, independent of and layered on top of IAM: even if a future IAM binding were mistakenly granted to `allUsers`/`allAuthenticatedUsers` on this bucket, GCS itself refuses to honor it while enforcement is on.

---

## Consequences

### What this closes

The job artifact bucket can no longer be made publicly accessible by an IAM misconfiguration alone — GCS enforces the restriction at the platform level regardless of what IAM bindings exist.

### What does not change

- No functional change to any existing IAM grant, service account, or upload/download path — every current caller (`JobDefinitionService`, `JobRuntimeExecutor`'s artifact download) already reaches the bucket through legitimate, non-public IAM bindings, so `public_access_prevention = "enforced"` changes nothing for them.
- `uniform_bucket_level_access` and the existing versioning/lifecycle rules — unchanged.
