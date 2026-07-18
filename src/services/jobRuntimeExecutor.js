import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { safeZipExtract } from "../utils/safeZipExtract.js";
import { createStorageClient } from "../clients/gcsClient.js";

const SDK_SOURCE_PATH = fileURLToPath(new URL("../sdk/scheduler-sdk.js", import.meta.url));

const DEFAULT_ALLOWED_RUNTIMES = {
  javascript: new Set(["nodejs22", "22"]),
  python: new Set(["python311", "python312"]),
};
const RESULT_PREFIX = "IGA_RESULT_JSON:";
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_TIMEOUT_SECONDS = 1800;
const DEFAULT_MEMORY_LIMIT_MB = 256;
const DEFAULT_MAX_MEMORY_LIMIT_MB = 512;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;
const CONTEXT_DIR = ".iga";
const CONTEXT_FILE = "context.json";

// Bare names — PATH resolves on container (/usr/bin) and macOS (Homebrew).
// Use PYTHON311_BIN / PYTHON312_BIN to override when the binary is not on PATH.
const PYTHON_DEFAULT_BINS = {
  python311: "python3.11",
  python312: "python3.12",
};
const PYTHON_BIN_ENV_OVERRIDES = {
  python311: "PYTHON311_BIN",
  python312: "PYTHON312_BIN",
};
const PYTHON_SDK_PATH = fileURLToPath(new URL("../../sdk/python", import.meta.url));

export class JobRuntimeExecutor {
  constructor({
    allowedRuntimes = DEFAULT_ALLOWED_RUNTIMES,
    defaultTimeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    maxTimeoutSeconds = Number(process.env.WORKER_MAX_TIMEOUT_SECONDS || DEFAULT_MAX_TIMEOUT_SECONDS),
    defaultMemoryLimitMb = DEFAULT_MEMORY_LIMIT_MB,
    maxMemoryLimitMb = Number(process.env.WORKER_MAX_MEMORY_MB || DEFAULT_MAX_MEMORY_LIMIT_MB),
    maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    maxResultOutputBytes = Number(process.env.WORKER_MAX_RESULT_OUTPUT_BYTES || DEFAULT_MAX_RESULT_OUTPUT_BYTES),
    // Set WORKER_REQUIRE_RUNTIME_ISOLATION=false in environments where the
    // container boundary itself provides isolation (e.g. the worker Cloud Run service).
    requireRuntimeIsolation = process.env.WORKER_REQUIRE_RUNTIME_ISOLATION !== "false",
    killGraceMs = Number(process.env.WORKER_RUNTIME_KILL_GRACE_MS || DEFAULT_KILL_GRACE_MS)
  } = {}) {
    this.allowedRuntimes = this.normalizeAllowedRuntimes(allowedRuntimes);
    this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.maxTimeoutSeconds = maxTimeoutSeconds;
    this.defaultMemoryLimitMb = defaultMemoryLimitMb;
    this.maxMemoryLimitMb = maxMemoryLimitMb;
    this.maxStdoutBytes = maxStdoutBytes;
    this.maxStderrBytes = maxStderrBytes;
    this.maxResultOutputBytes = maxResultOutputBytes;
    this.requireRuntimeIsolation = requireRuntimeIsolation;
    this.killGraceMs = killGraceMs;
    this._activeByRunId = new Map();
  }

  // Signals the tracked subprocess for runId to terminate (COR-2). Returns
  // {status: "killed"} if a live execution was found, {status: "not_found"}
  // otherwise (already finished, or never started on this instance).
  cancel(runId) {
    const active = this._activeByRunId.get(runId);
    if (!active) return { status: "not_found" };
    active.killProcessGroup("SIGTERM");
    setTimeout(() => active.killProcessGroup("SIGKILL"), this.killGraceMs);
    return { status: "killed" };
  }

  async execute({ runId, dispatchId, run, execution, artifactBuffer, context } = {}) {
    const resolvedBuffer = await this.resolveArtifactBuffer({ execution, artifactBuffer });
    const normalizedEntrypoint = this.validateExecuteRequest({ runId, run, execution, artifactBuffer: resolvedBuffer, context });
    this.validateRuntimeIsolation();
    const extracted = await safeZipExtract(resolvedBuffer, { entrypoint: normalizedEntrypoint });
    try {
      const runtime = execution.definition.runtime;
      const contextFilePath = await this.writeContextFile({ extractDir: extracted.extractDir, context: context || {} });
      if (runtime === "python") {
        return await this.executePythonEntrypoint({ runId, dispatchId, execution, extracted, contextFilePath });
      }
      await fs.copyFile(SDK_SOURCE_PATH, path.join(extracted.extractDir, "scheduler-sdk.js"));
      return await this.executeNodeEntrypoint({ runId, dispatchId, execution, extracted, contextFilePath });
    } finally {
      await extracted.cleanup();
    }
  }

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

  resolvePythonBinary(runtimeVersion) {
    if (!PYTHON_DEFAULT_BINS[runtimeVersion]) {
      const error = new Error(`unsupported Python version: ${runtimeVersion}`);
      error.code = "RUNTIME_VERSION_UNSUPPORTED";
      error.retryable = false;
      throw error;
    }
    const envOverride = process.env[PYTHON_BIN_ENV_OVERRIDES[runtimeVersion]];
    if (envOverride) return envOverride;
    return PYTHON_DEFAULT_BINS[runtimeVersion];
  }

  resolveSpawnCommand(runtime, runtimeVersion, entrypointPath, memoryLimitMb) {
    if (runtime === "python") {
      // Python has no interpreter-level memory-cap flag (unlike Node's
      // --max-old-space-size), so enforce one via the OS instead. Passing the
      // real binary/entrypoint as extra argv entries (not string-interpolated
      // into the bash script) keeps this injection-safe despite the shell hop;
      // `exec` replaces the bash process so the child's pid is still the real
      // python process — process-group kill/timeout logic is unaffected.
      const pythonBin = this.resolvePythonBinary(runtimeVersion);
      const limitKb = memoryLimitMb * 1024;
      return {
        command: "bash",
        args: ["-c", `ulimit -v ${limitKb}; exec "$0" "$@"`, pythonBin, entrypointPath]
      };
    }
    return {
      command: process.execPath,
      args: [`--max-old-space-size=${memoryLimitMb}`, entrypointPath],
    };
  }

  validateRuntimeIsolation() {
    if (this.requireRuntimeIsolation) {
      throw this.validationError("RUNTIME_ISOLATION_REQUIRED", "runtime isolation is required before executing untrusted job artifacts; set WORKER_REQUIRE_RUNTIME_ISOLATION=false in environments where the container provides isolation", { retryable: false });
    }
  }
  async writeContextFile({ extractDir, context }) { const contextDir = path.join(extractDir, CONTEXT_DIR); const contextFilePath = path.join(contextDir, CONTEXT_FILE); await fs.mkdir(contextDir, { recursive: true, mode: 0o700 }); await fs.writeFile(contextFilePath, JSON.stringify(context, null, 2), { encoding: "utf8", mode: 0o600 }); return contextFilePath; }

  executeNodeEntrypoint({ runId, dispatchId, execution, extracted, contextFilePath }) {
    const memoryLimitMb = this.effectiveMemoryLimitMb(execution.definition.memoryMb);
    const { command, args } = this.resolveSpawnCommand("javascript", execution.definition.runtimeVersion, extracted.entrypointPath, memoryLimitMb);
    return this._spawnEntrypoint({
      command, args,
      cwd: extracted.extractDir,
      runId, execution,
      extraEnv: {
        NODE_ENV: "production",
        IGA_SCHEDULER_RUN_ID: runId,
        IGA_SCHEDULER_CONTEXT_FILE: contextFilePath,
        ...(process.env.RUNTIME_BROKER_URL ? { IGA_BROKER_URL: process.env.RUNTIME_BROKER_URL } : {}),
        ...(dispatchId ? { IGA_SCHEDULER_DISPATCH_ID: dispatchId } : {}),
      }
    });
  }

  executePythonEntrypoint({ runId, dispatchId, execution, extracted, contextFilePath }) {
    const memoryLimitMb = this.effectiveMemoryLimitMb(execution.definition.memoryMb);
    const { command, args } = this.resolveSpawnCommand("python", execution.definition.runtimeVersion, extracted.entrypointPath, memoryLimitMb);
    const existingPythonPath = process.env.PYTHONPATH || "";
    const pythonPath = existingPythonPath ? `${PYTHON_SDK_PATH}:${existingPythonPath}` : PYTHON_SDK_PATH;
    return this._spawnEntrypoint({
      command, args,
      cwd: extracted.extractDir,
      runId, execution,
      extraEnv: {
        IGA_SCHEDULER_RUN_ID: runId,
        IGA_SCHEDULER_CONTEXT_FILE: contextFilePath,
        PYTHONPATH: pythonPath,
        ...(process.env.RUNTIME_BROKER_URL ? { IGA_BROKER_URL: process.env.RUNTIME_BROKER_URL } : {}),
        ...(dispatchId ? { IGA_SCHEDULER_DISPATCH_ID: dispatchId } : {}),
      }
    });
  }

  _spawnEntrypoint({ command, args, cwd, runId, execution, extraEnv }) {
    const startedAt = new Date().toISOString();
    const timeoutSeconds = this.effectiveTimeoutSeconds(execution.definition.timeoutSeconds);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        detached: true,
        env: extraEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = ""; let stderr = ""; let stdoutTruncated = false; let stderrTruncated = false; let timedOut = false; let settled = false; let forceKillTimeout;
      const killProcessGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
      this._activeByRunId.set(runId, { killProcessGroup });
      const timeout = setTimeout(() => { timedOut = true; killProcessGroup("SIGTERM"); forceKillTimeout = setTimeout(() => { killProcessGroup("SIGKILL"); }, this.killGraceMs); }, timeoutSeconds * 1000);
      child.stdout.on("data", (chunk) => { const captured = this.appendWithLimit(stdout, chunk, this.maxStdoutBytes); stdout = captured.value; stdoutTruncated ||= captured.truncated; });
      child.stderr.on("data", (chunk) => { const captured = this.appendWithLimit(stderr, chunk, this.maxStderrBytes); stderr = captured.value; stderrTruncated ||= captured.truncated; });
      child.on("error", (error) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(forceKillTimeout); this._activeByRunId.delete(runId); reject(this.executionError("RUNTIME_PROCESS_FAILED", error.message, { cause: error })); });
      child.on("close", (exitCode, signal) => {
        if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(forceKillTimeout); this._activeByRunId.delete(runId);
        const endedAt = new Date().toISOString();
        let parsedResult;
        try { parsedResult = this.parseResult(stdout); } catch (error) { reject(error); return; }
        const result = { status: exitCode === 0 && !timedOut ? "completed" : "failed", runId, runtime: execution.definition.runtime, runtimeVersion: execution.definition.runtimeVersion, entrypoint: execution.definition.entrypoint, exitCode, signal, timedOut, timeoutSeconds, memoryLimitMb: this.effectiveMemoryLimitMb(execution.definition.memoryMb), stdout, stderr, stdoutTruncated, stderrTruncated, output: parsedResult, startedAt, endedAt };
        if (timedOut) { const error = this.executionError("RUNTIME_PROCESS_TIMED_OUT", `job process exceeded timeout of ${timeoutSeconds} seconds`, { retryable: true }); error.execution = result; reject(error); return; }
        if (exitCode !== 0) { const error = this.executionError("RUNTIME_PROCESS_EXITED_NON_ZERO", `job process exited with code ${exitCode}`, { retryable: true }); error.execution = result; reject(error); return; }
        resolve(result);
      });
    });
  }

  appendWithLimit(current, chunk, maxBytes) { const incoming = chunk.toString("utf8"); const combined = current + incoming; const combinedBytes = Buffer.byteLength(combined, "utf8"); if (combinedBytes <= maxBytes) return { value: combined, truncated: false }; return { value: combined.slice(0, maxBytes), truncated: true }; }
  effectiveTimeoutSeconds(timeoutSeconds) { const requested = Number(timeoutSeconds || this.defaultTimeoutSeconds); if (!Number.isFinite(requested) || requested <= 0) return this.defaultTimeoutSeconds; return Math.min(requested, this.maxTimeoutSeconds); }
  effectiveMemoryLimitMb(memoryMb) { const requested = Number(memoryMb || this.defaultMemoryLimitMb); if (!Number.isFinite(requested) || requested <= 0) return this.defaultMemoryLimitMb; return Math.min(requested, this.maxMemoryLimitMb); }
  parseResult(stdout) { const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX)); if (!resultLine) return null; const payload = resultLine.slice(RESULT_PREFIX.length); if (Buffer.byteLength(payload, "utf8") > this.maxResultOutputBytes) throw this.executionError("RUNTIME_RESULT_OUTPUT_TOO_LARGE", `runtime result output exceeds ${this.maxResultOutputBytes} bytes`, { retryable: false }); try { return JSON.parse(payload); } catch (error) { throw this.executionError("RUNTIME_RESULT_JSON_INVALID", error.message, { retryable: false }); } }
  validateExecuteRequest({ runId, execution, artifactBuffer }) { if (!runId || typeof runId !== "string") throw this.validationError("RUNTIME_RUN_ID_REQUIRED", "runId is required"); if (!execution?.definition) throw this.validationError("RUNTIME_DEFINITION_REQUIRED", "execution definition is required"); if (!artifactBuffer || !Buffer.isBuffer(artifactBuffer)) throw this.validationError("RUNTIME_ARTIFACT_BUFFER_REQUIRED", "artifactBuffer must be a Buffer"); this.validateRuntime({ runtime: execution.definition.runtime, runtimeVersion: execution.definition.runtimeVersion }); return this.validateEntrypoint(execution.definition.entrypoint); }
  validateRuntime({ runtime, runtimeVersion }) { const allowedVersions = this.allowedRuntimes.get(runtime); if (!allowedVersions) throw this.validationError("RUNTIME_UNSUPPORTED", `unsupported runtime: ${runtime}`, { retryable: false }); if (!allowedVersions.has(runtimeVersion)) throw this.validationError("RUNTIME_VERSION_UNSUPPORTED", `unsupported runtimeVersion for ${runtime}: ${runtimeVersion}`, { retryable: false }); }
  validateEntrypoint(entrypoint) { if (!entrypoint || typeof entrypoint !== "string") throw this.validationError("RUNTIME_ENTRYPOINT_REQUIRED", "entrypoint is required", { retryable: false }); if (path.isAbsolute(entrypoint)) throw this.validationError("RUNTIME_ENTRYPOINT_INVALID", "entrypoint must be relative", { retryable: false }); const normalized = path.posix.normalize(entrypoint.replaceAll(path.win32.sep, path.posix.sep)); if (normalized === "." || normalized.startsWith("../") || normalized === "..") throw this.validationError("RUNTIME_ENTRYPOINT_INVALID", "entrypoint must not traverse outside the artifact root", { retryable: false }); return normalized; }
  normalizeAllowedRuntimes(allowedRuntimes) { return new Map(Object.entries(allowedRuntimes).map(([runtime, versions]) => [runtime, versions instanceof Set ? versions : new Set(versions)])); }
  validationError(code, message, { retryable = false } = {}) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
  executionError(code, message, { cause, retryable = true } = {}) { const error = new Error(message); error.code = code; error.retryable = retryable; if (cause) error.cause = cause; return error; }
}
