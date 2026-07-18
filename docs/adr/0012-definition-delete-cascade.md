# ADR 0012: Refuse Definition Delete While Active Instances Reference It

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`JobDefinitionService.deleteDefinition` only soft-deleted the Elasticsearch document (`state: "DELETED"`, `enabled: false`) — it never checked or touched `job_instances` in Postgres. Nothing paused instances still referencing the deleted definition, so every subsequent scheduled fire of an orphaned instance created a run that permanently failed at dispatch (`DEFINITION_NOT_ACTIVE`, confirmed non-retryable) — a failed-run generator on every cron interval, indefinitely, until an operator noticed and manually paused the instance. This is tracked as COR-7.

An instance-by-definition listing already existed and was Postgres-indexed on `definition_id` (`InstanceStore.listInstancesForDefinition`), already wired to a public route (`GET /job-definitions/:definitionId/instances`) — no new query was needed.

---

## Decision

`JobDefinitionService` takes an optional `instanceStore` dependency. When present, `deleteDefinition` lists instances referencing the definition before flipping the ES document, and refuses the delete (throwing a `DEFINITION_HAS_ACTIVE_INSTANCES` error, surfaced as HTTP 409) if any referencing instance is both `enabled` and in state `ACTIVE` — i.e., anything the tick's `claimDueInstances` query would actually fire. Paused or disabled instances don't block deletion.

Production wiring (`src/app.js`) now constructs `JobDefinitionService` with the same `instanceStore` already used by `JobInstanceService`, and passes the resulting `jobDefinitionService` into `createApp()` — previously `app.js` never passed one at all, so the `/job-definitions` route always fell back to `createJobDefinitionRouter`'s own default (`new JobDefinitionService()`, no `instanceStore`). Refuse, not pause, was chosen over the bug log's other stated option: it gives the operator an explicit, actionable error at the point of the mistake, rather than silently mutating instance state as a side effect of a delete call.

`instanceStore` is optional specifically so this stays backward compatible: any construction site that doesn't supply one (tests, or a future caller) keeps the prior unconditional-delete behavior rather than breaking.

---

## Consequences

### What this closes

An operator can no longer delete a definition out from under active instances without an explicit error naming the problem.

### What does not change

- `LocalDefinitionService` (local dev, SQLite-backed) — a separate class, untouched. Local mode already has its own simplified behavior in several other areas by design.
- ES document shape and soft-delete mechanism (`state: "DELETED"`) — unchanged.
- COR-3 (definition version facade) — independent, addressed separately.
