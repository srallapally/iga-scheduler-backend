# ADR 0008: Remove the HTTP Completion Route

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`POST /internal/job-runs/:runId/complete` (`src/routes/internalWorker.js`)
was guarded by `completionAuthMiddleware`, whose default fallback chain
accepted the principal `RUNTIME_SERVICE_ACCOUNT_EMAIL` — the same service
account job subprocesses mint OIDC tokens as, as normal operation (the SDK
does this to call the IGA broker proxy). Any running job could therefore
call `/complete` for any RUNNING run with an arbitrary result payload. Run
IDs are deterministic (`instanceId:scheduledFireTime`), so targets were
guessable. The impact is result-integrity forgery: a job could mark another
run SUCCEEDED or FAILED with fabricated output. This is tracked as SEC-3.

The route had no production caller. In production the worker writes run
outcomes to Postgres directly via the `onExecutionSuccess`/
`onExecutionError` callbacks in `src/workers/app.js` — no SDK, launcher, or
job path ever POSTs to `/complete`. A repo-wide search confirmed the only
other `/complete` references were prose comments in `staleRunSweeper.js`
and service-level unit tests of `WorkerRunService.completeRun`. It was an
armed, unused door.

---

## Decision

The route and its `completionAuthMiddleware` are removed entirely from
`internalWorker.js`. The sibling routes on the same router (`/execute`,
`/retry`, `/cancel`, `/redrive`) and their `authMiddleware` are untouched.

`WorkerRunService.completeRun` is kept as-is — it remains unit-tested and
is harmless with no route calling it. Removing it is a separate cleanup,
not done here, to keep this change to the smallest fix that closes SEC-3.

Run outcomes now have exactly one path to terminal state in production:
the worker's own direct Postgres writes after local execution completes.

### Reintroduction constraint

If a future execution-model change needs an HTTP completion callback
again (e.g. a pull-worker or cross-service completion signal), it must
authenticate a principal that job code cannot assume — not the runtime
service account, since that is exactly the identity job subprocesses hold.

---

## Consequences

### What this closes

A job can no longer forge another run's completion over HTTP — the
endpoint that accepted the job-assumable runtime SA principal no longer
exists.

### What this does not close

The sibling routes on this router (`/execute`, `/retry`, `/cancel`,
`/redrive`) still authenticate via an implicit env-var fallback chain in
`createInternalAuthMiddleware`. Whether that chain's principal set is
appropriate for each of those routes is a separate, broader finding —
not addressed by this ADR.

### What does not change

- `WorkerRunService.completeRun` and its existing unit tests.
- The worker's direct-write completion path (`onExecutionSuccess`/
  `onExecutionError` in `src/workers/app.js`).
- SEC-1, SEC-2 — independent boundaries.
