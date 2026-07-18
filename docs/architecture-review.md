# Architecture Review: iga-scheduler-backend

**Reviewer perspective:** Software / Technical Architect
**Review:** Fourth pass — exhaustive, post-fix state, July 2026
**Hard constraint:** Elasticsearch and Postgres must coexist. IGA owns Elasticsearch; consolidation is not an option.

---

## Service Inventory

| Layer | Services |
|---|---|
| Compute | Cloud Run (scheduler service) + Cloud Run (worker service) |
| Data | Cloud SQL Postgres (instances, runs) + Elasticsearch (definitions, audit events) |
| Storage | GCS (artifact ZIPs) |
| Queue / Trigger | Cloud Scheduler (cron tick) + Postgres poll loop (dispatch) |
| Networking | VPC + VPC Access Connector (min 2 instances, always-on) |
| Auth | PingOne/AIC JWKS (public API) + Google OIDC (internal) + Secret Manager (credentials) |
| CI/CD | Artifact Registry + Cloud Build |

---

## Prior Review Resolution

| Prior item | Status |
|---|---|
| P0 trust gate | **Removed (SEC-6)** — `approval`/`scan` were self-asserted (written and checked by the same code path, never producible by any real workflow) and have been dropped rather than fixed; see "Artifact trust chain" below |
| P1 drop Elasticsearch | **Cannot do** — IGA constraint |
| P2 VPC connector | **Open** — still the highest-value remaining simplification |
| P3 dead code | **Fixed** — six files deleted (PRs #4, #8) |
| P4 orphaned SA | **Fixed** — `worker_task_invoker` SA and IAM binding removed from Terraform |
| P5 WORKER_RUNTIME_ISOLATION | **Fixed** — dead code path removed from executor |
| P6 stale-RUNNING sweep | **Fixed** — `StaleRunSweeper` (PR #10) |
| P7 dispatcher backpressure | **Fixed** — exponential backoff (PR #6) |
| P8 worker service collapse | **Moot** — two-service boundary is correct given the ES constraint |
| Worker startup validation | **Fixed** — `validateWorkerStartupConfig()` at worker entry (PR #14) |
| P0 (review 3): pre-existing test failures | **Open** — 14 tests still failing on `master` |
| P1 (review 3): ES readiness probe | **Open** |
| P2 (review 3): VPC connector | **Open** |
| P3 (review 3): RUNTIME_WORKER_URL in worker validation | **Open** |
| P4 (review 3): StaleRunSweeper overlap guard | **Open** |
| P5 (review 3): executor internal style | **Open** |
| P6 (review 3): lazy ES client in WorkerRunService | **Open** |
| P7 (review 3): bootstrap chicken-and-egg | **Open** |

---

## What Is Good

### Queue design
`job_runs` is used directly as the queue. `FOR UPDATE SKIP LOCKED` in the tick and `UPDATE ... WHERE state='QUEUED'` in the dispatch poller are the right primitives. No pg-boss, no Cloud Tasks, no dual-write. The skip-locked pattern is correctly used and well-tested.

### Two-service security boundary
User job code runs inside the worker Cloud Run service under a separate IAM identity (`runtime` SA). Untrusted subprocess execution is isolated from the scheduler process at the container boundary. The isolation guard (`WORKER_REQUIRE_RUNTIME_ISOLATION=false` explicitly required in `validateWorkerStartupConfig`) is enforced at startup.

### Three-plane auth design
- **Public API:** PingOne JWKS with OIDC discovery, handles both `client_id` and `azp` claims for PingOne/AIC variants.
- **Internal scheduler/worker:** Google OIDC bearer tokens, service-account email + audience checked.
- **Runtime callbacks:** Same Google OIDC, but specifically the `RUNTIME_SERVICE_ACCOUNT_EMAIL` SA, not the invoker SA.

`productionValidation.js` enforces that `RUNTIME_SERVICE_ACCOUNT_EMAIL` differs from both invoker SAs — a meaningful runtime configuration safety check.

### Transactional tick with savepoints
`SchedulerTickService` wraps the full batch in a single transaction but uses a savepoint per instance. A cron parse failure on one instance does not abort the rest. This is the correct resilience pattern for a batch scheduler.

### Dispatcher backpressure
Self-scheduling `setTimeout` with exponential backoff (`intervalMs × 2^(failures - threshold)`, capped at `maxBackoffMs`). Counter resets on any successful dispatch. No flood of log entries or token fetches during sustained worker outages.

### Stale-RUNNING sweep
`StaleRunSweeper` periodically queries `job_runs` for RUNNING rows older than the threshold, marks them FAILED with `STALE_RUNNING` error code. Per-run errors are isolated — one failure does not stop the sweep. Worker crashes no longer leave runs permanently stuck.

### Artifact trust chain (corrected, SEC-6)
This row previously claimed `approval`/`scan` (stamped `APPROVED`/`CLEAN` unconditionally at upload) combined with hash/generation verification to prevent artifact substitution. That claim didn't hold: `approval`/`scan` were written and later checked by the same code path with no scanner or approval workflow ever in the loop — writing a constant and checking it equals itself is not a trust decision, and a `revoked` flag checked alongside them was never actually settable anywhere in the codebase either. All three fields have been removed (SEC-6) rather than "fixed," since there was no real control there to fix. What actually prevents artifact substitution, independent of that removed ceremony, is unchanged: `WorkerRunService.verifyApprovedArtifact` recomputes the SHA-256 digest against the real downloaded bytes, and `buildExecutionMetadata` pins the GCS object generation — both enforced on every dispatch, neither ever depended on `approval`/`scan`.

### IAM least-privilege
Three service accounts (`scheduler_service`, `runtime`, `deployer`) with tightly scoped grants. The orphaned `worker_task_invoker` SA was removed from Terraform. The deployer SA has object-admin on the Terraform state bucket and the correct roles for `gcloud run deploy`.

### Token management
`TokenManager` single-flights concurrent token refresh via a shared promise, with a 60-second clock-skew buffer. No thundering-herd on expiry under load.

### Test coverage breadth
335 passing tests across 47 files. Core paths — `JobRuntimeExecutor`, `WorkerRunService`, `StaleRunSweeper`, `RunDispatcher`, production validation, and public auth middleware — all have meaningful unit coverage with dependency injection.

---

## What Needs Improvement

### VPC connector is unnecessary overhead

`pgClient.js` uses `@google-cloud/cloud-sql-connector`, which authenticates through the Cloud SQL Admin API with short-lived mTLS certificates. It works equally well against a public IP Cloud SQL instance and does not require VPC routing. The VPC, subnet, Private Service Access peering, and VPC Access Connector (minimum 2 always-on instances, ~$50–100/month) serve no function not already provided by the connector library. Removing them simplifies the networking Terraform by four resources.

### Dual execution paths in `WorkerRunService` are hard to keep in sync

`WORKER_EXECUTION_MODE=isolated` is required in production. The `local` path is needed for development. Both paths share `WorkerRunService` but diverge in artifact download order, isolation gate, concurrency tracking (`this.localRunning`), and audit event structure. This is approximately 200 lines of service code that must track the production path but is never exercised in production. The local path should be retained for the dev loop, but the divergence should be documented and ideally behind a clear abstraction to prevent silent drift.

### `validateWorkerStartupConfig` requires a variable the worker doesn't use

`RUNTIME_WORKER_URL` is in the worker's required startup set but is the URL the scheduler uses to reach the worker — the worker process itself never references it. The worker won't start in any environment where this variable is absent, even though it has zero effect on worker behavior. Remove it from `validateWorkerStartupConfig`; it belongs only in `validateProductionStartupConfig`.

### `StaleRunSweeper._sweep()` has no overlap guard

`RunDispatcher._pass()` uses a `_running` flag to prevent concurrent invocations. `StaleRunSweeper._sweep()` does not. Under PG pool saturation, a sweep can outlast its interval and produce two concurrent sweeps. The `markFailed` call is idempotent (guarded by `WHERE state = 'RUNNING'`), so this is safe in practice, but the inconsistency is worth resolving.

### `jobRuntimeExecutor.js` internal methods are minified one-liners

The constructor and public interface are readable. Internal methods including `_spawnEntrypoint` (child process lifecycle, timeout, stdout/stderr capture, force-kill), `parseResult`, `validateExecuteRequest`, and `writeContextFile` are single-line dense code. `_spawnEntrypoint` in particular is the highest-risk method in the codebase — it manages async state across multiple event listeners — and should be as readable as possible for review and debugging.

### Bootstrap chicken-and-egg problem on fresh deploy

The worker Cloud Run service URL is unknown until after `terraform apply`. The scheduler's `WorkerServiceRuntimeLauncher` and the deploy script both need it. This requires a manual two-phase deploy process on first rollout, which is documented but operationally fragile. Feeding the worker URL Terraform output into Cloud Build substitutions would close this gap.

### `schedule.js` error message references a development phase

`src/utils/schedule.js` line 5: `throw new Error("Only cron schedules are supported in Phase 4")`. This stale development-phase label is in production code and will appear in user-facing error responses if a non-cron schedule type is submitted.

### `jobDefinitionSchema.js` `timeoutSeconds` maximum silently disagrees with the executor

The Zod schema allows `timeoutSeconds` up to 3600 seconds. `JobRuntimeExecutor.DEFAULT_MAX_TIMEOUT_SECONDS` is 1800. A definition that declares `timeoutSeconds: 3600` will pass schema validation, be stored in Elasticsearch, and be silently capped at 1800 at execution time. The schema max should match the executor cap, or the cap should be surfaced as a validation error at definition-creation time.

### No pagination on run history

`GET /runs?instanceId=...` is capped at 200 results with no cursor or offset. Instances with long histories silently return a truncated result set.

---

## What Is Bad

### `cloudbuild.yaml` has three production deployment bugs

**Bug 1 — worker deploys with `WORKER_EXECUTION_MODE=local` (line 125).** The worker service is an HTTP server that accepts `/execute` requests and runs job subprocesses. `WORKER_EXECUTION_MODE` is not a variable the worker process reads — it is the scheduler's variable for controlling how it dispatches. Passing it to the worker is harmless for the worker, but it signals the script was written under a misunderstanding of which service reads which variable. More importantly, this is the canonical deploy script that operators will follow.

**Bug 2 — scheduler deploy reads a deleted Terraform output (line 139).** `WORKER_INVOKER_SA=$$(jq -r '.worker_task_invoker_email.value' "$$OUT")` reads `worker_task_invoker_email` from the Terraform output JSON. That output was deleted when the `worker_task_invoker` SA was removed. `jq` will return the string `"null"`, and the deploy will set `WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL=null` on the scheduler Cloud Run service. The scheduler's `productionValidation.js` checks this variable is non-empty, so the scheduler will fail to start after every Cloud Build deploy. This is a live production-breaking bug on the next deploy.

**Bug 3 — worker deploy omits `WORKER_REQUIRE_RUNTIME_ISOLATION=false`.** `validateWorkerStartupConfig()` requires this variable to be explicitly set to `"false"`. The Terraform `worker_service.tf` sets it correctly. But `cloudbuild.yaml`'s `--set-env-vars` fully replaces the Cloud Run env (it does not merge), so the variable set by Terraform is wiped on every Cloud Build deploy. The worker will fail `validateWorkerStartupConfig` and refuse to start until an operator manually re-sets the env var. This is a production-breaking bug on every Cloud Build deploy.

### `workerApp.js` drops execution failures silently

When `executor.execute()` fails (line 57), the error is logged to `console.error` and the promise resolves. The scheduler service already transitioned the run to RUNNING before dispatching. The worker never calls `/complete` (there is no completion callback in `workerApp.js`). The run stays RUNNING until the stale sweeper marks it FAILED after the full threshold (default 31 minutes). Any job execution failure in the worker — timeout, non-zero exit, zip extraction error — produces a 31-minute silent delay before the failure is recorded. The worker should call the `/complete` callback with a failure payload when `executor.execute()` rejects.

### ES readiness is invisible to the health endpoint

Every dispatch goes through `WorkerRunService.buildExecutionMetadata()`, which calls `esClient.get()` to fetch the job definition from Elasticsearch. If ES is down, every dispatch fails. The scheduler's `/health` and `/ready` endpoints return `{ status: "ok" }` regardless of ES connectivity. An operator watching the health endpoint will see green while all runs are silently failing. ES should be probed in the readiness check, and ES-down vs worker-down should be distinguishable in logs (they currently produce the same dispatcher backoff behavior).

### `workerRunService.js` initializes the ES client eagerly in the constructor default

`constructor({ esClient = createEsClient(), ... })` — the default parameter fires `createEsClient()` at class instantiation time, which reads `ES_ENDPOINT`/`ES_API_KEY` from the environment. Any code path that constructs `WorkerRunService` without injecting a mock will trigger real ES client initialization. In tests this is silent; in environments without `ES_ENDPOINT` set it throws at construction. The `definitionsIndex` getter already uses lazy initialization; the ES client should follow the same pattern.

### `cloudbuild.yaml` scheduler deploy reads `SCHEDULER_OIDC_AUDIENCE=${_SERVICE_URL}` but the audience is the scheduler URL, not the worker URL

Both `WORKER_OIDC_AUDIENCE` and `SCHEDULER_OIDC_AUDIENCE` are set to `${_SERVICE_URL}`, which is the scheduler's Cloud Run service URL. `WORKER_OIDC_AUDIENCE` should be the worker service URL (the audience the worker's OIDC verifier checks), not the scheduler URL. With both set to the same value, a OIDC token minted for the scheduler can be replayed against the worker's internal routes, breaking the intended SA-per-route isolation.

### Python jobs receive no broker URL — IGA API calls will fail

`jobRuntimeExecutor.executePythonEntrypoint()` (line 199) checks `process.env.IGA_BROKER_URL` to inject the broker URL into the child process env. But `IGA_BROKER_URL` is never set in the parent process — only `RUNTIME_BROKER_URL` is. The Node job path at line 177 correctly maps `RUNTIME_BROKER_URL → IGA_BROKER_URL`. The Python path uses the wrong source variable and will always inject nothing. Every Python job that calls the IGA API through the broker will fail with a missing broker URL.

### `CANCELLING` runs are never swept

`StaleRunSweeper.listStaleRunningIds()` queries only `WHERE state = 'RUNNING'`. When a RUNNING job is cancelled, it transitions to CANCELLING via `RunControlService.cancelRun()`, which then calls `cancelRuntimeExecution()`. In the production path, `WorkerServiceRuntimeLauncher.cancel()` returns `{ status: "unsupported" }` — the Cloud Run container cannot be remotely terminated. The run sits in CANCELLING indefinitely unless the worker eventually calls `/complete`. There is no sweep, no timeout, and no operator-visible indication beyond the CANCELLING state. Runs cancelled while RUNNING will never resolve without manual database intervention.

---

## Prioritised Action List

| Priority | Action | Impact | Effort |
|---|---|---|---|
| P0 | Fix `cloudbuild.yaml` Bug 2 — replace `worker_task_invoker_email` output reference with the correct `scheduler_tick_invoker_email` or a dedicated invoker variable | Production: scheduler will not start after next Cloud Build deploy | Minutes |
| P0 | Fix `cloudbuild.yaml` Bug 3 — add `WORKER_REQUIRE_RUNTIME_ISOLATION=false` to worker `--set-env-vars` | Production: worker will not start after next Cloud Build deploy | Minutes |
| P0 | Fix `cloudbuild.yaml` audience bug — set `WORKER_OIDC_AUDIENCE` to the worker service URL, not the scheduler URL | Security: prevents OIDC token replay across services | Minutes |
| P0 | Fix Python broker URL — change `process.env.IGA_BROKER_URL` to `process.env.RUNTIME_BROKER_URL` in `executePythonEntrypoint()` | Correctness: all Python jobs that call the IGA API are currently broken | Minutes |
| P1 | Fix worker silent failure — have `workerApp.js` call `/complete` (via `RUNTIME_BROKER_URL`) with a failure payload when `executor.execute()` rejects | Operational: reduces failure visibility delay from 31 minutes to seconds | Hours |
| P1 | Fix CANCELLING stuck state — extend `StaleRunSweeper` to also sweep CANCELLING runs older than threshold | Operational: cancelled RUNNING jobs are currently permanent without manual DB intervention | Hours |
| P2 | Fix pre-existing test failures — triage and resolve 14 failing tests on `master` | Restore unambiguous green test signal | Hours |
| P3 | Add ES readiness probe — include ES connectivity in `/health` and `/ready` | Operational: ES outage becomes visible in monitoring before all runs fail | Hours |
| P4 | Remove VPC connector — move Cloud SQL to public IP + IAM auth (connector library already handles this) | Cost and complexity: removes ~$50–100/month and four Terraform resources | Day |
| P5 | Remove `RUNTIME_WORKER_URL` from `validateWorkerStartupConfig` required list | Correctness: worker should not fail to start because of a scheduler-only variable | Minutes |
| P6 | Fix `timeoutSeconds` schema max — align `jobDefinitionSchema.js` max (3600) with executor cap (1800) | Correctness: silent truncation at execution time | Minutes |
| P7 | Fix `schedule.js` error message — remove "Phase 4" reference | Code quality: stale dev language in a user-facing error message | Minutes |
| P8 | Lazy-initialize ES client in `WorkerRunService` constructor | Code quality: decouples construction from environment availability | Minutes |
| P9 | Add `_running` overlap guard to `StaleRunSweeper._sweep()` | Correctness: prevent redundant concurrent sweeps under PG saturation | Minutes |
| P10 | Reformat `jobRuntimeExecutor.js` internal methods — expand minified one-liners | Maintainability: highest-risk methods in the codebase should be readable | Hours |
| P11 | Resolve bootstrap chicken-and-egg — feed worker URL Terraform output into Cloud Build substitutions | Operational: removes manual two-phase deploy requirement | Hours |
