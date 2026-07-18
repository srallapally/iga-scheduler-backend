# Claude Code Plan 9: Admin UI

## Context

The backend exposes a complete public API (Plan 5) secured by PingOne JWT bearer tokens (client-credentials flow). This plan adds a browser-based admin UI as a **separate static SPA** that logs in via PingOne AIC using the **Authorization Code + PKCE** flow (interactive login, not client credentials), then calls the existing public API routes with the resulting access token.

The backend needs one net-new public API endpoint: `POST /job-runs/:runId/cancel` (cancel is currently only on the internal OIDC-protected route). Everything else the UI needs already exists.

## Technology decisions

| Decision | Choice | Rationale |
|---|---|---|
| SPA framework | React 18 + Vite | Minimal, fast, ESM-native; no SSR complexity needed |
| Styling | Tailwind CSS | Utility-first; no design-system dependency |
| OIDC client | `oidc-client-ts` | Battle-tested PKCE + AIC support; no custom crypto |
| HTTP client | native `fetch` | No dep needed; thin wrapper for auth headers |
| Routing | React Router v6 | Handles protected routes, back-button state |
| State | React Context + `useReducer` | No global state lib needed at this scope |
| Build output | `ui/dist/` — served as Cloud Run static via `express.static` or deployed to Cloud Storage + CDN | Keep deployment simple; same Cloud Run service initially |
| Testing | Vitest + React Testing Library | Matches backend test runner; no Jest divergence |

## Locked decisions

- **Auth flow: Authorization Code + PKCE only.** Client credentials is for machine-to-machine; humans log in via auth-code. No implicit flow.
- **No new backend auth system.** The UI gets an access token from AIC, sends it as `Bearer` to the existing `publicAuth` middleware. No session cookies, no server-side session storage.
- **Cancel on the public API.** `POST /job-runs/:runId/cancel` is added to `jobRuns.js` (the public router), not the internal router. It uses `RunControlService` exactly like the internal route does.
- **No tenant scoping.** Deferred — matches Plan 5 deferred scope.
- **SPA lives in `ui/` at the repo root.** Backend and UI are separate npm workspaces. Backend is unmodified except for the cancel endpoint addition and `express.static` mounting in development.

## New env vars (backend)

| Variable | Purpose |
|---|---|
| `UI_DIST_PATH` | Absolute path to `ui/dist`. When set, backend mounts it at `/`. Optional — not set in prod if serving from CDN. |

## New env vars (UI — build-time / `.env`)

| Variable | Purpose |
|---|---|
| `VITE_OIDC_AUTHORITY` | AIC realm URL, e.g. `https://auth.example.com/am/oauth2/realms/root/realms/alpha` |
| `VITE_OIDC_CLIENT_ID` | OAuth client ID registered in AIC for the UI (public client, PKCE) |
| `VITE_OIDC_REDIRECT_URI` | Post-login redirect, e.g. `http://localhost:5173/callback` |
| `VITE_OIDC_POST_LOGOUT_REDIRECT_URI` | Post-logout redirect |
| `VITE_OIDC_SCOPE` | Scopes to request, e.g. `openid profile scheduler:admin` |
| `VITE_API_BASE_URL` | Backend URL, e.g. `http://localhost:3000`. Empty string = same origin. |

## AIC client registration (operator step, not code)

Register a **public OAuth 2.0 client** in the AIC realm:
- Grant type: `authorization_code`
- PKCE: required (`S256`)
- Redirect URIs: `http://localhost:5173/callback` (dev) + the prod Cloud Run URL + `/callback`
- Post-logout redirect URIs: matching origins
- Scopes: `openid profile` + whatever `VITE_OIDC_SCOPE` includes (must match `PUBLIC_API_REQUIRED_SCOPE` on the backend if set)
- Token endpoint auth method: `none` (public client)

---

## REST API reference

All public routes are mounted under the scheduler service base URL and require `Authorization: Bearer <access_token>` (validated by `publicAuth` middleware). All responses are `application/json`.

### Job Definitions

#### `GET /job-definitions`

List all active definitions.

Query params:
- `includeDeleted=true` — include soft-deleted definitions (default: `false`)

Response `200`:
```json
{
  "items": [
    {
      "definitionId": "risk-score",
      "name": "Risk Score",
      "runtime": "javascript",
      "runtimeVersion": "nodejs22",
      "wrapperVersion": "1.0.0",
      "entrypoint": "index.js",
      "parameters": [
        { "name": "scanType", "type": "string", "required": true }
      ],
      "timeoutSeconds": 1800,
      "memoryMb": 256,
      "version": 1,
      "state": "ACTIVE",
      "enabled": true,
      "jobZip": {
        "uri": "gs://bucket/approved/risk-score/abc123/job.zip",
        "sha256": "abc123...",
        "generation": "12345",
        "approval": { "status": "APPROVED", "sha256": "abc123...", "approvedAt": "2026-07-15T10:00:00.000Z" },
        "scan": { "status": "CLEAN", "sha256": "abc123...", "scannedAt": "2026-07-15T10:00:00.000Z" }
      },
      "validation": { "fileCount": 5, "uncompressedBytes": 10240, "validatedAt": "2026-07-15T10:00:00.000Z" },
      "createdAt": "2026-07-15T10:00:00.000Z",
      "updatedAt": "2026-07-15T10:00:00.000Z"
    }
  ]
}
```

#### `POST /job-definitions`

Create a new definition. Request is `multipart/form-data`:
- `file` — the artifact `.zip` (required)
- `metadata` — JSON string of definition metadata (required)

Metadata fields (validated by `createJobDefinitionSchema`):

| Field | Type | Required | Constraints |
|---|---|---|---|
| `definitionId` | string | yes | `[A-Za-z0-9_.-]+` |
| `name` | string | yes | min 1 char |
| `runtime` | string | yes | `javascript` or `python` |
| `runtimeVersion` | string | yes | e.g. `nodejs22`, `python311` |
| `wrapperVersion` | string | yes | e.g. `1.0.0` |
| `entrypoint` | string | yes | relative path, e.g. `index.js` |
| `parameters` | array | no | default `[]` |
| `timeoutSeconds` | integer | no | 30–1800, default 1800 |
| `memoryMb` | integer | no | 64–512 |

ZIP contract: `manifest.json` present, `entrypoint` in zip, no symlinks/path traversal/credential files, ≤200 files, ≤10 MB compressed, ≤50 MB uncompressed.

Response `201`: full definition document (same shape as list item above).

Errors:
- `400` — missing `file` or `metadata`, invalid JSON metadata, Zod validation failure (`{ error, details: [...] }`)
- `409` — `definitionId` already exists

#### `GET /job-definitions/:definitionId`

Get a single definition by ID.

Response `200`: full definition document.
Response `404`: `{ "error": "definition not found" }`

#### `PATCH /job-definitions/:definitionId`

Update mutable fields. Request body (all fields optional, validated by `patchJobDefinitionSchema`):
```json
{
  "name": "Updated Name",
  "enabled": false,
  "timeoutSeconds": 300,
  "memoryMb": 128
}
```

Response `200`: updated definition document.
Errors: `400` Zod validation failure, `404` not found.

#### `DELETE /job-definitions/:definitionId`

Soft-delete a definition (`state: "DELETED"`, `enabled: false`). Idempotent.

Response `200`: updated definition document with `state: "DELETED"`.

---

### Job Instances

#### `GET /job-definitions/:definitionId/instances`

List all instances for a definition.

Response `200`:
```json
{
  "items": [
    {
      "instanceId": "risk-score-nightly",
      "definitionId": "risk-score",
      "definitionVersion": 1,
      "definitionParameterSchema": [...],
      "enabled": true,
      "state": "ACTIVE",
      "schedule": { "type": "cron", "expression": "0 2 * * *", "timezone": "UTC" },
      "nextFireAt": "2026-07-16T02:00:00.000Z",
      "lastFireAt": "2026-07-15T02:00:00.000Z",
      "parameters": { "scanType": "full" },
      "createdAt": "2026-07-01T00:00:00.000Z",
      "updatedAt": "2026-07-15T02:00:01.000Z"
    }
  ]
}
```

#### `POST /job-definitions/:definitionId/instances`

Create a new instance. Request body (validated by `createJobInstanceSchema`):
```json
{
  "instanceId": "risk-score-nightly",
  "schedule": { "type": "cron", "expression": "0 2 * * *", "timezone": "UTC" },
  "enabled": true,
  "parameters": { "scanType": "full" }
}
```

Response `201`: full instance document.
Errors: `400` validation failure, `404` definition not found or not active, `409` instance already exists.

#### `GET /job-instances/:instanceId`

Get a single instance by ID.

Response `200`: full instance document (same shape as list item above).
Response `404`: `{ "error": "instance not found" }`

#### `PATCH /job-instances/:instanceId`

Update mutable fields (`schedule`, `enabled`, `parameters`).

Response `200`: updated instance document.

#### `POST /job-instances/:instanceId/pause`

Disable the instance (`enabled: false`, `state: "PAUSED"`). Shorthand for `PATCH { enabled: false }`.

Response `200`: updated instance document.

#### `POST /job-instances/:instanceId/resume`

Re-enable the instance (`enabled: true`, `state: "ACTIVE"`). Shorthand for `PATCH { enabled: true }`.

Response `200`: updated instance document.

#### `DELETE /job-instances/:instanceId`

Soft-delete an instance (`state: "DELETED"`, `enabled: false`).

Response `200`: updated instance document with `state: "DELETED"`.

#### `POST /job-instances/:instanceId/run-now`

Immediately queue a run for this instance, bypassing the cron schedule. The run is created with `state: "QUEUED"` and a `runId` of `<instanceId>:manual:<uuid>`.

Response `201`:
```json
{
  "runId": "risk-score-nightly:manual:550e8400-e29b-41d4-a716-446655440000",
  "state": "QUEUED",
  "instanceId": "risk-score-nightly"
}
```

Errors:
- `404` — instance not found
- `409` — instance is deleted

---

### Job Runs

#### `GET /job-runs/:runId`

Get a single run. `runtimeExecution` (internal broker metadata) is stripped from the response.

Response `200`:
```json
{
  "runId": "risk-score-nightly:manual:550e8400-...",
  "instanceId": "risk-score-nightly",
  "definitionId": "risk-score",
  "definitionVersion": 1,
  "scheduledFireTime": "2026-07-15T02:00:00.000Z",
  "state": "SUCCEEDED",
  "attempt": 1,
  "dispatchId": "uuid",
  "params": { "scanType": "full" },
  "status": { "phase": "succeeded", "message": "Run completed successfully" },
  "result": { "output": { "recordsProcessed": 142 } },
  "error": null,
  "parentRunId": null,
  "redriveOfRunId": null,
  "cancelRequestedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelReason": null,
  "createdAt": "2026-07-15T02:00:00.100Z",
  "startedAt": "2026-07-15T02:00:01.000Z",
  "endedAt": "2026-07-15T02:04:22.000Z",
  "heartbeatAt": "2026-07-15T02:04:22.000Z",
  "updatedAt": "2026-07-15T02:04:22.000Z"
}
```

State values: `QUEUED` | `RUNNING` | `SUCCEEDED` | `FAILED` | `CANCELLING` | `CANCELLED`

Response `404`: `{ "error": "run not found" }`

#### `GET /job-instances/:instanceId/runs`

List runs for an instance, newest first.

Query params:
- `limit` — integer 1–200, default 50
- `state` — filter by state (e.g. `state=RUNNING`)

Response `200`:
```json
{
  "items": [ /* array of run documents, same shape as GET /job-runs/:runId */ ]
}
```

#### `POST /job-runs/:runId/cancel` _(net-new, added in Step 9.1)_

Request cancellation of a run. Valid for states: `QUEUED`, `RUNNING`, `CANCELLING`.

Request body (optional):
```json
{ "reason": "Cancelled by admin" }
```

Response `202` — one of three outcomes depending on current state:

```json
// QUEUED → immediately transitioned to CANCELLED
{ "status": "cancelled", "action": "cancel", "runId": "...", "state": "CANCELLED" }

// RUNNING → transitioned to CANCELLING; runtime asked to stop
{ "status": "cancelling", "action": "cancel", "runId": "...", "state": "CANCELLING" }

// Already CANCELLING (idempotent)
{ "status": "cancelling", "action": "cancel", "runId": "...", "state": "CANCELLING", "idempotent": true }

// Already CANCELLED (idempotent)
{ "status": "cancelled", "action": "cancel", "runId": "...", "state": "CANCELLED", "idempotent": true }
```

Errors:
- `404` — run not found
- `409` — run is in a non-cancellable state (`SUCCEEDED`, `FAILED`)

---

## API usage map per UI page

| Page | API calls made |
|---|---|
| `DefinitionsPage` | `GET /job-definitions` |
| `DefinitionDetailPage` | `GET /job-definitions/:id`, `GET /job-definitions/:id/instances` |
| `InstancesPage` | `GET /job-definitions` → `GET /job-definitions/:id/instances` for each (fan-out) |
| `InstanceDetailPage` | `GET /job-instances/:id`, `GET /job-instances/:id/runs?limit=20`, `POST /job-instances/:id/run-now` |
| `RunDetailPage` | `GET /job-runs/:id` (+ poll every 5s while QUEUED/RUNNING), `POST /job-runs/:id/cancel` |
| Upload modal | `POST /job-definitions` (multipart) |

---

## Step 9.1 — Backend: public cancel endpoint

**File:** `src/routes/jobRuns.js`

Add `POST /job-runs/:runId/cancel` to the public router (alongside the existing `GET /job-runs/:runId`). Accepts optional `{ reason: string }` body. Delegates to `RunControlService.cancelRun()`. Returns `202` with the result, or the appropriate 4xx from `RunControlService`.

`createJobRunRouter` currently receives `{ runStore }`. Extend to also accept `{ runControlService }` (lazy-init `new RunControlService({ runStore })` if not injected, same pattern as `internalWorker.js`).

```js
// contract addition to createJobRunRouter
router.post("/:runId/cancel", async (req, res, next) => {
  try {
    const result = await getRunControlService().cancelRun({
      runId: req.params.runId,
      reason: req.body?.reason
    });
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});
```

**Test:** `test/job-run-cancel-public.test.js`
- `202` with `{ status: "cancelling", state: "CANCELLING" }` when run is RUNNING
- `202` with `{ status: "cancelled", state: "CANCELLED" }` when run is QUEUED
- `202` idempotent when already CANCELLED or CANCELLING
- `404` propagated when run not found
- `409` propagated when run is in non-cancellable state (SUCCEEDED, FAILED)

## Step 9.2 — Backend: serve UI static files in dev/prod (optional mount)

**File:** `src/createApp.js`

When `UI_DIST_PATH` env var is set, mount `express.static(UI_DIST_PATH)` at `/` before the `globalErrorHandler`, and add a SPA fallback (`*` → `index.html`) so client-side routing works.

```js
// inside createApp(), after all routes, before globalErrorHandler:
if (process.env.UI_DIST_PATH) {
  app.use(express.static(process.env.UI_DIST_PATH));
  app.get("*", (_req, res) => res.sendFile(path.join(process.env.UI_DIST_PATH, "index.html")));
}
```

This is opt-in and off by default — prod can serve from CDN without it. No test needed; it's a thin Express built-in.

## Step 9.3 — UI workspace scaffold

**New files:**

```
ui/
  package.json          # name: "iga-scheduler-ui", type: "module"
  vite.config.js        # proxy /job-* and /health to VITE_API_BASE_URL in dev
  index.html
  src/
    main.jsx
    App.jsx
    auth/
      AuthProvider.jsx  # oidc-client-ts UserManager, Context, hook
      useAuth.js
      CallbackPage.jsx  # handles the /callback redirect
    api/
      client.js         # fetch wrapper: injects Authorization header, handles 401
    pages/
      LoginPage.jsx
      DefinitionsPage.jsx
      DefinitionDetailPage.jsx
      InstancesPage.jsx
      InstanceDetailPage.jsx
      RunDetailPage.jsx
    components/
      ProtectedRoute.jsx
      NavBar.jsx
      StatusBadge.jsx
      Spinner.jsx
```

**Root `package.json`** — add `"workspaces": ["ui"]` so `npm install` from root installs both.

## Step 9.4 — Auth layer (`ui/src/auth/`)

**`AuthProvider.jsx`**

Wraps the app. Constructs a `UserManager` from `oidc-client-ts` using the `VITE_OIDC_*` env vars:
```js
new UserManager({
  authority: import.meta.env.VITE_OIDC_AUTHORITY,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI,
  post_logout_redirect_uri: import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI,
  scope: import.meta.env.VITE_OIDC_SCOPE || "openid profile",
  response_type: "code",
  automaticSilentRenew: true,
})
```

Exposes `{ user, isLoading, login, logout }` via Context.

`user` is the `oidc-client-ts` `User` object. `user.access_token` is what gets sent to the backend as the `Bearer` token.

**`CallbackPage.jsx`**

Calls `userManager.signinRedirectCallback()`, then navigates to `/definitions`.

**`useAuth.js`** — `useContext(AuthContext)` convenience hook.

## Step 9.5 — API client (`ui/src/api/client.js`)

Thin fetch wrapper. All calls go through `apiFetch(path, options)`:
- Reads `user.access_token` from auth context (or from `UserManager.getUser()` directly to avoid circular imports)
- Adds `Authorization: Bearer <token>` header
- On `401`: calls `userManager.signinRedirect()` to re-authenticate
- Returns parsed JSON or throws with `{ status, message }`

Exported helpers matching the API reference above:
```js
export const api = {
  definitions: {
    list: () =>
      apiFetch("/job-definitions"),
    get: (id) =>
      apiFetch(`/job-definitions/${id}`),
    create: (formData) =>
      apiFetch("/job-definitions", { method: "POST", body: formData }),
      // formData: FormData with fields "file" (Blob) and "metadata" (JSON string)
  },
  instances: {
    listForDefinition: (definitionId) =>
      apiFetch(`/job-definitions/${definitionId}/instances`),
    get: (instanceId) =>
      apiFetch(`/job-instances/${instanceId}`),
    runs: (instanceId, { limit = 20, state } = {}) => {
      const p = new URLSearchParams({ limit });
      if (state) p.set("state", state);
      return apiFetch(`/job-instances/${instanceId}/runs?${p}`);
    },
    runNow: (instanceId) =>
      apiFetch(`/job-instances/${instanceId}/run-now`, { method: "POST" }),
  },
  runs: {
    get: (runId) =>
      apiFetch(`/job-runs/${encodeURIComponent(runId)}`),
    cancel: (runId, reason) =>
      apiFetch(`/job-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }),
  },
};
```

Note: `runId` values contain colons (e.g. `risk-score-nightly:manual:uuid`) — always `encodeURIComponent` before embedding in a URL path.

## Step 9.6 — Routing and pages

**`App.jsx`** — React Router routes:

| Path | Component | Auth required |
|---|---|---|
| `/login` | `LoginPage` | No |
| `/callback` | `CallbackPage` | No |
| `/definitions` | `DefinitionsPage` | Yes |
| `/definitions/:id` | `DefinitionDetailPage` | Yes |
| `/instances` | `InstancesPage` | Yes |
| `/instances/:id` | `InstanceDetailPage` | Yes |
| `/runs/:id` | `RunDetailPage` | Yes |
| `/` | redirect → `/definitions` | — |

`ProtectedRoute` checks `isLoading` (spinner) → `user` (render children) → else redirect to `/login`.

**Page specs:**

`DefinitionsPage`
- Calls `api.definitions.list()` on mount → `GET /job-definitions`
- Table columns: `definitionId`, `name`, `runtime`, `runtimeVersion`, `enabled`, `createdAt`
- Each row links to `/definitions/:definitionId`
- "New Definition" button → opens upload modal (Step 9.7)

`DefinitionDetailPage`
- Calls `api.definitions.get(id)` → `GET /job-definitions/:id`
- Shows all definition fields; `jobZip.approval.status` and `jobZip.scan.status` displayed as badges
- "Instances" section: calls `api.instances.listForDefinition(id)` → `GET /job-definitions/:id/instances`
- Instances table: `instanceId`, `schedule.expression`, `enabled`, `state`, `nextFireAt`; each row links to `/instances/:instanceId`

`InstancesPage`
- No flat list endpoint exists — fan-out: call `api.definitions.list()`, then `api.instances.listForDefinition(id)` for each definition in parallel (`Promise.all`)
- Table: `instanceId`, `definitionId`, `schedule.expression`, `enabled`, `state`, `nextFireAt`; each row links to `/instances/:instanceId`

> **Gap note:** There is no `GET /job-instances` top-level list endpoint. The fan-out is acceptable at low scale. A backend endpoint can be added in a follow-on plan if needed.

`InstanceDetailPage`
- Calls `api.instances.get(id)` → `GET /job-instances/:id`
- Shows: `instanceId`, `definitionId`, `schedule`, `enabled`, `state`, `nextFireAt`, `lastFireAt`, `parameters`
- "Runs" section: calls `api.instances.runs(id, { limit: 20 })` → `GET /job-instances/:id/runs?limit=20`
- Runs table: `runId` (truncated), `state` badge, `scheduledFireTime`, `startedAt`, `endedAt`, `status.message`; each row links to `/runs/:runId`
- "Run Now" button → calls `api.instances.runNow(id)` → `POST /job-instances/:id/run-now`; on `201` shows the new `runId` and refreshes the runs list

`RunDetailPage`
- Calls `api.runs.get(id)` → `GET /job-runs/:id` on mount
- Auto-refreshes every 5 seconds while `state` is `QUEUED` or `RUNNING`; stops polling on `SUCCEEDED`, `FAILED`, `CANCELLED`
- Displays:
  - Header: `runId`, `state` badge, `attempt`
  - Timing: `scheduledFireTime`, `startedAt`, `endedAt`, computed duration
  - `status.phase` + `status.message`
  - `error` block when present: `error.code`, `error.message`, `error.retry.retryable`
  - `result.output` block when present: formatted JSON
  - Redrive ancestry: `redriveOfRunId` / `parentRunId` links when present
- **Cancel button**: shown only when `state` is `QUEUED` or `RUNNING`
  - Calls `api.runs.cancel(runId, reason)` → `POST /job-runs/:runId/cancel`
  - On `202`: refreshes run state; button label changes to "Cancellation requested" when state becomes `CANCELLING`
  - On `409`: shows "Run cannot be cancelled from its current state"

## Step 9.7 — New definition upload modal

Inline modal on `DefinitionsPage`. Calls `POST /job-definitions` as `multipart/form-data`.

Fields:

| Field | Input | Validation |
|---|---|---|
| Definition ID | text | `[A-Za-z0-9_.-]+`, required |
| Name | text | required |
| Runtime | select | `javascript` / `python` |
| Runtime Version | text | required (e.g. `nodejs22`, `python311`) |
| Wrapper Version | text | required (e.g. `1.0.0`) |
| Entrypoint | text | required, relative path (e.g. `index.js`) |
| Timeout (seconds) | number | 30–1800 |
| Artifact ZIP | file | `.zip` only, required |

On submit:
1. Build a `FormData`: `formData.append("file", zipFile)` + `formData.append("metadata", JSON.stringify({ definitionId, name, runtime, ... }))`
2. Call `api.definitions.create(formData)` — the `apiFetch` wrapper must **not** set `Content-Type` when body is `FormData` (browser sets it with the correct boundary automatically)
3. On `201`: close modal, refresh definitions list
4. On `400` with `details` array (Zod errors): render each issue inline next to its field
5. On `409`: show "A definition with this ID already exists"

## Step 9.8 — UI tests

**`ui/src/__tests__/`** — Vitest + React Testing Library

Minimum coverage:
- `AuthProvider.test.jsx` — unauthenticated renders login redirect; authenticated renders children with user in context
- `ProtectedRoute.test.jsx` — redirects to `/login` when no user; renders children when user present
- `client.test.js` — `apiFetch` injects `Authorization: Bearer` header from user token; on `401` response calls `signinRedirect`; `runId` values are `encodeURIComponent`-encoded in paths
- `RunDetailPage.test.jsx`:
  - Cancel button visible when state is `RUNNING` or `QUEUED`
  - Cancel button hidden when state is `SUCCEEDED`, `FAILED`, or `CANCELLED`
  - Cancel button calls `POST /job-runs/:id/cancel` with correct body
  - Auto-refresh polling stops when state transitions to a terminal state
  - `error.code` and `error.message` rendered when present
  - `result.output` rendered as formatted JSON when present
- `DefinitionsPage.test.jsx` — renders definition list; "New Definition" opens modal
- `UploadModal.test.jsx` — submits correct `FormData` fields; Zod errors rendered per-field; `409` shows duplicate message

## Step 9.9 — Wiring and run scripts

**`ui/package.json`** scripts:
```json
{
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "test": "vitest run"
}
```

**`vite.config.js`** — dev proxy so the browser doesn't need CORS configured:
```js
server: {
  proxy: {
    "/job-definitions": "http://localhost:3000",
    "/job-instances": "http://localhost:3000",
    "/job-runs": "http://localhost:3000",
    "/health": "http://localhost:3000",
  }
}
```

**Root `package.json`** — add convenience scripts:
```json
"ui:dev": "npm run dev --workspace=ui",
"ui:build": "npm run build --workspace=ui",
"ui:test": "npm run test --workspace=ui"
```

## Stop Condition

- `npm test` (backend) green
- `npm run ui:test` green
- `npm run ui:dev` starts the Vite dev server; login → definitions list → instance detail → run detail → cancel all work end-to-end against a local backend
- `npm run ui:build` produces a `ui/dist/` that the backend can serve via `UI_DIST_PATH`

## Out of scope

- Pagination (limit=50 default is sufficient for the initial admin view)
- Create / edit / delete instance via UI (view-only for instances in this plan)
- Pause / resume instance via UI
- Redrive via UI
- Role-based access control / claim-based authorization beyond the single `scheduler:admin` scope
- CDN deployment / Cloud Storage hosting (operator step documented in README, not automated)
- Dark mode
