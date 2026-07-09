import { describe, expect, it, vi } from "vitest";
import { SchedulerJob } from "../src/index.js";

function createContext() {
  return {
    runId: "run-1",
    definitionId: "def-1",
    instanceId: "inst-1",
    parameters: {
      getString: vi.fn(),
      getStringArray: vi.fn(),
      getSecret: vi.fn()
    },
    iga: {},
    status: {
      update: vi.fn()
    },
    feedback: {
      update: vi.fn()
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    audit: {
      event: vi.fn()
    },
    isCancellationRequested: vi.fn().mockResolvedValue(false)
  };
}

describe("SchedulerJob lifecycle", () => {
  it("throws if execute is not implemented", async () => {
    const job = new SchedulerJob();
    const context = createContext();

    await expect(job.run(context)).rejects.toThrow(
      "execute(context) must be implemented by the job"
    );

    expect(context.audit.event).toHaveBeenCalledWith("JOB_STARTED");
    expect(context.audit.event).toHaveBeenCalledWith("JOB_FAILED", {
      error: "execute(context) must be implemented by the job"
    });
  });

  it("emits JOB_STARTED and JOB_SUCCEEDED on success", async () => {
    class SuccessfulJob extends SchedulerJob {
      async execute(_context) {
        return { status: "ok" };
      }
    }

    const job = new SuccessfulJob();
    const context = createContext();

    const result = await job.run(context);

    expect(result).toEqual({ status: "ok" });

    expect(context.logger.info).toHaveBeenCalledWith("Job started", {
      runId: "run-1",
      definitionId: "def-1",
      instanceId: "inst-1"
    });

    expect(context.audit.event).toHaveBeenCalledWith("JOB_STARTED");
    expect(context.audit.event).toHaveBeenCalledWith("JOB_SUCCEEDED", {
      result: { status: "ok" }
    });

    expect(context.logger.error).not.toHaveBeenCalled();
  });

  it("emits JOB_FAILED and logs error on failure", async () => {
    class FailingJob extends SchedulerJob {
      async execute(_context) {
        throw new Error("boom");
      }
    }

    const job = new FailingJob();
    const context = createContext();

    await expect(job.run(context)).rejects.toThrow("boom");

    expect(context.audit.event).toHaveBeenCalledWith("JOB_STARTED");
    expect(context.audit.event).toHaveBeenCalledWith("JOB_FAILED", {
      error: "boom"
    });

    expect(context.logger.error).toHaveBeenCalledWith("Job failed", {
      error: "boom"
    });
  });
});
