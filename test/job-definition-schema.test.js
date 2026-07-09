import { describe, expect, it } from "vitest";
import { createJobDefinitionSchema } from "../src/validation/jobDefinitionSchema.js";

describe("createJobDefinitionSchema", () => {
  it("validates a minimal JavaScript definition", () => {
    const result = createJobDefinitionSchema.parse({
      definitionId: "risk-score",
      name: "Risk Score",
      runtime: "javascript",
      runtimeVersion: "20",
      wrapperVersion: "1.0.0",
      entrypoint: "index.js",
      parameters: [
        { name: "scanType", type: "string", required: true },
        { name: "applications", type: "string[]", required: false },
        { name: "apiCredential", type: "sensitive", required: false }
      ],
      timeoutSeconds: 1800
    });

    expect(result.definitionId).toBe("risk-score");
  });

  it("rejects invalid parameter names", () => {
    expect(() => createJobDefinitionSchema.parse({
      definitionId: "risk-score",
      name: "Risk Score",
      runtime: "javascript",
      runtimeVersion: "20",
      wrapperVersion: "1.0.0",
      entrypoint: "index.js",
      parameters: [
        { name: "bad-name", type: "string", required: true }
      ],
      timeoutSeconds: 1800
    })).toThrow();
  });
});
