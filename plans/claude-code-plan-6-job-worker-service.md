# Claude Code Plan 6: Job Worker Service + Injected SDK + `igaClient`

## Context

Jobs currently execute via `JobRuntimeExecutor` (local child process) or `CloudRunJobRuntimeLauncher` (Cloud Run Job, cold-start per execution). This plan:

1. Replaces `CloudRunJobRuntimeLauncher` with a persistent Cloud Run Service (`iga-job-worker`) that runs `JobRuntimeExecutor` — eliminating cold starts.
2. Builds a canonical server-side SDK (`src/sdk/scheduler-sdk.js`) that is injected into every job's extraction directory at runtime, replacing the hand-copied stubs in each example job.
3. Exposes `context.igaClient.execute(method, path, body?)` as the sole IGA surface for jobs — proxied through the existing `RuntimeIgaProxyService`, with all token operations handled by the SDK (never by job code).
4. Implements graceful drain on the worker service so Cloud Run scale-down events cannot kill in-flight jobs.

Depends on plans 1–4 (PG foundation, run lifecycle, instances/tick, deletion pass). Independent of plan 5.

## Assumptions

- All jobs belong to a single tenant. Process-level isolation (the existing `JobRuntimeExecutor` model) is sufficient; container-level isolation is not required.
- The `iga-job-worker` Cloud Run Service is a new image built from this repo. Its entry point is `src/workers/app.js`. Terraform provisions it.
- The worker service runs with the same `RUNTIME_SERVICE_ACCOUNT_EMAIL` as the current Cloud Run Job — no new service account needed.
- Token for the worker service's `/execute` endpoint: Google OIDC, same `internalAuth` pattern as all other internal routes.
- `BrokerIgaClient` fetches a Google OIDC token from the GCP metadata server. In local mode (no `IGA_BROKER_URL`, but `IGA_BASE_URL` + `IGA_TOKEN_ENDPOINT` + `IGA_CLIENT_ID` + `IGA_CLIENT_SECRET` present) it falls back to a direct client using `TokenManager`. This is the only place `igaDirect`-style config is honoured; it is not a supported production path.
- `min-instances: 1`, `cpu-always-allocated`, and `shutdown-timeout = WORKER_MAX_TIMEOUT_SECONDS` are Terraform/Cloud Run config — documented as operator steps, not code.
- `npm test` must be green at every step.
- No docker, gcloud, or deployment commands in this plan.

## Out of Scope

- Stale-RUNNING sweep (noted in plan-index caveat; still out of scope).
- Multi-tenant isolation or per-tenant job sandboxing.
- Named IGA capability wrappers (`riskScores.recompute`, `health.check`) — replaced by `igaClient.execute` with explicit paths.

## Stop Condition

All steps complete, `npm test` green, `CloudRunJobRuntimeLauncher` deleted, both example jobs updated, SDK injected by executor, `src/runtime/iga.js` bridge machinery deleted.

---

## Step 6.1 — Canonical SDK: `src/sdk/scheduler-sdk.js`

Create `src/sdk/scheduler-sdk.js`. This is the file injected into every job's extraction directory at runtime.

### Exports

**`SchedulerJob`** — base class. `run(context)` provides the execution harness (no changes to its surface; the stale example stubs referenced `context.logger`/`context.audit` which never existed — `run()` should only catch errors and call `execute(context)`, no audit events):

```js
export class SchedulerJob {
  async run(context) {
    return this.execute(context);
  }
  async execute(_context) {
    throw new Error("execute(context) must be implemented");
  }
}
```

**`createContext(env)`** — reads `IGA_SCHEDULER_CONTEXT_FILE` from `env`, parses it, returns:

```js
{
  runId,
  params,        // raw params object from context file
  param,         // createParameterReader(params) — existing API
  definition,
  instance,
  scheduledFireTime,
  attempt,
  igaClient,     // BrokerIgaClient instance
}
```

`BrokerIgaClient` is constructed from `env.IGA_BROKER_URL` and `env.IGA_SCHEDULER_RUN_ID`. If `IGA_BROKER_URL` is absent but all four `igaDirect` vars are present, constructs the local fallback client instead (see step 6.2).

**`runJob(JobClass, env = process.env)`** — convenience entrypoint:

```js
export async function runJob(JobClass, env = process.env) {
  const context = await createContext(env);
  const job = new JobClass();
  const result = await job.run(context);
  process.stdout.write(`IGA_RESULT_JSON:${JSON.stringify(result)}\n`);
}

// auto-run if this file is the entrypoint (but jobs import it, so they call runJob themselves)
```

`runJob` is called explicitly by `main()` in each job file — it does not auto-execute on import.

### Acceptance criteria

- `src/sdk/scheduler-sdk.js` exists and exports `SchedulerJob`, `createContext`, `runJob`.
- Unit test: `createContext` with a temp context file returns the correct shape including a `igaClient` with an `execute` method.
- Unit test: `runJob` calls `execute`, captures the result, writes `IGA_RESULT_JSON:...` to stdout.
- `npm test` green.

---

## Step 6.2 — `src/sdk/BrokerIgaClient.js`

Single class with one public method: `execute(method, path, body?)`.

### Production path (`IGA_BROKER_URL` present)

Posts `{ runId, method, path, body }` to `${brokerUrl}/internal/runtime/iga/request`.

Auth: Google OIDC token fetched from the GCP metadata server:

```
GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity
    ?audience=<brokerUrl>&format=full
    Metadata-Flavor: Google
```

Token caching: store `{ token, expiresAt }`. Re-fetch when within 60 s of expiry. On 401 from the broker: clear cache, retry once.

On non-OK response: throw an error with `.status` set to the HTTP status code, and `.message` from the response body's `message` field or `HTTP <status>`. This matches the shape `create-managed-users-job` already expects for its 409-conflict handling.

### Local fallback path (`IGA_BROKER_URL` absent, direct vars present)

Construct a `TokenManager` (imported from `../../src/iga/tokenManager.js` — this import works because the SDK is in the same repo; when injected, the executor writes only `scheduler-sdk.js` into the extract dir, but `BrokerIgaClient` is inlined into `scheduler-sdk.js` — see step 6.3). Posts directly to `${IGA_BASE_URL}${path}`.

**Important:** `BrokerIgaClient` is a separate source file during development, but is inlined into `scheduler-sdk.js` at the point of use (or `scheduler-sdk.js` imports it using a path relative to `src/sdk/`). The executor injects only `scheduler-sdk.js` — not the whole `src/` tree. Therefore `scheduler-sdk.js` must be self-contained: either inline `BrokerIgaClient` directly, or the executor must also copy `BrokerIgaClient.js` alongside it (see step 6.4 for the decision).

### Acceptance criteria

- Unit tests covering: successful execute (mocked fetch), token caching (second call reuses token), 401 retry (token invalidated, one retry), local fallback detection, error shape on non-OK response.
- `npm test` green.

---

## Step 6.3 — Self-contained SDK bundle decision

`scheduler-sdk.js` imports `BrokerIgaClient.js` and `createParameterReader` from `src/runtime/params.js`. When injected into an extracted job directory, these relative imports would break unless the executor copies them too.

**Resolution:** `scheduler-sdk.js` is a single self-contained file. Inline `BrokerIgaClient` and `createParameterReader` directly into `scheduler-sdk.js`. No external imports except Node built-ins (`fs`, `crypto`). This is the simplest guarantee that injecting one file is sufficient.

During development, keep `BrokerIgaClient.js` as a separate file and `import` it in `scheduler-sdk.js` using a relative path — this is fine for tests run from the repo. Add a build/bundle step that produces a self-contained `dist/scheduler-sdk.js` (using `esbuild` or manual concatenation), and update `JobRuntimeExecutor` to copy from `dist/scheduler-sdk.js`.

**Simpler alternative (preferred):** write `src/sdk/scheduler-sdk.js` as a single file from the start — no separate `BrokerIgaClient.js` module, no build step. Keep it under ~200 lines. This is appropriate given its scope.

### Acceptance criteria

- `src/sdk/scheduler-sdk.js` has no imports that reference paths outside `src/sdk/` or Node built-ins.
- Verified by inspection: the file can be `cp`-ed standalone and `node --input-type=module` parses it.

---

## Step 6.4 — `JobRuntimeExecutor` — SDK injection

**File:** `src/services/jobRuntimeExecutor.js`

After `safeZipExtract` returns, copy `src/sdk/scheduler-sdk.js` into `extractDir/scheduler-sdk.js` before `writeContextFile`:

```js
const sdkSourcePath = new URL("../../sdk/scheduler-sdk.js", import.meta.url).pathname;
await fs.copyFile(sdkSourcePath, path.join(extracted.extractDir, "scheduler-sdk.js"));
```

Add `IGA_BROKER_URL` to the child process env, reading from `process.env.RUNTIME_BROKER_URL` (the existing env var used throughout the server for this value):

```js
env: {
  NODE_ENV: "production",
  IGA_SCHEDULER_RUN_ID: runId,
  IGA_SCHEDULER_CONTEXT_FILE: contextFilePath,
  ...(process.env.RUNTIME_BROKER_URL ? { IGA_BROKER_URL: process.env.RUNTIME_BROKER_URL } : {}),
  // local fallback vars — passed through if present so BrokerIgaClient can use direct mode
  ...(process.env.IGA_BASE_URL ? { IGA_BASE_URL: process.env.IGA_BASE_URL } : {}),
  ...(process.env.IGA_TOKEN_ENDPOINT ? { IGA_TOKEN_ENDPOINT: process.env.IGA_TOKEN_ENDPOINT } : {}),
  ...(process.env.IGA_CLIENT_ID ? { IGA_CLIENT_ID: process.env.IGA_CLIENT_ID } : {}),
  ...(process.env.IGA_CLIENT_SECRET ? { IGA_CLIENT_SECRET: process.env.IGA_CLIENT_SECRET } : {}),
}
```

Remove `igaBridge` from the context object written by `writeContextFile` — the context file is now just `{ runId, params, definition, instance, scheduledFireTime, attempt }`.

### Acceptance criteria

- Unit test: after `execute(...)`, the extraction directory (before cleanup) contains `scheduler-sdk.js`.
- Unit test: child process env contains `IGA_BROKER_URL` when `RUNTIME_BROKER_URL` is set on the executor's env.
- Existing executor tests pass unchanged.
- `npm test` green.

---

## Step 6.5 — `src/workers/workerApp.js` + `src/workers/app.js`

### `workerApp.js` — Express app factory

```js
export function createWorkerApp({ executor, runStore, authOptions } = {}) { ... }
```

Single route: `POST /execute`

- Auth: `internalAuth` middleware (same factory as other internal routes), audience = `RUNTIME_WORKER_URL` (new env var — the worker service's own URL, used as OIDC audience by callers).
- Body: `{ runId, execution, context }`.
- Validation: `runId` string required, `execution.definition` required, `context` object required.
- Responds `202 Accepted` immediately.
- Dispatches `executor.execute({ runId, run: {}, execution, context })` as a background promise tracked in the active-executions set (see graceful drain below).
- On dispatch error (caught from the background promise): log the error; do not affect the 202 already sent. The run will be left RUNNING — stale-RUNNING sweep is out of scope.

**`/health`** route: returns 200 `{ status: "ok" }`. Unauthenticated (Cloud Run health probe).

### Graceful drain

```js
const activeExecutions = new Set();

function track(promise) {
  activeExecutions.add(promise);
  promise.finally(() => activeExecutions.delete(promise));
}

function drain(timeoutMs) {
  if (activeExecutions.size === 0) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...activeExecutions]),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}
```

On `SIGTERM`:
1. Stop accepting new requests (close the HTTP server — `server.close()`).
2. Call `drain(DRAIN_TIMEOUT_MS)` where `DRAIN_TIMEOUT_MS = (WORKER_MAX_TIMEOUT_SECONDS + 30) * 1000` — gives jobs their full timeout plus a 30 s buffer for result reporting and `/complete`.
3. `process.exit(0)`.

### `app.js` — entry point

```js
// src/workers/app.js
import { createWorkerApp } from "./workerApp.js";
import { JobRuntimeExecutor } from "../services/jobRuntimeExecutor.js";

const executor = new JobRuntimeExecutor();
const app = createWorkerApp({ executor });
const port = Number(process.env.PORT || 8080);
const server = app.listen(port, () => console.log(`worker listening on ${port}`));

// graceful drain wired in createWorkerApp, exported and called here
```

Add `"worker": "node src/workers/app.js"` to `package.json` scripts.

### Acceptance criteria

- Unit tests: `POST /execute` returns 202, dispatches to executor, tracks the promise.
- Unit test: SIGTERM handler calls `server.close()` then `drain()` then exits.
- Unit test: drain waits for active executions up to `DRAIN_TIMEOUT_MS`, then exits regardless.
- Unit test: `/health` returns 200 without auth.
- Rejected execution promise is logged but does not crash the process.
- `npm test` green.

---

## Step 6.6 — `WorkerServiceRuntimeLauncher`

**New file:** `src/services/workerServiceRuntimeLauncher.js`

Replaces `CloudRunJobRuntimeLauncher`. POSTs `{ runId, execution, context }` to `${workerUrl}/execute` with a Google OIDC token for audience `workerUrl`.

```js
export class WorkerServiceRuntimeLauncher {
  constructor({
    workerUrl = process.env.RUNTIME_WORKER_URL,
    runtimeServiceAccount = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL,
    requestTimeoutMs = 10_000,
    fetchImpl = fetch,
    now = () => new Date()
  } = {}) { ... }

  async launchExecution({ runId, execution, context }) {
    const token = await this.getOidcToken();
    const res = await this.fetchImpl(`${this.workerUrl}/execute`, {
      method: "POST",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ runId, execution, context })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`worker /execute failed: HTTP ${res.status} ${text}`);
    }
    return {
      backend: "worker-service",
      workerUrl: this.workerUrl,
      launchedAt: this.now().toISOString()
    };
  }
}
```

OIDC token fetch: same metadata server pattern as `BrokerIgaClient` (audience = `workerUrl`). Cache + 60 s skew + single retry on 401.

`cancel` and `getStatus` — not applicable for the worker service model. Return `{ status: "unsupported" }` for now.

**`WorkerRunService`:** update `buildRuntimeContext` to remove `igaBridge`. Update `_createLauncher` (or wherever the launcher is instantiated) to use `WorkerServiceRuntimeLauncher` when `WORKER_EXECUTION_MODE=isolated` instead of `CloudRunJobRuntimeLauncher`.

**Config:** add `RUNTIME_WORKER_URL` to required production vars in `productionValidation.js`. Remove `RUNTIME_CLOUD_RUN_JOB_NAME` — no longer needed.

### Acceptance criteria

- Unit tests: successful launch returns the correct shape, OIDC token fetched, 202 from worker returns normally.
- Unit test: non-2xx from worker throws with the response status in the message.
- `WorkerRunService` integration test: `executionMode=isolated` uses `WorkerServiceRuntimeLauncher`.
- `npm test` green.

---

## Step 6.7 — Delete `CloudRunJobRuntimeLauncher`

- Delete `src/services/cloudRunJobRuntimeLauncher.js` and its tests.
- Remove `@google-cloud/run` from `package.json` dependencies if it is only used there.
- Remove any import of `CloudRunJobRuntimeLauncher` from `WorkerRunService` / `app.js` / `createApp.js`.

### Acceptance criteria

- `grep -r "CloudRunJobRuntimeLauncher\|cloudRunJobRuntimeLauncher" src/ test/` returns nothing.
- `npm test` green.

---

## Step 6.8 — Delete `src/runtime/iga.js` bridge machinery

The bridge (`createBridgeIgaHelpers`, `createUnavailableIgaHelpers`, `createContextBridge`) is fully replaced by the injected SDK.

- Delete `src/runtime/iga.js`.
- Update `src/runtime/context.js`: remove `createIgaHelpers` import and the `iga`/`igaBridge` assembly in `createRuntimeContext`.
- Update `src/runtime/index.js`: remove `createIgaHelpers` re-export.
- Confirm nothing in `src/` or `test/` still imports from `src/runtime/iga.js`.

### Acceptance criteria

- `grep -r "createIgaHelpers\|createBridgeIgaHelpers\|createUnavailableIgaHelpers\|createContextBridge" src/ test/` returns nothing.
- `npm test` green.

---

## Step 6.9 — Update example jobs

### `examples/js/create-managed-users-job/scheduler-sdk.js`

Replace with re-export shim (for local dev):

```js
export { SchedulerJob, createContext, runJob } from "../../../src/sdk/scheduler-sdk.js";
```

### `examples/js/create-managed-users-job/job.js`

Remove: `fetchToken`, `buildIgaClient`, `igaDirect` conditional, `RESULT_PREFIX`, `main()`.

```js
import { SchedulerJob, runJob } from "./scheduler-sdk.js";

const MANAGED_USER_PATH = "/openidm/managed/alpha_user";

// ... GIVEN_NAMES, SURNAMES, buildUser unchanged ...

class CreateManagedUsersJob extends SchedulerJob {
  async execute(context) {
    const userNamePrefix = context.param.string("userNamePrefix") ?? "test-user-";
    const mailDomain     = context.param.string("mailDomain") ?? "example.com";
    const count          = Number(context.param.get("count", 10) ?? 10);

    const created = [], skipped = [];
    for (let i = 0; i < count; i++) {
      const user = buildUser(i, { userNamePrefix, mailDomain });
      try {
        await context.igaClient.execute("POST", MANAGED_USER_PATH, user);
        created.push(user.userName);
      } catch (err) {
        if (err.status === 409) {
          process.stderr.write(`[WARN] User ${user.userName} already exists — skipping\n`);
        } else {
          process.stderr.write(`[ERROR] Failed to create ${user.userName}: ${err.message}\n`);
        }
        skipped.push({ userName: user.userName, reason: err.message });
      }
    }
    return { requested: count, created: created.length, skipped: skipped.length, createdUsers: created, skippedUsers: skipped };
  }
}

runJob(CreateManagedUsersJob);
```

### `examples/js/risk-score-job/scheduler-sdk.js`

Same re-export shim as above.

### `examples/js/risk-score-job/job.js`

Replace `context.iga.riskScores.recompute(input)` with `context.igaClient.execute("POST", "/scheduler/risk-scores/recompute", input)`. Remove stale `context.logger`, `context.audit`, `context.status`, `context.feedback` references — none of these are provided.

### Acceptance criteria

- Both example jobs import only from `./scheduler-sdk.js` and use only `context.param` and `context.igaClient.execute`.
- No `fetchToken`, `buildIgaClient`, `igaDirect`, `context.iga`, `context.status`, `context.feedback`, or `context.audit` references remain in example jobs.
- `npm test` green.

---

## Terraform / operator steps (not code)

Document in `terraform/README.md`:

- New Cloud Run Service `iga-job-worker`, image built from this repo, entry `src/workers/app.js`.
- `min-instances: 1` — prevents scale-to-zero, guarantees warm start.
- `cpu-always-allocated: true` — keeps the instance CPU-ready between dispatches.
- `shutdown-timeout: <WORKER_MAX_TIMEOUT_SECONDS + 60>` — gives in-flight jobs their full timeout to complete plus buffer before SIGKILL.
- `RUNTIME_WORKER_URL` — new required env var on the scheduler service; value is the worker service URL.
- Remove `RUNTIME_CLOUD_RUN_JOB_NAME` from scheduler service env vars.
- Worker service invoked by scheduler service's `RUNTIME_SERVICE_ACCOUNT_EMAIL` — same SA, no IAM change.

---

## Definition of Done

All of the following hold:

- `npm test` green.
- `grep -r "CloudRunJobRuntimeLauncher\|cloudRunJobRuntimeLauncher" src/ test/` → nothing.
- `grep -r "createIgaHelpers\|igaBridge\|igaDirect" src/ test/` → nothing.
- `grep -r "fetchToken\|buildIgaClient" examples/` → nothing.
- `src/sdk/scheduler-sdk.js` exists, is self-contained (no imports outside Node built-ins), exports `SchedulerJob`, `createContext`, `runJob`.
- Both example jobs use `context.igaClient.execute` and `runJob(...)`.
- `JobRuntimeExecutor` copies `scheduler-sdk.js` into the extraction directory before spawning.
- `WorkerServiceRuntimeLauncher` used when `WORKER_EXECUTION_MODE=isolated`.
- Graceful drain: SIGTERM handler closes server, drains active executions, then exits.
