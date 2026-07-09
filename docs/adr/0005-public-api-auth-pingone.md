# ADR 0005: Public API Authentication via PingOne

**Status:** Accepted  
**Deciders:** srallapally  
**Date:** 2026-07-08

---

## Context

The scheduler's public HTTP API (job definition upload, instance management, run control, run reads) is currently unprotected — any caller with network access can invoke it. The internal routes (`/internal/**`) are protected by Google OIDC tokens, which is appropriate for machine-to-machine calls from Cloud Scheduler and Cloud Run. The public routes need a separate, externally-usable auth mechanism for human operators and CI pipelines.

PingOne is the organization's identity provider. It supports OAuth 2.0 client credentials and serves JWKS for stateless JWT validation — no token introspection round-trip per request.

---

## Decision

### Authorization Server: PingOne

PingOne issues access tokens via the OAuth 2.0 client credentials grant. Callers obtain a token out-of-band and present it as a `Bearer` token on every public API request.

The scheduler validates tokens entirely locally:

1. Fetch the JWKS endpoint from PingOne (cached with TTL).
2. Verify the JWT signature against the matching key.
3. Verify `iss`, `aud`, and expiry claims.
4. Check for the required scope.

No introspection endpoint is called per request. Token revocation relies on short expiry (standard for machine-to-machine client-credential tokens).

### Grant type: client credentials only

Interactive (user-facing) grants are out of scope. The scheduler is a backend service; all callers are machine identities. Client credentials is the correct grant type.

### Scope: single coarse scope to start

A single scope (`scheduler:admin` or equivalent, configured via environment variable) is required on all protected public routes. Fine-grained scopes (per-resource, per-action) and per-tenant enforcement are explicitly deferred — the initial deployment has a single authorized client with broad access.

### Tenant scoping: deferred

The `tenant_id` columns in `job_instances` and `job_runs` are nullable placeholders. Nothing reads or enforces them today. When tenant scoping is introduced it will be a separate ADR and migration. The concern to track: the run-read path (plan 5) must not accidentally expose cross-tenant runs; this must be addressed before multi-tenant production traffic is routed to those endpoints.

### Internal routes: unchanged

`/internal/**` routes remain protected by Google OIDC bearer tokens (service account email + audience). PingOne middleware is not applied to internal routes.

---

## Consequences

- Plan 5 introduces the PingOne JWT middleware and wires it onto public routes.
- Plan 5 depends on plan 2 (`runStore`) for the run-read endpoints.
- JWKS fetch adds an external dependency at startup; the service should fail fast if the JWKS endpoint is unreachable and `NODE_ENV=production`.
- Tenant scoping must be implemented before the service routes requests from multiple distinct tenants. The current design does not prevent cross-tenant data access — it simply has no multi-tenant traffic to expose.

### Mount-prefix fix

The old `/` blanket mount for the instance router is replaced with explicit prefix mounts (`/job-definitions`, `/job-definitions/:definitionId/instances`, `/job-instances`, `/job-runs`). The `publicAuth` middleware is applied to all four. `/health`, `/ready`, and all `/internal/**` mounts are unaffected.

### `runtimeExecution` exclusion

`GET /job-runs/:runId` and `GET /job-instances/:instanceId/runs` omit the `runtimeExecution` field from responses. This field contains broker-internal Cloud Run Job launch metadata (job execution name, generation, etc.) that has no meaning to public API consumers.

### Required configuration (plan 5)

- `PUBLIC_API_ISSUER` — PingOne issuer URL (used for JWKS discovery and `iss` claim validation)
- `PUBLIC_API_AUDIENCE` — expected `aud` claim on incoming tokens
- `PUBLIC_API_REQUIRED_SCOPE` — optional required scope string (e.g. `scheduler:admin`)
- `PUBLIC_API_JWKS_URL` — optional JWKS URL override (defaults to `${PUBLIC_API_ISSUER}/.well-known/jwks.json`)
