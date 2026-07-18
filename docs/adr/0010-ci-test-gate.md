# ADR 0010: CI Test Gate

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`cloudbuild.yaml`'s pipeline (terraform outputs → docker build ×2 → docker push ×2 → Postgres migrate → deploy worker → deploy scheduler) contained no test step. `npm test` (`vitest run`) existed only as a documented session convention in `CLAUDE.md` — nothing mechanically enforced it. The Cloud Build trigger (`terraform/cicd.tf`) fires on every push to `main`, so a regression could ship straight to production with zero automated gate, which matters given how much of this system is state-machine correctness (run lifecycle, dispatch, cancellation) rather than simple CRUD. This is tracked as CIP-1.

Four tests in `test/worker-execution-metadata.test.js` were failing at the time this was picked up. The bug log's original diagnosis guessed cross-test `process.env` leakage; investigation found the actual cause was narrower: `serviceWithDefinition` (the file's own test helper) constructed `WorkerRunService` without an explicit `definitionsIndex`, so the service's lazy `definitionsIndex` getter fell through to `getConfig()` — which throws unless `GCP_PROJECT_ID`, `JOB_ZIP_BUCKET`, `ES_ENDPOINT`, and `ES_API_KEY` are all set in the ambient environment. Every other test file exercising `WorkerRunService` already passes `definitionsIndex` explicitly; this one file didn't.

---

## Decision

A test step runs in `cloudbuild.yaml` immediately after the Terraform-outputs step and before any Docker build: a `node:22-slim` step running `npm ci && npm test`, failing the build on any non-zero exit. It's placed first (not after the builds/pushes) so a failing test fails fast, before spending time building or pushing images. It needs no live Postgres — the PG-integration test suites already `describe.skipIf` gracefully without `TEST_DATABASE_URL`, so they skip in this step exactly as they do in local development without a database.

`test/worker-execution-metadata.test.js`'s `serviceWithDefinition` helper now passes `definitionsIndex: "scheduler_definitions_v1"` explicitly, matching the pattern already used elsewhere (e.g. `test/worker-run-service.test.js`). This was a one-line test-fixture fix, not a change to any production code path.

---

## Consequences

### What this closes

No commit can reach `main`'s deploy steps with a failing test — `npm test` is now a real, enforced gate rather than a documented convention.

### What this does not close

The 28 currently-skipped PG-integration tests (`test/runStore.test.js`, `test/instanceStore.test.js`, `test/schedulerTickService.test.js`, part of `test/pgClient.test.js`) still skip in CI exactly as they do locally, since no `TEST_DATABASE_URL` is provided to this step. Wiring a real Postgres into CI (a sidecar container, or Cloud Build's docker-in-docker capability, pointed at by `TEST_DATABASE_URL`) so this concurrency-critical SQL is actually exercised in CI is CIP-2 — tracked separately, not done here.

### What does not change

- All other pipeline steps (docker build/push, migrate, deploy worker, deploy scheduler) — unchanged, unreordered relative to each other.
- No production code changed; the only non-test-infrastructure edit was the one-line test fixture in `worker-execution-metadata.test.js`.
