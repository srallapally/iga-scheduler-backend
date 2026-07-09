import { describe, expect, it, vi } from "vitest";
import { createRuntimeContext, loadRuntimeContext } from "../src/runtime/context.js";

describe("runtime context SDK", () => {
  it("loads context from IGA_SCHEDULER_CONTEXT_FILE", async () => {
    const readFile = vi.fn(async () => JSON.stringify({
      runId: "run-1",
      definition: {
        definitionId: "risk-score"
      },
      instance: {
        instanceId: "risk-score-hourly"
      },
      scheduledFireTime: "2026-06-03T18:00:00.000Z",
      attempt: 2,
      params: {
        window: "PT1H"
      }
    }));

    const context = await loadRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile
    });

    expect(readFile).toHaveBeenCalledWith("/tmp/context.json", "utf8");
    expect(context).toEqual({
      runId: "run-1",
      definition: {
        definitionId: "risk-score"
      },
      instance: {
        instanceId: "risk-score-hourly"
      },
      scheduledFireTime: "2026-06-03T18:00:00.000Z",
      attempt: 2,
      params: {
        window: "PT1H"
      }
    });
  });

  it("creates friendly runtime context accessors", async () => {
    const runtimeContext = await createRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: vi.fn(async () => JSON.stringify({
        runId: "run-1",
        definition: {
          definitionId: "risk-score"
        },
        instance: {
          instanceId: "risk-score-hourly"
        },
        scheduledFireTime: "2026-06-03T18:00:00.000Z",
        attempt: 2,
        params: {
          window: "PT1H"
        }
      }))
    });

    expect(runtimeContext).toMatchObject({
      raw: {
        runId: "run-1",
        definition: {
          definitionId: "risk-score"
        },
        instance: {
          instanceId: "risk-score-hourly"
        },
        scheduledFireTime: "2026-06-03T18:00:00.000Z",
        attempt: 2,
        params: {
          window: "PT1H"
        }
      },
      runId: "run-1",
      definition: {
        definitionId: "risk-score"
      },
      instance: {
        instanceId: "risk-score-hourly"
      },
      scheduledFireTime: "2026-06-03T18:00:00.000Z",
      attempt: 2,
      params: {
        window: "PT1H"
      }
    });
    expect(runtimeContext.param.requiredString("window")).toBe("PT1H");
  });

  it("defaults params to an empty object", async () => {
    const runtimeContext = await createRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: vi.fn(async () => JSON.stringify({
        runId: "run-1"
      }))
    });

    expect(runtimeContext.params).toEqual({});
    expect(runtimeContext.param.get("missing", "fallback")).toBe("fallback");
  });

  it("requires IGA_SCHEDULER_CONTEXT_FILE", async () => {
    await expect(loadRuntimeContext({ env: {} })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_FILE_REQUIRED"
    });
  });

  it("wraps context file read failures", async () => {
    await expect(loadRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/missing.json"
      },
      readFile: vi.fn(async () => {
        throw new Error("missing");
      })
    })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_FILE_READ_FAILED",
      message: "failed to read runtime context file: missing"
    });
  });

  it("rejects invalid JSON", async () => {
    await expect(loadRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: vi.fn(async () => "{bad-json")
    })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_JSON_INVALID"
    });
  });

  it("rejects non-object context JSON", async () => {
    await expect(loadRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: vi.fn(async () => JSON.stringify(["not", "object"]))
    })).rejects.toMatchObject({
      code: "RUNTIME_CONTEXT_INVALID"
    });
  });
});
