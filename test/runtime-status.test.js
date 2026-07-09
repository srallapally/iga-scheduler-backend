import { describe, expect, it, vi } from "vitest";
import { emitStatus, updateStatus } from "../src/runtime/status.js";
import { emitStatus as exportedEmitStatus, updateStatus as exportedUpdateStatus } from "../src/runtime/index.js";

describe("runtime status helper", () => {
  it("emits status marker JSON to stdout", () => {
    const stdout = {
      write: vi.fn()
    };

    emitStatus({
      state: "running",
      message: "Processed Salesforce",
      percentComplete: 50
    }, { stdout });

    expect(stdout.write).toHaveBeenCalledTimes(1);

    const line = stdout.write.mock.calls[0][0];
    expect(line).toMatch(/^IGA_STATUS_JSON:/);
    expect(line.endsWith("\n")).toBe(true);

    const payload = JSON.parse(line.replace(/^IGA_STATUS_JSON:/, ""));
    expect(payload).toEqual({
      state: "running",
      message: "Processed Salesforce",
      percentComplete: 50
    });
  });

  it("updateStatus emits the same status marker", () => {
    const stdout = {
      write: vi.fn()
    };

    updateStatus({ state: "running" }, { stdout });

    expect(stdout.write).toHaveBeenCalledWith(
      'IGA_STATUS_JSON:{"state":"running"}\n'
    );
  });

  it("exports status helpers from runtime index", () => {
    expect(exportedEmitStatus).toBe(emitStatus);
    expect(exportedUpdateStatus).toBe(updateStatus);
  });
});
