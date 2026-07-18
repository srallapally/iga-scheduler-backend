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
| SEC-2 | P0 | `secretRef` resolution has no allowlist — jobs can read platform secrets | Security / credential boundary | Verified | **Resolved (app-layer)** — PR #54 (`5fbc4a6`), ADR 0007. Soft control: IAM follow-on (scoped resolver SA) still open |
| SEC-3 | P0 | Completion endpoint accepts runtime SA; any job can forge any run's result | Security / audit integrity | Verified | **Resolved** — PR #55 (`619b083`), ADR 0008. Route removed; sibling-route principal concern remains a separate follow-on |
| SEC-4 | P1 | Same-UID co-residency: job subprocess can read broker `/proc/1/environ` | Security / isolation | By inspection | **Partially resolved** — PR #57, ADR 0009. DB password moved to Secret Manager fetch (no env-var secrets left to leak via `/proc/1/environ` today); job-UID separation (`gosu`/`jobrunner`) still required — AVL-1's residual was resolved via pull-worker, not container-per-job, so all jobs still share one container/UID and this gap is not superseded |
| COR-1 | P1 | No fencing token: a ghost subprocess can complete a re-dispatched run | Correctness / concurrency | **Verified** (reproduced against a real Postgres) | **Resolved** — this PR, ADR 0014 |
| COR-2 | P1 | Cancellation records CANCELLED while side effects fully execute | Correctness / audit integrity | Verified | **Resolved** — this PR, ADR 0015. Real cancellation implemented (not just documented as a gap) |
| COR-3 | P1 | Definition version hardcoded to 1; re-upload swaps code under a pinned version | Change control | Verified | **Resolved** — this PR, ADR 0013. `LocalDefinitionService` has the same pattern, left untouched (local-dev only) |
| AVL-1 | P1 | Worker runs jobs as fire-and-forget subprocess; killed on every deploy/scale-in | Availability / lifecycle | Verified | **Resolved** — hardening subset (PR #73, ADR 0017) + strategic rework (this PR, ADR 0019: pull-worker execution model). SEC-4's UID separation is still open — pull-worker does not close it |
| AVL-2 | P1 | ES on the dispatch hot path; ES blip permanently fails in-flight dispatches | Availability | Verified | **Resolved** — this PR, ADR 0016. COR-4 (dead retry-classification machinery) remains a separate, unaddressed gap |
| AVL-3 | P1 | Scheduler service lacks always-on CPU; dispatch/sweep loops stall to tick cadence | Availability | Verified | **Resolved** — this PR, ADR 0011 |
| CIP-1 | P1 | CI runs no tests | CI / process | Verified | **Resolved** — this PR, ADR 0010. CIP-2 (hermetic PG-backed CI so the 28 skipped tests run) remains a separate follow-on |
| SEC-8 | P1 | Production guardrails fail open: all prod validation is gated on `NODE_ENV === "production"`; drift silently disables isolation/DB-engine checks | Security / defense-in-depth | Verified | **Resolved** — this PR, ADR 0022 |
| SEC-5 | P2 | `publicAuth` trusts JWT-header `alg`, nullifying algorithm allowlist | Security / defense-in-depth | By inspection | **Resolved** — this PR, ADR 0020 |
| COR-4 | P2 | No automatic retry despite full retry-classification machinery | Correctness | By inspection | Open |
| COR-5 | P2 | Stale sweeper keys off `started_at`, not `heartbeat_at`; hard job ceiling | Correctness | By inspection | Open |
| COR-6 | P2 | Misfire policy replays every missed occurrence after an outage | Correctness | By inspection | Open |
| COR-7 | P1 | Definition delete does not cascade; orphaned instances fail-loop forever | Correctness | Verified | **Resolved** — this PR, ADR 0012 |
| CIP-2 | P2 | Test suite not hermetic; PG store tests skip silently without a database | CI / test integrity | Verified | Open |
| SEC-6 | P2 | Self-asserted approval/scan presented as a trust chain | Security / control theatre | Verified | **Resolved** — this PR, ADR 0021. Fields dropped rather than backed by a real workflow |
| SEC-7 | P2 | IGA proxy does not bind caller to run; audit attribution forgeable across concurrent runs | Security / audit integrity | Verified | **Resolved** — this PR, ADR 0018 |
| OPS-1 | P2 | GCS bucket missing `public_access_prevention = "enforced"` | Hardening | Verified | Open |
| SCA-1 | P2 | Pipeline throughput ceiling well below data-layer capacity | Scalability | By inspection | Open |
| DBT-1 | P3 | Dead tenancy plumbing (`tenant_id`, `tenantId`) after multi-tenancy dropped | Cleanup | By inspection | Open |
| DBT-2 | P3 | `dispatch_id` written but never read (fixing COR-1 activates it) | Cleanup | By inspection | **Resolved by COR-1** — `dispatch_id` is now read and enforced, see COR-1's entry and ADR 0014 |

---

## P0

### SEC-1 — IGA client secret injected into untrusted job subprocess env — **Resolved**
**Where:** `src/services/jobRuntimeExecutor.js:177-181, 199-203`; `cloudbuild.yaml:130` (mounts `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` into the worker service).
**What:** The Node and Python spawn paths spread `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` from the worker env into the job subprocess env. The broker IGA proxy (`RuntimeIgaProxyService`) — with its RUNNING-state gate and per-request audit — is bypassable: a malicious artifact reads the secret from its own environment and calls IGA directly, unaudited, ungated. The client-credentials grant is not tied to run lifecycle, so the access is durable.
**Blast radius:** Any caller holding a token with the upload scope obtains standing IGA-tenant access.
**Fix:** Remove the five `IGA_*` spread lines from both spawn paths; stop mounting `IGA_CLIENT_SECRET` into the worker service in `cloudbuild.yaml`. The SDK already prefers `IGA_BROKER_URL`; direct creds are labelled a local-dev fallback in `src/sdk/scheduler-sdk.js:234` and should never be present in production.
**Note:** `docs/architecture-review.md` listed the "trust gate" as Fixed at the time; that referred to the approval/scan fields, a separate and (per SEC-6, since resolved by removing those fields entirely) weaker control than it claimed. This env-injection path was never addressed by that item either way.
**Resolution:** Fixed in PR #52 (`ea8dbc7`, squash of `71d3825`). The four direct-credential spreads were removed from both `executeNodeEntrypoint` and `executePythonEntrypoint`; `IGA_BROKER_URL` remains. The worker's Cloud Run deploy step no longer sets `IGA_TOKEN_ENDPOINT`/`IGA_BASE_URL` as env vars or mounts `IGA_CLIENT_ID`/`IGA_CLIENT_SECRET` as secrets; the scheduler deploy step is unchanged. `validateWorkerStartupConfig` no longer requires the four IGA vars. Regression tests in `test/job-runtime-executor.test.js` assert the subprocess env excludes the credentials while still receiving `IGA_BROKER_URL`, for both runtimes. See `docs/adr/0006-iga-credential-boundary.md`. **Cross-note:** this fix removes the IGA secret from the worker's own environment, but SEC-4 (co-residency `/proc/1/environ` read) remains open — until it's fixed, a job can still read whatever *other* secrets a co-resident worker process holds.

### SEC-2 — `secretRef` resolution has no allowlist — **Resolved (app-layer)**
**Where:** `src/services/secretManagerParameterResolver.js:36-50`.
**What:** `toSecretVersionName` accepts any `projects/.../secrets/...` resource name or any bare secret name in the project. Resolution runs in the broker under the scheduler SA, which holds `secretAccessor` on the platform's own secrets (`iga-scheduler-db-password`, `iga-scheduler-iga-client-secret`, `iga-scheduler-es-api-key` — per-resource bindings in `terraform/service_accounts.tf`). An authenticated caller creates an instance with a sensitive parameter `secretRef: "iga-scheduler-db-password"`; the broker resolves the plaintext into the job's context file; the job reads it.
**Independence:** Survives the SEC-1 fix — a distinct path to the same secrets.
**Fix:** Constrain `toSecretVersionName` to a dedicated prefix (e.g. `job-params-*`), or resolve job parameters under a separate SA scoped to job-parameter secrets only.
**Resolution:** Fixed in PR #54 (`5fbc4a6`). `toSecretVersionName` now parses both `secretRef` forms down to a concrete secret id before any check runs (so the fully-qualified form can no longer bypass a prefix check), refuses a fixed denylist of the five known platform secret ids unconditionally, and otherwise requires the id to start with `SECRET_PARAM_PREFIX` (default `job-param-`); cross-project fully-qualified refs are refused. No `accessSecretVersion` call is made on a refused id. See `docs/adr/0007-job-parameter-secret-allowlist.md`. **This is a soft control**: the resolving SA's IAM grant is unchanged and still holds `secretAccessor` on the platform secrets — the enforced version of this boundary (a separate resolver identity scoped to job-parameter secrets only) is a tracked follow-on, not done here.

### SEC-3 — Completion endpoint accepts runtime SA; jobs are runtime SA — **Resolved**
**Where:** `src/routes/internalWorker.js:10-12` (`completionAuth` fallback chain puts `RUNTIME_SERVICE_ACCOUNT_EMAIL` first); `POST /internal/job-runs/:runId/complete`.
**What:** Job subprocesses mint OIDC tokens from the metadata server as the runtime SA (the SDK does this for the IGA proxy). The completion route accepts that principal, so any job can complete **any** RUNNING run with an arbitrary result payload. Run IDs are deterministic (`instanceId:scheduledFireTime`, `src/utils/runId.js`), so targets are guessable. In production nothing legitimate calls this route — the worker writes PG directly via `onExecutionSuccess`/`onExecutionError` (`src/workers/app.js`) — so it is an armed, unused door.
**Blast radius:** Result-integrity forgery; severe if run results feed downstream governance decisions.
**Fix:** Remove the route, or stop accepting the runtime SA on it (require a principal that job code cannot assume).
**Resolution:** Fixed in PR #55 (`619b083`). `POST /internal/job-runs/:runId/complete` and `completionAuthMiddleware` are removed from `internalWorker.js`; the route no longer exists (a regression test asserts 404). Sibling routes (`/execute`, `/retry`, `/cancel`, `/redrive`) and their `authMiddleware` are untouched. `WorkerRunService.completeRun` and its unit tests are kept, unchanged, with no route calling it. Run outcomes now have exactly one production path: the worker's direct Postgres writes via `onExecutionSuccess`/`onExecutionError`. See `docs/adr/0008-remove-completion-route.md`. **Follow-on note:** the sibling routes still authenticate via the same implicit env-var fallback chain (`createInternalAuthMiddleware`); whether their accepted principal set is appropriate is a separate, broader finding not addressed here.

---

## P1

### SEC-4 — Same-UID co-residency — **Partially resolved**
**Where:** `runtime-containers/worker/Dockerfile` (`USER node`); jobs spawned in-process by `JobRuntimeExecutor`.
**What:** Broker/worker and all job subprocesses share UID `node`. A job can read `/proc/1/environ` (`DB_PASSWORD`, IGA creds, ES key) and signal siblings. The Terraform comment "Cloud Run container boundary is the isolation layer" holds only for job↔other-service; the boundaries that matter (job↔platform-secrets, job↔job) are inside the container. Single-tenancy softens job↔job but not job↔platform-secrets.
**Fix:** Run jobs under a distinct unprivileged UID with no read access to the server process env, or move to container-per-job (see AVL-1 fix). Interacts with SEC-1/SEC-2: even with those fixed, `/proc` access re-exposes any secret the server holds.
**Resolution (partial):** The planned fix had two coupled parts — (a) run job subprocesses under a distinct `jobrunner` uid via a `gosu` setuid helper, and (b) fetch `DB_PASSWORD` from Secret Manager instead of mounting it as an env var. **(b) is shipped**: `createPgPool` (`src/clients/pgClient.js`) now fetches the password via `resolveCloudSqlPassword`, held only in the pool's local config, never on `process.env`; both the worker and scheduler `cloudbuild.yaml` deploy steps no longer mount `DB_PASSWORD` as a secret. **(a) is deferred**: the plan required verifying `gosu`/setuid actually works under Cloud Run's gVisor sandbox in a real container build before shipping it, and this environment has no Docker daemon and no path to deploy to real Cloud Run to check — shipping it unverified would have violated the plan's own "verify in a real container, don't assert from source" requirement. **Correction (AVL-1's residual landed, see ADR 0019):** this section previously said (a) was "deferred to AVL-1... which makes the question moot structurally," on the assumption AVL-1's strategic rework would be container-per-job. AVL-1 was instead resolved via a pull-worker running as a fixed warm pool — jobs still execute in-process inside the one worker container, sharing its UID exactly as before. (a) is therefore **still required**, not superseded; there is no remaining planned rework that closes it structurally. See `docs/adr/0009-job-uid-and-db-secret-handling.md`. **Residual:** no secret currently mounted as an env var on either service remains readable via `/proc/1/environ` today, but job↔job mutual isolation and protection of any future env-mounted secret both still depend on (a), which remains open with no scheduled fix.

### COR-1 — No fencing token on claim/complete — **Resolved**
**Where:** `src/stores/runStore.js` (`claimRun`, `markSucceeded`, `markFailed` guard on `state='RUNNING'` only); `dispatch_id` generated in `src/services/runControlService.js` but never checked.
**What:** Sweeper (or SEC-3 forgery) flips a still-alive run to FAILED → operator retries → re-claimed, RUNNING again → the original subprocess finishes and marks the retry's attempt SUCCEEDED with the original result. The overlap is real because the sweeper only flips state; it kills no process (see AVL-1).
**Fix:** Thread `dispatch_id` as a fencing token: `... WHERE run_id=$1 AND state='RUNNING' AND dispatch_id=$2`. Activates DBT-2.
**Resolution:** `claimRun` now mints a fresh `dispatch_id` on every successful claim (not just retry/redrive) and returns it; `recordRuntimeExecution`/`markSucceeded`/`markFailed` all accept an optional `dispatchId` and fence their UPDATE on it when provided. The token is threaded through the full dispatch path — claim → `/execute` POST body → worker completion callbacks → `markSucceeded`/`markFailed` — and through the stale-run sweeper's own `markFailed` call. **Verified against a real local Postgres instance** (this sandbox has no Docker daemon, but `psql`/`postgres` were natively available): the exact ghost-completion-after-retry race reproduces and is correctly rejected; the legitimate re-claimed attempt still completes normally. `DBT-2` (`dispatch_id` written but never read) is now activated by this fix. See `docs/adr/0014-dispatch-fencing-token.md`. **Residual:** `LocalRunStore` (SQLite, local dev) is not fenced — consistent with this codebase's established pattern of holding local dev to a simpler bar; `completeRun` (dead code per SEC-3) is also not threaded, since it has no production caller.

### COR-2 — Cancellation loses real outcomes — **Resolved**
**Where:** `src/services/runControlService.js:40-52`; `WorkerServiceRuntimeLauncher.cancel()` returns `{status:"unsupported"}`.
**What:** Cancel on RUNNING flips to CANCELLING; the launcher can't stop the subprocess; it runs to completion; its completion no-ops (state ≠ RUNNING); the sweeper force-cancels at the threshold. Record says CANCELLED while side effects — IGA writes included — fully happened.
**Fix:** Implement real cancellation (pull-worker model makes this a claim-check the worker honors), or remove the CANCELLING state and document that cancel only prevents not-yet-started runs.
**Resolution:** Real cancellation implemented, not the lesser fix. `JobRuntimeExecutor` now tracks each spawned child in a runId-keyed registry and exposes `cancel(runId)`, sending SIGTERM then SIGKILL (after the existing kill-grace period) to the process group. `workerApp.js` exposes this as `POST /cancel/:runId`. `WorkerServiceRuntimeLauncher.cancel()` replaces its `{status:"unsupported"}` stub with a real authenticated call to that route. `RunControlService.cancelRuntimeExecution` no longer gates on the never-populated `runtimeExecution.executionId` field, and — when the worker confirms the kill — immediately transitions CANCELLING → CANCELLED rather than waiting for the sweeper's ~31-minute timeout. `RunControlService` is now constructed once (with a live launcher) and wired into both the internal and public cancel routes, which previously each lazily constructed their own launcher-less instance. See `docs/adr/0015-real-run-cancellation.md`. **Residual:** the sweeper's timeout-based force-cancel remains the backstop for the case where the worker can't confirm the kill (already finished, or worker instance recycled) — unchanged, as intended.

### COR-3 — Definition version is a facade — **Resolved**
**Where:** `src/services/jobDefinitionService.js:28` (`const version = 1`); never incremented. Consumer side fully built: instances pin `definitionVersion`; dispatch enforces `DEFINITION_VERSION_MISMATCH` (`src/services/workerRunService.js:389`).
**What:** The only way to update job code is delete + re-POST the same `definitionId`, which returns version 1 again — so pinned instances execute different code under the same pinned version. The digest changes in `jobZip.sha256` (forensically reconstructable), but the pinning mechanism designed to catch this is blind to it.
**Fix:** Increment version on re-upload (digest-keyed GCS paths already allow coexisting artifacts), or remove the pinning fields so nothing falsely relies on them.
**Resolution:** `createDefinition` now reads any prior document (including soft-deleted) via `getDefinition` before writing, incrementing `version` on re-upload instead of resetting to 1; a genuinely new `definitionId` still uses the atomic `es.create` (409 conflict detection preserved), a re-upload uses `es.index` (full-document upsert). The existing `DEFINITION_VERSION_MISMATCH` check (already correct) can now actually catch a code swap. See `docs/adr/0013-definition-version-increment.md`. **Residual:** `LocalDefinitionService` (local-dev, SQLite-backed) has the identical hardcoded-version pattern and was left untouched, consistent with COR-7's precedent of scoping definition-lifecycle fixes to the production ES-backed service.

### COR-7 — Definition delete does not cascade — **Resolved**
**Where:** `src/services/jobDefinitionService.js:151-163` (marks ES doc DELETED); instances left ACTIVE.
**What:** Every subsequent fire creates a run that permanently fails at dispatch (`DEFINITION_NOT_ACTIVE`, non-retryable) — a failed-run generator on every cron interval until someone manually pauses instances.
**Fix:** On delete, pause or refuse while active instances reference the definition (the instance-by-definition listing already exists).
**Resolution:** `deleteDefinition` now refuses (`DEFINITION_HAS_ACTIVE_INSTANCES`, HTTP 409) when any enabled/`ACTIVE` instance still references the definition, using the existing `listInstancesForDefinition` query — no new query needed. `src/app.js` now wires `instanceStore` into `JobDefinitionService` and passes `jobDefinitionService` into `createApp()` (previously never passed, so the route silently used a bare default with no cascade awareness). See `docs/adr/0012-definition-delete-cascade.md`.

### AVL-1 — Worker execution model fights Cloud Run lifecycle — **Resolved**
**Where:** `src/workers/workerApp.js:55` (202 + background subprocess); `terraform/worker_service.tf` (`timeout` comment misattributes drain protection).
**What:** Cloud Run gives ~10s SIGTERM grace; `maxDrainMs` (~1830s) is unachievable. Every deploy/scale-in kills in-flight jobs, which sit RUNNING until the sweeper fails them (up to the threshold). Fast 202s also break autoscaling signal (request concurrency ≈ 0), and there is no worker-side concurrency cap — `maxLocalConcurrency` lives in `WorkerRunService`, which the worker service does not use. Python jobs get no memory cap (`resolveSpawnCommand` sets `--max-old-space-size` for Node only).
**Fix (strategic):** Move to pull-worker (worker polls `job_runs` for QUEUED with `FOR UPDATE SKIP LOCKED`), or Cloud Run Jobs per run for real per-job isolation and task timeouts. Either deletes the `/execute` hop and this whole failure class.
**Resolution (hardening subset, PR #73):** `createWorkerApp` gained `maxConcurrency` (env `WORKER_MAX_CONCURRENCY`, default 10); Python's `resolveSpawnCommand` gained a real `ulimit -v` memory cap (argv-passed, injection-safe); the Terraform `timeout` comment was corrected. See `docs/adr/0017-worker-hardening-subset.md`.
**Resolution (strategic rework, this PR):** cold-start latency ruled out Cloud Run Jobs per run, so the worker was converted to a pull-worker running as a fixed warm pool instead. `RunStore.claimNextQueued` atomically discovers and claims a batch of QUEUED runs (`FOR UPDATE SKIP LOCKED`, fresh `dispatch_id` per row). The worker's poll loop (`src/workers/pollLoop.js`) claims and executes runs directly against Postgres — no more HTTP push. Execution reuses `WorkerRunService`'s existing in-process pipeline (trust verification, secret resolution, execution-metadata build, all already built for `executionMode: "local"`) via a new `executeClaimedRun` entry point, rather than a new launcher abstraction; `WorkerRunService` now runs inside the worker process instead of the scheduler. A heartbeat loop (`RunStore.touchHeartbeat`, fenced on `dispatch_id`) keeps the sweeper's liveness signal current and detects an operator-requested cancel, invoking `JobRuntimeExecutor.cancel` directly — no HTTP hop either way now. `POST /execute`, `POST /cancel`, `WorkerServiceRuntimeLauncher`, and the scheduler→worker invoker IAM binding are all removed; the worker's HTTP surface is `/health` only. The scheduler's `RunDispatcher` is untouched for local dev (`app.local.js`), just no longer constructed in production. The worker is sized as a fixed warm pool (`worker_pool_size`, one Terraform variable driving both `--min-instances`/`--max-instances`) — a deliberate trade of elastic autoscaling for latency, since a poll loop has no inbound-request signal to scale on. See `docs/adr/0019-pull-worker-execution-model.md`.
**Residual:** Grace-exceeding in-flight jobs on SIGTERM still remain RUNNING rather than being resumed — full survival needs a stale-RUNNING → QUEUED requeue, which is COR-4/COR-5 territory and remains open. SEC-4 (same-container co-residency) is **not** closed by this — pull-worker still executes every job in the one worker container, so job↔job UID separation is unaffected and still required (see SEC-4's corrected entry above). `heartbeat_at` is now actively written by the worker, but COR-5 (the sweeper still keys staleness off `started_at`, not `heartbeat_at`) is unaddressed by this PR — that's a separate, still-open fix.

### AVL-2 — ES on the dispatch hot path — **Resolved**
**Where:** `WorkerRunService.buildExecutionMetadata` fetches the definition from ES per dispatch; failure → `markFailed`, no auto-retry (COR-4).
**What:** Contradicts the ES-out-of-coordination constraint; an ES blip permanently fails every dispatch during it.
**Fix:** Snapshot artifact metadata (uri, sha256, generation, entrypoint, runtime) into the run row at tick time; the row already pins `definition_version`.
**Resolution:** New `job_runs.execution_metadata` jsonb column (migration `002_run_execution_metadata.sql`). `SchedulerTickService` takes an optional `definitionService`; when configured (wired in production `src/app.js`), it fetches the definition once per due instance at tick time and snapshots it onto the run row — a missing/inactive/version-mismatched definition doesn't block run creation, it's still snapshotted as-is so dispatch fails with the same error code as before; only a genuine ES fetch error fails that one instance for that tick (self-healing next tick, since `next_fire_at` wasn't advanced). `WorkerRunService.buildExecutionMetadata` reads the snapshot when present — zero ES calls on the dispatch hot path — falling back to the original live lookup when absent (legacy runs, local dev). See `docs/adr/0016-execution-metadata-snapshot.md`. **Residual:** COR-4 (retry-classification machinery exists but nothing requeues) remains open and unaddressed — a definition-related dispatch failure is still `markFailed` unconditionally either way.

### AVL-3 — Scheduler service background loops not guaranteed CPU — **Resolved**
**Where:** `cloudbuild.yaml` scheduler deploy step lacks `--min-instances`/`--no-cpu-throttling` (the worker step at :127-128 has both).
**What:** Dispatcher 5s poll and sweeper execute only during request handling → degrade to once-per-minute tick cadence; the service can scale to zero, making the control loop's liveness depend on incidental traffic.
**Fix:** Add `--min-instances=1 --no-cpu-throttling` to the scheduler deploy, or externalize the loops.
**Resolution:** `--min-instances=1 --no-cpu-throttling` added to the scheduler's `gcloud run deploy` step in `cloudbuild.yaml`, mirroring the worker step. Deploy-config-only change, no code touched. See `docs/adr/0011-scheduler-min-instances.md`.

### CIP-1 — CI runs no tests — **Resolved**
**Where:** `cloudbuild.yaml` (terraform → docker build → migrate → deploy; no test step). `npm test` exists only as a CLAUDE.md session rule.
**What:** No mechanical gate between a regression and production — acute given how much of this system is state-machine correctness.
**Fix:** Add a test step before image build; fail the build on non-zero. Depends on CIP-2 for reliability.
**Resolution:** A `node:22-slim` test step (`npm ci && npm test`) now runs in `cloudbuild.yaml` right after the Terraform-outputs step and before any Docker build — fails fast, before any image is built/pushed/deployed. The 4 previously-failing tests in `test/worker-execution-metadata.test.js` are fixed: the actual cause was the test's own `serviceWithDefinition` helper omitting `definitionsIndex` (not cross-test env leakage as originally guessed), which made `WorkerRunService`'s lazy `getConfig()` fallback throw in any environment without `GCP_PROJECT_ID`/`JOB_ZIP_BUCKET`/`ES_ENDPOINT`/`ES_API_KEY` set. `npm test` is now fully green (0 failures, 28 pre-existing PG-integration tests still skip without `TEST_DATABASE_URL`, as before). See `docs/adr/0010-ci-test-gate.md`. **Residual:** CIP-2 (wiring a live Postgres into this CI step so those 28 tests run instead of skip) remains open, tracked separately.

### SEC-8 — Production guardrails fail open — **Resolved**
**Where:** `src/config/productionValidation.js` (`validateWorkerStartupConfig`, `validateProductionStartupConfig` both `return {status:"skipped"}` unless `NODE_ENV === "production"` exactly, and both call sites — `src/app.js`, `src/workers/app.js` — discard the return value); `src/main.js` (`APP_MODE || "production"`, no cross-check against `NODE_ENV`).
**What:** Every production control — `WORKER_EXECUTION_MODE=isolated`, DB-engine constraints, the `WORKER_RUNTIME_ISOLATION` rejection, service-account separateness — is enforced only when `NODE_ENV` holds the exact string `"production"`. Any drift (unset, `"Production"`, a staging value copied forward) silently disables all of them and the process boots anyway. Separately, `APP_MODE=local` routes to `app.local.js` (the fully local, unvalidated dev backend, which never calls either validator) with no cross-check against `NODE_ENV` — that combination on an actual production container would silently boot the insecure dev backend with neither validator ever in the loop.
**Fix:** Default to production posture unless explicitly and safely told otherwise; treat an unrecognized `NODE_ENV`/`APP_MODE` as production (enforce), not "skip". Cross-check `APP_MODE` against `NODE_ENV` and refuse contradictory combinations.
**Resolution:** Neither `startApplication()` nor `startWorker()` has a legitimate non-production run mode of its own — the real local-dev entrypoint, `app.local.js`, never calls either validator — so the skip branch existed purely for test convenience. Both validators now skip only when `NODE_ENV === "test"` (what vitest actually sets, and what every existing skip-path test already used); every other value, including unset, now falls through to full enforcement. `src/main.js`'s mode decision is extracted into an exported, independently-tested `resolveAppMode({env})`, which throws if `APP_MODE === "local"` and `NODE_ENV === "production"` — refusing to boot rather than silently starting the unvalidated local backend inside a production container. The bootstrap guard wraps mode resolution and startup in one `try/catch` → `process.exit(1)`, treating a refused contradiction the same as any other startup failure. See `docs/adr/0022-fail-closed-production-guardrails.md`. **Explicitly out of scope, reviewed and confirmed not currently exploitable:** `WorkerRunService.completeRun`'s unfenced `dispatchId` (zero live callers, SEC-3 removed its only route) and `routes/jobDefinitions.js`'s default `JobDefinitionService` construction lacking `instanceStore` (the only live entry point always wires one) — both are dead-code footguns, not reachable production paths, and fixing either here would be scope creep across unrelated bug IDs.

---

## P2

### SEC-5 — `publicAuth` trusts JWT-header `alg` — **Resolved**
**Where:** `src/middleware/publicAuth.js` (`algorithms:[alg]` read from `decodeProtectedHeader`).
**What:** Not practically exploitable via jose + remote JWKS (asymmetric keys only, `none` rejected), but it nullifies the allowlist as defense-in-depth.
**Fix:** Pin expected algorithms (e.g. `["RS256","ES256"]`).
**Resolution:** `createJoseVerifier` now takes a fixed `algorithms` parameter (default `["RS256", "ES256", "PS256"]`) and passes it directly to `jwtVerify`, instead of reading `alg` back out of the token's own header. The default had to include `PS256`, not just the bug report's illustrative `RS256`/`ES256` example — this codebase's PingOne AIC (ForgeRock) integration signs with PS256, confirmed by an existing test, so a narrower default would have regressed real AIC deployments while fixing the security gap. `createPublicAuthMiddleware` threads an `algorithms` option through, defaulting from a new optional `PUBLIC_API_ALGORITHMS` env var (comma-separated) — unset for both PingOne and AIC callers today, since both already fall inside the built-in default. See `docs/adr/0020-jwt-algorithm-allowlist.md`.

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

### SEC-6 — Approval/scan is self-asserted — **Resolved**
**Where:** `src/services/jobDefinitionService.js:57-66` stamps `APPROVED`/`CLEAN` unconditionally; `src/services/workerRunService.js:357-362` validates fields the same path always writes.
**What:** Ceremony that resembles a control. (`docs/architecture-review.md` marks this "Fixed" as the P0 trust gate — I disagree: writing constants and checking they equal the constants is not a trust decision. Flagging the disagreement rather than overriding the doc.)
**Fix:** Wire a real scanner/approval workflow, or drop the fields to avoid false assurance.
**Resolution:** Dropped the fields (explicit choice over building a real scanner/approval workflow). `jobZip.approval`/`.scan` are no longer stamped by either `JobDefinitionService.createDefinition` or `LocalDefinitionService.createDefinition`; `WorkerRunService.validateArtifactTrust` — the method that only ever checked these constants against themselves, plus a `revoked` flag confirmed never set anywhere in the codebase — is deleted along with both of its call sites (`dispatchRun`, `_runClaimedLocally`). `buildExecutionMetadata` and `SchedulerTickService.buildExecutionMetadataSnapshot` stop copying these fields through. The real, independent integrity controls — SHA-256 digest recompute against downloaded bytes (`verifyApprovedArtifact`) and GCS generation pinning — are unaffected; they never depended on `approval`/`scan`. `docs/architecture-review.md`'s "P0 trust gate: Fixed" claim is corrected to record this as a removal, not a fix. See `docs/adr/0021-remove-self-asserted-artifact-approval.md`.

### SEC-7 — IGA proxy does not bind caller to run — **Resolved**
**Where:** `src/services/runtimeIgaProxyService.js:55-99`.
**What:** `request({ runId, ..., principal })` validated only `run.state === "RUNNING"`; `principal` is identical across all concurrent jobs (every job assumes the same runtime SA), so it carries no per-run identity. The job's SDK puts its own `runId` straight into the proxy request body from an env var it controls. Since run IDs are deterministic (`instanceId:scheduledFireTime`), any RUNNING job could proxy IGA calls tagged with any other RUNNING run's id — audit-attribution forgery across concurrent runs, not confidentiality (single-tenant). Survived SEC-3's route removal because it lives in the proxy path, not the completion route; ADR 0008 had flagged this class of gap as an open follow-on.
**Fix:** Bind the proxy call to the run's actual dispatch attempt rather than trusting `body.runId` alone. Reused COR-1's `dispatch_id` (already minted fresh per claim and persisted on the run row) as the binding value instead of introducing a new credential type.
**Resolution:** `dispatch_id` is now threaded from `RunStore.claimRun` through the worker's `/execute` body into `JobRuntimeExecutor.execute()`, which injects it into the job subprocess env as `IGA_SCHEDULER_DISPATCH_ID` (both Node and Python spawn paths). Both SDKs (`BrokerIgaClient` in `scheduler-sdk.js` and `iga_scheduler/iga_client.py`) read it and send it back as `dispatchId` on every proxy request. `RuntimeIgaProxyService.request()` now rejects with `IGA_RUN_DISPATCH_MISMATCH` (403) when the run has a stored `dispatch_id` and the caller's doesn't match — before any audit event is emitted, consistent with how `RUN_NOT_FOUND`/`RUN_NOT_RUNNING` already reject. The check is skipped when the run store never minted a `dispatch_id` (local dev's `LocalRunStore`), preserving today's behavior there. Side benefit: a ghost subprocess from a superseded dispatch (COR-1's concern) now also gets rejected at the IGA-proxy layer, not just at the DB-fencing layer. See `docs/adr/0018-iga-proxy-run-binding.md`. **Residual:** SEC-4 (same-container co-residency env read) is unrelated and still open — if a co-resident process can read another job's environment directly, it can still read that job's `dispatch_id`.

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

### DBT-2 — `dispatch_id` written, never read — **Resolved by COR-1**
**Where:** schema + `runControlService`; no read site.
**What:** Fixing COR-1 gives it a purpose; until then it is dead.
**Resolution:** COR-1 added the read/enforcement site — `dispatch_id` is now compared in `claimRun`/`markSucceeded`/`markFailed`/`recordRuntimeExecution`'s WHERE clauses. See COR-1 above and `docs/adr/0014-dispatch-fencing-token.md`.
