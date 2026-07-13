import { describe, expect, it } from "vitest";
import { classifyWorkerError } from "../src/services/retryClassifier.js";

function errorWithCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

describe("classifyWorkerError", () => {
  it("classifies known definition and artifact validation errors as non-retryable", () => {
    const error = new Error("job definition is not active");
    error.code = "DEFINITION_NOT_ACTIVE";

    expect(classifyWorkerError(error)).toEqual({
      retryable: false,
      classification: "NON_RETRYABLE",
      reason: "non_retryable_code:DEFINITION_NOT_ACTIVE"
    });
  });

  it("classifies transient artifact download errors as retryable", () => {
    const error = new Error("download failed");
    error.code = "ARTIFACT_DOWNLOAD_FAILED";

    expect(classifyWorkerError(error)).toEqual({
      retryable: true,
      classification: "RETRYABLE",
      reason: "retryable_code:ARTIFACT_DOWNLOAD_FAILED"
    });
  });

  it("classifies transient runtime process errors as retryable", () => {
    for (const code of [
      "RUNTIME_PROCESS_EXITED_NON_ZERO",
      "RUNTIME_PROCESS_TIMED_OUT"
    ]) {
      expect(classifyWorkerError(errorWithCode(code))).toEqual({
        retryable: true,
        classification: "RETRYABLE",
        reason: `retryable_code:${code}`
      });
    }
  });

  it("classifies runtime contract and configuration errors as non-retryable", () => {
    for (const code of [
      "RUNTIME_ARTIFACT_BUFFER_REQUIRED",
      "RUNTIME_ENTRYPOINT_INVALID",
      "RUNTIME_ENTRYPOINT_REQUIRED",
      "RUNTIME_RESULT_JSON_INVALID",
      "RUNTIME_RESULT_MISSING",
      "RUNTIME_RESULT_OUTPUT_TOO_LARGE",
      "RUNTIME_UNSUPPORTED",
      "RUNTIME_VERSION_UNSUPPORTED"
    ]) {
      expect(classifyWorkerError(errorWithCode(code))).toEqual({
        retryable: false,
        classification: "NON_RETRYABLE",
        reason: `non_retryable_code:${code}`
      });
    }
  });

  it("honors an explicit retryable flag on the error", () => {
    const error = new Error("runtime rejected request");
    error.retryable = false;

    expect(classifyWorkerError(error)).toEqual({
      retryable: false,
      classification: "NON_RETRYABLE",
      reason: "explicit_error_retryable_flag"
    });
  });

  it("classifies RUNTIME_ARTIFACT_SHA256_MISMATCH as non-retryable", () => {
    expect(classifyWorkerError(errorWithCode("RUNTIME_ARTIFACT_SHA256_MISMATCH"))).toEqual({
      retryable: false,
      classification: "NON_RETRYABLE",
      reason: "non_retryable_code:RUNTIME_ARTIFACT_SHA256_MISMATCH"
    });
  });

  it("classifies RUNTIME_ARTIFACT_DOWNLOAD_FAILED as retryable", () => {
    expect(classifyWorkerError(errorWithCode("RUNTIME_ARTIFACT_DOWNLOAD_FAILED"))).toEqual({
      retryable: true,
      classification: "RETRYABLE",
      reason: "retryable_code:RUNTIME_ARTIFACT_DOWNLOAD_FAILED"
    });
  });
});
