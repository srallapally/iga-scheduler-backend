#!/usr/bin/env node
// Preflight: validates all env vars and probes live connectivity before any writes.
// Exit 0 = all checks passed. Exit 1 = one or more checks failed.
// Safe to run standalone: node scripts/prod/preflight.js
//
// ES_ENDPOINT / ES_API_KEY / GCP_PROJECT_ID can be supplied as CLI flags when
// they are not already in the environment:
//   --es-endpoint <url>   seeds ES_ENDPOINT
//   --es-api-key  <key>   seeds ES_API_KEY
//   --gcp-project <id>    seeds GCP_PROJECT_ID
//
// Checks by mode:
//
//   local mode (APP_MODE=local)
//     1. Required env vars (auth only: PUBLIC_API_*, WORKER_*, SCHEDULER_*)
//     2. OAuth AS JWKS endpoint reachable
//
//   production mode (APP_MODE=production, default)
//     1. Required env vars present and semantically valid
//     2. Elasticsearch reachable and API key has sufficient permissions
//     3. Postgres reachable (Cloud SQL connector or direct)
//     4. GCS bucket exists and is accessible
//     5. Secret Manager API reachable (if IGA_CLIENT_SECRET looks like a SM resource name)
//     6. OAuth AS JWKS endpoint reachable

import { ok, fail, warn, header, dim, requireEnv, env, stopwatch, applyCliDefaults } from "./lib.js";

applyCliDefaults();

const MODE = process.env.APP_MODE || "production";
const IS_LOCAL = MODE === "local";

let failures = 0;

function pass(section, msg) { ok(section, msg); }
function fault(section, msg) { fail(section, msg); failures++; }

// ─── 1. Environment variables ─────────────────────────────────────────────────

header(`1 / ${IS_LOCAL ? 2 : 6}  Environment variables`);

// These vars are required in every mode — local and production.
const AUTH_REQUIRED = [
  "PUBLIC_API_ISSUER",
  "PUBLIC_API_AUDIENCE",
  "WORKER_OIDC_AUDIENCE",
  "WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL",
  "SCHEDULER_OIDC_AUDIENCE",
  "SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL",
];

const { ok: authOk, missing: authMissing } = requireEnv(AUTH_REQUIRED);
if (authOk) {
  pass("env", `auth vars present (${AUTH_REQUIRED.length} checked)`);
} else {
  authMissing.forEach((v) => fault("env", `missing: ${v}`));
}

if (IS_LOCAL) {
  dim("  APP_MODE=local — GCP, ES, DB, and runtime vars not required");
} else {
  // Production: check GCP/ES/DB core vars
  const PROD_CORE = [
    "GCP_PROJECT_ID",
    "JOB_ZIP_BUCKET",
    "ES_ENDPOINT",
    "ES_API_KEY",
    "DB_ENGINE",
  ];

  const RUNTIME_REQUIRED = [
    "WORKER_EXECUTION_MODE",
    "RUNTIME_CLOUD_RUN_JOB_NAME",
    "RUNTIME_SERVICE_ACCOUNT_EMAIL",
    "RUNTIME_BROKER_URL",
    "IGA_TOKEN_ENDPOINT",
    "IGA_CLIENT_ID",
    "IGA_CLIENT_SECRET",
    "IGA_BASE_URL",
  ];

  const { ok: coreOk, missing: coreMissing } = requireEnv(PROD_CORE);
  if (coreOk) {
    pass("env", `core vars present (${PROD_CORE.length} checked)`);
  } else {
    coreMissing.forEach((v) => fault("env", `missing: ${v}`));
  }

  const { ok: runtimeOk, missing: runtimeMissing } = requireEnv(RUNTIME_REQUIRED);
  if (runtimeOk) {
    pass("env", `runtime vars present (${RUNTIME_REQUIRED.length} checked)`);
  } else {
    runtimeMissing.forEach((v) => fault("env", `missing: ${v}`));
  }

  // DB-engine-specific vars
  const dbEngine = env("DB_ENGINE");
  if (dbEngine === "cloud-sql") {
    const { ok: dbOk, missing: dbMissing } = requireEnv(["DB_INSTANCE_CONNECTION_NAME", "DB_USER", "DB_NAME"]);
    if (dbOk) pass("env", "DB_ENGINE=cloud-sql vars present");
    else dbMissing.forEach((v) => fault("env", `missing: ${v}`));
  } else if (dbEngine === "direct") {
    if (env("DATABASE_URL")) pass("env", "DB_ENGINE=direct DATABASE_URL present");
    else fault("env", "missing: DATABASE_URL (required for DB_ENGINE=direct)");
    if (!env("DB_ALLOW_DIRECT")) warn("env", "DB_ALLOW_DIRECT not set — production validation will reject DB_ENGINE=direct without it");
  } else if (dbEngine) {
    fault("env", `DB_ENGINE=${dbEngine} is not a supported value (use cloud-sql or direct)`);
  }

  // Semantic checks
  if (env("WORKER_EXECUTION_MODE") && env("WORKER_EXECUTION_MODE") !== "isolated") {
    fault("env", "WORKER_EXECUTION_MODE must be 'isolated' in production");
  }
  if (env("RUNTIME_SERVICE_ACCOUNT_EMAIL") && env("WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL") &&
      env("RUNTIME_SERVICE_ACCOUNT_EMAIL") === env("WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL")) {
    fault("env", "RUNTIME_SERVICE_ACCOUNT_EMAIL must differ from WORKER_INVOKER_SERVICE_ACCOUNT_EMAIL");
  }
  if (env("RUNTIME_SERVICE_ACCOUNT_EMAIL") && env("SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL") &&
      env("RUNTIME_SERVICE_ACCOUNT_EMAIL") === env("SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL")) {
    fault("env", "RUNTIME_SERVICE_ACCOUNT_EMAIL must differ from SCHEDULER_INVOKER_SERVICE_ACCOUNT_EMAIL");
  }
}

// ─── Production-only connectivity checks ─────────────────────────────────────

if (!IS_LOCAL) {
  const dbEngine = env("DB_ENGINE");

  // ─── 2. Elasticsearch connectivity ─────────────────────────────────────────

  header("2 / 6  Elasticsearch");

  if (!env("ES_ENDPOINT") || !env("ES_API_KEY")) {
    warn("es", "skipped — ES_ENDPOINT or ES_API_KEY not set");
  } else {
    const elapsed = stopwatch();
    try {
      // Need GCP_PROJECT_ID / JOB_ZIP_BUCKET set for getConfig() used by createEsClient
      const { createEsClient } = await import("../../src/clients/esClient.js");
      const esClient = createEsClient();

      await esClient.ping();
      pass("es", `reachable (${elapsed()})`);

      try {
        await esClient.cat.indices({ format: "json", h: "index" });
        pass("es", "API key can list indices");
      } catch (e) {
        warn("es", `API key cannot list indices — may lack monitor privilege: ${e.message}`);
      }

      const { getSchedulerIndexDefinitions } = await import("../../src/elasticsearch/schedulerIndexMappings.js");
      const indices = getSchedulerIndexDefinitions();
      for (const { name } of indices) {
        const exists = await esClient.indices.exists({ index: name });
        if (exists) {
          dim(`  index ${name} already exists — bootstrap will skip`);
        } else {
          dim(`  index ${name} does not exist — bootstrap will create`);
        }
      }

      const probeIndex = `__iga_preflight_probe_${Date.now()}`;
      try {
        await esClient.indices.create({ index: probeIndex });
        await esClient.indices.delete({ index: probeIndex });
        pass("es", "API key can create/delete indices");
      } catch (e) {
        fault("es", `API key cannot create indices — bootstrap will fail: ${e.message}`);
      }
    } catch (e) {
      fault("es", `unreachable: ${e.message}`);
    }
  }

  // ─── 3. Postgres connectivity ───────────────────────────────────────────────

  header("3 / 6  Postgres");

  const hasPgConfig = dbEngine === "cloud-sql"
    ? Boolean(env("DB_INSTANCE_CONNECTION_NAME") && env("DB_USER") && env("DB_NAME"))
    : Boolean(env("DATABASE_URL"));

  if (!hasPgConfig) {
    warn("pg", "skipped — connection vars not set");
  } else {
    const elapsed = stopwatch();
    let pool;
    try {
      const { createPgPool } = await import("../../src/clients/pgClient.js");
      pool = await createPgPool();
      const { rows } = await pool.query("SELECT current_database() AS db, current_user AS usr, version() AS ver");
      pass("pg", `connected to '${rows[0].db}' as '${rows[0].usr}' (${elapsed()})`);
      dim(`  ${rows[0].ver.split(" ").slice(0, 2).join(" ")}`);

      const { rows: tables } = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('job_instances','job_runs','pgmigrations')"
      );
      const names = tables.map((r) => r.tablename);
      if (names.includes("job_instances") && names.includes("job_runs")) {
        dim("  tables job_instances + job_runs already exist — migrations will skip");
      } else {
        dim("  tables not yet created — migrations will run");
      }

      try {
        await pool.query("CREATE TABLE __iga_preflight_probe (id int); DROP TABLE __iga_preflight_probe;");
        pass("pg", "user has CREATE TABLE privilege");
      } catch (e) {
        fault("pg", `user lacks CREATE TABLE privilege — migrations will fail: ${e.message}`);
      }
    } catch (e) {
      fault("pg", `unreachable: ${e.message}`);
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
  }

  // ─── 4. GCS bucket ─────────────────────────────────────────────────────────

  header("4 / 6  GCS bucket");

  const bucket = env("JOB_ZIP_BUCKET");
  if (!bucket) {
    warn("gcs", "skipped — JOB_ZIP_BUCKET not set");
  } else {
    const elapsed = stopwatch();
    try {
      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({ projectId: env("GCP_PROJECT_ID") });
      const [exists] = await storage.bucket(bucket).exists();
      if (exists) {
        pass("gcs", `bucket '${bucket}' exists (${elapsed()})`);
      } else {
        fault("gcs", `bucket '${bucket}' does not exist — create it before deploying`);
      }

      const probeFile = storage.bucket(bucket).file("__iga_preflight_probe");
      try {
        await probeFile.save("probe", { resumable: false });
        await probeFile.delete();
        pass("gcs", "service account can write to bucket");
      } catch (e) {
        fault("gcs", `cannot write to bucket — app will fail to store job artifacts: ${e.message}`);
      }
    } catch (e) {
      fault("gcs", `check failed: ${e.message}`);
    }
  }

  // ─── 5. Secret Manager reachability ────────────────────────────────────────

  header("5 / 6  Secret Manager");

  const igaClientSecret = env("IGA_CLIENT_SECRET");
  if (!igaClientSecret) {
    warn("sm", "skipped — IGA_CLIENT_SECRET not set");
  } else if (!igaClientSecret.startsWith("projects/")) {
    dim("  IGA_CLIENT_SECRET is a literal value, not a Secret Manager reference — skipping SM probe");
    pass("sm", "literal secret configured (not using Secret Manager)");
  } else {
    const elapsed = stopwatch();
    try {
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      const client = new SecretManagerServiceClient();
      const [version] = await client.accessSecretVersion({ name: igaClientSecret });
      if (version?.payload?.data) {
        pass("sm", `secret accessible (${elapsed()})`);
      } else {
        fault("sm", "secret returned empty payload");
      }
    } catch (e) {
      fault("sm", `cannot access secret '${igaClientSecret}': ${e.message}`);
    }
  }
} // end production-only checks

// ─── 6. OAuth AS JWKS endpoint ────────────────────────────────────────────────
// Supports PingOne and PingOne Advanced Identity Cloud (AIC / ForgeRock).
// If PUBLIC_API_JWKS_URL is set, it is used directly.
// Otherwise we try OIDC discovery (issuer/.well-known/openid-configuration) to
// find jwks_uri — required for AIC realm URLs that don't follow the
// /.well-known/jwks.json convention.

header(`${IS_LOCAL ? 2 : 6} / ${IS_LOCAL ? 2 : 6}  OAuth AS JWKS`);

const issuer = env("PUBLIC_API_ISSUER");
let jwksUrl = env("PUBLIC_API_JWKS_URL") || null;

if (!issuer) {
  warn("ping", "skipped — PUBLIC_API_ISSUER not set");
} else {
  if (!jwksUrl) {
    const elapsed = stopwatch();
    try {
      const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
      const discoveryRes = await fetch(discoveryUrl);
      if (discoveryRes.ok) {
        const doc = await discoveryRes.json();
        if (doc.jwks_uri) {
          jwksUrl = doc.jwks_uri;
          pass("ping", `OIDC discovery succeeded, jwks_uri resolved (${elapsed()})`);
          dim(`  jwks_uri: ${jwksUrl}`);
        } else {
          warn("ping", "OIDC discovery doc has no jwks_uri — falling back to <issuer>/.well-known/jwks.json");
          jwksUrl = `${issuer}/.well-known/jwks.json`;
        }
      } else {
        warn("ping", `OIDC discovery returned HTTP ${discoveryRes.status} — falling back to <issuer>/.well-known/jwks.json`);
        jwksUrl = `${issuer}/.well-known/jwks.json`;
      }
    } catch (e) {
      warn("ping", `OIDC discovery failed (${e.message}) — falling back to <issuer>/.well-known/jwks.json`);
      jwksUrl = `${issuer}/.well-known/jwks.json`;
    }
  } else {
    dim(`  using explicit PUBLIC_API_JWKS_URL: ${jwksUrl}`);
  }

  const elapsed = stopwatch();
  try {
    const res = await fetch(jwksUrl);
    if (!res.ok) {
      fault("ping", `JWKS endpoint returned HTTP ${res.status}: ${jwksUrl}`);
    } else {
      const body = await res.json();
      const keyCount = body?.keys?.length ?? 0;
      if (keyCount === 0) {
        warn("ping", `JWKS endpoint returned 0 keys — tokens will fail to verify: ${jwksUrl}`);
      } else {
        pass("ping", `JWKS endpoint reachable, ${keyCount} key(s) (${elapsed()})`);
      }
    }
  } catch (e) {
    fault("ping", `JWKS endpoint unreachable: ${e.message} — ${jwksUrl}`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

header("Summary");

if (failures === 0) {
  ok("preflight", "all checks passed — safe to proceed with bootstrap");
  process.exit(0);
} else {
  fail("preflight", `${failures} check(s) failed — resolve issues above before bootstrapping`);
  process.exit(1);
}
