import { describe, expect, it, vi } from "vitest";
import { complete, emitResult } from "../src/runtime/result.js";

describe("runtime result SDK", () => {
  it("emits result marker JSON to stdout", () => {
    const stdout = {
      write: vi.fn()
    };

    emitResult({ ok: true, count: 3 }, { stdout });

    expect(stdout.write).toHaveBeenCalledWith("IGA_RESULT_JSON:{\"ok\":true,\"count\":3}\n");
  });

  it("complete emits result marker JSON", () => {
    const stdout = {
      write: vi.fn()
    };

    complete({ status: "done" }, { stdout });

    expect(stdout.write).toHaveBeenCalledWith("IGA_RESULT_JSON:{\"status\":\"done\"}\n");
  });
});
