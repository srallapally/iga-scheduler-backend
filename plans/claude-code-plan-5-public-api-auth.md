# Claude Code Plan 5: Public API Authentication (PingOne) + Run Read Endpoints

## Context

`/job-definitions` and `/job-instances/*` currently have no authentication. This plan puts them behind PingOne-issued OAuth access tokens (client credentials, JWT validated via JWKS) and adds read-only run visibility endpoints — a public API for a scheduler is unusable without run status. Tenant scoping is explicitly deferred; validation is authentication plus a single coarse scope.

Depends on plan 2 (`runStore` for the read endpoints). Independent of plans 3–4.

## Assumptions

- PingOne environment issues JWT access tokens with standard `iss`, `aud`, `exp`, `client_id`/`sub` claims and publishes JWKS at the OIDC discovery location. Env vars:
  - `PUBLIC_API_ISSUER` — e.g. `https://auth.pingone.com/{envId}/as`
  - `PUBLIC_API_AUDIENCE` — the API's registered audience/resource identifier
  - `PUBLIC_API_REQUIRED_SCOPE` — optional; when set, tokens must carry it (space-delimited `scope` claim). Start with a single scope, e.g. `scheduler:admin`.
- Token validation library: `jose` (`createRemoteJWKSet` + `jwtVerify`). JWKS URL derived as `${PUBLIC_API_ISSUER}/.well-known/openid-configuration` → `jwks_uri`, or configured directly via `PUBLIC_API_JWKS_URL` (support both; direct URL wins). Verify actual PingOne discovery/JWKS paths during implementation.
- Follow the existing `internalAuth.js` pattern: factory returning middleware, injectable `verifyToken` for tests. Consistency over novelty.
- `/health` and `/ready` stay unauthenticated (infra probes). All `/internal/*` auth unchanged.
- Tenant scoping deferred: no claim-to-tenant mapping, no per-tenant filtering. `ADR 0005` records this.

## Out of Scope

- Human/operator interactive login (auth-code flow) — client credentials only.
- Fine-grained scopes per route.
- Rate limiting, API keys, CORS policy work.

## Stop Condition

All steps complete, `npm test` green including the auth accept/reject matrix. No docker/gcloud/deploy commands.

---

## Step 5.1 — Dependency

**File:** `package.json` — add `jose`.

## Step 5.2 — Public auth middleware

**File:** `src/middleware/publicAuth.js`

```js
// src/middleware/publicAuth.js — contract
// createPublicAuthMiddleware({
//   issuer = process.env.PUBLIC_API_ISSUER,
//   audience = process.env.PUBLIC_API_AUDIENCE,
//   requiredScope = process.env.PUBLIC_API_REQUIRED_SCOPE,
//   jwksUrl = process.env.PUBLIC_API_JWKS_URL,   // optional override
//   verifyToken                                   // injectable for tests
// })
//
// Behavior:
// - throws at construction if issuer or audience missing (matches internalAuth style)
// - default verifyToken: jose jwtVerify against createRemoteJWKSet (cached across
//   requests — construct the JWKSet once in the factory, not per request),
//   options { issuer, audience }
// - missing/malformed Authorization header -> 401 { error: "missing bearer token" }
// - signature/issuer/audience/exp failure -> 401 { error: "invalid bearer token" }
// - requiredScope set and absent from the token's scope claim -> 403
//   { error: "insufficient scope" }
// - success: req.publicAuth = { claims, clientId: claims.client_id || claims.sub }
```

Do not log token contents. Do not distinguish failure causes in response bodies beyond 401 vs 403.

### Acceptance criteria
- Construction throws with named missing vars.
- Matrix (with injected `verifyToken`): no header → 401; bad token → 401; valid token wrong audience → 401; valid token missing required scope → 403; valid token with scope → next() and `req.publicAuth` populated.
- JWKS set constructed once per middleware instance (test: factory called once across N requests).

## Step 5.3 — Apply to public routes

**File:** `src/createApp.js`

- Construct one `publicAuthMiddleware` (options injectable via `createApp` params, same pattern as the internal routers).
- Apply to `app.use("/job-definitions", ...)` and the job-instance router mount. Keep `/health`, `/ready` open; `/internal/*` untouched.
- Ordering note: the instance router is mounted at `/`; either scope the middleware to its specific paths (`/job-definitions`, `/job-instances`) or — better — change the instance router mount to explicit prefixes so a blanket `/` mount no longer exists. Prefer the mount fix; it removes a standing foot-gun. Route paths inside the router then drop their duplicated prefixes. Verify no path behavior changes with route tests.

### Acceptance criteria
- Every definition/instance route returns 401 without a token and works with a valid one (supertest with injected verifier).
- `/health`, `/ready`, and all `/internal/*` behavior unchanged.
- No route is reachable through an unauthenticated `/` mount.

## Step 5.4 — Run read endpoints

**Files:** `src/routes/jobRuns.js` (new), `src/createApp.js`, `src/stores/runStore.js`

- `GET /job-runs/:runId` → `runStore.getRun`; 404 when null. Response: the run document minus internals not meant for consumers — return as-is for now except `runtime_execution` (broker-internal launch metadata); document the exclusion.
- `GET /job-instances/:instanceId/runs?limit=&state=` → new store method `listRunsForInstance({ instanceId, limit = 50, state })` — `SELECT ... WHERE instance_id=$1 [AND state=$2] ORDER BY created_at DESC LIMIT $3` (index from plan 1 covers it). Response `{ items: [...] }`.
- Both behind `publicAuthMiddleware`.

### Acceptance criteria
- Both endpoints require auth, return documented shapes, and 404/empty-list correctly.
- `runtimeExecution` absent from responses.

## Step 5.5 — Production validation and ADR

**Files:** `src/config/productionValidation.js`, `docs/adr/0005-public-api-auth-pingone.md`

- Require `PUBLIC_API_ISSUER` and `PUBLIC_API_AUDIENCE` in production.
- Update ADR 0005 status to Accepted; record the mount-prefix fix and the `runtimeExecution` exclusion.

### Acceptance criteria
- Production validation fails without the two vars; its tests updated.

## Step 5.6 — Tests

**Files:** `test/publicAuth.test.js`, `test/publicRoutes.test.js`, `test/jobRuns.routes.test.js`

Covering the matrices above via supertest with the injectable verifier; one integration test with a locally-signed JWT and a local JWKS (jose can generate a keypair and serve the JWKS via the `jwksUrl` override) to exercise the real verification path without PingOne.

---

## Definition of Done

- All public definition/instance/run routes: 401 without a valid PingOne-style token, 403 without the required scope, functional with both.
- No unauthenticated route exists outside `/health`, `/ready`, and OIDC-protected `/internal/*`.
- Read-only run visibility available (`GET /job-runs/:runId`, `GET /job-instances/:instanceId/runs`).
- Real-JWT integration test passes against a local JWKS.
- `npm test` green.
