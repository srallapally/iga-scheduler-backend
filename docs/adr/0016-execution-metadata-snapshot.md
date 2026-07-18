# ADR 0016: Snapshot Execution Metadata at Tick Time

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`WorkerRunService.buildExecutionMetadata` fetched the job definition from Elasticsearch synchronously on every dispatch attempt (up to the dispatcher's batch rate, e.g. 10 per 5s). This contradicted the "ES stays out of run/instance coordination" design constraint from ADR 0004, and — since a non-404 ES error was rethrown unchanged and both dispatch call sites unconditionally called `markFailed` on any thrown error — an ES blip during dispatch permanently failed every in-flight dispatch for its duration, regardless of `classifyWorkerError`'s retry classification (a separate, already-tracked gap, COR-4). This is tracked as AVL-2.

`job_runs.definition_version` was already snapshotted onto the run row at tick time (from the instance's pinned version), but no artifact-identity fields (uri, sha256, generation, entrypoint, runtime, etc.) were, and `SchedulerTickService.tick()` had no ES dependency at all.

---

## Decision

A new nullable `jsonb` column, `job_runs.execution_metadata` (migration `002_run_execution_metadata.sql`), holds a snapshot of everything `buildExecutionMetadata` needs: the definition fields (`definitionId`, `version`, `runtime`, `runtimeVersion`, `wrapperVersion`, `entrypoint`, `timeoutSeconds`), a separate `definitionEnabled`/`definitionState` pair (the live enabled/active check), and the artifact fields (`uri`, `sha256`, `generation`, `approval`, `scan`, `revoked`).

`SchedulerTickService` takes an optional `definitionService` dependency (anything with `.getDefinition(id)` — in production, the existing `JobDefinitionService`). When present, `tick()` fetches the definition once per due instance and calls `buildExecutionMetadataSnapshot` to build the row's snapshot before creating the run. This deliberately does **not** throw for a missing/inactive/version-mismatched definition — that's a real, expected outcome that should still produce a run, which then fails at dispatch with the same error code as before (preserving today's observability and audit trail exactly). Only a genuine fetch failure (ES down, network) propagates, and — because each due instance already runs inside its own per-instance `SAVEPOINT` — that failure only fails *that* instance for *this* tick; it's picked up again next tick, since `next_fire_at` was never advanced. This is the actual fix: an ES blip now delays one instance's fire by one tick interval instead of permanently failing an already-created run.

`WorkerRunService.buildExecutionMetadata` now checks `run.executionMetadata` first: if present, it validates using the snapshot (no ES call at all) and returns the same shape as before. If absent, it falls back to the original live ES lookup — unchanged — which covers legacy runs created before this migration and any backend that doesn't populate the snapshot.

`definitionService` is optional specifically so this stays backward compatible: local dev (`app.local.js`, `LocalDefinitionService`) does not wire it in, so local-mode ticks continue to skip the snapshot entirely and local dispatch continues to use the live-lookup fallback — unchanged behavior, consistent with this codebase's established pattern of holding local dev to a simpler bar (same as SEC-1's local fallback, COR-7/COR-3's ES-backed-service-only scoping).

Production wiring (`src/app.js`) constructs `SchedulerTickService` with `definitionService: jobDefinitionService`, the same instance already used elsewhere.

---

## Consequences

### What this closes

Elasticsearch is no longer on the dispatch hot path for the production isolated-dispatch flow. An ES outage during dispatch no longer permanently fails in-flight runs; at worst it delays a due instance's run creation by one tick interval, self-healing on the next tick.

### What does not change

- The `DEFINITION_NOT_ACTIVE`/`DEFINITION_VERSION_MISMATCH`/`DEFINITION_ARTIFACT_MISSING`/`DEFINITION_NOT_FOUND` error codes and their meaning — identical either way, snapshot-sourced or live-sourced.
- COR-4 (retry-classification machinery exists but nothing requeues a failed run) — independent, unaddressed by this ADR; a definition-related dispatch failure is still `markFailed` unconditionally either way.
- Local dev (`APP_MODE=local`) — unchanged; continues to use the live-lookup fallback path.
- `LocalRunStore`/local SQLite schema — not given an `execution_metadata` column; local mode never needs it since it never receives a snapshot to persist.
