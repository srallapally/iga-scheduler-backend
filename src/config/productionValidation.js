export function validateWorkerStartupConfig({ env = process.env } = {}) {
  if (env.NODE_ENV !== "production") return { status: "skipped", reason: "not_production" };

  const required = [
    "GCP_PROJECT_ID",
    "RUNTIME_SERVICE_ACCOUNT_EMAIL",
    "RUNTIME_BROKER_URL",
    "IGA_TOKEN_ENDPOINT",
    "IGA_CLIENT_ID",
    "IGA_CLIENT_SECRET",
    "IGA_BASE_URL"
  ];

  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing required worker environment variables: ${missing.join(", ")}`);

  if (env.WORKER_REQUIRE_RUNTIME_ISOLATION !== "false") {
    throw new Error("WORKER_REQUIRE_RUNTIME_ISOLATION must be set to 'false' in the worker service — the Cloud Run container boundary is the isolation layer");
  }

  return { status: "ok" };
}

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
    "RUNTIME_WORKER_URL",
    "RUNTIME_SERVICE_ACCOUNT_EMAIL",
    "RUNTIME_BROKER_URL",
    "IGA_TOKEN_ENDPOINT",
    "IGA_CLIENT_ID",
    "IGA_CLIENT_SECRET",
    "IGA_BASE_URL",
    "PUBLIC_API_ISSUER",
    "PUBLIC_API_AUDIENCE"
  ];

  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);

  if (env.WORKER_EXECUTION_MODE !== "isolated") throw new Error("WORKER_EXECUTION_MODE must be isolated in production");
  if (env.RUNTIME_SERVICE_ACCOUNT_EMAIL === env.WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the worker invoker service account");
  if (env.RUNTIME_SERVICE_ACCOUNT_EMAIL === env.SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL must be separate from the scheduler invoker service account");
  if (env.WORKER_RUNTIME_ISOLATION) throw new Error("WORKER_RUNTIME_ISOLATION is not a production isolation control; use WORKER_EXECUTION_MODE=isolated");

  const dbEngine = env.DB_ENGINE;
  if (!dbEngine) throw new Error("Missing required production environment variables: DB_ENGINE");

  if (dbEngine === "cloud-sql") {
    const missingDb = ["DB_INSTANCE_CONNECTION_NAME", "DB_USER", "DB_NAME"].filter((n) => !env[n]);
    if (missingDb.length > 0) throw new Error(`Missing required production environment variables for DB_ENGINE=cloud-sql: ${missingDb.join(", ")}`);
  } else if (dbEngine === "direct") {
    if (!env.DATABASE_URL) throw new Error("Missing required production environment variables for DB_ENGINE=direct: DATABASE_URL");
    if (!env.DB_ALLOW_DIRECT) throw new Error("DB_ENGINE=direct is not allowed in production without DB_ALLOW_DIRECT=true (use for AlloyDB Auth Proxy or other sidecar deployments)");
  } else {
    throw new Error(`unsupported DB_ENGINE: ${dbEngine}`);
  }

  return { status: "ok" };
}
