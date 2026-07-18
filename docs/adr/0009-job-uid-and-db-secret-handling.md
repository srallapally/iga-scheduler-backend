# ADR 0009: DB Password via Secret Manager; Job-UID Separation Deferred

**Status:** Accepted (partial — see Decision)  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

The worker/broker process and every job subprocess share UID `node` in a
single container (`runtime-containers/worker/Dockerfile`; jobs spawned
in-process by `JobRuntimeExecutor._spawnEntrypoint`). Same-UID processes can
read PID 1's environment via `/proc/1/environ`, so any secret the server
process holds is reachable by job code. After SEC-1, the worker no longer
holds IGA credentials, but it still mounted `DB_PASSWORD` for `createPgPool`
(`src/clients/pgClient.js`), and the scheduler process (where job-parameter
resolution runs) holds more. SEC-1's guarantee explicitly leans on this gap
being closed. This is tracked as SEC-4.

The planned fix had two coupled parts:

- **(a)** Run job subprocesses under a dedicated unprivileged uid
  (`jobrunner`), distinct from the server's `node`, via a setuid helper
  (`gosu`), so the kernel blocks a job's cross-uid read of
  `/proc/1/environ`.
- **(b)** Stop mounting `DB_PASSWORD` as an env var; fetch it from Secret
  Manager into memory at pool-creation time, so `/proc/<server-pid>/environ`
  has no DB password to leak regardless of uid.

The plan required part (a) to be verified in a real container build under
the target sandbox (Cloud Run's gVisor) before shipping — "the runtime
honoring the setuid bit" was explicitly called out as unconfirmed, with a
documented fallback if it could not be verified.

This ADR is implemented in PR #57.

---

## Decision

**(b) is shipped. (a) is deferred**, per the plan's own fallback clause.

This environment has no Docker daemon available (`docker` CLI present, but
`/var/run/docker.sock` does not exist) and no path to deploy to actual
Cloud Run to observe gVisor's real setuid behavior — building and testing
a real container was out of reach here, and asserting (a) works from source
alone is exactly what the plan said not to do ("Container behavior claims
about uid separation verified in a real container build, not asserted from
source"). Rather than ship an unverified privilege-drop mechanism, (a) is
deferred to the container-per-job rework (AVL-1), which achieves the same
end — and more — structurally: a separate container per run has no shared
UID with the server at all, making this question moot.

### What (b) does

`createPgPool` (`src/clients/pgClient.js`) fetches the Cloud SQL password
from Secret Manager via `resolveCloudSqlPassword`, given `DB_PASSWORD_SECRET`
(a secret id or fully-qualified resource name). The fetched value is held
only in the pool's local config, never assigned to `process.env`. When
`DB_PASSWORD_SECRET` is unset, no password is used (preserving the
IAM-database-auth deployment mode, unchanged from before). The `direct`
engine path (`DATABASE_URL`, used by local dev and migrations) is
unchanged.

Both the worker and scheduler Cloud Run deploy steps in `cloudbuild.yaml`
were updated symmetrically: `DB_PASSWORD` removed from `--set-secrets`,
`DB_PASSWORD_SECRET=iga-scheduler-db-password` added to `--set-env-vars`
(the secret's name, not its value — not sensitive). No IAM change was
needed; the resolving service accounts already hold `secretAccessor` on
`iga-scheduler-db-password`.

---

## Consequences

### What this closes

The DB password is no longer present in either service's process
environment. A same-uid `/proc/<pid>/environ` read (by a job subprocess,
or any other same-uid process) can no longer recover it.

### What remains open

Job subprocesses still share UID `node` with the server. SEC-4's
same-container, job↔server credential-boundary concern is only partially
closed by this ADR:

- No secret currently mounted as an env var on either service remains
  readable via `/proc/1/environ` (IGA creds removed in SEC-1; DB password
  removed here). If a future secret is ever added as an env var, this gap
  reopens for it specifically.
- Job↔job mutual isolation (one job reading another concurrently-running
  job's per-run extract directory) is unaddressed — moot without part (a),
  since no job-specific uid exists to separate them by.
- The structural fix (container-per-job, AVL-1) remains the only path to
  full isolation, including protecting secrets not yet identified.

### Follow-on

Part (a) — and the concurrent-job mutual-isolation question it partially
raises — is deferred to AVL-1. Whoever picks up AVL-1 should re-evaluate
whether `gosu`/setuid is still the right mechanism or whether
container-per-job supersedes the question entirely (it does, structurally).

### What does not change

- SEC-1, SEC-2, SEC-3 — independent, already resolved.
- The `direct` engine / local dev / migration path.
- IAM: no bindings changed; the existing `secretAccessor` grant on
  `iga-scheduler-db-password` is reused as-is.
