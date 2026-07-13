# Claude Code Plan 6 (revised): Python Job Execution Parity

## Context

`jobDefinitionSchema` already accepts `runtime: "python"` — the API takes a Python job
definition today and dispatch fails at the executor. Two things block it:
`JobRuntimeExecutor` only accepts `javascript`, and there is no Python SDK.

This plan supersedes `~/Downloads/claude-code-plan-6.md`, which was written against the
Cloud Run Jobs architecture. That architecture was replaced before the plan ran —
`CloudRunJobRuntimeLauncher`, `cloudRunJobsClient.js`, and `RUNTIME_CLOUD_RUN_JOB_NAME`
were deleted. `WorkerServiceRuntimeLauncher` is the production dispatcher; it is
runtime-agnostic and needs no changes here.

**Artifact buffer gap (also fixed in this plan):** `WorkerServiceRuntimeLauncher`
sends `{ runId, execution, context }` to the worker service's `/execute` endpoint.
`workerApp.js` passes this directly to `executor.execute()`, which requires
`artifactBuffer` as a `Buffer` and throws `RUNTIME_ARTIFACT_BUFFER_REQUIRED` if it is
absent. The scheduler service downloads and verifies the artifact before calling the
executor in local mode (`executeRunLocallyInternal`), but in isolated dispatch mode the
bytes are never forwarded — only the artifact metadata URI/sha256/generation. The worker
service must download the artifact from GCS itself. This affects JS dispatch today and
is fixed in this plan before adding Python.

**What's already in place:**
- `WorkerServiceRuntimeLauncher` sends `execution.artifact.{uri, sha256, generation}`
  in the payload — the worker has everything it needs to download the artifact.
- `workerRunService.verifyApprovedArtifact` already encapsulates GCS download +
  SHA256 check + zip validation; the logic moves to `JobRuntimeExecutor` (which is
  where it needs to run inside the worker service).
- `src/clients/gcsClient.js` exists and exports `createStorageClient()`.
- `JobRuntimeExecutor.execute()` already calls `safeZipExtract`, injects the SDK,
  writes the context file, and spawns the child process — no changes to that path.

Depends on plans 1–6 (the worker service plan, `claude-code-plan-6-job-worker-service.md`)
already complete. Production Python execution also requires plan 7's worker Dockerfile
(Python binaries installed). Production isolated dispatch for both JS and Python requires
plan 8's `worker_service.tf` to provision the `iga-job-worker` Cloud Run Service.

## Assumptions

- `runtimeVersion` values: `"python311"` / `"python312"`. Internally consistent — the
  pre-existing `"nodejs22"` vs `"22"` mismatch in the JS path is not carried forward.
- SDK delivery: the executor prepends the repo's `sdk/python/` directory to `PYTHONPATH`
  in the child env (computed relative to `jobRuntimeExecutor.js`, same locality principle
  as `SDK_SOURCE_PATH`). In production (plan 7's Dockerfile) the package is pip-installed,
  making the `PYTHONPATH` addition redundant but harmless. For Python spawns, `scheduler-sdk.js`
  is **not** copied into the extraction directory — it is JS-only.
- **Python binary resolution — local vs production.** The executor uses bare binary
  names (`python3.11`, `python3.12`) and lets `PATH` resolve them. This works on the
  production container (Debian/Ubuntu, `/usr/bin` always on `PATH`), on macOS with
  Homebrew (`/opt/homebrew/bin` on `PATH`), and in any other environment where the
  binary is installed. For cases where the binary is installed but not on the child
  process `PATH` (e.g. pyenv without shell integration), `PYTHON311_BIN` /
  `PYTHON312_BIN` env vars let the operator specify the full path without code changes.
- **Local dev setup requirement.** `PYTHONPATH` alone does not install the SDK's
  `requests` dependency. Local dev requires `pip install sdk/python/` (or
  `pip install requests`) once before running Python jobs. This is a one-time setup
  step, not a per-run concern. The README for the Python example job documents it.
- Python SDK API mirrors the JS SDK surface: `SchedulerJob` base class, `run_job(JobClass)`
  entrypoint, `context["iga_client"].execute(method, path, body)`,
  `context["param"].required_string(name)` etc. No bridge stubs — the deleted
  `src/runtime/iga.js` bridge pattern is not ported.
- Python SDK is synchronous (`requests`-based).
- `BrokerIgaClient` (production): fetches OIDC token from the GCP metadata server,
  caches it with expiry, retries once on 401. Mirrors `BrokerIgaClient` in
  `src/sdk/scheduler-sdk.js`.
- `DirectIgaClient` (local dev fallback): used when `IGA_BROKER_URL` is absent but
  `IGA_BASE_URL`/credentials are present. Reads `IGA_BASE_URL`, `IGA_TOKEN_ENDPOINT`,
  `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET` from `os.environ` in the child process — the
  executor passes these through in the child env for Python spawns just as it does for
  JS, so `LocalWorkerRunService`'s `igaDirect` context field does not need to be read
  by the Python SDK. The child env is the transport; the context file carries structured
  job metadata only.
- `run_job` prints `IGA_RESULT_JSON:<json>` to stdout on success (matching the executor's
  `parseResult` line prefix) and exits 0. On uncaught exception exits 1.
- `productionValidation.js` is **not changed** — Python is opt-in, no new required var.
- `WorkerServiceRuntimeLauncher` is **not changed** — already runtime-agnostic.

## Out of Scope

- Container packaging / Dockerfile (plan 7).
- Terraform / IAM (plan 8).
- Cloud Run Jobs, `RUNTIME_PYTHON_CLOUD_RUN_JOB_NAME`, `RUNTIME_JOB_NOT_CONFIGURED` —
  artifacts of the deleted architecture.
- Fixing the pre-existing `"nodejs22"` / `"22"` inconsistency in the JS path.

## Stop Condition

`npm test` green, no regressions. `pytest sdk/python/` green. No `docker`/`gcloud`
commands run.

---

## Step 6.1 — `JobRuntimeExecutor`: artifact download + Python spawn

**File:** `src/services/jobRuntimeExecutor.js`

This step has two parts that must ship together: the artifact download (fixes isolated
dispatch for JS today) and Python spawn support.

### Part A — Artifact download inside the executor

Add `@google-cloud/storage` download capability to `JobRuntimeExecutor` so it can
resolve an artifact buffer from GCS when one is not supplied by the caller.

**Add a `resolveArtifactBuffer({ execution, artifactBuffer })` method:**

```js
async resolveArtifactBuffer({ execution, artifactBuffer }) {
  if (Buffer.isBuffer(artifactBuffer)) return artifactBuffer;

  const uri = execution?.artifact?.uri;
  const sha256Expected = execution?.artifact?.sha256;
  const generation = execution?.artifact?.generation;

  if (!uri || !sha256Expected || !generation) {
    throw this.validationError(
      "RUNTIME_ARTIFACT_BUFFER_REQUIRED",
      "artifactBuffer must be a Buffer, or execution.artifact.{uri,sha256,generation} must be present for GCS download",
      { retryable: false }
    );
  }

  const { bucket, object } = this.parseGcsUri(uri);
  let buffer;
  try {
    [buffer] = await this.getStorage()
      .bucket(bucket)
      .file(object, { generation: String(generation) })
      .download();
  } catch (error) {
    throw this.executionError(
      "RUNTIME_ARTIFACT_DOWNLOAD_FAILED",
      `artifact download failed for ${uri}: ${error.message}`,
      { cause: error, retryable: true }
    );
  }

  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual !== sha256Expected) {
    throw this.executionError(
      "RUNTIME_ARTIFACT_SHA256_MISMATCH",
      `artifact sha256 mismatch for ${uri}: expected ${sha256Expected}, got ${actual}`,
      { retryable: false }
    );
  }

  return buffer;
}

parseGcsUri(uri) {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw this.validationError("RUNTIME_ARTIFACT_URI_INVALID", `invalid GCS URI: ${uri}`, { retryable: false });
  return { bucket: match[1], object: match[2] };
}

getStorage() {
  if (!this._storage) this._storage = createStorageClient();
  return this._storage;
}
```

Add `import crypto from "crypto"` and `import { createStorageClient } from "../clients/gcsClient.js"` at the top.

**Modify `execute()` to call `resolveArtifactBuffer` before `validateExecuteRequest`:**

```js
async execute({ runId, run, execution, artifactBuffer, context } = {}) {
  const resolvedBuffer = await this.resolveArtifactBuffer({ execution, artifactBuffer });
  const normalizedEntrypoint = this.validateExecuteRequest({ runId, run, execution, artifactBuffer: resolvedBuffer, context });
  // ... rest unchanged, using resolvedBuffer in place of artifactBuffer
}
```

**Remove `artifactBuffer || !Buffer.isBuffer(artifactBuffer)` validation from
`validateExecuteRequest`** — by the time it runs, `resolveArtifactBuffer` has already
guaranteed a valid Buffer.

### Part B — Python spawn support

**1. Extend `DEFAULT_ALLOWED_RUNTIMES` and add Python binary resolution:**

```js
const DEFAULT_ALLOWED_RUNTIMES = {
  javascript: new Set(["nodejs22", "22"]),
  python: new Set(["python311", "python312"]),
};

// Default binary names — bare names that PATH resolves on any platform.
// On the production container (Debian/Ubuntu, plan 7 Dockerfile) /usr/bin is
// on PATH so python3.11/python3.12 resolve to the correct binaries.
// On macOS dev machines (Homebrew/pyenv) the same bare names work as long as
// the binaries are installed and on PATH.
// Overridable via env vars for cases where the binary is not on PATH at all
// (e.g. pyenv shim directories that aren't in the child process PATH).
const PYTHON_DEFAULT_BINS = {
  python311: "python3.11",
  python312: "python3.12",
};
const PYTHON_BIN_ENV_OVERRIDES = {
  python311: "PYTHON311_BIN",
  python312: "PYTHON312_BIN",
};
const PYTHON_SDK_PATH = fileURLToPath(new URL("../../sdk/python", import.meta.url));
```

**2. Add `resolvePythonBinary(runtimeVersion)`:**

```js
resolvePythonBinary(runtimeVersion) {
  if (!PYTHON_DEFAULT_BINS[runtimeVersion]) {
    const error = new Error(`unsupported Python version: ${runtimeVersion}`);
    error.code = "RUNTIME_VERSION_UNSUPPORTED";
    error.retryable = false;
    throw error;
  }
  // Env override wins (local dev pointing at Homebrew/pyenv).
  const envOverride = process.env[PYTHON_BIN_ENV_OVERRIDES[runtimeVersion]];
  if (envOverride) return envOverride;
  // Bare name — PATH resolves on any platform (container, macOS, CI).
  return PYTHON_DEFAULT_BINS[runtimeVersion];
}
```

**3. Add `resolveSpawnCommand(runtime, runtimeVersion, entrypointPath, memoryLimitMb)`:**

```js
resolveSpawnCommand(runtime, runtimeVersion, entrypointPath, memoryLimitMb) {
  if (runtime === "python") {
    return { command: this.resolvePythonBinary(runtimeVersion), args: [entrypointPath] };
  }
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${memoryLimitMb}`, entrypointPath],
  };
}
```

**3. In `execute()`, branch on runtime before SDK injection and spawn:**

```js
const runtime = execution.definition.runtime;

if (runtime === "python") {
  // do NOT copy scheduler-sdk.js for Python
  const contextFilePath = await this.writeContextFile({ extractDir: extracted.extractDir, context: context || {} });
  return await this.executePythonEntrypoint({ runId, execution, extracted, contextFilePath });
} else {
  await fs.copyFile(SDK_SOURCE_PATH, path.join(extracted.extractDir, "scheduler-sdk.js"));
  const contextFilePath = await this.writeContextFile({ extractDir: extracted.extractDir, context: context || {} });
  return await this.executeNodeEntrypoint({ runId, execution, extracted, contextFilePath });
}
```

**4. Add `executePythonEntrypoint`** — same shape as `executeNodeEntrypoint` but uses
`resolveSpawnCommand` for the spawn command and injects `PYTHONPATH`:

```js
executePythonEntrypoint({ runId, execution, extracted, contextFilePath }) {
  const { command, args } = this.resolveSpawnCommand(
    "python",
    execution.definition.runtimeVersion,
    extracted.entrypointPath,
    this.effectiveMemoryLimitMb(execution.definition.memoryMb)
  );
  const existingPythonPath = process.env.PYTHONPATH || "";
  const pythonPath = existingPythonPath
    ? `${PYTHON_SDK_PATH}:${existingPythonPath}`
    : PYTHON_SDK_PATH;

  return this._spawnEntrypoint({
    command, args,
    cwd: extracted.extractDir,
    runId, execution,
    extraEnv: {
      IGA_SCHEDULER_RUN_ID: runId,
      IGA_SCHEDULER_CONTEXT_FILE: contextFilePath,
      PYTHONPATH: pythonPath,
      ...(process.env.IGA_BROKER_URL ? { IGA_BROKER_URL: process.env.IGA_BROKER_URL } : {}),
      ...(process.env.IGA_BASE_URL ? { IGA_BASE_URL: process.env.IGA_BASE_URL } : {}),
      ...(process.env.IGA_TOKEN_ENDPOINT ? { IGA_TOKEN_ENDPOINT: process.env.IGA_TOKEN_ENDPOINT } : {}),
      ...(process.env.IGA_CLIENT_ID ? { IGA_CLIENT_ID: process.env.IGA_CLIENT_ID } : {}),
      ...(process.env.IGA_CLIENT_SECRET ? { IGA_CLIENT_SECRET: process.env.IGA_CLIENT_SECRET } : {}),
    }
  });
}
```

Extract the common spawn loop from `executeNodeEntrypoint` into a shared
`_spawnEntrypoint({ command, args, cwd, runId, execution, extraEnv })` method to avoid
duplicating the stdout/stderr capture, timeout, and result-parse logic. `executeNodeEntrypoint`
becomes a thin wrapper that calls `resolveSpawnCommand` for JS and delegates to
`_spawnEntrypoint`.

### Acceptance criteria

- `executor.execute({ runId, execution, context })` with no `artifactBuffer` but valid
  `execution.artifact.{uri,sha256,generation}` downloads from GCS, verifies SHA256, and
  proceeds. A SHA256 mismatch throws `RUNTIME_ARTIFACT_SHA256_MISMATCH` (non-retryable).
  A download failure throws `RUNTIME_ARTIFACT_DOWNLOAD_FAILED` (retryable).
- Passing a valid `artifactBuffer` directly still works (no regression — local mode
  `executeRunLocallyInternal` supplies the buffer directly).
- `validateRuntime({ runtime: "python", runtimeVersion: "python311" })` passes;
  `"python310"` throws `RUNTIME_VERSION_UNSUPPORTED`.
- `resolveSpawnCommand("javascript", "nodejs22", "index.js", 256)` →
  `{ command: process.execPath, args: ["--max-old-space-size=256", "index.js"] }`.
- `resolveSpawnCommand("python", "python311", "main.py", 256)` with no env override →
  `{ command: "python3.11", args: ["main.py"] }`.
- `resolveSpawnCommand("python", "python311", ...)` with `PYTHON311_BIN=/opt/homebrew/bin/python3.11`
  set → `{ command: "/opt/homebrew/bin/python3.11", args: ["main.py"] }`.
- For Python spawns: `PYTHONPATH` includes `sdk/python/`; `scheduler-sdk.js` is NOT
  copied into the extraction directory.
- All existing `test/job-runtime-executor.test.js` cases pass. New cases:
  - `resolveArtifactBuffer` with a pre-supplied Buffer returns it unchanged.
  - `resolveArtifactBuffer` with missing artifact metadata throws
    `RUNTIME_ARTIFACT_BUFFER_REQUIRED`.
  - `resolveArtifactBuffer` downloads from GCS and verifies SHA256 (mock `getStorage()`).
  - `resolveArtifactBuffer` throws `RUNTIME_ARTIFACT_SHA256_MISMATCH` on mismatch.
  - Python `validateRuntime`, `resolvePythonBinary` (default, env override), and
    `resolveSpawnCommand` cases above.
  - `PYTHONPATH` injection and no `scheduler-sdk.js` copy for Python spawns.

## Step 6.2 — `retryClassifier.js`: new error codes

**File:** `src/services/retryClassifier.js`

Add to `NON_RETRYABLE_CODES`:
- `"RUNTIME_VERSION_UNSUPPORTED"` — unknown Python (or future) version; won't succeed on retry.
- `"RUNTIME_ARTIFACT_SHA256_MISMATCH"` — artifact is corrupted or wrong; retry won't fix it.

Add to `RETRYABLE_CODES` (or ensure it doesn't fall through as non-retryable):
- `"RUNTIME_ARTIFACT_DOWNLOAD_FAILED"` — transient GCS failure; safe to retry.

### Acceptance criteria

- `classifyWorkerError({ code: "RUNTIME_VERSION_UNSUPPORTED" })` → `{ retryable: false }`.
- `classifyWorkerError({ code: "RUNTIME_ARTIFACT_SHA256_MISMATCH" })` → `{ retryable: false }`.
- `classifyWorkerError({ code: "RUNTIME_ARTIFACT_DOWNLOAD_FAILED" })` → `{ retryable: true }`.
- Existing cases unaffected; new cases added to `test/retry-classifier.test.js`.

## Step 6.3 — Python SDK (`sdk/python/`)

```
sdk/python/
  pyproject.toml
  iga_scheduler/
    __init__.py
    scheduler_job.py
    context.py
    iga_client.py
    run_job.py
  tests/
    test_context.py
    test_iga_client.py
    test_run_job.py
```

**`pyproject.toml`:**
```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "iga-scheduler"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = ["requests"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

**`scheduler_job.py`:**
```python
from abc import ABC, abstractmethod

class SchedulerJob(ABC):
    @abstractmethod
    def execute(self, context):
        ...
```

**`iga_client.py`:**

`BrokerIgaClient` — mirrors `BrokerIgaClient` in `src/sdk/scheduler-sdk.js`:
- Constructor reads `IGA_BROKER_URL` and `IGA_SCHEDULER_RUN_ID` from env.
- `_fetch_token()`: GETs the GCP metadata server identity endpoint with
  `audience=broker_url`. Caches result; treats token as expired when within 60s of
  `exp` claim (decode payload from JWT second segment, base64-decode, parse JSON).
- `execute(method, path, body)`: POSTs `{ "runId": ..., "method": ..., "path": ..., "body": ... }`
  to `{broker_url}` with `Authorization: Bearer <token>`. On 401, clears cache and retries once.

`DirectIgaClient` — local dev fallback:
- Constructor reads `IGA_BASE_URL`, `IGA_TOKEN_ENDPOINT`, `IGA_CLIENT_ID`,
  `IGA_CLIENT_SECRET` from env.
- `_fetch_token()`: POSTs client credentials grant to `IGA_TOKEN_ENDPOINT`, caches with
  expiry check.
- `execute(method, path, body)`: calls `{IGA_BASE_URL}{path}` with the cached token.

`resolve_iga_client()`:
```python
def resolve_iga_client():
    import os
    if os.environ.get("IGA_BROKER_URL"):
        return BrokerIgaClient()
    if os.environ.get("IGA_BASE_URL"):
        return DirectIgaClient()
    raise RuntimeError("no IGA client configured: set IGA_BROKER_URL (production) or IGA_BASE_URL (local)")
```

**`context.py`:**
```python
import json, os
from .iga_client import resolve_iga_client

class ParameterReader:
    def __init__(self, params):
        self._params = params or {}

    def required_string(self, name):
        v = self._params.get(name)
        if not v or not isinstance(v, str):
            raise ValueError(f"missing required string parameter: {name}")
        return v

    def required_string_array(self, name):
        v = self._params.get(name)
        if not isinstance(v, list) or not v:
            raise ValueError(f"missing required string array parameter: {name}")
        return v

def create_context():
    context_file = os.environ.get("IGA_SCHEDULER_CONTEXT_FILE")
    if not context_file:
        raise RuntimeError("IGA_SCHEDULER_CONTEXT_FILE is not set")
    with open(context_file) as f:
        raw = json.load(f)
    return {
        "raw": raw,
        "run_id": raw.get("runId"),
        "definition": raw.get("definition", {}),
        "instance": raw.get("instance", {}),
        "scheduled_fire_time": raw.get("scheduledFireTime"),
        "attempt": raw.get("attempt", 1),
        "params": raw.get("params", {}),
        "param": ParameterReader(raw.get("params")),
        "iga_client": resolve_iga_client(),
    }
```

**`run_job.py`:**
```python
import json, sys
from .context import create_context

RESULT_PREFIX = "IGA_RESULT_JSON:"

def run_job(job_class):
    context = create_context()
    job = job_class()
    result = job.execute(context)
    print(f"{RESULT_PREFIX}{json.dumps(result)}", flush=True)
    sys.exit(0)
```

If `job.execute` raises, the exception propagates to stderr and Python exits 1 — the
executor treats any non-zero exit code as a run failure.

**`__init__.py`:** exports `SchedulerJob`, `run_job`, `create_context`.

### Tests

- `test_context.py`: `create_context()` reads the context file; builds `param` and
  `iga_client`; raises `RuntimeError` on missing `IGA_SCHEDULER_CONTEXT_FILE`.
- `test_iga_client.py`:
  - `BrokerIgaClient.execute` POSTs correct payload to broker URL with token; clears
    cache and retries once on 401; does not retry a second 401.
  - `DirectIgaClient.execute` calls `{IGA_BASE_URL}{path}` with client credentials token.
  - `resolve_iga_client` returns `BrokerIgaClient` when `IGA_BROKER_URL` is set;
    `DirectIgaClient` when only `IGA_BASE_URL` is set; raises when neither is set.
- `test_run_job.py`: `run_job` prints `IGA_RESULT_JSON:{"status":"ok"}` to stdout and
  exits 0; exits 1 when `execute` raises.

### Acceptance criteria

- `pytest sdk/python/` passes.
- `pip install sdk/python/` installs without error.
- `from iga_scheduler import SchedulerJob, run_job, create_context` works.

## Step 6.4 — Example Python job

**Files:** `examples/python/risk-score-job/{job.py, manifest.json, README.md}`

`manifest.json`:
```json
{ "entrypoint": "job.py", "runtime": "python", "wrapperVersion": "1" }
```

`job.py`:
```python
from iga_scheduler import SchedulerJob, run_job

class RiskScoreJob(SchedulerJob):
    def execute(self, context):
        scan_type = context["param"].required_string("scanType")
        applications = context["param"].required_string_array("applications")
        response = context["iga_client"].execute(
            "POST",
            "/scheduler/risk-scores/recompute",
            {"scanType": scan_type, "applications": applications},
        )
        return {"status": "submitted", "igaRequestId": response.get("requestId")}

run_job(RiskScoreJob)
```

README follows the same deploy/schedule/check-run curl sequence as the JS examples,
with `"runtime": "python"`, `"runtimeVersion": "python311"`, and a **Local dev setup**
section that documents: (1) install Python 3.11 or 3.12, (2) `pip install sdk/python/`
from the repo root to make `iga_scheduler` importable and install `requests`, (3)
optionally set `PYTHON311_BIN` or `PYTHON312_BIN` if the binary is not on `PATH` as
`python3.11`/`python3.12`.

### Acceptance criteria

- `job.py` only uses SDK surface that `create_context` actually returns.
- No import of anything outside `iga_scheduler`.

## Step 6.5 — Tests for the scheduler service

Full list for the session's final `npm test` pass:

- `test/job-runtime-executor.test.js` — per Step 6.1 (artifact download cases, Python
  spawn cases, `PYTHONPATH` injection, no `scheduler-sdk.js` copy for Python).
- `test/retry-classifier.test.js` — `RUNTIME_VERSION_UNSUPPORTED`,
  `RUNTIME_ARTIFACT_SHA256_MISMATCH` (non-retryable),
  `RUNTIME_ARTIFACT_DOWNLOAD_FAILED` (retryable) — per Step 6.2.

---

# Definition of Done

```
- npm test green, no regressions.
- pytest sdk/python/ green.
- JobRuntimeExecutor.execute() with no artifactBuffer downloads the artifact from GCS
  using execution.artifact.{uri,sha256,generation}, verifies SHA256, and proceeds.
  Passing a Buffer directly still works (local mode path unchanged).
- JobRuntimeExecutor accepts python311/python312. Binary resolution: PYTHON311_BIN /
  PYTHON312_BIN env override > python3.11/python3.12 (bare name, PATH-resolved).
  Sets PYTHONPATH to include sdk/python/. Does not copy scheduler-sdk.js for Python.
- RUNTIME_VERSION_UNSUPPORTED and RUNTIME_ARTIFACT_SHA256_MISMATCH are non-retryable;
  RUNTIME_ARTIFACT_DOWNLOAD_FAILED is retryable.
- Local dev: `pip install sdk/python/` required once before running Python jobs.
  `PYTHON311_BIN` / `PYTHON312_BIN` env vars allow pointing at Homebrew/pyenv binaries
  without code changes. Python job's DirectIgaClient reads IGA credentials from env
  (IGA_BASE_URL, IGA_TOKEN_ENDPOINT, IGA_CLIENT_ID, IGA_CLIENT_SECRET) — the executor
  passes these as child env vars for Python spawns identically to JS spawns.
- WorkerServiceRuntimeLauncher and productionValidation.js unchanged.
- Python SDK exports SchedulerJob, run_job, create_context. BrokerIgaClient mirrors JS:
  OIDC from metadata server, cache with expiry, 401 retry. DirectIgaClient is the local
  fallback. run_job prints IGA_RESULT_JSON:<json> on success, exits 1 on exception.
- Production Python execution additionally requires plan 7's worker Dockerfile
  (Python 3.11/3.12 + pip install sdk/python/).
- Production isolated dispatch (JS or Python) additionally requires plan 8's
  worker_service.tf to provision the iga-job-worker Cloud Run Service.
- No docker/gcloud commands run during this session.
```
