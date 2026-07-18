# Bug Log

Source: technical/functional review of `main` @ `e8ef9fb`, four passes.
Scope constraints under review: ES = job definitions + audit only (Postgres owns run/instance coordination); single-tenant (multi-tenancy dropped).

Verification legend:
- **Verified** — reproduced or confirmed by reading both sides of the interface / by execution in this review.
- **By inspection** — read in code, not executed.

Priority legend:
- **P0** — exploitable breach of a trust boundary, or silent incorrect governance outcome. Fix before next deploy.
- **P1** — availability loss, data/audit integrity gap, or missing change-control on identity-affecting code.
- **P2** — correctness edge, operational footgun, hardening.
- **P3** — dead mechanism / cleanup; no runtime consequence.

| ID | Pri | Title | Area | Verify | Status |
|----|-----|-------|------|--------|--------|
| SEC-1 | P0 | IGA client secret injected into untrusted job subprocess env | Security / credential boundary | Verified | **Resolved** — PR #52 (`ea8dbc7`), ADR 0006 |
| SEC-2 | P0 | `secretRef` resolution has no allowlist — jobs can read platform secrets | Security / credential boundary | Verified | **Resolved (app-layer)** — PR #54, ADR 0007. Soft control: IAM follow-on (scoped resolver SA) still open |
| SEC-3 | P0 | Completion endpoint accepts runtime SA; any job can forge any run's result | Security / audit integrity | Verified | Open |
| SEC-4 | P1 | Same-UID co-residency: job subprocess can read broker `/proc/1/environ` | Security / isolation | By inspection | Open — the SEC-1 fix removes the IGA secret from the worker's own env so there's nothing for a co-residency read to find there, but SEC-4 itself (the read primitive) is unaddressed; other worker secrets (e.g. `DB_PASSWORD`) remain readable this way until SEC-4 is fixed |
| COR-1 | P1 | No fencing token: a ghost subprocess can complete a re-dispatched run | Correctness / concurrency | By inspection | Open |
| COR-2 | P1 | Cancellation records CANCELLED while side effects fully execute | Correctness / audit integrity | Verified | Open |
| COR-3 | P1 | Definition version hardcoded to 1; re-upload swaps code under a pinned version | Change control | Verified | Open |
| AVL-1 | P1 | Worker runs jobs as fire-and-forget subprocess; killed on every deploy/scale-in | Availability / lifecycle | By inspection | Open |
| AVL-2 | P1 | ES on the dispatch hot path; ES blip permanently fails in-flight dispatches | Availability | By inspection | Open |
| AVL-3 | P1 | Scheduler service lacks always-on CPU; dispatch/sweep loops stall to tick cadence | Availability | Verified | Open |
| CIP-1 | P1 | CI runs no tests | CI / process | Verified | Open |
| SEC-5 | P2 | `publicAuth` trusts JWT-header `alg`, nullifying algorithm allowlist | Security / defense-in-depth | By inspection | Open |
| COR-4 | P2 | No automatic retry despite full retry-classification machinery | Correctness | By inspection | Open |
| COR-5 | P2 | Stale sweeper keys off `started_at`, not `heartbeat_at`; hard job ceiling | Correctness | By inspection | Open |
| COR-6 | P2 | Misfire policy replays every missed occurrence after an outage | Correctness | By inspection | Open |
| COR-7 | P1 | Definition delete does not cascade; orphaned instances fail-loop forever | Correctness | Verified | Open |
| CIP-2 | P2 | Test suite not hermetic; PG store tests skip silently without a database | CI / test integrity | Verified | Open |
| SEC-6 | P2 | Self-asserted approval/scan presented as a trust chain | Security / control theatre | Verified | Open |
| OPS-1 | P2 | GCS bucket missing `public_access_prevention = "enforced"` | Hardening | Verified | Open |
| SCA-1 | P2 | Pipeline throughput ceiling well below data-layer capacity | Scalability | By inspection | Open |
| DBT-1 | P3 | Dead tenancy plumbing (`tenant_id`, `tenantId`) after multi-tenancy dropped | Cleanup | By inspection | Open |
| DBT-2 | P3 | `dispatch_id` written but never read (fixing COR-1 activates it) | Cleanup | By inspection | Open |

---

## P0

### SEC-1 — IGA client secret injected into untrusted job subprocess env — **Resolved**
**Where:** `src/services/jobRuntimeExecutor.js:177-181, 199-203`; `cloudbuild.yaml:130` (mounts `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` into the worker service).
**What:** The Node and Python spawn paths spread `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` from the worker env into the job subprocess env. The broker IGA proxy (`RuntimeIgaProxyService`) — with its RUNNING-state gate and per-request audit — is bypassable: a malicious artifact reads the secret from its own environment and calls IGA directly, unaudited, ungated. The client-credentials grant is not tied to run lifecycle, so the access is durable.
**Blast radius:** Any caller holding a token with the upload scope obtains standing IGA-tenant access.
**Fix:** Remove the five `IGA_*` spread lines from both spawn paths; stop mounting `IGA_CLIENT_SECRET` into the worker service in `cloudbuild.yaml`. The SDK already prefers `IGA_BROKER_URL`; direct creds are labelled a local-dev fallback in `src/sdk/scheduler-sdk.js:234` and should never be present in production.
**Note:** `docs/architecture-review.md` lists the "trust gate" as Fixed; that refers to the approval/scan fields (see SEC-6), which is a separate and weaker control. This env-injection path is not addressed by that item.
**Resolution:** Fixed in PR #52 (`ea8dbc7`, squash of `71d3825`). The four direct-credential spreads were removed from both `executeNodeEntrypoint` and `executePythonEntrypoint`; `IGA_BROKER_URL` remains. The worker's Cloud Run deploy step no longer sets `IGA_TOKEN_ENDPOINT`/`IGA_BASE_URL` as env vars or mounts `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` as secrets; the scheduler deploy step is unchanged. `validateWorkerStartupConfig` no longer requires the four IGA vars. Regression tests in `test/job-runtime-executor.test.js` assert the subprocess env excludes the credentials while still receiving `IGA_BROKER_URL`, for both runtimes. See `docs/adr/0006-iga-credential-boundary.md`. **Cross-note:** this fix removes the IGA secret from the worker's own environment, but SEC-4 (co-residency `/proc/1/environ` read) remains open — until it's fixed, a job can still read whatever *other* secrets a co-resident worker process holds.

### SEC-2 — `secretRef` resolution has no allowlist — **Resolved (app-layer)**
**Where:** `src/services/secretManagerParameterResolver.js:36-50`.
**What:** `toSecretVersionName` accepts any `projects/.../secrets/...` resource name or any bare secret name in the project. Resolution runs in the broker under the scheduler SA, which holds `secretAccessor` on the platform's own secrets (`iga-scheduler-db-password`, `iga-scheduler-iga-client-secret`, `iga-scheduler-es-api-key` — per-resource bindings in `terraform/service_accounts.tf`). An authenticated caller creates an instance with a sensitive parameter `secretRef: "iga-scheduler-db-password"`; the broker resolves the plaintext into the job's context file; the job reads it.
**Independence:** Survives the SEC-1 fix — a distinct path to the same secrets.
**Fix:** Constrain `toSecretVersionName` to a dedicated prefix (e.g. `job-params-*`), or resolve job parameters under a separate SA scoped to job-parameter secrets only.
**Resolution:** `toSecretVersionName` now parses both `secretRef` forms down to a concrete secret id before any check runs (so the fully-qualified form can no longer bypass a prefix check), refuses a fixed denylist of the five known platform secret ids unconditionally, and otherwise requires the id to start with `SECRET_PARAM_PREFIX` (default `job-param-`); cross-project fully-qualified refs are refused. No `accessSecretVersion` call is made on a refused id. See `docs/adr/0007-job-parameter-secret-allowlist.md`. **This is a soft control**: the resolving SA's IAM grant is unchanged and still holds `secretAccessor` on the platform secrets — the enforced version of this boundary (a separate resolver identity scoped to job-parameter secrets only) is a tracked follow-on, not done here.

### SEC-3 — Completion endpoint accepts runtime SA; jobs are runtime SA
**Where:** `src/routes/internalWorker.js:10-12` (`completionAuth` fallback chain puts `RUNTIME_SERVICE_ACCOUNT_EMAIL` first); `POST /internal/job-runs/:runId/complete`.
**What:** Job subprocesses mint OIDC tokens from the metadata server as the runtime SA (the SDK does this for the IGA proxy). The completion route accepts that principal, so any job can complete **any** RUNNING run with an arbitrary result payload. Run IDs are deterministic (`instanceId:scheduledFireTime`, `src/utils/runId.js`), so targets are guessable. In production nothing legitimate calls this route — the worker writes PG directly via `onExecutionSuccess`/`onExecutionError` (`src/workers/app.js`) — so it is an armed, unused door.
**Blast radius:** Result-integrity forgery; severe if run results feed downstream governance decisions.
**Fix:** Remove the route, or stop accepting the runtime SA on it (require a principal that job code cannot assume).

---

## P1

### SEC-4 — Same-UID co-residency
**Where:** `runtime-containers/worker/Dockerfile` (`USER node`); jobs spawned in-process by `JobRuntimeExecutor`.
**What:** Broker/worker and all job subprocesses share UID `node`. A job can read `/proc/1/environ` (`DB_PASSWORD`, IGA creds, ES key) and signal siblings. The Terraform comment "Cloud Run container boundary is the isolation layer" holds only for job↔other-service; the boundaries that matter (job↔platform-secrets, job↔job) are inside the container. Single-tenancy softens job↔job but not job↔platform-secrets.
**Fix:** Run jobs under a distinct unprivileged UID with no read access to the server process env, or move to container-per-job (see AVL-1 fix). Interacts with SEC-1/SEC-2: even with those fixed, `/proc` access re-exposes any secret the server holds.

### COR-1 — No fencing token on claim/complete
**Where:** `src/stores/runStore.js` (`claimRun`, `markSucceeded`, `markFailed` guard on `state='RUNNING'` only); `dispatch_id` generated in `src/services/runControlService.js` but never checked.
**What:** Sweeper (or SEC-3 forgery) flips a still-alive run to FAILED → operator retries → re-claimed, RUNNING again → the original subprocess finishes and marks the retry's attempt SUCCEEDED with the original result. The overlap is real because the sweeper only flips state; it kills no process (see AVL-1).
**Fix:** Thread `dispatch_id` as a fencing token: `... WHERE run_id=$1 AND state='RUNNING' AND dispatch_id=$2`. Activates DBT-2.

### COR-2 — Cancellation loses real outcomes
**Where:** `src/services/runControlService.js:40-52`; `WorkerServiceRuntimeLauncher.cancel()` returns `{status:"unsupported"}`.
**What:** Cancel on RUNNING flips to CANCELLING; the launcher can't stop the subprocess; it runs to completion; its completion no-ops (state ≠ RUNNING); the sweeper force-cancels at the threshold. Record says CANCELLED while side effects — IGA writes included — fully happened.
**Fix:** Implement real cancellation (pull-worker model makes this a claim-check the worker honors), or remove the CANCELLING state and document that cancel only prevents not-yet-started runs.

### COR-3 — Definition version is a facade
**Where:** `src/services/jobDefinitionService.js:28` (`const version = 1`); never incremented. Consumer side fully built: instances pin `definitionVersion`; dispatch enforces `DEFINITION_VERSION_MISMATCH` (`src/services/workerRunService.js:389`).
**What:** The only way to update job code is delete + re-POST the same `definitionId`, which returns version 1 again — so pinned instances execute different code under the same pinned version. The digest changes in `jobZip.sha256` (forensically reconstructable), but the pinning mechanism designed to catch this is blind to it.
**Fix:** Increment version on re-upload (digest-keyed GCS paths already allow coexisting artifacts), or remove the pinning fields so nothing falsely relies on them.

### COR-7 — Definition delete does not cascade
**Where:** `src/services/jobDefinitionService.js:151-163` (marks ES doc DELETED); instances left ACTIVE.
**What:** Every subsequent fire creates a run that permanently fails at dispatch (`DEFINITION_NOT_ACTIVE`, non-retryable) — a failed-run generator on every cron interval until someone manually pauses instances.
**Fix:** On delete, pause or refuse while active instances reference the definition (the instance-by-definition listing already exists).

### AVL-1 — Worker execution model fights Cloud Run lifecycle
**Where:** `src/workers/workerApp.js:55` (202 + background subprocess); `terraform/worker_service.tf` (`timeout` comment misattributes drain protection).
**What:** Cloud Run gives ~10s SIGTERM grace; `maxDrainMs` (~1830s) is unachievable. Every deploy/scale-in kills in-flight jobs, which sit RUNNING until the sweeper fails them (up to the threshold). Fast 202s also break autoscaling signal (request concurrency ≈ 0), and there is no worker-side concurrency cap — `maxLocalConcurrency` lives in `WorkerRunService`, which the worker service does not use. Python jobs get no memory cap (`resolveSpawnCommand` sets `--max-old-space-size` for Node only).
**Fix (strategic):** Move to pull-worker (worker polls `job_runs` for QUEUED with `FOR UPDATE SKIP LOCKED`), or Cloud Run Jobs per run for real per-job isolation and task timeouts. Either deletes the `/execute` hop and this whole failure class.

### AVL-2 — ES on the dispatch hot path
**Where:** `WorkerRunService.buildExecutionMetadata` fetches the definition from ES per dispatch; failure → `markFailed`, no auto-retry (COR-4).
**What:** Contradicts the ES-out-of-coordination constraint; an ES blip permanently fails every dispatch during it.
**Fix:** Snapshot artifact metadata (uri, sha256, generation, entrypoint, runtime) into the run row at tick time; the row already pins `definition_version`.

### AVL-3 — Scheduler service background loops not guaranteed CPU
**Where:** `cloudbuild.yaml` scheduler deploy step lacks `--min-instances`/`--no-cpu-throttling` (the worker step at :127-128 has both).
**What:** Dispatcher 5s poll and sweeper execute only during request handling → degrade to once-per-minute tick cadence; the service can scale to zero, making the control loop's liveness depend on incidental traffic.
**Fix:** Add `--min-instances=1 --no-cpu-throttling` to the scheduler deploy, or externalize the loops.

### CIP-1 — CI runs no tests
**Where:** `cloudbuild.yaml` (terraform → docker build → migrate → deploy; no test step). `npm test` exists only as a CLAUDE.md session rule.
**What:** No mechanical gate between a regression and production — acute given how much of this system is state-machine correctness.
**Fix:** Add a test step before image build; fail the build on non-zero. Depends on CIP-2 for reliability.

---

## P2

### SEC-5 — `publicAuth` trusts JWT-header `alg`
**Where:** `src/middleware/publicAuth.js` (`algorithms:[alg]` read from `decodeProtectedHeader`).
**What:** Not practically exploitable via jose + remote JWKS (asymmetric keys only, `none` rejected), but it nullifies the allowlist as defense-in-depth.
**Fix:** Pin expected algorithms (e.g. `["RS256","ES256"]`).

### COR-4 — No automatic retry
**Where:** `retryClassifier` computes `retryable`, recorded and audited; nothing requeues.
**What:** Transient worker/GCS/ES failures become permanent FAILED requiring manual retry. The classification is currently decorative.
**Fix:** On retryable classification, requeue with attempt increment and a backoff cap.

### COR-5 — Sweeper keys off `started_at`, not heartbeat
**Where:** `src/stores/runStore.js` (`listStaleRunningIds`/`listStaleCancellingIds` use `started_at`); `heartbeat_at` written but unread.
**What:** Hard ceiling ~= threshold from start; a job configured near `WORKER_MAX_TIMEOUT_SECONDS` races the sweeper within the grace window. (`timeoutSeconds` is schema-capped at 1800, so the 30-min ceiling is enforced policy — the finding is that legitimate long IGA jobs can't be configured, plus the near-boundary race.)
**Fix:** Sweep on heartbeat staleness and have the worker heartbeat; raise the cap for reconciliation workloads.

### COR-6 — Misfire policy replays everything
**Where:** `SchedulerTickService.tick` advances `nextFireAt` one step per tick.
**What:** After an outage, every missed occurrence fires — a herd of stale runs.
**Fix:** Add a "skip to next valid fire" option per instance; catch up at most once.

### CIP-2 — Test suite not hermetic
**Where:** Full run: 392 tests, 12 env-coupling failures (config/middleware read `process.env` at construction), 28 skipped. PG store tests skip without a local database.
**What:** "npm test before done" silently depends on the developer's shell; the concurrency-critical SQL is the least-exercised code whenever PG is absent.
**Fix:** vitest setup file to seed required env; CI Postgres service so store tests run instead of skip.

### SEC-6 — Approval/scan is self-asserted
**Where:** `src/services/jobDefinitionService.js:57-66` stamps `APPROVED`/`CLEAN` unconditionally; `src/services/workerRunService.js:357-362` validates fields the same path always writes.
**What:** Ceremony that resembles a control. (`docs/architecture-review.md` marks this "Fixed" as the P0 trust gate — I disagree: writing constants and checking they equal the constants is not a trust decision. Flagging the disagreement rather than overriding the doc.)
**Fix:** Wire a real scanner/approval workflow, or drop the fields to avoid false assurance.

### OPS-1 — GCS bucket hardening
**Where:** `terraform/storage.tf` (uniform access + versioning present; `public_access_prevention` absent).
**Fix:** Add `public_access_prevention = "enforced"`.

### SCA-1 — Pipeline throughput ceiling
**Where:** tick (≤100/min, single txn), dispatch (10 per 5s, serial awaits w/ ES fetch each), execution (≤10 worker instances, no per-instance cap).
**What:** Data layer handles thousands of instances / millions of runs trivially; the push pipeline cannot. Top-of-hour cron clustering makes 1000+ simultaneously-due instances take ~10 min just to create runs, longer to dispatch, beyond worker concurrency.
**Fix:** Parallelize dispatch and adopt pull-worker (AVL-1); raise batch sizes. Structural ceiling is the push-to-shared-container model.

---

## P3

### DBT-1 — Dead tenancy plumbing
**Where:** `tenant_id` columns (`migrations/001_scheduler_core.sql`); `tenantId` throughout services and `buildRunId`.
**What:** Half-implemented tenancy after multi-tenancy was dropped invites the belief it works.
**Fix:** Remove, or document explicitly as reserved-and-unenforced.

### DBT-2 — `dispatch_id` written, never read
**Where:** schema + `runControlService`; no read site.
**What:** Fixing COR-1 gives it a purpose; until then it is dead.
