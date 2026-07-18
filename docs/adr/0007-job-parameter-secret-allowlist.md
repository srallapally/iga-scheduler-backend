# ADR 0007: Job-Parameter Secret Allowlist

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-18

---

## Context

Sensitive job parameters (`type: "sensitive"`) resolve a `secretRef` through
`SecretManagerParameterResolver`, which runs inside `WorkerRunService.resolveParameters`
under the scheduler service's identity. That identity holds project-wide
`secretmanager.secretAccessor` (see `docs/runbook.md`, IAM setup), which
includes the platform's own secrets: `iga-scheduler-db-password`,
`iga-scheduler-iga-client-id`, `iga-scheduler-iga-client-secret`,
`iga-scheduler-es-api-key`, and `iga-scheduler-github-token`.

This ADR is implemented in PR #54.

`toSecretVersionName` previously accepted any secret the resolving identity
could read, in either of two forms: a bare secret id (`iga-api-key` →
`projects/{proj}/secrets/iga-api-key/versions/latest`) or a fully-qualified
`projects/.../secrets/.../versions/...` string passed through unchanged. An
authenticated caller could create an instance with a sensitive parameter
`secretRef: "iga-scheduler-db-password"` (or the fully-qualified equivalent),
and the broker would resolve the plaintext into the job's context file,
where the job reads it. This is tracked as SEC-2, and is independent of
SEC-1 (credential injection) — it survives that fix and reaches the same
secrets by a different route.

---

## Decision

The resolver enforces an allowlist on the *resolved* secret id, regardless
of which `secretRef` form was used to reach it:

1. Both `secretRef` forms are parsed down to a concrete secret id before any
   check runs. A prefix check on the raw input string would be bypassable
   via the fully-qualified form, so the allowlist is applied only after
   parsing.
2. A fixed denylist of the five known platform secret ids is always
   refused, regardless of prefix configuration (belt-and-suspenders against
   prefix misconfiguration).
3. Otherwise, the secret id must start with `SECRET_PARAM_PREFIX` (env var,
   default `job-param-`). Anything else is refused.
4. A fully-qualified ref naming a different GCP project is refused — job
   parameters live in this project only.

Refusals throw `PARAMETER_SECRET_REF_FORBIDDEN` (new) or
`PARAMETER_SECRET_REF_INVALID` (malformed ref), both non-retryable, without
ever calling `accessSecretVersion` — no read is attempted on a refused id.

This is single-tenant: the allowlist is a flat namespace, not scoped per
tenant.

---

## Consequences

### This is a soft control

The resolving identity's IAM grant is unchanged by this ADR — it still
holds `secretAccessor` on the platform secrets and could physically read
them. The allowlist is an app-layer convention enforced by code, not an
IAM boundary. It closes SEC-2 as reported (the reachable exploit path via
`secretRef`), but the guarantee is contingent on the code path staying
correct.

### Follow-on: IAM hardening (not done here)

The enforced version of this boundary is a separate identity for
job-parameter secret resolution, granted `secretAccessor` only on secrets
matching `SECRET_PARAM_PREFIX`, so platform secrets are physically
unreachable regardless of application code. This plan does not touch
`terraform/service_accounts.tf` — that is a tracked follow-on the SEC-2
resolution depends on for a fully enforced (rather than conventional)
guarantee.

### Operator action required

Job-parameter secrets must be created with the `SECRET_PARAM_PREFIX`
prefix (default `job-param-`) for sensitive parameters to resolve. See
`.env.example` and `docs/runbook.md`.

### What does not change

- `LocalParameterResolver` (local dev) — separate class, out of scope.
- SEC-1 (credential injection) and SEC-3 (completion principal) — independent boundaries.
- Secret versioning/rotation policy.
