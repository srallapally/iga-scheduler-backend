export function validateProductionStartupConfig({ env = process.env } = {}) {
  if (env.NODE_ENV !== "production") return { status: "skipped", reason: "not_production" };

  const required = [
    "GCP_PROJECT_ID",
    "JOB_ZIP_BUCKET",
    "ES_ENDPOINT",
    "ES_API_KEY",
    "WORKER_OIDC_AUDIENCE",
    "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL",
    "SCHEDULER_OIDC_AUDIENCE",
    "SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL",
    "WORKER_EXECUTION_MODE",
    "RUNTIME_CLOUD_RUN_JOB_NAME",
    "RUNTIME_SERVICE_ACCOUNT_EMAIL",
    "RUNTIME_BROKER_URL",
    "IGA_TOKEN_ENDPOINT",
    "IGA_CLIENT_ID",
    "IGA_CLIENT_SECRET",
    "IGA_BASE_URL"
  ];

  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);

  if (env.WORKER_EXECUTION_MODE !== "isolated") throw new Error("WORKER_EXECUTION_MODE must be isolated in production");
  if (env.RUNTIME_SERVICE_ACCOUNT_EMAIL === env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the worker invoker service account");
  if (env.RUNTIME_SERVICE_ACCOUNT_EMAIL === env.SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the scheduler invoker service account");
  if (env.WORKER_RUNTIME_ISOLATION) throw new Error("WORKER_RUNTIME_ISOLATION is not a production isolation control; use WORKER_EXECUTION_MODE=isolated");

  return { status: "ok" };
}
