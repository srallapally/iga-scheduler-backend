# Architecture Review: iga-scheduler-backend

**Reviewer perspective:** Software / Technical Architect
**Criteria:** Same functionality · fewer moving parts · lower cost

---

## Current Service Inventory

| Layer | Services |
|---|---|
| Compute | Cloud Run (scheduler) + Cloud Run (worker) |
| Data | Cloud SQL Postgres + Elasticsearch |
| Storage | GCS |
| Queue / Trigger | Cloud Scheduler + Postgres poll loop |
| Networking | VPC + VPC Access Connector (min 2 instances, always-on) |
| Auth | PingOne/AIC JWKS + Google OIDC (internal) + Secret Manager |
| CI/CD | Artifact Registry + Cloud Build |

**12+ services** to implement a loop that is conceptually: fire cron → create run row → dispatch to worker → execute ZIP → record result.

---

## What Is Good

### Queue design
Using `job_runs` as the queue directly (no pg-boss, no Cloud Tasks) is correct for this workload. `FOR UPDATE SKIP LOCKED` in the tick and conditional `UPDATE ... WHERE state='QUEUED'` in the dispatch poller are the right primitives. This avoids dual-write coordination between a job table and a run table, and removes a dependency that was deleted for good reason.

### Security boundary between scheduler and worker
Running user job code in a separate Cloud Run service is the right call. Even for internal code, keeping untrusted subprocess execution out of the scheduler process limits the blast radius of a misbehaving job (memory exhaustion, file descriptor leaks, runaway CPU). The OIDC-secured callback for completion and IGA proxying is the correct pattern.

### Auth implementation
The dual-mode `publicAuth.js` middleware — supporting both PingOne (`client_id` claim) and PingOne AIC / ForgeRock (`azp` claim) via OIDC discovery with JWKS caching — is well-structured and handles real-world IdP variation cleanly. Using `jose` for JWKS verification is the right library choice.

### IAM is least-privilege
The three service accounts (`scheduler_service`, `runtime`, `deployer`) have tight, well-reasoned permission sets. Each SA gets exactly what it needs and nothing more. The separation of the deployer SA from the runtime SAs is correct and the `iam.serviceAccountUser` grants are properly scoped.

### Run state machine
`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLING → CANCELLED` with per-instance savepoints in the tick is solid. The redrive path (new run ID with `:redrive:<uuid>` suffix) preserves the full history rather than mutating the original run, which is the right choice for an audit-oriented system.

### Token management
`TokenManager` in `src/iga/tokenManager.js` single-flights concurrent refresh via a shared promise and handles the 60-second skew correctly. This avoids a thundering-herd token refresh under load.

### Test coverage
48 test files covering all major components, including deep tests for `JobRuntimeExecutor`, `WorkerRunService`, and the public auth middleware. The use of Vitest with ESM is the right modern choice.

### Zip artifact trust chain design
The intent behind the artifact trust chain (SHA-256 integrity, GCS generation pinning, approval + scan status gates) is architecturally sound. Pinning to a GCS object generation prevents substitution attacks after approval. This is a mature security pattern.

### Transactional tick with per-instance savepoints
`SchedulerTickService` wraps the entire batch in one transaction but uses a savepoint per instance. A cron parse error on one instance does not abort the whole batch. This is the correct resilience pattern for a scheduler.

---

## What Needs Improvement

### Split data stores add coordination risk without a clear payoff

Elasticsearch holds job definitions and audit events. Postgres holds instances and runs. This means two databases must be healthy for the system to operate, and writes that span both (definition upload) have a partial-failure window.

**Definitions** are JSON config documents keyed by ID. The only queries are by ID and by state. Postgres JSONB handles this natively — you already constrain the shape with Zod on write, so ES's schema-free flexibility is not used. A `job_definitions` table with JSONB columns is a drop-in replacement.

**Audit events** are append-only structured logs. This is exactly what Cloud Logging is for. It is free at reasonable volumes, searchable in Log Explorer, retainable via log sinks to Cloud Storage or BigQuery, and natively integrated with GCP IAM audit trails.

Dropping ES removes: the ES client, the ES API key secret, dual-write in `JobDefinitionService`, the ES health dependency on every dispatch (definition fetch before trust validation), and the partial-write cleanup code.

### VPC connector may be unnecessary

The VPC connector (min 2 always-on instances) exists for Cloud SQL private IP access. However, `pgClient.js` already uses `@google-cloud/cloud-sql-connector`, which connects via the Cloud SQL Admin API and does not route through your VPC. It works with a public IP instance and IAM authentication, with SSL enforced by the connector.

If Cloud SQL is moved to public IP + IAM auth + connector library, the entire VPC setup can be removed: the custom VPC, the subnet, the Private Service Access allocation, and the VPC Access Connector. These are four Terraform resources with ongoing cost and operational complexity.

The connector library provides equivalent security (IAM-authenticated, short-lived mTLS certificates) without the network plumbing.

### Dual execution paths (`local` vs `isolated`) in WorkerRunService

Production enforces `WORKER_EXECUTION_MODE=isolated` via `productionValidation.js`. The `local` path (in-process subprocess within the scheduler) exists only for development and testing. It adds approximately 200 lines across `WorkerRunService` and `JobRuntimeExecutor` that must be maintained in parallel with the production path, and it creates subtle asymmetries — for example, the artifact download and integrity check sequence differs between the two modes.

Consider moving the `local` path behind a clearer abstraction or extracting it to a test-only helper, so the production code path is unambiguous.

### Dispatch poller has no backpressure

`RunDispatcher` polls every 5 seconds and attempts to dispatch all queued runs. If the worker service is unhealthy or rate-limiting, each poll pass will log a warning and retry all queued runs on the next tick. There is no exponential backoff, no per-run failure counting at the dispatcher level, and no circuit-breaker pattern.

Under a sustained worker outage, this produces continuous noise in logs and unnecessary OIDC token fetches. A simple per-run failure counter with exponential delay, or a circuit-breaker that pauses dispatch after N consecutive failures, would reduce churn significantly.

### No stale-RUNNING sweep

A Cloud Run worker instance that crashes without calling `/complete` leaves its run in `RUNNING` state forever. This is acknowledged in the plan index as a known gap. It is not a regression from the prior architecture, but it is a real operational problem: a stale run blocks retry and manual intervention is required. A background sweep that marks RUNNING runs older than `timeout + grace` as FAILED is a small addition with high operational value.

### Worker service bootstrap chicken-and-egg problem

On a fresh deployment, the worker Cloud Run service URL is unknown until after `terraform apply`. The scheduler's `WorkerServiceRuntimeLauncher` needs that URL at startup. This is documented but means the first deploy requires a manual two-phase process. A Terraform output feeding a Cloud Build substitution would close this gap.

---

## What Is Bad

### The trust gate always rejects — every run fails in production

`WorkerRunService.validateArtifactTrust()` requires `jobZip.approval.status === 'APPROVED'` and `jobZip.scan.status === 'CLEAN'`. `JobDefinitionService.createDefinition()` never sets these fields. No definition uploaded through the API will ever pass the trust gate. Every dispatched run fails at this check.

This means no job has ever successfully executed through the normal path in production unless an operator manually patched the Elasticsearch definition document to add `approval` and `scan` fields. This is a P0 correctness defect, not a design gap. It needs to be resolved before the system is usable: either auto-set `approval.status = 'APPROVED'` and `scan.status = 'CLEAN'` on upload for trusted internal code, or build and wire the actual approval and scanning pipeline.

### Orphaned infrastructure from the Cloud Tasks deletion

`terraform/scheduler.tf` creates `google_service_account.worker_task_invoker` with the description "Used in Cloud Tasks OIDC tokens when invoking the internal worker route." Cloud Tasks was deleted in Plan 4. This SA has `run.invoker` IAM bindings but no corresponding queue or use in the codebase. It is ghost infrastructure: it has no operational purpose, incurs no meaningful cost, but signals that the Terraform state is not clean and will confuse anyone reading the infra in the future.

### `WORKER_RUNTIME_ISOLATION` env var is partially removed

`src/config/productionValidation.js` throws if `WORKER_RUNTIME_ISOLATION` is set, because it was the old gVisor isolation flag replaced by `WORKER_EXECUTION_MODE`. However, `src/services/jobRuntimeExecutor.js` still reads `WORKER_RUNTIME_ISOLATION` in its constructor and uses it to gate gVisor invocation. The result is a dead code path in the executor that references a variable that production explicitly rejects. It will silently never activate but adds confusion about which env var controls what. The old flag and its handling in `jobRuntimeExecutor.js` should be removed.

### Dead code inventory is significant

The following files are preserved by plan invariant but serve no operational purpose and should be deleted once the invariant is lifted:

| File | Why it is dead |
|---|---|
| `src/services/isolatedRuntimeLauncher.js` | Replaced by `WorkerServiceRuntimeLauncher`; was the Cloud Run Jobs path |
| `src/workers/internalWorkerPlaceholder.js` | Placeholder with no logic |
| `src/middleware/cloudSchedulerInvocation.js` | Superseded by `internalAuth.js` |
| `routes/` (root level) | Orphaned pre-migration route files |
| `bin/www` | Leftover Express scaffold |
| `public/` | Leftover Express scaffold |

Keeping dead code increases the cognitive load of every future reader and creates maintenance surface. The plan invariant that preserves them was appropriate during migration; it is not appropriate as permanent policy.

---

## Proposed Simplified Architecture

The same functionality with fewer services:

```
PingOne OAuth ──► Cloud Run (single service: API + tick handler + dispatch poller + job executor)
                      │
                      ├── Postgres (definitions + instances + runs + JSONB for flexible config)
                      ├── GCS (ZIP artifacts)
                      ├── Secret Manager (credentials only)
                      └── Cloud Logging (audit events, structured JSON)
                              ▲
                   Cloud Scheduler (POST /internal/scheduler/tick every minute)
```

**Services: 6 instead of 12+.** Same functional capability.

| Removed | Justification |
|---|---|
| Elasticsearch | Definitions → Postgres JSONB; audit → Cloud Logging |
| Worker Cloud Run service | Process isolation sufficient for internal trusted code |
| VPC + VPC Access Connector | Cloud SQL connector library does not require VPC routing |
| Worker Dockerfile + Artifact Registry entries | Follows from worker service removal |
| OIDC dispatch flow (scheduler → worker) | Follows from worker service removal |

The only capability trade-off is process isolation vs container isolation for job execution. If job code comes from external or untrusted authors, retain the separate worker service. If jobs are written by your own teams, process isolation (the `local` execution path, hardened) is sufficient and the operational cost of the two-service architecture is not justified.

---

## Prioritised Action List

| Priority | Action | Impact | Effort |
|---|---|---|---|
| P0 | Fix trust gate — auto-approve on upload or wire the approval pipeline | Production correctness: no runs complete without this | Hours |
| P1 | Drop Elasticsearch — definitions to Postgres JSONB, audit to Cloud Logging | Removes second DB, eliminates dual-write risk, reduces cost | Days |
| P2 | Remove VPC connector — Cloud SQL public IP + connector lib + IAM auth | Removes always-on connector cost and VPC complexity | Day |
| P3 | Delete dead code — isolated launcher, placeholder, old middleware, routes, bin, public | Reduces maintenance surface and cognitive load | Hours |
| P4 | Delete orphaned `worker_task_invoker` SA from Terraform | Clean infra state | Minutes |
| P5 | Remove `WORKER_RUNTIME_ISOLATION` from `jobRuntimeExecutor.js` | Remove dead code path and confusion with the rejected env var | Minutes |
| P6 | Add stale-RUNNING sweep — mark RUNNING runs older than timeout+grace as FAILED | Operational reliability: no stuck runs requiring manual intervention | Hours |
| P7 | Add dispatcher backpressure — circuit-breaker or exponential backoff on repeated worker failures | Reduce log noise and unnecessary token fetches under worker outage | Hours |
| P8 | Evaluate worker service collapse — if job code is internal and trusted, collapse worker into scheduler | Removes two-service complexity, OIDC dispatch, bootstrap problem | Days |
