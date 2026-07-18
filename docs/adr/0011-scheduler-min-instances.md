# ADR 0011: Scheduler Service Min-Instances and No-CPU-Throttling

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

The scheduler service runs two always-on, in-process background loops, wired up unconditionally at process boot (`src/app.js`), independent of any HTTP request: the dispatch poller (`RunDispatcher`, a self-rescheduling `setTimeout` chain, default 5s cadence) and the stale-run sweeper (`StaleRunSweeper`, a `setInterval`, default 60s cadence).

Cloud Run's default CPU-throttling model only allocates CPU while the container is actively processing a request; between requests, CPU is throttled to near-zero. A JavaScript timer (`setTimeout`/`setInterval`) still *fires* on schedule, but its callback cannot actually *execute* until the CPU is unthrottled — in practice, until the next inbound request (the once-a-minute `/internal/scheduler` tick call from Cloud Scheduler) wakes it. Without `--min-instances`, the service can also scale to zero between traffic, killing the process — and both loops — entirely.

The worker service's Cloud Run deploy step already has `--min-instances=1 --no-cpu-throttling`. The scheduler's deploy step in `cloudbuild.yaml` had neither. This is tracked as AVL-3.

---

## Decision

Add `--min-instances=1 --no-cpu-throttling` to the scheduler's `gcloud run deploy` step in `cloudbuild.yaml`, mirroring the worker step exactly. No code change — this is a deploy-configuration fix only.

---

## Consequences

### What this closes

The dispatch poller and stale-run sweeper now run on their configured cadence regardless of inbound HTTP traffic, and the scheduler process itself no longer scales to zero.

### What does not change

- The scheduler's other deploy flags, env vars, and secrets — untouched.
- The worker deploy step — already had these flags, unchanged.
- No application code changed.
