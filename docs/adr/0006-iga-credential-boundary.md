# ADR 0006: IGA Credential Boundary — Broker-Only Access for Job Subprocesses

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

`JobRuntimeExecutor` spawns job artifacts as child processes (Node and
Python) and previously forwarded the worker's raw IGA client-credentials
(`IGA_CLIENT_ID`, `IGA_CLIENT_SECRET`, `IGA_TOKEN_ENDPOINT`,
`IGA_BASE_URL`) directly into every job subprocess's environment. Because
`_spawnEntrypoint` calls `spawn(command, args, { env: extraEnv })` — the
constructed `extraEnv` object *is* the entire subprocess environment, not
an overlay on `process.env` — those four vars were the only reason a job
could reach the IGA platform directly instead of through
`RuntimeIgaProxyService` (the broker), bypassing its RUNNING-state gate and
per-request audit trail.

The client-credentials grant is not tied to run lifecycle, so a job
artifact holding these credentials gains durable, unaudited IGA-tenant
access that outlives the run itself. This is tracked as SEC-1.

Both SDKs already prefer the broker path whenever `IGA_BROKER_URL` is
present: JS `buildIgaClient` (`src/sdk/scheduler-sdk.js`) and Python
`resolve_iga_client` (`sdk/python/iga_scheduler/iga_client.py`) both return
a `BrokerIgaClient` in that case, falling back to a direct client only when
the broker URL is absent. `IGA_BROKER_URL` (mapped from
`RUNTIME_BROKER_URL`) is injected into the subprocess unconditionally in
both spawn paths, so the broker path is unaffected by removing the direct
credentials.

---

## Decision

Production jobs reach IGA only through the broker proxy
(`RuntimeIgaProxyService` + the `/internal/runtime-broker` route in
`internalIga.js`). Direct IGA credentials (`IGA_CLIENT_ID`,
`IGA_CLIENT_SECRET`, `IGA_TOKEN_ENDPOINT`, `IGA_BASE_URL`) are never
present in the worker service's environment or in any job subprocess
environment:

- `JobRuntimeExecutor` no longer forwards these four vars into either the
  Node or Python subprocess `extraEnv`. `IGA_BROKER_URL` is still forwarded.
- The worker's Cloud Run deploy step (`cloudbuild.yaml`) no longer sets
  these vars as env vars or mounts them as secrets. The scheduler service's
  deploy step is unchanged — it still needs all four to run the broker
  proxy and its own IGA token management.
- `validateWorkerStartupConfig` no longer requires these vars at worker
  startup. `validateProductionStartupConfig` (scheduler) is unchanged.

The direct-credential client (`DirectIgaClient` in the JS SDK, the
equivalent Python path, and `LocalWorkerRunService`'s `igaDirect` context)
remains a local-dev-only fallback, used when `IGA_BROKER_URL` is absent and
the four direct vars are present. It is not reachable in production once
the worker's env no longer carries those vars.

---

## Consequences

### What this closes

A job artifact executing in the worker service can no longer read or use
the IGA client-credentials grant directly — its only path to IGA is the
broker, which enforces that the calling run is in the RUNNING state and
records a per-request audit trail.

### What this does not close (SEC-4)

This ADR does not address SEC-4: a job subprocess co-resides in the same
container as the worker process and can, in principle, read
`/proc/1/environ` or otherwise inspect co-resident process state. Until
SEC-4 is fixed (separate UID or a container-per-job boundary), a job could
still read secrets a co-resident worker process holds. The broker-only
rule this ADR establishes depends on SEC-4 being closed for the boundary
to be complete — this ADR removes the secret from the worker's own
environment specifically so there is nothing for a co-residency read to
find, but does not itself harden against co-residency reads of unrelated
secrets.

### What does not change

- The broker proxy's behavior, request verification, and audit path.
- The JS and Python SDKs' client-selection logic.
- Local dev (`APP_MODE=local`), which continues to use direct credentials
  by design.
