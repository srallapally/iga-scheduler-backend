const NON_RETRYABLE_CODES = new Set([
  "RUN_DEFINITION_MISSING",
  "DEFINITION_NOT_FOUND",
  "DEFINITION_NOT_ACTIVE",
  "DEFINITION_VERSION_MISMATCH",
  "DEFINITION_ARTIFACT_MISSING",
  "ARTIFACT_URI_INVALID",
  "ARTIFACT_SHA256_MISMATCH",
  "ARTIFACT_ZIP_INVALID",
  "RUNTIME_ARTIFACT_BUFFER_REQUIRED",
  "RUNTIME_ARTIFACT_SHA256_MISMATCH",
  "RUNTIME_ARTIFACT_URI_INVALID",
  "RUNTIME_ENTRYPOINT_INVALID",
  "RUNTIME_ENTRYPOINT_REQUIRED",
  "RUNTIME_RESULT_JSON_INVALID",
  "RUNTIME_RESULT_MISSING",
  "RUNTIME_RESULT_OUTPUT_TOO_LARGE",
  "RUNTIME_UNSUPPORTED",
  "RUNTIME_VERSION_UNSUPPORTED"
]);

const RETRYABLE_CODES = new Set([
  "ARTIFACT_DOWNLOAD_FAILED",
  "RUNTIME_ARTIFACT_DOWNLOAD_FAILED",
  "WORKER_EXECUTION_FAILED",
  "WORKER_TIMEOUT",
  "RUNTIME_PROCESS_EXITED_NON_ZERO",
  "RUNTIME_PROCESS_TIMED_OUT"
]);

const NON_RETRYABLE_HTTP_STATUS_CODES = new Set([400, 401, 403, 404, 409, 410, 422]);
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusCodeFromError(error) {
  return error?.statusCode || error?.meta?.statusCode || error?.body?.status;
}

function classification({ retryable, reason }) {
  return {
    retryable,
    classification: retryable ? "RETRYABLE" : "NON_RETRYABLE",
    reason
  };
}

export function classifyWorkerError(error) {
  if (typeof error?.retryable === "boolean") {
    return classification({
      retryable: error.retryable,
      reason: "explicit_error_retryable_flag"
    });
  }

  const code = error?.code || "WORKER_EXECUTION_FAILED";

  if (NON_RETRYABLE_CODES.has(code)) {
    return classification({
      retryable: false,
      reason: `non_retryable_code:${code}`
    });
  }

  if (RETRYABLE_CODES.has(code)) {
    return classification({
      retryable: true,
      reason: `retryable_code:${code}`
    });
  }

  const statusCode = statusCodeFromError(error);

  if (NON_RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
    return classification({
      retryable: false,
      reason: `non_retryable_http_status:${statusCode}`
    });
  }

  if (RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) {
    return classification({
      retryable: true,
      reason: `retryable_http_status:${statusCode}`
    });
  }

  return classification({
    retryable: true,
    reason: "default_retryable_worker_failure"
  });
}
