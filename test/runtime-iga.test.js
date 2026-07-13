// IGA helpers are now provided by src/sdk/scheduler-sdk.js (injected at runtime).
// The server-side runtime/context.js no longer assembles an `iga` property.
// These tests verify that createRuntimeContext no longer exposes context.iga,
// and that the runtime index no longer exports createIgaHelpers.

import { describe, expect, it } from "vitest";
import { createRuntimeContext } from "../src/runtime/context.js";
import * as runtimeIndex from "../src/runtime/index.js";

describe("runtime context (post-bridge removal)", () => {
  it("does not expose context.iga", async () => {
    const context = await createRuntimeContext({
      env: { IGA_SCHEDULER_CONTEXT_FILE: "/tmp/ctx.json" },
      readFile: async () => JSON.stringify({ runId: "run-1", params: {} })
    });
    expect(context.iga).toBeUndefined();
  });

  it("does not export createIgaHelpers from runtime index", () => {
    expect(runtimeIndex.createIgaHelpers).toBeUndefined();
  });
});
