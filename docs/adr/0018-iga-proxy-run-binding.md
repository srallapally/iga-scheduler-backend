# ADR 0018: Bind the IGA Runtime Proxy to the Caller's Dispatch

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`RuntimeIgaProxyService.request({ runId, ..., principal })` gated IGA proxy calls only on `run.state === "RUNNING"` for the run named by the request's `runId`. It never checked that the *calling* job was actually that run. The route in front of it, `POST /internal/runtime/iga/request`, authenticates via Google OIDC (`internalAuth`) — but every job subprocess mints that token as the same `RUNTIME_SERVICE_ACCOUNT_EMAIL`, so `principal` is identical across all concurrent jobs and carries no per-run identity. The job's SDK (`BrokerIgaClient`, both the JS and Python builds) puts its own `runId` straight into the proxy request body from an env var (`IGA_SCHEDULER_RUN_ID`) that the job process itself holds. Since run IDs are deterministic (`instanceId:scheduledFireTime`), any RUNNING job could send a proxy request naming a different, also-RUNNING run's id, and the request would be honored and audited under that other run's identity. Under single-tenancy this is not a confidentiality breach (all jobs already share the runtime SA and, ultimately, the IGA tenant), but it forges "which run made this IGA change" in the audit trail. This is tracked as SEC-7.

ADR 0008 (SEC-3's completion-route fix) explicitly flagged this class of gap as unresolved: "the sibling routes... still authenticate via an implicit env-var fallback chain... whether that chain's principal set is appropriate for each of those routes is a separate, broader finding." SEC-7 is that finding, for the IGA proxy specifically — it survived SEC-3's fix because it lives in the proxy path, not the completion route SEC-3 removed.

---

## Decision

Rather than mint a new run-scoped credential, this reuses the one COR-1 already built: `RunStore.claimRun` mints a fresh, unguessable `dispatch_id` (`randomUUID()`) on every successful claim and persists it on the run row. Today it exists purely for Postgres-side fencing; it was never handed to the job subprocess. This ADR threads it one hop further and uses it as the run-binding credential for the IGA proxy too:

- `JobRuntimeExecutor.execute()` now accepts a `dispatchId` and forwards it into both `executeNodeEntrypoint`/`executePythonEntrypoint`, which inject it into the job subprocess env as `IGA_SCHEDULER_DISPATCH_ID` (mirroring the existing conditional `IGA_BROKER_URL` spread — absent entirely when no `dispatchId` is supplied).
- `workerApp.js`'s `/execute` handler already destructures `dispatchId` off the request body (COR-1, for the completion callbacks) — it now also passes it into `executor.execute(...)`.
- Both SDKs' `BrokerIgaClient` read `IGA_SCHEDULER_DISPATCH_ID` from the environment and send it back as `dispatchId` on every proxy request body, alongside `runId`.
- `internalRuntimeIga.js` forwards `req.body.dispatchId` into `RuntimeIgaProxyService.request(...)`.
- `RuntimeIgaProxyService.request()` fetches the run (as before) and, if `run.dispatchId` is present, rejects with `IGA_RUN_DISPATCH_MISMATCH` (403) unless the caller's `dispatchId` matches it exactly. This check runs before the "started" audit event is emitted — the same treatment `RUN_NOT_FOUND`/`RUN_NOT_RUNNING` already get.

If `run.dispatchId` is absent — the case for `LocalRunStore` (local dev), which never mints one — the check is skipped entirely, leaving today's behavior unchanged there. This mirrors the backward-compatibility precedent COR-1 itself established (optional `dispatchId` params that fence only when provided).

---

## Consequences

### What this closes

A job can no longer proxy IGA calls tagged with a different run's id — the request must carry the exact `dispatch_id` minted for the run it claims to be, a value only that run's own subprocess ever receives. "Which run made this IGA change" in the audit trail is now trustworthy across concurrent runs.

### An incidental benefit

Because `dispatch_id` is re-minted on every claim (including retries/redrives), a ghost subprocess from a superseded dispatch attempt — the exact scenario COR-1 already closed at the database-fencing layer — is now also rejected at the IGA-proxy layer, for the same underlying reason: it's still carrying its original, now-stale `dispatch_id`.

### What remains open

- SEC-4 (same-container co-residency read of another process's environment) is unrelated and unaffected — if a co-resident process can read another job's env directly, it can still read that job's `dispatch_id`. This ADR closes the proxy-level forgery (a job claiming to be a run it wasn't dispatched as), not the co-residency read itself.
- `principal` in the audit event is still the shared runtime SA email; this ADR doesn't change what's recorded there, only whether the request is honored for a run it doesn't belong to.

### What does not change

- `LocalRunStore` / local dev — no `dispatch_id` is minted there today, so the new check never triggers; behavior is identical to before this ADR.
- COR-1's dispatch-fencing behavior at the database layer — unchanged; this ADR is an additional consumer of the same value, not a modification of it.
- SEC-1 through SEC-4, COR-2/COR-3/COR-7, AVL-1/2/3, CIP-1 — independent, already resolved.
