# ADR 0015: Real Run Cancellation

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`RunControlService.cancelRun` flipped a RUNNING run to CANCELLING and called `cancelRuntimeExecution`, but `WorkerServiceRuntimeLauncher.cancel()` was a permanent stub returning `{status: "unsupported"}` — it made no HTTP call to the worker at all. Worse, `RunControlService` was constructed without a `runtimeLauncher` in both production wiring sites (`createApp.js`, `routes/jobRuns.js`), and `cancelRuntimeExecution`'s guard additionally required `run.runtimeExecution?.executionId`, which nothing in production ever set — so the whole cancellation-side-effect call was unreachable dead code, on top of being a stub.

In practice: cancel on RUNNING flipped state to CANCELLING; the real subprocess was never signaled; it ran to completion; its completion no-opped (state ≠ RUNNING, silently discarded, no audit event); the stale-run sweeper eventually force-cancelled the row at the timeout threshold (~31 minutes later). The record said CANCELLED while side effects (e.g. IGA writes) had fully happened. This is tracked as COR-2.

Per an explicit scoping decision, this ADR implements real cancellation rather than the lesser fix (removing the false promise and documenting the gap).

---

## Decision

### Worker: a runId-keyed kill capability

`JobRuntimeExecutor` already builds a `killProcessGroup(signal)` closure per spawned child (used internally for its own timeout enforcement). It now also registers that closure in an internal `Map` keyed by `runId` (`_activeByRunId`), cleared when the child settles (`close`/`error`). A new public method, `cancel(runId)`, looks up the map and — if found — sends `SIGTERM`, then `SIGKILL` after `killGraceMs` (the same grace period the timeout path already uses), returning `{status: "killed"}`. If nothing is tracked for that `runId` (already finished, or never started on this instance), it returns `{status: "not_found"}`.

`workerApp.js` exposes this as `POST /cancel/:runId`, gated by the same `authMiddleware` as `/execute`.

### Launcher: a real cancel call

`WorkerServiceRuntimeLauncher.cancel({runId})` replaces the stub with an authenticated `POST` to the worker's new `/cancel/:runId` route (mirroring `launchExecution`'s token-fetch-and-401-retry pattern), returning the worker's JSON response (`{status: "killed"}` or `{status: "not_found"}`).

### Scheduler: wired for real, fenced by `dispatch_id` not `executionId`

`RunControlService.cancelRuntimeExecution` no longer gates on `run.runtimeExecution?.executionId` (a field nothing in production ever populated) — it calls `this.runtimeLauncher.cancel(run)` whenever a launcher is configured at all, passing the full run document (the launcher only needs `runId`; COR-1's `dispatch_id` is available on the same object if a future need arises to disambiguate attempts at the launcher level, though the current design doesn't require it since the worker's registry is itself runId-keyed and only ever holds one live execution per run at a time).

If the launcher call throws (worker unreachable), the error is swallowed — the run is already durably recorded as CANCELLING, and the sweeper's existing timeout remains the backstop; a network hiccup calling cancel should not surface as a 500 to the operator when the cancellation intent was already persisted. If the launcher confirms `{status: "killed"}`, `cancelRuntimeExecution` immediately transitions the run `CANCELLING → CANCELLED` (with `cancelledAt` set), rather than waiting for the sweeper's timeout — this is the actual fix: real cancellation now resolves in the time of one HTTP round trip, not ~31 minutes.

`RunControlService` is now constructed once in `src/app.js` (reusing the same `WorkerServiceRuntimeLauncher` instance dispatch already uses, so cancellation targets the same worker) and passed into `createApp()`, which threads it to both `/internal/job-runs/:runId/cancel` (`createInternalWorkerRouter`) and the public `/job-runs/:runId/cancel` (`createJobRunRouter`) — previously each router lazily constructed its own `RunControlService({runStore})` with no launcher at all.

### A deliberate non-change: the HTTP response contract

`cancelRun`'s returned shape for the RUNNING branch stays `{status: "cancelling", ..., state: "CANCELLING"}`, even when the kill was confirmed synchronously within the same call (`cancelRuntimeExecution`'s return value was already discarded by the caller before this change, and remains so). The alternative — reporting `"cancelled"` immediately when confirmed — would be more honest but changes an existing response contract for comparatively little value: a follow-up `GET /job-runs/:runId` will already show `CANCELLED` correctly, since the DB transition happens synchronously before the HTTP response is sent.

---

## Consequences

### What this closes

A RUNNING run's subprocess is now actually signaled to terminate when cancelled, and the run transitions to CANCELLED promptly once the worker confirms the kill — not ~31 minutes later via the sweeper.

### What does not change

- The stale-run sweeper's CANCELLING timeout path (`_sweepCancelling`/`markCancelled`) — kept as the backstop for the `not_found`/unreachable-worker cases (the process may have already finished naturally, or the worker instance may have recycled).
- `WorkerServiceRuntimeLauncher.getStatus()` — still a stub; out of scope, not needed by this fix.
- The `cancelRun` HTTP response contract — unchanged, per the deliberate non-change above.
- COR-1 (dispatch fencing) — independent, already resolved; this ADR's cancellation path doesn't currently need to disambiguate by `dispatch_id` since the worker's kill registry is runId-keyed and single-execution-per-run.
