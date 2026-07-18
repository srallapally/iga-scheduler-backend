# ADR 0013: Increment Definition Version on Re-Upload

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`JobDefinitionService.createDefinition` hardcoded `const version = 1` on every call, with no read of any prior document for the same `definitionId` before writing. Instances pin `definitionVersion` at creation time, and dispatch enforces a `DEFINITION_VERSION_MISMATCH` check comparing the pinned version against the live definition's current version — a real, correctly-implemented comparison, but one whose input was permanently poisoned: since re-upload always wrote `version: 1` again, the only way to update job code (delete + re-POST the same `definitionId`) silently returned an unchanged-looking version, so pinned instances could execute different code under a pinned version that never actually changed. This is tracked as COR-3.

GCS artifact paths were already content-digest-keyed (`approved/{definitionId}/{sha256}/job.zip`), so old and new artifacts already coexisted in storage without collision — only the ES `version` field itself needed to actually increment.

---

## Decision

`createDefinition` now reads any existing document for `definitionId` via `getDefinition` (which already returns documents regardless of `state`, including soft-deleted ones) before writing. If a prior document exists, `version = existing.version + 1`; otherwise `version = 1`. The ES write branches accordingly: a genuinely new `definitionId` still uses `es.create` (atomic, 409s if another concurrent request wins the same id-not-found race — preserving the existing conflict-detection behavior), while a re-upload of an existing `definitionId` uses `es.index` (a full-document upsert), since the whole definition — not just the version field — may have changed.

`LocalDefinitionService` (the local-dev, SQLite-backed backend) has the same hardcoded-version pattern and is not touched by this ADR — consistent with COR-7's precedent of scoping definition-lifecycle fixes to the production ES-backed service.

---

## Consequences

### What this closes

Re-uploading a definition now actually increments its version, so the existing `DEFINITION_VERSION_MISMATCH` dispatch-time check can do the job it was already built to do: catch a run dispatched against a definition whose code has since changed underneath a pinned instance.

### What does not change

- `WorkerRunService`'s `DEFINITION_VERSION_MISMATCH` comparison logic itself — it was already correct; only its input was fixed.
- GCS artifact storage layout (`approved/{definitionId}/{sha256}/job.zip`) — unchanged, already digest-keyed.
- `LocalDefinitionService` — separate class, untouched, noted as a residual if local-dev parity is ever wanted.
- COR-7 (definition delete cascade) — independent, already resolved.
