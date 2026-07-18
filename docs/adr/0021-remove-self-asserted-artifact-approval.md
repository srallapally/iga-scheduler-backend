# ADR 0021: Remove the Self-Asserted Artifact Approval/Scan Fields

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`JobDefinitionService.createDefinition` (and its local-dev equivalent, `LocalDefinitionService.createDefinition`) stamped `jobZip.approval = {status: "APPROVED", sha256, generation, approvedAt}` and `jobZip.scan = {status: "CLEAN", sha256, scannedAt}` unconditionally on every artifact upload — there was no scanner and no approval workflow that could ever produce a different value. `WorkerRunService.validateArtifactTrust` then checked that these same always-constant fields equaled the constants it expected, plus an `artifact.revoked` flag that a full-repo search confirmed was never written by any route, admin action, or other code path — always `undefined`, so that check never fired either. `docs/architecture-review.md` had called this the "P0 trust gate" and marked it "Fixed." This is tracked as SEC-6, whose own bug report explicitly disagreed with that "Fixed" characterization rather than silently overriding the doc: writing constants and checking they equal the constants is not a trust decision.

Two remediation paths existed: wire a real scanner/approval workflow, or drop the fields entirely to stop presenting ceremony as a control. The fields were product-facing in name only — no operator ever set them, no external system ever consumed them, and no other part of the codebase branched on them except the one self-check being removed alongside them.

---

## Decision

Drop `approval`, `scan`, and `revoked` entirely, rather than build a real scanner/approval workflow. This was an explicit choice, not a default: a real workflow was a live option, and the alternative — leaving the fields in place unfixed — was rejected as continuing false assurance. `validateArtifactTrust` (the method that only ever checked these three fields) is deleted outright, along with its two call sites (`WorkerRunService.dispatchRun` and `_runClaimedLocally`, the isolated-dispatch and pull-worker execution paths respectively). `buildExecutionMetadata` and `SchedulerTickService.buildExecutionMetadataSnapshot` stop copying these fields from `jobZip` into the execution context and the AVL-2 tick-time snapshot.

What's left, and was never part of this ceremony to begin with: `WorkerRunService.verifyApprovedArtifact` recomputes the SHA-256 digest against the actual downloaded artifact bytes, and `buildExecutionMetadata` pins the GCS object generation (`uri`/`sha256`/`generation` on `jobZip`) — both real, both independent of `approval`/`scan`, both unaffected by this change. `validateArtifactTrust`'s own cross-checks of `approval.sha256`/`.generation` against the artifact's real `sha256`/`generation` were themselves redundant with `verifyApprovedArtifact`'s independent recompute, so nothing of substance was lost by removing them along with the rest.

`docs/architecture-review.md`'s "P0 trust gate: Fixed" row and "Artifact trust chain" section are corrected to describe what's actually enforced (digest + generation pinning) instead of the removed self-check, and to record that this was a removal, not a fix, resolving the disagreement the original bug report flagged rather than silently overriding.

---

## Consequences

### What this closes

No code path anywhere writes or reads a job artifact "approval" or "scan" status, or a "revoked" flag, that could never be produced by anything but the write path itself. The trust-gate claim in `architecture-review.md` no longer misdescribes what's enforced.

### What does not change

- Artifact upload behavior for operators — nothing about `createDefinition`'s public contract (input shape, GCS path naming under `approved/<definitionId>/<digest>/job.zip`, response shape minus the removed fields) requires any caller-side change.
- `verifyApprovedArtifact`'s SHA-256 recompute and `buildExecutionMetadata`'s GCS generation pinning — both untouched, both still enforced on every dispatch.
- No other part of the codebase depended on `approval`/`scan`/`revoked` (confirmed by a full-repo search before this change) — this is a clean removal, not a partial one requiring a follow-on.

### What remains open

- If a real scanner/approval workflow is ever wanted, it would need to be built from scratch — this ADR does not leave a partially-wired scaffold behind for one; the fields it removed were not reusable groundwork.
