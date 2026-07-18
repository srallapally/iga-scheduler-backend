# ADR 0017: Worker Execution Model Hardening (Subset)

**Status:** Accepted (partial — see Decision)  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

The worker's `/execute` handler has no concurrency cap — every POST unconditionally spawns a tracked execution regardless of how many are already in flight. The one concurrency guard that exists in the codebase, `WorkerRunService.maxLocalConcurrency`, is wired to `executeRunLocally`, a code path nothing in production calls (production always dispatches via the isolated `WorkerServiceRuntimeLauncher` → the worker's `/execute` route). Python job subprocesses got no memory limit (`JobRuntimeExecutor.resolveSpawnCommand`'s Python branch passed no equivalent of Node's `--max-old-space-size`). `terraform/worker_service.tf`'s `timeout` comment claimed it protected graceful-shutdown drain time, which isn't what Cloud Run's per-request timeout setting actually governs. This is tracked as AVL-1.

The bug log's stated "real" fix for AVL-1 is a strategic rework — pull-worker or Cloud-Run-Jobs-per-run — which is its own large migration, not a one-PR fix. Per an explicit prior scoping decision (recorded when COR-2 was planned), this ADR ships only the containable hardening subset; the strategic rework is deferred.

---

## Decision

### Concurrency cap

`createWorkerApp` gains `maxConcurrency` (env `WORKER_MAX_CONCURRENCY`, default 10). The `/execute` handler checks `activeExecutions.size >= maxConcurrency` before spawning and returns `503 {error: "worker is at max concurrency", retryable: true}` if at capacity. This reuses the `activeExecutions` `Set` already tracked for drain purposes — no new tracking structure needed. A `503` with no distinguishing error code already falls through `classifyWorkerError`'s default `"default_retryable_worker_failure"` classification when it propagates through `WorkerServiceRuntimeLauncher`/`dispatchRun`'s catch handler, so this is retryable without any special-casing (though COR-4 — nothing currently requeues a retryable failure — means this doesn't yet trigger an automatic retry; it's still the correct classification for when that's fixed).

### Python memory limit

`resolveSpawnCommand`'s Python branch now wraps the interpreter invocation: `bash -c 'ulimit -v <limitKb>; exec "$0" "$@"' <pythonBin> <entrypointPath>`. Python has no interpreter-level memory flag analogous to Node's `--max-old-space-size`, so the limit is enforced via the OS `RLIMIT_AS` (virtual address space) instead. The real binary and entrypoint path are passed as separate argv entries to `bash -c`, not string-interpolated into the script text — `$0`/`$@` are bash's own positional-parameter mechanism, not concatenation — so this stays injection-safe despite the added shell hop, consistent with `_spawnEntrypoint`'s existing `shell: false` posture (the shell here is an explicit, fixed-argv invocation of `bash`, not a shell parsing untrusted content). `exec` replaces the bash process image in place, so the resulting live process keeps the same pid `spawn` returned — the existing process-group kill/timeout logic is unaffected.

Verified empirically (not just asserted): a 64MB `ulimit -v` limit is comfortably sufficient for a trivial Python script to start and run normally, while a script that allocates a 200MB `bytearray` reliably fails with `MemoryError` under that same limit.

### Terraform comment

`worker_service.tf`'s `timeout` comment previously claimed to give "the SIGTERM handler time to drain active job subprocesses" — that's not what Cloud Run's per-request `timeout` field does; it bounds an individual HTTP request's duration, and since `/execute` responds `202` almost immediately (the job runs detached in the background), this setting doesn't bound job execution duration either. The comment now describes accurately what the setting does and does not do. No functional Terraform change — comment only.

---

## Consequences

### What this closes

The worker no longer accepts unbounded concurrent job subprocesses on one instance. Python jobs can no longer exhaust host memory unbounded, matching the protection Node jobs already had. The Terraform comment no longer misleads an operator into believing this setting provides graceful-shutdown protection it doesn't.

### What remains open (explicit residual, deferred to AVL-1's strategic fix)

- The `202`-then-background-subprocess pattern itself: Cloud Run's autoscaling/concurrency signal is based on request lifecycle, and a request that returns in milliseconds while the real work continues detached undercounts load to the platform's scaler.
- True per-job isolation (container-per-job or a pull-worker model) — same-container co-residency concerns (SEC-4) are unaffected by this ADR.
- `maxDrainMs`'s actual reliability during scale-in/deploy — Cloud Run's real SIGTERM-to-SIGKILL window is short and platform-controlled; nothing in this ADR changes that.

### What does not change

- `WorkerRunService.maxLocalConcurrency` / `executeRunLocally` — still dead code in production, unchanged; local dev's own concurrency behavior is untouched.
- Node's `--max-old-space-size` memory-cap mechanism — unchanged.
- SEC-1 through SEC-4, COR-1 through COR-3/COR-7, AVL-2, CIP-1 — independent, already resolved.
