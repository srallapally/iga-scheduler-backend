# ADR 0019: Pull-Worker Execution Model

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

AVL-1's hardening subset (ADR 0017: concurrency cap, Python memory limit, honest Terraform comment) shipped without touching the strategic problem it deferred: the scheduler's `RunDispatcher` polls `listQueuedRunIds` and pushes each run over HTTP via `WorkerServiceRuntimeLauncher` to the worker's `POST /execute`, which returns `202` and runs the job as a fire-and-forget subprocess (`workerApp.js`). The worker runs as a Cloud Run service with `--min-instances=1`. This has three consequences: in-flight jobs are killed on every deploy/scale-in (Cloud Run's SIGTERM-to-SIGKILL grace is short and platform-controlled, unrelated to the `timeout` setting); request-based autoscaling never fires, since a `202` response completes in milliseconds regardless of how long the job actually runs; and two services that share one database are coupled by an HTTP hop plus its OIDC handshake for no structural reason.

Cloud Run Jobs per run (true per-job isolation, real task timeouts) was considered and rejected: cold-start latency for a fresh Job execution per run is unacceptable for this workload's dispatch cadence.

---

## Decision

### Pull-worker, fixed warm pool

The worker converts to a pull-worker: it polls `job_runs` itself, atomically claims a batch with `FOR UPDATE SKIP LOCKED` (`RunStore.claimNextQueued`), executes in-process, heartbeats and self-cancels its owned runs, and completes through the existing dispatch-id-fenced callbacks (`markSucceeded`/`markFailed`, unchanged from COR-1). The scheduler stops pushing entirely. `POST /execute`, `POST /cancel`, `WorkerServiceRuntimeLauncher`, and the scheduler→worker invoker IAM binding (`scheduler_service_invoke_worker`) are all removed. The worker's only remaining HTTP route is `/health`, kept because Cloud Run requires the container to listen on `$PORT` for liveness/readiness.

Because a poll loop has no inbound requests, Cloud Run's request-based autoscaling signal never fires for it — this is not a bug to work around, it's the reason the worker is sized as a fixed warm pool instead: one Terraform variable, `worker_pool_size`, drives both `--min-instances` and `--max-instances` (previously `worker_service_min_instances` alone existed, with `max_instance_count` hardcoded to `10` independently of it). Peak capacity is `worker_pool_size × per-instance concurrency cap` (`WORKER_MAX_CONCURRENCY`, from AVL-1) — a capacity-planning decision, not free elastic scaling. `cloudbuild.yaml`'s worker deploy step now reads `worker_pool_size` from the Terraform output and applies it to both flags, replacing what was previously a hardcoded `--min-instances=1` literal disconnected from Terraform's own variable.

### Reused `WorkerRunService`, not a new launcher abstraction

`WorkerRunService.dispatchRun` (the isolated/HTTP-push path) builds `execution`/`context` — artifact trust verification, Secret Manager parameter resolution, execution-metadata resolution — before handing off to a launcher. A different branch, `executeRunLocallyInternal` (`executionMode: "local"`), already does this entire pipeline in-process with no launcher at all, calling `this.runtimeExecutor.execute(...)` (a `JobRuntimeExecutor` instance) directly. That branch existed only for `startApplication()` run without `WORKER_EXECUTION_MODE` set, or for tests — production always took the isolated/HTTP path.

Rather than invent a new in-process launcher class implementing `launchExecution`/`cancel`, this plan relocates `WorkerRunService` from the scheduler process into the worker process, and extracts `executeRunLocallyInternal`'s post-claim body into a private `_runClaimedLocally({run, startedAt})`, reused by both the existing single-`runId` path and a new `executeClaimedRun({runId, dispatchId})` — the latter is what the poll loop drives, since `RunStore.claimNextQueued` has already atomically claimed the row (flipped to `RUNNING`, minted a `dispatch_id`), so re-claiming via `claimQueuedRun`'s single-run `claimRun` would just no-op. One real gap was closed in the process: `_runClaimedLocally`'s call to `runtimeExecutor.execute(...)` didn't pass `dispatchId` — needed so SEC-7's `IGA_SCHEDULER_DISPATCH_ID` propagation (which reuses the same `dispatch_id` to bind a job's IGA proxy calls to its own run) keeps working once this path carries production traffic.

Since `WorkerRunService`'s `buildExecutionMetadata` falls back to a live ES lookup when a run has no AVL-2 execution-metadata snapshot, and this logic now runs inside the worker, the worker gains `ES_ENDPOINT`/`ES_API_KEY`/`JOB_ZIP_BUCKET` (mirroring the scheduler's existing values) rather than turning a missing snapshot into a new hard failure — this preserves existing, tested, self-healing behavior instead of changing it as an incidental side effect of relocating the code that happens to use it.

### Heartbeat and pull-based cancel

`RunStore.touchHeartbeat({runId, dispatchId, heartbeatAt})` updates `heartbeat_at` and returns the run's current state (`RUNNING` or `CANCELLING`) in one fenced round trip. The poll loop's heartbeat tick calls this for every run it owns; when it reports `CANCELLING`, the loop calls `JobRuntimeExecutor.cancel(runId)` directly — the same SIGTERM/SIGKILL path COR-2 already built, just invoked by the worker's own loop instead of over HTTP from `WorkerServiceRuntimeLauncher.cancel()`. `RunControlService.cancelRuntimeExecution` already no-ops gracefully with no `runtimeLauncher` configured (`if (!this.runtimeLauncher?.cancel) return false`), so production wiring simply stops constructing one — no code change needed there.

### Manual force-dispatch route removed

`POST /internal/job-runs/:runId/execute` (`internalWorker.js`) let an operator force-dispatch a specific QUEUED run immediately via the scheduler→worker push path. It has no way to act once the worker is the only thing that executes a run — removed, since it's orphaned by this exact change (the ~1s poll interval also makes manual force-dispatch largely redundant). `WorkerRunService`'s construction in the scheduler was removed entirely as a result, since that route was its only consumer there.

### Local dev unaffected

`src/app.local.js` still constructs and starts `RunDispatcher` with `LocalWorkerRunService` for synchronous in-process execution — untouched by this plan. `RunDispatcher` itself is not deleted; only its construction in production `src/app.js` is removed.

---

## Consequences

### What this closes

In-flight jobs finishing within the (raised) termination grace survive a deploy or scale-in, instead of being killed unconditionally. The worker no longer depends on request-based autoscaling that never actually fired for it. The scheduler↔worker HTTP coupling (OIDC handshake, `WorkerServiceRuntimeLauncher`, the invoker IAM binding) is gone.

### What remains open

- **Grace-exceeding jobs.** A job whose execution outlives the termination grace is left `RUNNING` with its `dispatch_id` intact — safe (the fence prevents another worker from stealing it), but not resumed. Full survival requires a stale-`RUNNING` → `QUEUED` requeue policy, which is COR-4/COR-5 territory and out of scope here.
- **SEC-4 is not closed.** There is no container-per-job; every job still executes inside the one worker container, sharing its UID. The bug log's SEC-4 entry previously assumed AVL-1's strategic rework would be container-per-job and said so — that assumption was wrong once pull-worker was chosen instead, and is corrected in this same change: the `gosu`/`jobrunner` UID-separation work remains required, not superseded.
- **COR-5 partially touched, not resolved.** `heartbeat_at` is now actively written by the worker (previously written only at claim/completion time), which is exactly the signal COR-5's fix would consume — but the stale-run sweeper itself still keys staleness off `started_at`, unchanged by this PR.

### What does not change

- Tick, the broker IGA proxy (`RuntimeIgaProxyService`/`internalRuntimeIga.js`), and run-control retry/redrive semantics.
- The run state machine and public route response shapes.
- SEC-1 through SEC-3, SEC-7, COR-1/COR-2/COR-3/COR-7, AVL-2/AVL-3, CIP-1 — independent, already resolved.
