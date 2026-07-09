import { describe, expect, it } from "vitest";
import { createParameterReader } from "../src/runtime/params.js";
import { createRuntimeContext } from "../src/runtime/context.js";
import { createParameterReader as exportedCreateParameterReader } from "../src/runtime/index.js";

describe("runtime parameter helpers", () => {
  it("reads optional and required values", () => {
    const params = createParameterReader({
      window: "PT1H",
      apps: ["salesforce", "workday"],
      apiKey: "resolved-secret"
    });

    expect(params.get("window")).toBe("PT1H");
    expect(params.get("missing", "fallback")).toBe("fallback");
    expect(params.require("apiKey")).toBe("resolved-secret");
    expect(params.string("window")).toBe("PT1H");
    expect(params.requiredString("apiKey")).toBe("resolved-secret");
    expect(params.stringArray("apps")).toEqual(["salesforce", "workday"]);
    expect(params.stringArray("missing", [])).toEqual([]);
  });

  it("rejects missing required values", () => {
    const params = createParameterReader({ empty: "" });

    expect(() => params.require("missing")).toThrow("required runtime parameter is missing: missing");
    expect(() => params.require("empty")).toThrow("required runtime parameter is missing: empty");
  });

  it("rejects invalid string and string array types", () => {
    const params = createParameterReader({
      window: ["PT1H"],
      apps: ["salesforce", 42]
    });

    expect(() => params.string("window")).toThrow("runtime parameter window must be a string");
    expect(() => params.requiredString("window")).toThrow("runtime parameter window must be a string");
    expect(() => params.stringArray("apps")).toThrow("runtime parameter apps must be a string array");
    expect(() => params.requiredStringArray("apps")).toThrow("runtime parameter apps must be a string array");
  });

  it("attaches parameter helpers to created runtime context", async () => {
    const context = await createRuntimeContext({
      env: {
        IGA_SCHEDULER_CONTEXT_FILE: "/tmp/context.json"
      },
      readFile: async () => JSON.stringify({
        runId: "run-1",
        params: {
          window: "PT1H"
        }
      })
    });

    expect(context.params).toEqual({ window: "PT1H" });
    expect(context.param.requiredString("window")).toBe("PT1H");
  });

  it("exports parameter helpers from runtime index", () => {
    expect(exportedCreateParameterReader).toBe(createParameterReader);
  });
});
