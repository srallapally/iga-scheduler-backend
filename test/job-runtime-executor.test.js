import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { JobRuntimeExecutor } from "../src/services/jobRuntimeExecutor.js";

const execFileAsync = promisify(execFile);

function createExecutor(options = {}) {
  return new JobRuntimeExecutor({ runtimeIsolationEnabled: true, ...options });
}

async function createZip(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iga-runtime-src-"));
  const zipPath = path.join(os.tmpdir(), `iga-runtime-${Date.now()}-${Math.random()}.zip`);

  try {
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, entry.content ?? "");
    }

    await execFileAsync("zip", ["-qry", zipPath, "."], { cwd: dir });
    return await fs.readFile(zipPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(zipPath, { force: true });
  }
}

async function runtimeSdkEntries() {
  const [contextSource, resultSource, statusSource, paramsSource, indexSource] = await Promise.all([
    fs.readFile(new URL("../src/runtime/context.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/result.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/status.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/params.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/runtime/index.js", import.meta.url), "utf8")
  ]);

  return [
    { name: "runtime/context.js", content: contextSource },
    { name: "runtime/result.js", content: resultSource },
    { name: "runtime/status.js", content: statusSource },
    { name: "runtime/params.js", content: paramsSource },
    { name: "runtime/index.js", content: indexSource }
  ];
}

async function validArtifactBuffer(script = "console.log('ok');", extraEntries = []) {
  return createZip([{ name: "manifest.json", content: "{}" }, { name: "index.js", content: script }, ...extraEntries]);
}

async function validRequest(overrides = {}) {
  return { runId: "run-1", run: { runId: "run-1" }, execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js" } }, artifactBuffer: await validArtifactBuffer(), context: {}, ...overrides };
}

describe("JobRuntimeExecutor", () => {
  it("requires explicit runtime isolation before executing", async () => {
    const executor = new JobRuntimeExecutor();
    await expect(executor.execute(await validRequest())).rejects.toMatchObject({ code: "RUNTIME_ISOLATION_REQUIRED", retryable: false });
  });

  it("executes a valid node runtime entrypoint", async () => {
    const executor = createExecutor();
    const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("console.log('hello from job');") }));
    expect(result).toEqual(expect.objectContaining({ status: "completed", runId: "run-1", runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js", exitCode: 0, signal: null, timedOut: false, stderr: "", output: null }));
    expect(result.stdout).toContain("hello from job");
    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });

  it("injects runtime context through a context file", async () => {
    const executor = createExecutor();
    const script = `import fs from 'fs'; const context = JSON.parse(fs.readFileSync(process.env.IGA_SCHEDULER_CONTEXT_FILE, 'utf8')); console.log('IGA_RESULT_JSON:' + JSON.stringify({ runId: process.env.IGA_SCHEDULER_RUN_ID, contextRunId: context.runId, tenantId: context.tenantId, hasJsonEnv: Object.prototype.hasOwnProperty.call(process.env, 'IGA_SCHEDULER_CONTEXT_JSON'), contextFileBasename: process.env.IGA_SCHEDULER_CONTEXT_FILE.split('/').pop() }));`;
    const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer(script), context: { runId: "run-1", tenantId: "tenant-1" } }));
    expect(result.output).toEqual({ runId: "run-1", contextRunId: "run-1", tenantId: "tenant-1", hasJsonEnv: false, contextFileBasename: "context.json" });
  });

  it("allows job code to load context and emit results through the runtime SDK", async () => {
    const executor = createExecutor();
    const script = `import { complete, createRuntimeContext } from './runtime/index.js'; const context = await createRuntimeContext(); complete({ runId: context.runId, definitionId: context.definition.definitionId, instanceId: context.instance.instanceId, paramWindow: context.param.requiredString('window'), apps: context.param.requiredStringArray('apps') });`;
    const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer(script, await runtimeSdkEntries()), context: { runId: "run-1", definition: { definitionId: "risk-score" }, instance: { instanceId: "risk-score-hourly" }, params: { window: "PT1H", apps: ["salesforce", "workday"] } } }));
    expect(result.output).toEqual({ runId: "run-1", definitionId: "risk-score", instanceId: "risk-score-hourly", paramWindow: "PT1H", apps: ["salesforce", "workday"] });
  });

  it("parses optional result marker from stdout", async () => {
    const executor = createExecutor();
    const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("console.log('before'); console.log('IGA_RESULT_JSON:' + JSON.stringify({ ok: true, count: 3 }));") }));
    expect(result.output).toEqual({ ok: true, count: 3 });
  });

  it("rejects result marker payload above max output bytes", async () => {
    const executor = createExecutor({ maxResultOutputBytes: 10 });
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("console.log('IGA_RESULT_JSON:' + JSON.stringify({ value: 'this is too large' }));") }))).rejects.toMatchObject({ code: "RUNTIME_RESULT_OUTPUT_TOO_LARGE", retryable: false });
  });

  it("rejects non-zero process exit with captured execution details", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("console.error('boom'); process.exit(7);") }))).rejects.toMatchObject({ code: "RUNTIME_PROCESS_EXITED_NON_ZERO", retryable: true, execution: expect.objectContaining({ status: "failed", exitCode: 7, timedOut: false, stderr: expect.stringContaining("boom") }) });
  });

  it("rejects invalid result marker JSON", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("console.log('IGA_RESULT_JSON:{bad-json');") }))).rejects.toMatchObject({ code: "RUNTIME_RESULT_JSON_INVALID", retryable: false });
  });

  it("kills process after timeout", async () => {
    const executor = createExecutor({ defaultTimeoutSeconds: 1, maxTimeoutSeconds: 1 });
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("setInterval(() => {}, 1000);") }))).rejects.toMatchObject({ code: "RUNTIME_PROCESS_TIMED_OUT", retryable: true, execution: expect.objectContaining({ status: "failed", timedOut: true, timeoutSeconds: 1 }) });
  });

  it("force kills a job that traps SIGTERM", async () => {
    const executor = createExecutor({ defaultTimeoutSeconds: 1, maxTimeoutSeconds: 1, killGraceMs: 50 });
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);") }))).rejects.toMatchObject({ code: "RUNTIME_PROCESS_TIMED_OUT", retryable: true, execution: expect.objectContaining({ status: "failed", timedOut: true, timeoutSeconds: 1 }) });
  });

  it("truncates stdout after max bytes", async () => {
    const executor = createExecutor({ maxStdoutBytes: 5 });
    const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("process.stdout.write('123456789');") }));
    expect(result.stdout).toBe("12345");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("truncates stderr after max bytes", async () => {
    const executor = createExecutor({ maxStderrBytes: 5 });
    await expect(executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer("process.stderr.write('abcdefghi'); process.exit(2);") }))).rejects.toMatchObject({ execution: expect.objectContaining({ stderr: "abcde", stderrTruncated: true }) });
  });

  it("caps requested timeout at executor max timeout", async () => {
    const executor = createExecutor({ maxTimeoutSeconds: 1 });
    await expect(executor.execute(await validRequest({ execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js", timeoutSeconds: 10 } }, artifactBuffer: await validArtifactBuffer("setInterval(() => {}, 1000);") }))).rejects.toMatchObject({ code: "RUNTIME_PROCESS_TIMED_OUT", execution: expect.objectContaining({ timeoutSeconds: 1 }) });
  });

  it("rejects unsupported runtime", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ execution: { definition: { runtime: "ruby", runtimeVersion: "ruby3", entrypoint: "main.rb" } } }))).rejects.toMatchObject({ code: "RUNTIME_UNSUPPORTED", retryable: false });
  });

  it("rejects unsupported runtimeVersion", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs18", entrypoint: "index.js" } } }))).rejects.toMatchObject({ code: "RUNTIME_VERSION_UNSUPPORTED", retryable: false });
  });

  it("rejects absolute entrypoint path", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "/index.js" } } }))).rejects.toMatchObject({ code: "RUNTIME_ENTRYPOINT_INVALID", retryable: false });
  });

  it("rejects path traversal entrypoint", async () => {
    const executor = createExecutor();
    await expect(executor.execute(await validRequest({ execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "../index.js" } } }))).rejects.toMatchObject({ code: "RUNTIME_ENTRYPOINT_INVALID", retryable: false });
  });

  it("requires artifactBuffer to be a Buffer", async () => {
    const executor = createExecutor();
    await expect(executor.execute({ runId: "run-1", execution: { definition: { runtime: "javascript", runtimeVersion: "nodejs22", entrypoint: "index.js" } }, artifactBuffer: "not-a-buffer" })).rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_BUFFER_REQUIRED", retryable: false });
  });

  it("injects scheduler-sdk.js and exposes igaClient in the job", async () => {
    const executor = createExecutor();
    // The job imports the injected scheduler-sdk.js and checks igaClient is available
    const script = `
      import { createContext } from './scheduler-sdk.js';
      const ctx = await createContext(process.env);
      console.log('IGA_RESULT_JSON:' + JSON.stringify({ hasIgaClient: typeof ctx.igaClient.execute === 'function', runId: ctx.runId }));
    `;
    const result = await executor.execute(await validRequest({
      artifactBuffer: await validArtifactBuffer(script),
      context: { runId: "run-sdk-test", params: {} }
    }));
    expect(result.output).toEqual({ hasIgaClient: true, runId: "run-sdk-test" });
  });

  it("passes IGA_BROKER_URL to child process when RUNTIME_BROKER_URL is set", async () => {
    const executor = createExecutor();
    const script = `console.log('IGA_RESULT_JSON:' + JSON.stringify({ brokerUrl: process.env.IGA_BROKER_URL ?? null }));`;
    const originalBrokerUrl = process.env.RUNTIME_BROKER_URL;
    process.env.RUNTIME_BROKER_URL = "https://broker.test.example.com";
    try {
      const result = await executor.execute(await validRequest({ artifactBuffer: await validArtifactBuffer(script) }));
      expect(result.output).toEqual({ brokerUrl: "https://broker.test.example.com" });
    } finally {
      if (originalBrokerUrl === undefined) delete process.env.RUNTIME_BROKER_URL;
      else process.env.RUNTIME_BROKER_URL = originalBrokerUrl;
    }
  });
});

describe("JobRuntimeExecutor - resolveArtifactBuffer", () => {
  it("returns a pre-supplied Buffer unchanged", async () => {
    const executor = createExecutor();
    const buf = Buffer.from("test");
    const result = await executor.resolveArtifactBuffer({ execution: {}, artifactBuffer: buf });
    expect(result).toBe(buf);
  });

  it("throws RUNTIME_ARTIFACT_BUFFER_REQUIRED when no buffer and no artifact metadata", async () => {
    const executor = createExecutor();
    await expect(executor.resolveArtifactBuffer({ execution: { artifact: {} } }))
      .rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_BUFFER_REQUIRED", retryable: false });
  });

  it("throws RUNTIME_ARTIFACT_BUFFER_REQUIRED when artifact metadata is partially missing", async () => {
    const executor = createExecutor();
    await expect(executor.resolveArtifactBuffer({ execution: { artifact: { uri: "gs://b/o" } } }))
      .rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_BUFFER_REQUIRED", retryable: false });
  });

  it("downloads from GCS and verifies SHA256", async () => {
    const executor = createExecutor();
    const content = Buffer.from("zip-content");
    const crypto = await import("crypto");
    const sha256 = crypto.default.createHash("sha256").update(content).digest("hex");
    const mockFile = { download: async () => [content] };
    const mockBucket = { file: () => mockFile };
    executor._storage = { bucket: () => mockBucket };

    const result = await executor.resolveArtifactBuffer({
      execution: { artifact: { uri: "gs://my-bucket/my-object", sha256, generation: "12345" } }
    });
    expect(result).toEqual(content);
  });

  it("throws RUNTIME_ARTIFACT_DOWNLOAD_FAILED on GCS error (retryable)", async () => {
    const executor = createExecutor();
    const mockFile = { download: async () => { throw new Error("network error"); } };
    const mockBucket = { file: () => mockFile };
    executor._storage = { bucket: () => mockBucket };

    await expect(executor.resolveArtifactBuffer({
      execution: { artifact: { uri: "gs://b/o", sha256: "abc123", generation: "1" } }
    })).rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_DOWNLOAD_FAILED", retryable: true });
  });

  it("throws RUNTIME_ARTIFACT_SHA256_MISMATCH on hash mismatch (non-retryable)", async () => {
    const executor = createExecutor();
    const mockFile = { download: async () => [Buffer.from("real-content")] };
    const mockBucket = { file: () => mockFile };
    executor._storage = { bucket: () => mockBucket };

    await expect(executor.resolveArtifactBuffer({
      execution: { artifact: { uri: "gs://b/o", sha256: "wrong-hash", generation: "1" } }
    })).rejects.toMatchObject({ code: "RUNTIME_ARTIFACT_SHA256_MISMATCH", retryable: false });
  });
});

describe("JobRuntimeExecutor - Python support", () => {
  it("accepts python311 and python312 runtimeVersions", () => {
    const executor = createExecutor();
    expect(() => executor.validateRuntime({ runtime: "python", runtimeVersion: "python311" })).not.toThrow();
    expect(() => executor.validateRuntime({ runtime: "python", runtimeVersion: "python312" })).not.toThrow();
  });

  it("rejects unsupported Python version with RUNTIME_VERSION_UNSUPPORTED", () => {
    const executor = createExecutor();
    expect(() => executor.validateRuntime({ runtime: "python", runtimeVersion: "python310" }))
      .toThrow(expect.objectContaining({ code: "RUNTIME_VERSION_UNSUPPORTED", retryable: false }));
  });

  it("resolveSpawnCommand for javascript returns process.execPath with memory flag", () => {
    const executor = createExecutor();
    const { command, args } = executor.resolveSpawnCommand("javascript", "nodejs22", "index.js", 256);
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["--max-old-space-size=256", "index.js"]);
  });

  it("resolveSpawnCommand for python311 returns bare binary name", () => {
    const executor = createExecutor();
    const orig = process.env.PYTHON311_BIN;
    delete process.env.PYTHON311_BIN;
    try {
      const { command, args } = executor.resolveSpawnCommand("python", "python311", "main.py", 256);
      expect(command).toBe("python3.11");
      expect(args).toEqual(["main.py"]);
    } finally {
      if (orig !== undefined) process.env.PYTHON311_BIN = orig;
    }
  });

  it("resolveSpawnCommand for python311 uses PYTHON311_BIN env override", () => {
    const executor = createExecutor();
    process.env.PYTHON311_BIN = "/opt/homebrew/bin/python3.11";
    try {
      const { command } = executor.resolveSpawnCommand("python", "python311", "main.py", 256);
      expect(command).toBe("/opt/homebrew/bin/python3.11");
    } finally {
      delete process.env.PYTHON311_BIN;
    }
  });

  it("resolvePythonBinary throws RUNTIME_VERSION_UNSUPPORTED for unknown version", () => {
    const executor = createExecutor();
    expect(() => executor.resolvePythonBinary("python310"))
      .toThrow(expect.objectContaining({ code: "RUNTIME_VERSION_UNSUPPORTED" }));
  });
});
